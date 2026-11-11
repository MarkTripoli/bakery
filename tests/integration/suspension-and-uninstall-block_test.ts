import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  connectionFlow,
  count,
  enabledConnection,
  type GitHubAppFixture,
  githubCallback,
  githubSetup,
  openGitHubAppFixture,
  patchConnection,
  patchResource,
  pendingConnection,
  postCheck,
  postDiscovery,
  readInstallations,
  secondOrganization,
} from "../helpers/github-app-registration.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";
import {
  connectionsAwaitingRevalidation,
  dueInstallations,
  revalidateConnection,
} from "../../apps/server/src/modules/integrations/reconcile.ts";
import {
  fanOutConnections,
  InstallationStatus,
} from "../../apps/server/src/modules/integrations/installation-fan-out.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { createIntegrationLifecycleSweep } from "../../apps/server/src/modules/integrations/lifecycle-workflow.ts";
import type { Inngest } from "inngest";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
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
  lastProblemCode: string | null;
};

async function connectionState(
  f: GitHubAppFixture,
  connectionId: string,
): Promise<ConnectionState> {
  return (await f.pgDatabase.query<ConnectionState>(
    `select status, health, version, last_problem_code as "lastProblemCode"
       from bakery.integration_connections where id = $1`,
    [connectionId],
  )).rows[0];
}

/** The installation row a connection is bound to. */
async function installationOf(
  f: GitHubAppFixture,
  connectionId: string,
): Promise<{ id: string; status: string; version: number }> {
  return (await f.pgDatabase.query<
    { id: string; status: string; version: number }
  >(
    `select installation.id, installation.status, installation.version
       from bakery.integration_installations as installation
       join bakery.integration_connections as connection
         on connection.installation_id = installation.id
      where connection.id = $1`,
    [connectionId],
  )).rows[0];
}

/** Every resource row of every organization, for no-change assertions. */
async function resourceSnapshot(f: GitHubAppFixture) {
  return (await f.pgDatabase.query(
    `select id, organization_id, connection_id, selected, available,
       archived_at, version
       from bakery.integration_resources order by id`,
  )).rows;
}

async function problem(response: Response, status: number, code: string) {
  const body = await response.text();
  assertEquals(response.status, status, body);
  const parsed = JSON.parse(body);
  assertEquals(parsed.code, code, body);
  return parsed as { code: string; reason?: string };
}

async function healthy(response: Response) {
  const body = await response.text();
  assertEquals(response.status, 200, body);
  assertEquals(JSON.parse(body).healthy, true, body);
}

function events(f: GitHubAppFixture, connectionId: string, type: string) {
  return count(
    f,
    `select count(*) from bakery.domain_events
      where event_type = $1 and aggregate_id = $2`,
    [type, connectionId],
  );
}

/**
 * The fixture organization's enabled connection plus a second organization's
 * connection on the same installation, selecting a different repository
 * and enabled unless `secondEnabled` is false.
 */
async function sharedInstallation(
  f: GitHubAppFixture,
  options: { secondEnabled?: boolean } = {},
) {
  const first = await enabledConnection(f, {
    repositories: fakeRepositories(3, ["admin"]),
  });
  const secondId = await secondOrganization(f);
  const second = await pendingConnection(f, {
    app: first.app,
    existing: first.installation,
    attempt: { organizationId: secondId },
  });
  const other = second.resources.find((row) =>
    row.external_id !== first.selected[0].external_id
  )!;
  const selected = await patchResource(
    f,
    second.connectionId,
    other.id,
    { selected: true },
    { organizationId: secondId },
  );
  assertEquals(selected.status, 200, await selected.text());
  if (options.secondEnabled !== false) {
    const enabled = await patchConnection(f, second.connectionId, {
      enabled: true,
    }, { organizationId: secondId });
    assertEquals(enabled.status, 200, await enabled.text());
  }
  f.github.calls.length = 0;
  f.github.tokenRequests.length = 0;
  return { first, second, secondId };
}

Deno.test("AC1: WHEN reconciliation observes the installation suspended, the server marks it suspended and refuses token minting for every connection on it", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId } = await sharedInstallation(f);
    // A cached token exists for the first connection before the suspension.
    await healthy(await postCheck(f, first.connectionId));
    assertEquals(f.github.tokenRequests.length, 1);
    const installation = await installationOf(f, first.connectionId);
    const before = {
      first: await connectionState(f, first.connectionId),
      second: await connectionState(f, second.connectionId),
    };
    const healthEvents = {
      first: await events(f, first.connectionId, "integration.health_changed"),
      second: await events(
        f,
        second.connectionId,
        "integration.health_changed",
      ),
    };
    f.github.setInstallationState(first.installation.id, "suspended");

    const outcome = await f.reconcile(installation.id);
    assertEquals(outcome, {
      kind: "transitioned",
      from: "enabled",
      to: "suspended",
      connections: 2,
      revalidated: 0,
    });
    const after = await installationOf(f, first.connectionId);
    assertEquals(after.status, "suspended");
    assertEquals(after.version, installation.version + 1);
    for (
      const [id, prior, priorEvents] of [
        [first.connectionId, before.first, healthEvents.first],
        [second.connectionId, before.second, healthEvents.second],
      ] as const
    ) {
      const state = await connectionState(f, id);
      assertEquals(state.status, "enabled", "suspension is not a disable");
      assertEquals(state.health, "degraded");
      assertEquals(state.lastProblemCode, "installation_suspended");
      assertEquals(state.version, prior.version + 1);
      assertEquals(
        await events(f, id, "integration.health_changed"),
        priorEvents + 1,
      );
    }

    // Every connection on the installation is refused before any mint, the
    // cached token included.
    f.github.calls.length = 0;
    const own = await problem(
      await postCheck(f, first.connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(own.reason, "installation_unavailable");
    const other = await problem(
      await postCheck(f, second.connectionId, { organizationId: secondId }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(other.reason, "installation_unavailable");
    assertEquals(f.github.calls.length, 0, "no token request reached GitHub");
    assertEquals(f.github.tokenRequests.length, 1);
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationInstallations.reconcile'
            and resource_id = any($1::text[])`,
        [[installation.id, first.connectionId, second.connectionId]],
      ),
      3,
      "one installation row and one per affected connection",
    );
  });
});

Deno.test("AC2: WHEN reconciliation observes the installation unsuspended, the server revalidates its connections and leaves each Admin-disabled connection disabled", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId } = await sharedInstallation(f);
    const disabled = await patchConnection(f, second.connectionId, {
      enabled: false,
    }, { organizationId: secondId });
    assertEquals(disabled.status, 200, await disabled.text());
    await healthy(await postCheck(f, first.connectionId));
    const installation = await installationOf(f, first.connectionId);
    f.github.setInstallationState(first.installation.id, "suspended");
    assertEquals((await f.reconcile(installation.id)).kind, "transitioned");
    f.github.setInstallationState(first.installation.id, "active");
    f.github.tokenRequests.length = 0;
    f.github.calls.length = 0;
    const eventsBefore = await events(
      f,
      first.connectionId,
      "integration.health_changed",
    );

    const outcome = await f.reconcile(installation.id);
    assertEquals(outcome, {
      kind: "transitioned",
      from: "suspended",
      to: "enabled",
      connections: 2,
      revalidated: 1,
    });
    assertEquals(
      (await installationOf(f, first.connectionId)).status,
      "enabled",
    );
    // Revalidation ran: the enabled connection was probed with a fresh token
    // narrowed to its selection (the one cached before the suspension was
    // dropped) and recorded healthy.
    assertEquals(f.github.tokenRequests.length, 1, "one fresh mint");
    assertEquals(f.github.tokenRequests[0].repositoryIds, [
      Number(first.selected[0].external_id),
    ]);
    assertEquals(f.github.tokenListings().length, 1, "the probe listed");
    const enabledState = await connectionState(f, first.connectionId);
    assertEquals(enabledState.status, "enabled");
    assertEquals(enabledState.health, "healthy");
    assertEquals(enabledState.lastProblemCode, null);
    assertEquals(
      await events(f, first.connectionId, "integration.health_changed"),
      eventsBefore + 2,
      "degraded to unknown on the unsuspend, unknown to healthy on the probe",
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationConnections.revalidate'
            and resource_id = $1`,
        [first.connectionId],
      ),
      1,
    );
    // The Admin-disabled connection stays disabled and is not probed.
    const disabledState = await connectionState(f, second.connectionId);
    assertEquals(disabledState.status, "disabled", "never re-enabled");
    assertEquals(disabledState.health, "unknown");
    const refused = await problem(
      await postCheck(f, second.connectionId, { organizationId: secondId }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(refused.reason, "connection_disabled");
    await healthy(await postCheck(f, first.connectionId));
  });
});

Deno.test("an unsuspend whose revalidation probe fails leaves health unknown for the next check", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const installation = await installationOf(f, connectionId);
    f.github.setInstallationState(fake.id, "suspended");
    await f.reconcile(installation.id);
    f.github.setInstallationState(fake.id, "active");
    f.github.failures.tokenListing.add(fake.id);
    const outcome = await f.reconcile(installation.id);
    assert(outcome.kind === "transitioned");
    assertEquals(outcome.revalidated, 0);
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "enabled");
    assertEquals(state.health, "unknown");
    // The sweep finds it and probes again once GitHub answers.
    f.github.failures.tokenListing.delete(fake.id);
    assertEquals(state.lastProblemCode, "dependency_unavailable");
    // Just probed: not due again within the interval, so a failing
    // connection yields the sweep's batch to others.
    assert(
      !(await connectionsAwaitingRevalidation(f.runtimePgDatabase!, 1000))
        .includes(connectionId),
    );
    const awaiting = await connectionsAwaitingRevalidation(
      f.runtimePgDatabase!,
      1000,
      0,
    );
    assert(awaiting.includes(connectionId));
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
    assertEquals((await connectionState(f, connectionId)).health, "healthy");
  });
});

Deno.test("a setup that finds a suspended installation active again clears its connections' suspension and leaves them for revalidation", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake, app } = await enabledConnection(
      f,
    );
    const installation = await installationOf(f, connectionId);
    f.github.setInstallationState(fake.id, "suspended");
    await f.reconcile(installation.id);
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      "installation_suspended",
    );
    f.github.setInstallationState(fake.id, "active");
    // Another organization connects the same installation before any
    // reconcile observes the unsuspend; setup re-enables the row.
    const before = await connectionState(f, connectionId);
    const secondId = await secondOrganization(f);
    await pendingConnection(f, {
      app,
      existing: fake,
      attempt: { organizationId: secondId },
    });
    assertEquals((await installationOf(f, connectionId)).status, "enabled");
    const after = await connectionState(f, connectionId);
    assertEquals(after.status, "enabled");
    assertEquals(after.health, "unknown");
    assertEquals(after.lastProblemCode, null);
    assertEquals(after.version, before.version + 1);
    // Audited as the setup that caused it. Only the acting organization's
    // installation row names its Admin; the first organization's
    // connection row names no other organization's principal.
    const audited = (await f.pgDatabase.query<
      {
        resourceId: string;
        organizationId: string;
        operation: string;
        principalId: string | null;
      }
    >(
      `select resource_id as "resourceId",
         organization_id as "organizationId", operation,
         principal_id as "principalId"
         from bakery.audit_events
        where resource_id = any($1::text[])
          and details -> 'installation' ->> 'to' = 'enabled'`,
      [[connectionId, installation.id]],
    )).rows;
    assertEquals(audited.length, 2, "one per connection and installation");
    const onConnection = audited.find((row) =>
      row.resourceId === connectionId
    )!;
    assertEquals(onConnection.organizationId, f.organizationId);
    assertEquals(onConnection.principalId, null);
    assert(onConnection.operation !== "integrationInstallations.reconcile");
    const onInstallation = audited.find((row) =>
      row.resourceId === installation.id
    )!;
    assertEquals(onInstallation.organizationId, secondId);
    assert(onInstallation.principalId !== null);
    // Nothing is left for a reconcile; the sweep revalidates it.
    assertEquals((await f.reconcile(installation.id)).kind, "unchanged");
    assert(
      (await connectionsAwaitingRevalidation(f.runtimePgDatabase!, 1000))
        .includes(connectionId),
    );
  });
});

Deno.test("a fan-out names its actor only on audit rows of the actor's own organization", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId } = await sharedInstallation(f);
    const installation = await installationOf(f, first.connectionId);
    f.github.setInstallationState(first.installation.id, "suspended");
    await f.reconcile(installation.id);
    const principalId = (await f.pgDatabase.query<{ id: string }>(
      `select initiating_principal_id as id
         from bakery.integration_auth_attempts
        where organization_id = $1 limit 1`,
      [f.organizationId],
    )).rows[0].id;
    const traceId = crypto.randomUUID();
    const moved = await withPgTransaction(
      f.runtimePgDatabase!,
      async (transaction) => {
        await transaction.query(
          `select id from bakery.integration_installations
            where id = $1 for update`,
          [installation.id],
        );
        return await fanOutConnections(
          transaction,
          installation.id,
          InstallationStatus.Suspended,
          InstallationStatus.Enabled,
          traceId,
          {
            operation: "integrationAuth.githubCallback",
            actor: { organizationId: f.organizationId, principalId },
          },
        );
      },
    );
    assertEquals(moved, 2);
    const audited = new Map(
      (await f.pgDatabase.query<
        { resourceId: string; operation: string; principalId: string | null }
      >(
        `select resource_id as "resourceId", operation,
           principal_id as "principalId"
           from bakery.audit_events where trace_id = $1`,
        [traceId],
      )).rows.map((row) => [row.resourceId, row]),
    );
    assertEquals(audited.get(first.connectionId)?.principalId, principalId);
    assertEquals(
      audited.get(first.connectionId)?.operation,
      "integrationAuth.githubCallback",
    );
    assertEquals(audited.get(second.connectionId)?.principalId, null);
    assert(secondId !== f.organizationId);
  });
});

Deno.test("AC3: WHEN reconciliation observes the installation deleted, the server sets each affected connection to revoked and releases no organization's selections", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId } = await sharedInstallation(f);
    // A connection of the first organization on another installation is
    // not affected.
    const unrelated = await enabledConnection(f, { app: first.app });
    const installation = await installationOf(f, first.connectionId);
    const unrelatedBefore = await connectionState(f, unrelated.connectionId);
    const resourcesBefore = await resourceSnapshot(f);
    f.github.setInstallationState(first.installation.id, "deleted");

    const outcome = await f.reconcile(installation.id);
    assertEquals(outcome, {
      kind: "transitioned",
      from: "enabled",
      to: "revoked",
      connections: 2,
      revalidated: 0,
    });
    assertEquals(
      (await installationOf(f, first.connectionId)).status,
      "revoked",
    );
    for (const id of [first.connectionId, second.connectionId]) {
      const state = await connectionState(f, id);
      assertEquals(state.status, "revoked");
      assertEquals(state.lastProblemCode, "installation_revoked");
      assertEquals(
        await events(f, id, "integrationConnections.updated") >= 1,
        true,
      );
    }
    assertEquals(
      await resourceSnapshot(f),
      resourcesBefore,
      "no selection or availability of any organization moved",
    );
    assertEquals(
      await connectionState(f, unrelated.connectionId),
      unrelatedBefore,
    );
    const revoked = await problem(
      await postCheck(f, second.connectionId, { organizationId: secondId }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(revoked.reason, "connection_revoked");

    // Revoked is terminal: a later reconcile changes nothing.
    const again = await f.reconcile(installation.id);
    assertEquals(again, { kind: "unchanged", status: "revoked" });
  });
});

Deno.test("a setup never brings a revoked installation row back", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake, app } = await enabledConnection(
      f,
    );
    const installation = await installationOf(f, connectionId);
    f.github.setInstallationState(fake.id, "deleted");
    assertEquals((await f.reconcile(installation.id)).kind, "transitioned");
    // SYNTHETIC: GitHub answers the revoked id as active again, which it
    // never does for a deleted installation.
    f.github.setInstallationState(fake.id, "active");
    const flow = await connectionFlow(f, {
      app,
      existing: [fake],
      attempt: { organizationId: await secondOrganization(f) },
    });
    const setup = await githubSetup(f, {
      installation_id: String(fake.id),
      setup_action: "install",
      state: flow.state,
    });
    await setup.body?.cancel();
    const bound = await githubCallback(f, {
      code: flow.code,
      state: flow.state,
    });
    assertEquals(bound.status, 303, await bound.clone().text());
    await bound.body?.cancel();
    const location = new URL(bound.headers.get("location")!, "http://x");
    assertEquals(
      location.searchParams.get("githubConnection"),
      "installation_unverified",
    );
    const after = await installationOf(f, connectionId);
    assertEquals(after.status, "revoked");
    assertEquals(after.version, installation.version + 1, "only the revoke");
    assertEquals((await connectionState(f, connectionId)).status, "revoked");
  });
});

Deno.test("reconciliation with no state change only stamps last_checked_at", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const installation = await installationOf(f, connectionId);
    const before = await connectionState(f, connectionId);
    assertEquals(await f.reconcile(installation.id), {
      kind: "unchanged",
      status: "enabled",
    });
    const after = await installationOf(f, connectionId);
    assertEquals(after.version, installation.version);
    assertEquals(await connectionState(f, connectionId), before);
    const stamped = await count(
      f,
      `select count(*) from bakery.integration_installations
        where id = $1 and last_checked_at is not null`,
      [installation.id],
    );
    assertEquals(stamped, 1);
  });
});

Deno.test("a provider failure reading the installation transitions nothing", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const installation = await installationOf(f, connectionId);
    f.github.setInstallationState(fake.id, "suspended");
    f.github.failures.installationReads.add(fake.id);
    const error = await assertRejects(() => f.reconcile(installation.id));
    assert(error instanceof StandardError);
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(await installationOf(f, connectionId), installation);
    assertEquals((await connectionState(f, connectionId)).health, "unknown");
  });
});

type DiscoveryRow = {
  status: string;
  outcome_code: string | null;
  listed_count: number | null;
  unavailable_count: number | null;
  not_before: Date;
  requested_by: string;
};

async function discoveryRow(f: GitHubAppFixture, id: string) {
  return (await f.pgDatabase.query<DiscoveryRow>(
    `select status, outcome_code, listed_count, unavailable_count,
       not_before, requested_by
       from bakery.integration_discoveries where id = $1`,
    [id],
  )).rows[0];
}

type InstallationPage = {
  items: {
    id: string;
    status: string;
    enabledConnectionCount?: number;
  }[];
  nextCursor: string | null;
};

/** A validated installation page. */
async function installationPage(response: Response): Promise<InstallationPage> {
  const body = await response.text();
  assertEquals(response.status, 200, body);
  const parsed = JSON.parse(body);
  contractSchemas["Page<IntegrationInstallation>"].parse(parsed);
  return parsed as InstallationPage;
}

async function accepted(response: Response): Promise<string> {
  const body = await response.text();
  assertEquals(response.status, 202, body);
  const parsed = JSON.parse(body);
  assertEquals(Object.keys(parsed).sort(), ["discoveryId", "status"]);
  assertEquals(parsed.status, "queued");
  return parsed.discoveryId as string;
}

/** Availability of each of the connection's repositories, by external id. */
async function availability(f: GitHubAppFixture, connectionId: string) {
  const rows = (await f.pgDatabase.query<
    { external_id: string; available: boolean }
  >(
    `select external_id, available from bakery.integration_resources
      where connection_id = $1 order by external_id`,
    [connectionId],
  )).rows;
  return Object.fromEntries(
    rows.map((row) => [row.external_id, row.available]),
  );
}

Deno.test("AC4: WHEN an Admin calls integrationDiscoveries.create, the server returns 202 and schedules one bounded discovery", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const discoveryId = await accepted(await postDiscovery(f, connectionId));
    const row = await discoveryRow(f, discoveryId);
    assertEquals(row.status, "queued");
    assertEquals(row.requested_by, f.adminId);
    assertEquals(f.github.calls.length, 0, "the request calls no provider");
    // The outbox carries integration.discovery_requested to the function.
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.domain_events as event
           join bakery.outbox as outbox on outbox.event_id = event.id
          where event.event_type = 'integration.discovery_requested'
            and event.aggregate_id::text = $1 and outbox.destination = 'inngest'
            and event.payload ->> 'resourceId' = $1`,
        [discoveryId],
      ),
      1,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationDiscoveries.create'
            and resource_id = $1`,
        [discoveryId],
      ),
      1,
    );
    // Bounded: a second request while the first is queued answers it.
    assertEquals(
      await accepted(await postDiscovery(f, connectionId)),
      discoveryId,
    );
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_discoveries where connection_id = $1",
        [connectionId],
      ),
      1,
    );
  });
});

Deno.test("AC4: a complete successful scan marks unlisted resources unavailable and listed ones available", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, resources } = await enabledConnection(
      f,
      { repositories: fakeRepositories(3, ["admin"]) },
    );
    const [kept, removed] = [resources[0], resources[1]];
    const fake = installation.repositories;
    fake.splice(
      fake.findIndex((repository) =>
        String(repository.id) === removed.external_id
      ),
      1,
    );
    const discoveryId = await accepted(await postDiscovery(f, connectionId));
    const revoked = f.github.revokedTokens.length;
    const result = await f.discover(discoveryId);
    assertEquals(result, {
      kind: "finished",
      status: "completed",
      outcome: null,
      unavailable: 1,
      restored: 0,
    });
    const after = await availability(f, connectionId);
    assertEquals(after[removed.external_id], false);
    assertEquals(after[kept.external_id], true);
    const row = await discoveryRow(f, discoveryId);
    assertEquals(row.status, "completed");
    assertEquals(row.unavailable_count, 1);
    assertEquals(row.listed_count, 2);
    // The scan token was unnarrowed metadata read and revoked afterwards.
    const scanToken = f.github.tokenRequests.at(-1)!;
    assertEquals(scanToken.permissions, { metadata: "read" });
    assertEquals(f.github.revokedTokens.length, revoked + 1);
    // A later complete scan that lists it again restores it.
    fake.push({
      ...installation.repositories[0],
      id: Number(removed.external_id),
    });
    const again = await accepted(await postDiscovery(f, connectionId));
    assert(again !== discoveryId, "a finished discovery admits a new one");
    await f.pgDatabase.query(
      "update bakery.integration_discoveries set not_before = now() where id = $1",
      [again],
    );
    const restored = await f.discover(again);
    assert(restored.kind === "finished");
    assertEquals(restored.restored, 1);
    assertEquals(
      (await availability(f, connectionId))[removed.external_id],
      true,
    );
  });
});

Deno.test("AC4: a scan rate limited midway marks nothing unavailable", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f, {
      repositories: fakeRepositories(3, ["admin"]),
    });
    const before = await availability(f, connectionId);
    // Page one answers; page two is rate limited, and one repository is gone.
    f.github.repositoryListing.pageSize = 1;
    f.github.failures.listingFailsAt.set(installation.id, {
      page: 2,
      status: 429,
    });
    installation.repositories.pop();
    const discoveryId = await accepted(await postDiscovery(f, connectionId));
    const revoked = f.github.revokedTokens.length;
    const result = await f.discover(discoveryId);
    assertEquals(result, {
      kind: "finished",
      status: "partial",
      outcome: "scan_incomplete",
      unavailable: 0,
      restored: 0,
    });
    assertEquals(await availability(f, connectionId), before);
    assertEquals((await discoveryRow(f, discoveryId)).status, "partial");
    assertEquals(
      f.github.revokedTokens.length,
      revoked + 1,
      "the scan token revoked",
    );
  });
});

Deno.test("AC4: discoveries of one installation are paced in Postgres across connections", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId } = await sharedInstallation(f);
    const one = await accepted(await postDiscovery(f, first.connectionId));
    const two = await accepted(
      await postDiscovery(f, second.connectionId, { organizationId: secondId }),
    );
    const [a, b] = [await discoveryRow(f, one), await discoveryRow(f, two)];
    assert(
      b.not_before.getTime() - a.not_before.getTime() >= 30_000,
      "the second scan waits for the first's pacing window",
    );
    const waiting = await f.discover(two);
    assertEquals(waiting.kind, "waiting");
    assertEquals((await discoveryRow(f, two)).status, "queued");
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("AC4: discovery refuses a disabled connection, a suspended installation, a Developer and another organization", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    const developer = await problem(
      await postDiscovery(f, connectionId, { cookie: f.developerCookie }),
      403,
      "AUTH_FORBIDDEN",
    );
    assertEquals(developer.code, "AUTH_FORBIDDEN");
    const secondId = await secondOrganization(f);
    await problem(
      await postDiscovery(f, connectionId, { organizationId: secondId }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await problem(
      await postDiscovery(f, connectionId, { key: null }),
      428,
      "PRECONDITION_REQUIRED",
    );
    f.github.setInstallationState(installation.id, "suspended");
    await f.reconcile(
      await installationOf(f, connectionId).then((row) => row.id),
    );
    const suspended = await problem(
      await postDiscovery(f, connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(suspended.reason, "installation_unavailable");
    const disabled = await patchConnection(f, connectionId, { enabled: false });
    assertEquals(disabled.status, 200, await disabled.text());
    const refused = await problem(
      await postDiscovery(f, connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(refused.reason, "connection_disabled");
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_discoveries where connection_id = $1",
        [connectionId],
      ),
      0,
    );
  });
});

Deno.test("AC5: WHEN an installation administrator calls integrationInstallations.list or .get, the server returns safe identity, lifecycle and aggregate impact", async () => {
  await withFixture(async (f) => {
    const { first } = await sharedInstallation(f, { secondEnabled: false });
    const installation = await installationOf(f, first.connectionId);
    const response = await readInstallations(f, { id: installation.id });
    const body = await response.text();
    assertEquals(response.status, 200, body);
    const read = contractSchemas.IntegrationInstallation.parse(
      JSON.parse(body),
    );
    assertEquals(read.id, installation.id);
    assertEquals(read.status, "enabled");
    assertEquals(read.version, installation.version);
    assertEquals(read.externalAuthorizationId, String(first.installation.id));
    assertEquals(
      read.externalAccountId,
      String(first.installation.account.id),
    );
    assertEquals(read.providerId, "a1fbffc0-eeec-541c-b2a1-93179931917e");
    // Aggregate impact across both organizations, as counts only.
    assertEquals(read.connectionCount, 2);
    assertEquals(read.enabledConnectionCount, 1);
    assertEquals(read.organizationCount, 2);
    assertEquals(
      Object.keys(JSON.parse(body)).sort(),
      [
        "authorizationRevision",
        "connectionCount",
        "createdAt",
        "enabledConnectionCount",
        "externalAccountId",
        "externalAuthorizationId",
        "grantedPermissions",
        "id",
        "lastCheckedAt",
        "organizationCount",
        "providerId",
        "providerRegistrationId",
        "status",
        "updatedAt",
        "version",
      ],
    );

    // The list carries the same projection; the status filter and the
    // lifecycle follow reconciliation.
    f.github.setInstallationState(first.installation.id, "suspended");
    await f.reconcile(installation.id);
    const page = await installationPage(
      await readInstallations(f, { query: "?status=suspended" }),
    );
    const listed = page.items.find((item) => item.id === installation.id);
    assert(listed !== undefined, "the suspended installation is listed");
    assertEquals(listed.status, "suspended");
    assertEquals(listed.enabledConnectionCount, 1);
    const enabledPage = await installationPage(
      await readInstallations(f, { query: "?status=enabled" }),
    );
    assert(!enabledPage.items.some((item) => item.id === installation.id));
  });
});

Deno.test("AC5: installation pages are keyset cursors bound to the caller and filters", async () => {
  await withFixture(async (f) => {
    // Two installations of the registered App.
    const first = await enabledConnection(f);
    await pendingConnection(f, { app: first.app });
    const firstPage = await installationPage(
      await readInstallations(f, { query: "?limit=1" }),
    );
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor !== null);
    const next = await installationPage(
      await readInstallations(f, {
        query: `?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      }),
    );
    assertEquals(next.items.length, 1);
    assert(next.items[0].id !== firstPage.items[0].id);
    // A cursor replayed under other filters is refused.
    await problem(
      await readInstallations(f, {
        query: `?limit=1&status=revoked&cursor=${
          encodeURIComponent(firstPage.nextCursor)
        }`,
      }),
      400,
      "INVALID_CURSOR",
    );
    // Every installation is GitHub's: its provider id lists them, another
    // provider id lists none.
    const github = await installationPage(
      await readInstallations(f, {
        query: "?providerId=a1fbffc0-eeec-541c-b2a1-93179931917e",
      }),
    );
    assert(github.items.length >= 2);
    const none = await installationPage(
      await readInstallations(f, {
        query: `?providerId=${crypto.randomUUID()}`,
      }),
    );
    assertEquals(none, { items: [], nextCursor: null });
    await problem(
      await readInstallations(f, { id: crypto.randomUUID() }),
      404,
      "RESOURCE_NOT_FOUND",
    );
  });
});

/** Captures one Inngest function and runs its handler with an inline step. */
function capture(): {
  client: Inngest;
  run: () => Promise<unknown>;
  config: () => Record<string, unknown>;
} {
  let handler:
    | ((context: { step: unknown }) => Promise<unknown>)
    | undefined;
  let config: Record<string, unknown> = {};
  const client = {
    createFunction(options: Record<string, unknown>, run: typeof handler) {
      config = options;
      handler = run;
      return {};
    },
  } as unknown as Inngest;
  return {
    client,
    config: () => config,
    run: () =>
      handler!({
        step: {
          run: async <T>(_id: string, work: () => Promise<T>) => await work(),
        },
      }),
  };
}

Deno.test("the lifecycle sweep reconciles due installations through the API's broker", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    await healthy(await postCheck(f, connectionId));
    f.github.setInstallationState(fake.id, "suspended");
    const sweep = capture();
    createIntegrationLifecycleSweep({
      client: sweep.client,
      database: f.runtimePgDatabase!,
      github: f.github.client,
      secretsKey: f.secretsKey,
      broker: f.broker,
    });
    assertEquals(sweep.config().triggers, [
      { cron: "*/5 * * * *" },
      { event: "bakery/integration-installations.reconcile.v1" },
    ]);
    const generation = f.broker.generation(connectionId);
    const result = await sweep.run() as {
      outcomes: Record<string, number>;
    };
    assert((result.outcomes.transitioned ?? 0) >= 1);
    assertEquals((await installationOf(f, connectionId)).status, "suspended");
    assert(
      f.broker.generation(connectionId) > generation,
      "the sweep invalidated the token cache the API uses",
    );
  });
});

Deno.test("an installation whose reconcile keeps failing yields the sweep's batch", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const row = await installationOf(f, connectionId);
    f.github.failures.installationReads.add(fake.id);
    await assertRejects(() => f.reconcile(row.id));
    const due = await dueInstallations(f.runtimePgDatabase!, 10_000);
    assert(!due.includes(row.id), "attempted just now: not due again yet");
    assert(
      (await dueInstallations(f.runtimePgDatabase!, 10_000, 0)).includes(
        row.id,
      ),
    );
  });
});
