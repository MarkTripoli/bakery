import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  connectionsAwaitingRevalidation,
  revalidateConnection,
} from "../../apps/server/src/modules/integrations/reconcile.ts";
import {
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  postCheck,
  readConnection,
} from "../helpers/github-app-registration.ts";

/** A client deadline short enough for a scripted hang, long enough for a mint. */
const TIMEOUT_MS = 1_500;

async function withFixture(
  run: (f: GitHubAppFixture) => Promise<void>,
  options: { requestTimeoutMs?: number } = {},
) {
  const f = await openGitHubAppFixture(options);
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

type ConnectionState = {
  status: string;
  health: string;
  version: number;
  lastCheckedAt: Date | null;
  nextAllowedAt: Date | null;
  lastProblemCode: string | null;
};

async function connectionState(
  f: GitHubAppFixture,
  connectionId: string,
): Promise<ConnectionState> {
  return (await f.pgDatabase.query<ConnectionState>(
    `select status, health, version, last_checked_at as "lastCheckedAt",
       next_allowed_at as "nextAllowedAt",
       last_problem_code as "lastProblemCode"
       from bakery.integration_connections where id = $1`,
    [connectionId],
  )).rows[0];
}

async function ok(response: Response) {
  const body = await response.text();
  assertEquals(response.status, 200, body);
  return contractSchemas.ConnectionCheck.parse(JSON.parse(body));
}

async function problem(response: Response, status: number, code: string) {
  const body = await response.text();
  assertEquals(response.status, status, body);
  const parsed = JSON.parse(body);
  assertEquals(parsed.code, code, body);
  return parsed as { code: string; retryAfterSeconds?: number };
}

/** Domain events of one type for one connection. */
function events(f: GitHubAppFixture, connectionId: string, type: string) {
  return count(
    f,
    `select count(*) from bakery.domain_events
      where organization_id = $1 and event_type = $2 and aggregate_id = $3`,
    [f.organizationId, type, connectionId],
  );
}

const healthEvents = (f: GitHubAppFixture, id: string) =>
  events(f, id, "integration.health_changed");
/** integration.discovery_requested events naming a discovery of this connection. */
const discoveryEvents = (f: GitHubAppFixture, id: string) =>
  count(
    f,
    `select count(*) from bakery.domain_events as event
       join bakery.integration_discoveries as discovery
         on discovery.id::text = event.aggregate_id::text
      where event.organization_id = $1
        and event.event_type = 'integration.discovery_requested'
        and discovery.connection_id = $2`,
    [f.organizationId, id],
  );

/** The connection's discovery rows, oldest first. */
async function discoveries(f: GitHubAppFixture, connectionId: string) {
  return (await f.pgDatabase.query<
    { id: string; status: string; requestedBy: string; notBefore: Date }
  >(
    `select id, status, requested_by as "requestedBy",
       not_before as "notBefore"
       from bakery.integration_discoveries where connection_id = $1
      order by not_before, created_at`,
    [connectionId],
  )).rows;
}

/** Lets the next check through a recorded rate limit. */
async function clearQuota(f: GitHubAppFixture, connectionId: string) {
  await f.pgDatabase.query(
    `update bakery.integration_connections set next_allowed_at = null
      where id = $1`,
    [connectionId],
  );
}

Deno.test("WHEN GitHub rejects a minted installation token with a definitive 401, the check mints one replacement and repeats the probe once", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    assertEquals(f.github.tokenRequests.length, 1);
    // GitHub revokes the cached token: the next check's first read gets 401.
    f.github.revokedTokens.push(f.github.issuedTokens.at(-1)!);
    f.github.calls.length = 0;
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, true);
    assertEquals(check.health, "healthy");
    assertEquals(check.fault, null);
    // Exactly one replacement and one repeated probe: the rejected read,
    // the replacement mint, the repeated read.
    assertEquals(f.github.tokenRequests.length, 2, "one replacement mint");
    assertEquals(
      f.github.calls.map((call) => call.method),
      ["GET", "POST", "GET"],
    );
    assertEquals(f.github.tokenListings().length, 2, "the probe ran twice");
    const after = await connectionState(f, connectionId);
    assertEquals(after.health, "healthy");
    assertEquals(after.version, healthy.version, "health held");
    // The replacement is cached; the rejected token is never presented again.
    f.github.calls.length = 0;
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 2);
    assertEquals(f.github.calls.map((call) => call.method), ["GET"]);
  });
});

Deno.test("WHEN the replacement token is also rejected, the check sets health auth_required and returns it", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    // Every token GitHub issues for this installation is rejected.
    f.github.failures.tokenListingScripts.set(installation.id, "unauthorized");
    f.github.calls.length = 0;
    const response = await postCheck(f, connectionId);
    assert(response.status !== 401, "never a Bakery-session 401");
    const check = await ok(response);
    assertEquals(check.healthy, false);
    assertEquals(check.health, "auth_required");
    assertEquals(check.fault, null);
    assertEquals(check.capabilities, []);
    // The cached token, then one replacement: never a third token.
    assertEquals(f.github.tokenRequests.length, 2);
    assertEquals(f.github.tokenListings().length, 2);
    const state = await connectionState(f, connectionId);
    assertEquals(state.health, "auth_required");
    assertEquals(state.lastProblemCode, "token_rejected");
    assertEquals(state.version, healthy.version + 1, "health moved");
    assertEquals(await healthEvents(f, connectionId), 2);
    assertEquals(await discoveryEvents(f, connectionId), 0);
    // Checking again refreshes once more and moves nothing.
    f.github.calls.length = 0;
    const again = await ok(await postCheck(f, connectionId));
    assertEquals(again.health, "auth_required");
    assertEquals(
      f.github.tokenRequests.length,
      4,
      "one fresh mint, one replacement",
    );
    assertEquals(f.github.tokenListings().length, 2);
    const held = await connectionState(f, connectionId);
    assertEquals(held.version, state.version);
    assertEquals(await healthEvents(f, connectionId), 2);
  });
});

Deno.test("WHILE a connection health is auth_required, the server keeps its lifecycle status unchanged", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.failures.tokenListingScripts.set(installation.id, "unauthorized");
    assertEquals(
      (await ok(await postCheck(f, connectionId))).health,
      "auth_required",
    );
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "enabled", "the stored status is untouched");
    assertEquals(state.health, "auth_required");
    // The projection folds health into the client-facing state.
    const read = await (await readConnection(f, connectionId)).json();
    assertEquals(read.status, "degraded");
    // Still enabled: the connection can be checked, and a check GitHub
    // accepts again restores health with the status still enabled.
    f.github.failures.tokenListingScripts.delete(installation.id);
    const restored = await ok(await postCheck(f, connectionId));
    assertEquals(restored.health, "healthy");
    const after = await connectionState(f, connectionId);
    assertEquals(after.status, "enabled");
    assertEquals(after.health, "healthy");
    assertEquals(after.lastProblemCode, null);
    assertEquals(
      (await (await readConnection(f, connectionId)).json()).status,
      "enabled",
    );
  });
});

Deno.test("WHEN GitHub answers 403 with rate-limit evidence, the check records the next allowed time and returns 429 PROVIDER_QUOTA_EXCEEDED without changing health", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    const healthBefore = await healthEvents(f, connectionId);
    f.github.failures.tokenListingScripts.set(installation.id, "rate_limited");
    const before = Date.now();
    const limited = await problem(
      await postCheck(f, connectionId),
      429,
      "PROVIDER_QUOTA_EXCEEDED",
    );
    // The fake resets the limit two minutes out (x-ratelimit-reset).
    assert(
      limited.retryAfterSeconds !== undefined &&
        limited.retryAfterSeconds >= 110 && limited.retryAfterSeconds <= 121,
      String(limited.retryAfterSeconds),
    );
    const state = await connectionState(f, connectionId);
    assert(state.nextAllowedAt !== null, "the next allowed time is recorded");
    const wait = state.nextAllowedAt.getTime() - before;
    assert(wait >= 110_000 && wait <= 125_000, String(wait));
    assertEquals(state.health, healthy.health, "health unchanged");
    assertEquals(state.version, healthy.version);
    assertEquals(state.lastProblemCode, healthy.lastProblemCode);
    assertEquals(
      state.lastCheckedAt?.getTime(),
      healthy.lastCheckedAt?.getTime(),
    );
    assertEquals(await healthEvents(f, connectionId), healthBefore);
    // A rate limit says nothing against the token: it stays cached.
    assertEquals(f.github.tokenRequests.length, 1);
    // Until the limit runs out a check is refused before any GitHub call.
    f.github.failures.tokenListingScripts.delete(installation.id);
    f.github.calls.length = 0;
    const gated = await problem(
      await postCheck(f, connectionId),
      429,
      "PROVIDER_QUOTA_EXCEEDED",
    );
    assert((gated.retryAfterSeconds ?? 0) >= 1);
    assertEquals(f.github.calls.length, 0);
    // Once it ran out the check proceeds.
    await clearQuota(f, connectionId);
    assertEquals((await ok(await postCheck(f, connectionId))).healthy, true);
  });
});

Deno.test("a 429 secondary rate limit and a rate-limited mint record the wait GitHub named and return 429 PROVIDER_QUOTA_EXCEEDED", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    f.github.failures.tokenListingScripts.set(installation.id, "quota");
    const quota = await problem(
      await postCheck(f, connectionId),
      429,
      "PROVIDER_QUOTA_EXCEEDED",
    );
    assertEquals(quota.retryAfterSeconds, 30, "Retry-After: 30");
    f.github.failures.tokenListingScripts.delete(installation.id);
    await clearQuota(f, connectionId);
    // A rate-limited mint (403 with Retry-After: 60): the revoked cached
    // token forces a fresh mint.
    f.github.revokedTokens.push(f.github.issuedTokens.at(-1)!);
    f.github.failures.rateLimited.add(installation.id);
    const minted = await problem(
      await postCheck(f, connectionId),
      429,
      "PROVIDER_QUOTA_EXCEEDED",
    );
    assertEquals(minted.retryAfterSeconds, 60);
    const state = await connectionState(f, connectionId);
    assert(state.nextAllowedAt !== null);
    assertEquals(state.health, healthy.health);
    assertEquals(state.version, healthy.version);
  });
});

Deno.test("a check queued behind a rate-limited one is refused with 429 without calling GitHub", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    f.github.failures.tokenListingScripts.set(installation.id, "rate_limited");
    f.github.calls.length = 0;
    const [first, second] = await Promise.all([
      postCheck(f, connectionId),
      postCheck(f, connectionId),
    ]);
    await problem(first, 429, "PROVIDER_QUOTA_EXCEEDED");
    await problem(second, 429, "PROVIDER_QUOTA_EXCEEDED");
    // Checks of one installation run one at a time; the limit the first
    // recorded refuses the second before it reaches GitHub.
    assertEquals(f.github.tokenListings().length, 1);
    assertEquals(f.github.tokenRequests.length, 1);
  });
});

Deno.test("WHEN the provider read times out, the check returns 504 DEPENDENCY_TIMEOUT and leaves health unchanged", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    const healthBefore = await healthEvents(f, connectionId);
    f.github.failures.tokenListingScripts.set(installation.id, "hang");
    await problem(await postCheck(f, connectionId), 504, "DEPENDENCY_TIMEOUT");
    const state = await connectionState(f, connectionId);
    assertEquals(state, healthy, "nothing about the connection was written");
    assertEquals(await healthEvents(f, connectionId), healthBefore);
    // A mint that times out is the same 504.
    f.github.failures.tokenListingScripts.delete(installation.id);
    f.github.revokedTokens.push(f.github.issuedTokens.at(-1)!);
    f.github.failures.tokenScripts.set(installation.id, "hang");
    await problem(await postCheck(f, connectionId), 504, "DEPENDENCY_TIMEOUT");
    assertEquals(await connectionState(f, connectionId), healthy);
    f.github.failures.tokenScripts.delete(installation.id);
    assertEquals((await ok(await postCheck(f, connectionId))).healthy, true);
  }, { requestTimeoutMs: TIMEOUT_MS });
});

Deno.test("a 403 permission loss marks the connection degraded, drops the token and requests discovery once per loss", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    f.github.failures.tokenListingScripts.set(installation.id, "forbidden");
    const lost = await ok(await postCheck(f, connectionId));
    assertEquals(lost.healthy, false);
    assertEquals(lost.health, "degraded");
    assertEquals(lost.fault, null);
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "enabled");
    assertEquals(state.health, "degraded");
    assertEquals(state.lastProblemCode, "permission_lost");
    assertEquals(state.version, healthy.version + 1);
    assertEquals(await discoveryEvents(f, connectionId), 1);
    // A queued discovery, requested by the Admin whose check found the loss.
    const [queued] = await discoveries(f, connectionId);
    assertEquals(queued.status, "queued");
    const checker = await f.pgDatabase.query<{ principalId: string }>(
      `select principal_id as "principalId" from bakery.audit_events
        where operation = 'integrationConnections.check' and resource_id = $1
        order by created_at desc, id desc limit 1`,
      [connectionId],
    );
    assertEquals(queued.requestedBy, checker.rows[0]?.principalId);
    // The forbidden token is dropped: the next check mints afresh. The
    // loss is already requested: no second discovery, no version move.
    const mints = f.github.tokenRequests.length;
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, mints + 1);
    assertEquals(await discoveryEvents(f, connectionId), 1);
    assertEquals(
      (await connectionState(f, connectionId)).version,
      state.version,
    );
    // An outage between two 403s proves nothing about the loss: it stays
    // recorded and the next 403 requests nothing new.
    f.github.failures.tokenListingScripts.delete(installation.id);
    f.github.failures.tokenListing.add(installation.id);
    const outage = await ok(await postCheck(f, connectionId));
    assertEquals(outage.fault?.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(outage.health, "degraded");
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      "permission_lost",
    );
    // The audit still records what that check found: the outage.
    const audited = await f.pgDatabase.query<{ problem: string }>(
      `select details->>'problem' as problem from bakery.audit_events
        where operation = 'integrationConnections.check' and resource_id = $1
        order by created_at desc, id desc limit 1`,
      [connectionId],
    );
    assertEquals(audited.rows[0]?.problem, "dependency_unavailable");
    f.github.failures.tokenListing.delete(installation.id);
    f.github.failures.tokenListingScripts.set(installation.id, "forbidden");
    await ok(await postCheck(f, connectionId));
    assertEquals(await discoveryEvents(f, connectionId), 1);
    assertEquals(
      (await connectionState(f, connectionId)).version,
      state.version,
    );
    // permission_lost → token_refused (a removed repository makes GitHub
    // refuse the narrowed mint) → permission_lost requests discovery again
    // once the first scan finished, paced after it.
    await f.pgDatabase.query(
      `update bakery.integration_discoveries set status = 'completed'
        where id = $1`,
      [queued.id],
    );
    f.github.failures.tokenListingScripts.delete(installation.id);
    const removed = installation.repositories.splice(0, 1);
    await ok(await postCheck(f, connectionId)).then((check) =>
      assertEquals(check.healthy, false)
    );
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      "token_refused",
    );
    installation.repositories.unshift(...removed);
    f.github.failures.tokenListingScripts.set(installation.id, "forbidden");
    await ok(await postCheck(f, connectionId));
    const again = await connectionState(f, connectionId);
    assertEquals(again.lastProblemCode, "permission_lost");
    // Health stayed degraded throughout: the version did not move.
    assertEquals(again.version, state.version);
    assertEquals(await discoveryEvents(f, connectionId), 2);
    const [first, second] = await discoveries(f, connectionId);
    assertEquals([first.id, second.status], [queued.id, "queued"]);
    assert(
      second.notBefore.getTime() - first.notBefore.getTime() >= 30_000,
      "paced 30 s after the earlier scan",
    );
  });
});

/** Suspends then unsuspends the connection's installation, revalidating it. */
async function unsuspend(
  f: GitHubAppFixture,
  connectionId: string,
  fakeInstallationId: number,
) {
  const { installationId } = (await f.pgDatabase.query<
    { installationId: string }
  >(
    `select installation_id as "installationId"
       from bakery.integration_connections where id = $1`,
    [connectionId],
  )).rows[0];
  f.github.setInstallationState(fakeInstallationId, "suspended");
  await f.reconcile(installationId);
  f.github.setInstallationState(fakeInstallationId, "active");
  return await f.reconcile(installationId);
}

/** The `discovery` detail of the connection's latest check audit row. */
async function auditedDiscovery(f: GitHubAppFixture, connectionId: string) {
  return (await f.pgDatabase.query<{ discovery: boolean }>(
    `select (details->>'discovery')::boolean as discovery
       from bakery.audit_events
      where operation = 'integrationConnections.check' and resource_id = $1
      order by created_at desc, id desc limit 1`,
    [connectionId],
  )).rows[0]?.discovery;
}

Deno.test("a permission loss an unsuspend revalidation records is still requested for discovery by the next Admin check", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    // An Admin rescan before the loss, already finished: it answers nothing
    // about a loss found later.
    const earlier = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.integration_discoveries (
         id, organization_id, connection_id, installation_id, requested_by,
         status, not_before, completed_at
       )
       select $1, organization_id, id, installation_id,
         (select principal_id from bakery.audit_events
           where operation = 'integrationConnections.check'
             and resource_id = $2::text limit 1),
         'completed', now() - interval '1 hour', now() - interval '1 hour'
         from bakery.integration_connections where id = $2::uuid`,
      [earlier, connectionId],
    );
    f.github.failures.tokenListingScripts.set(installation.id, "forbidden");
    const outcome = await unsuspend(f, connectionId, installation.id);
    assert(outcome.kind === "transitioned");
    assertEquals(outcome.revalidated, 1);
    const revalidated = await connectionState(f, connectionId);
    assertEquals(revalidated.health, "degraded");
    // Revalidation runs with no Admin, so it queues nothing and stores no
    // problem code, leaving the loss for a check to record with its
    // discovery.
    assertEquals(revalidated.lastProblemCode, null);
    // Not even over a code an earlier incomplete probe left behind.
    await f.pgDatabase.query(
      `update bakery.integration_connections
          set last_problem_code = 'dependency_unavailable' where id = $1`,
      [connectionId],
    );
    assertEquals(
      await revalidateConnection(
        {
          database: f.runtimePgDatabase!,
          github: f.github.client,
          secretsKey: f.secretsKey,
          broker: f.broker,
        },
        connectionId,
        new AbortController().signal,
      ),
      true,
    );
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      null,
    );
    assertEquals(
      (await discoveries(f, connectionId)).map((row) => row.id),
      [earlier],
    );
    await ok(await postCheck(f, connectionId));
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      "permission_lost",
    );
    const rows = await discoveries(f, connectionId);
    assertEquals(rows.map((row) => [row.id === earlier, row.status]), [
      [true, "completed"],
      [false, "queued"],
    ]);
    assertEquals(await discoveryEvents(f, connectionId), 1);
    assertEquals(await auditedDiscovery(f, connectionId), true);
    // The loss is now requested: the next check queues nothing more, and
    // its audit says so.
    await ok(await postCheck(f, connectionId));
    assertEquals((await discoveries(f, connectionId)).length, 2);
    assertEquals(await auditedDiscovery(f, connectionId), false);
  });
});

Deno.test("an unsuspend revalidation GitHub rate limits records only the wait, and the sweep skips the connection until it ends", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.failures.tokenListingScripts.set(installation.id, "quota");
    const outcome = await unsuspend(f, connectionId, installation.id);
    assert(outcome.kind === "transitioned");
    assertEquals(outcome.revalidated, 0);
    const state = await connectionState(f, connectionId);
    assertEquals(state.health, "unknown");
    assertEquals(state.lastProblemCode, null);
    assert(state.nextAllowedAt !== null);
    const wait = (state.nextAllowedAt.getTime() - Date.now()) / 1000;
    assert(wait > 20 && wait <= 30, `${wait}`);
    // Due by interval, but inside GitHub's window: not swept.
    assert(
      !(await connectionsAwaitingRevalidation(f.runtimePgDatabase!, 1000, 0))
        .includes(connectionId),
    );
    await clearQuota(f, connectionId);
    assert(
      (await connectionsAwaitingRevalidation(f.runtimePgDatabase!, 1000, 0))
        .includes(connectionId),
    );
  });
});
