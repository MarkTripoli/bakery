import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { Inngest } from "inngest";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import type { GitHubAppClient } from "../../../apps/server/src/modules/integrations/github-app.ts";
import {
  authorityVerdict,
  RouteOutcomeCode,
} from "../../../apps/server/src/modules/integrations/fact-reads.ts";
import {
  createIntegrationIntakeRecovery,
  createIntegrationIntakeWorkflow,
  dueRoutes,
  MAX_ROUTE_ATTEMPTS,
  processRoute,
  retryDelaySeconds,
  type RouteAuthority,
} from "../../../apps/server/src/modules/integrations/intake-workflow.ts";
import { registerPullRequest } from "../../../apps/server/src/modules/integrations/pull-requests.ts";
import type { ReconcileDependencies } from "../../../apps/server/src/modules/integrations/reconcile.ts";
import { fakeTimestamp } from "../fake-github-app.ts";
import type { GitHubAppFixture } from "../github-app-registration.ts";
import { removeSeed, seedTaskAndRepository } from "./seed.ts";
import {
  checkRunPayload,
  checkSuitePayload,
  enabledReceiver,
  installationPayload,
  issuesPayload,
  pullRequestPayload,
  receipt,
  type Receiver,
  type RouteRow,
  routeRows,
  selectAndEnable,
  type SendOptions,
  SHA_A,
  SHA_B,
  SHA_C,
  sharedSecondConnection,
  withFixture,
} from "./receipts-shared.ts";

/** Issue 71 route processor: claims, rechecked authority, fresh reads, finite retries. */

const T1 = "2026-10-30T10:00:00Z";
const T2 = "2026-10-30T11:00:00Z";
const T3 = "2026-10-30T12:00:00Z";
const CANARY = "processor-canary-text-91d2";

function dependenciesOf(
  f: GitHubAppFixture,
  github: GitHubAppClient = f.github.client,
): ReconcileDependencies {
  return {
    database: f.runtimePgDatabase!,
    github,
    secretsKey: f.secretsKey,
    broker: f.broker,
  };
}

function run(
  f: GitHubAppFixture,
  routeId: string,
  github?: GitHubAppClient,
  signal: AbortSignal = new AbortController().signal,
) {
  return processRoute(dependenciesOf(f, github), routeId, signal);
}

/** Sends a delivery and returns the one route it created. */
async function routed(r: Receiver, options: SendOptions): Promise<RouteRow> {
  const acknowledged = await receipt(r, options);
  assertEquals(acknowledged.status, "accepted");
  const routes = await routeRows(r.f, acknowledged.eventId);
  assertEquals(routes.length, 1);
  return routes[0];
}

async function routeState(f: GitHubAppFixture, id: string): Promise<RouteRow> {
  return (await routeRows(f)).find((route) => route.id === id)!;
}

type FactRow = {
  organization_id: string;
  resource_id: string;
  kind: string;
  external_id: string;
  number: number | null;
  head_sha: string | null;
  state: string;
  conclusion: string | null;
  provider_updated_at: Date;
  observed_started_at: Date;
  version: number;
  summary: Record<string, unknown>;
};

async function factRows(f: GitHubAppFixture): Promise<FactRow[]> {
  return (await f.pgDatabase.query<FactRow>(
    "select * from bakery.integration_remote_facts order by kind, external_id",
  )).rows;
}

type DiscoveryRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  requested_by: string;
  status: string;
};

async function discoveryRows(f: GitHubAppFixture): Promise<DiscoveryRow[]> {
  return (await f.pgDatabase.query<DiscoveryRow>(
    "select * from bakery.integration_discoveries order by created_at, id",
  )).rows;
}

async function creatorOf(
  f: GitHubAppFixture,
  connectionId: string,
): Promise<string> {
  return (await f.pgDatabase.query<{ created_by: string }>(
    "select created_by from bakery.integration_connections where id = $1",
    [connectionId],
  )).rows[0].created_by;
}

/** Makes a deferred route due again, as time passing would. */
async function makeDue(f: GitHubAppFixture, routeId: string): Promise<void> {
  await f.pgDatabase.query(
    `update bakery.inbound_event_routes
        set not_before = now() - interval '1 second' where id = $1`,
    [routeId],
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `condition` holds; a processor that never reaches it fails the test. */
async function waitUntil(
  condition: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The trace id one domain event of an aggregate carries. */
async function traceOf(
  f: GitHubAppFixture,
  aggregateId: string,
  eventType: string,
): Promise<string | null> {
  const found = await f.pgDatabase.query<{ trace_id: string | null }>(
    "select trace_id from bakery.domain_events where aggregate_id = $1 and event_type = $2",
    [aggregateId, eventType],
  );
  assertEquals(found.rows.length, 1, `${eventType} of ${aggregateId}`);
  return found.rows[0].trace_id;
}

/** A client whose reads first run `before`, as events during a slow provider call would. */
function disturbed(
  f: GitHubAppFixture,
  before: (method: string) => Promise<void>,
): GitHubAppClient {
  const client = f.github.client;
  return {
    ...client,
    readIssue: async (request, signal) => {
      await before("readIssue");
      return await client.readIssue(request, signal);
    },
    readPullRequest: async (request, signal) => {
      await before("readPullRequest");
      return await client.readPullRequest(request, signal);
    },
    listCheckRuns: async (request, signal) => {
      await before("listCheckRuns");
      return await client.listCheckRuns(request, signal);
    },
    readRepositoryIdentity: async (request, signal) => {
      await before("readRepositoryIdentity");
      return await client.readRepositoryIdentity(request, signal);
    },
  };
}

/** Runs `change` before the first read only, whichever read that is. */
function once(
  change: () => Promise<unknown>,
): (method: string) => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await change();
  };
}

/** Runs `change` before the first `method` read only. */
function onceAt(
  method: string,
  change: () => Promise<unknown>,
): (method: string) => Promise<void> {
  let done = false;
  return async (read) => {
    if (done || read !== method) return;
    done = true;
    await change();
  };
}

/** A pool whose `failOn`-th connection attempt fails, as a dropped database connection would. */
function flakyDatabase(pool: PgDatabase, failOn: number): PgDatabase {
  let attempts = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return (...args: unknown[]) => {
          attempts += 1;
          return attempts === failOn
            ? Promise.reject(new Error("injected connection failure"))
            : Reflect.apply(target.connect, target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs the Inngest function bodies with inline steps and records sent events. */
function capture() {
  let handler:
    | ((context: { event?: unknown; step: unknown }) => Promise<unknown>)
    | undefined;
  let config: Record<string, unknown> = {};
  const sent: { id: string; payload: unknown }[] = [];
  const client = {
    createFunction(options: Record<string, unknown>, body: typeof handler) {
      config = options;
      handler = body;
      return {};
    },
  } as unknown as Inngest;
  return {
    client,
    sent,
    config: () => config,
    run: (event?: unknown) =>
      handler!({
        event,
        step: {
          run: async <T>(_id: string, work: () => Promise<T>) => await work(),
          sendEvent: (id: string, payload: unknown) => {
            sent.push({ id, payload });
            return Promise.resolve();
          },
        },
      }),
  };
}

const NO_FACTS = { written: 0, unchanged: 0, stale: 0, skipped: 0 };

// ---------------------------------------------------------------- pure rules

Deno.test("issue 71 processor: retries back off 30 seconds times 2 to the attempts, up to an hour, and the limit is ten", () => {
  assertEquals(MAX_ROUTE_ATTEMPTS, 10);
  assertEquals(
    [0, 1, 2, 3, 6, 7, 10, 100].map(retryDelaySeconds),
    [30, 60, 120, 240, 1920, 3600, 3600, 3600],
  );
  assertEquals(retryDelaySeconds(-5), 30);
  assertEquals(retryDelaySeconds(Number.NaN), 30);
  assertEquals(retryDelaySeconds(Number.POSITIVE_INFINITY), 30);
  const codes = Object.values(RouteOutcomeCode);
  assertEquals(
    new Set(codes).size,
    codes.length,
    "every outcome code is its own",
  );
});

const BASE_AUTHORITY: RouteAuthority = {
  connection: { status: "enabled", installationId: "inst-1" },
  installation: {
    status: "enabled",
    externalId: "42",
    registrationId: "reg-1",
    alreadyCurrent: false,
  },
  resource: {
    externalId: "7",
    displayName: "octo/repo",
    selected: true,
    available: true,
  },
  credentials: null,
  generation: 0,
  tracked: true,
  repositoryId: null,
};

const route = (
  purpose: "installation_reconcile" | "discovery" | "fact_refresh",
  eventKind: string,
  resourceId: string | null = "res-1",
) => ({ purpose, eventKind, installationId: "inst-1", resourceId });

Deno.test("issue 71 processor: the live authority recheck settles ignored before any provider call", () => {
  const verdict = (
    purpose: "installation_reconcile" | "discovery" | "fact_refresh",
    eventKind: string,
    changes: Partial<RouteAuthority>,
    resourceId: string | null = "res-1",
  ) =>
    authorityVerdict(route(purpose, eventKind, resourceId), {
      ...BASE_AUTHORITY,
      ...changes,
    });
  const installation = (status: string) => ({
    ...BASE_AUTHORITY.installation!,
    status,
  });
  assertEquals(verdict("fact_refresh", "issues", {}), null);
  // Connection: absent (archived rows are not read), not enabled, moved.
  assertEquals(
    verdict("fact_refresh", "issues", { connection: null }),
    "connection_not_enabled",
  );
  for (const status of ["pending", "disabled", "revoked"]) {
    assertEquals(
      verdict("discovery", "installation_repositories", {
        connection: { status, installationId: "inst-1" },
      }, null),
      "connection_not_enabled",
      status,
    );
  }
  assertEquals(
    verdict("fact_refresh", "issues", {
      connection: { status: "enabled", installationId: "inst-2" },
    }),
    "connection_changed",
  );
  assertEquals(
    verdict("fact_refresh", "issues", { installation: null }),
    "installation_unavailable",
  );
  // Installation: only a lifecycle route acts on a suspended one.
  assertEquals(
    verdict("installation_reconcile", "installation", {
      installation: installation("suspended"),
    }, null),
    null,
  );
  for (
    const [purpose, kind] of [
      ["fact_refresh", "issues"],
      ["discovery", "installation_repositories"],
    ] as const
  ) {
    assertEquals(
      verdict(purpose, kind, { installation: installation("suspended") }, null),
      "installation_suspended",
      purpose,
    );
    assertEquals(
      verdict(purpose, kind, { installation: installation("revoked") }, null),
      "installation_revoked",
      purpose,
    );
    assertEquals(
      verdict(purpose, kind, { installation: installation("pending") }, null),
      "installation_pending",
      purpose,
    );
  }
  assertEquals(
    verdict("installation_reconcile", "installation", {
      installation: installation("revoked"),
    }, null),
    "installation_revoked",
  );
  assertEquals(
    verdict("installation_reconcile", "installation", {
      installation: installation("pending"),
    }, null),
    "installation_pending",
  );
  // Resource: deselected, unavailable or gone; a repository event names one too.
  const resource = BASE_AUTHORITY.resource!;
  assertEquals(
    verdict("fact_refresh", "issues", {
      resource: { ...resource, selected: false },
    }),
    "unselected_repository",
  );
  assertEquals(
    verdict("fact_refresh", "issues", {
      resource: { ...resource, available: false },
    }),
    "unselected_repository",
  );
  assertEquals(
    verdict("fact_refresh", "issues", { resource: null }),
    "unselected_repository",
  );
  assertEquals(
    verdict("discovery", "repository", { resource: null }),
    "unselected_repository",
  );
  assertEquals(
    verdict("discovery", "installation_repositories", {}, null),
    null,
  );
  // Pull request and check routes need a tracked pull request; issues do not.
  for (const kind of ["pull_request", "check_run", "check_suite"]) {
    assertEquals(
      verdict("fact_refresh", kind, { tracked: false }),
      "untracked_pull_request",
      kind,
    );
    assertEquals(verdict("fact_refresh", kind, { tracked: true }), null, kind);
  }
  assertEquals(verdict("fact_refresh", "issues", { tracked: false }), null);
  assertEquals(
    verdict("fact_refresh", "ping", {}),
    "unsupported_event",
  );
});

// ---------------------------------------------------------------- fact routes

Deno.test("issue 71 processor: a delayed delivery read after a newer one leaves the newer fact", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [
      { number: 1, labels: ["bug"], updatedAt: T1 },
    ]);
    // The newer state is read and stored first.
    f.github.editIssue(r.repositoryId, 1, {
      labels: ["bug", "p1"],
      updatedAt: T2,
    });
    const newer = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "labeled"),
    });
    assertEquals(await run(f, newer.id), {
      kind: "completed",
      code: "fact_written",
      notBefore: null,
      tally: { ...NO_FACTS, written: 1 },
    });
    const [stored] = await factRows(f);
    assertEquals(stored.organization_id, f.organizationId);
    assertEquals(stored.resource_id, r.resource.id);
    assertEquals(stored.kind, "issue");
    assertEquals(stored.number, 1);
    assertEquals(stored.state, "open");
    assertEquals(stored.summary.labels, ["bug", "p1"]);
    assertEquals(
      stored.provider_updated_at.toISOString(),
      "2026-10-30T11:00:00.000Z",
    );

    // A delayed delivery whose read still answers the earlier state (a
    // lagging replica) is stale: the stored fact does not move.
    f.github.editIssue(r.repositoryId, 1, { labels: ["bug"], updatedAt: T1 });
    const delayed = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "labeled"),
    });
    const second = await run(f, delayed.id);
    assertEquals(second.kind, "completed");
    assertEquals(second.kind === "skipped" ? null : second.code, "fact_stale");
    const [afterStale] = await factRows(f);
    assertEquals(afterStale.version, stored.version);
    assertEquals(afterStale.summary, stored.summary);
    assertEquals(afterStale.provider_updated_at, stored.provider_updated_at);

    // The same state again writes nothing and leaves the version alone.
    f.github.editIssue(r.repositoryId, 1, {
      labels: ["bug", "p1"],
      updatedAt: T2,
    });
    const repeat = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "edited"),
    });
    const third = await run(f, repeat.id);
    assertEquals(
      third.kind === "skipped" ? null : third.code,
      "fact_unchanged",
    );
    assertEquals((await factRows(f))[0].version, stored.version);

    // A newer state replaces it.
    f.github.editIssue(r.repositoryId, 1, {
      labels: ["done"],
      state: "closed",
      updatedAt: T3,
    });
    const closed = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "closed"),
    });
    const fourth = await run(f, closed.id);
    assertEquals(
      fourth.kind === "skipped" ? null : fourth.code,
      "fact_written",
    );
    const [latest] = await factRows(f);
    assertEquals([latest.state, latest.summary.labels], ["closed", ["done"]]);
    assertEquals(latest.version, stored.version + 1);
    assertEquals((await routeState(f, closed.id)).status, "completed");
  });
});

Deno.test("issue 71 processor: a payload that disagrees with GitHub records GitHub's state and none of the payload's text", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [
      { number: 2, state: "open", labels: ["ready"], updatedAt: T1 },
    ]);
    const body = JSON.stringify({
      ...issuesPayload(r, 2, "closed"),
      issue: {
        number: 2,
        state: "closed",
        title: CANARY,
        body: CANARY,
        labels: [{ name: `payload-${CANARY}` }],
      },
    });
    const created = await routed(r, { event: "issues", body });
    const outcome = await run(f, created.id);
    assertEquals(outcome.kind, "completed");
    const rows = await factRows(f);
    assertEquals(rows.length, 1);
    assertEquals([rows[0].state, rows[0].summary.labels], ["open", ["ready"]]);
    assert(
      !JSON.stringify(rows).includes(CANARY),
      "no payload or issue text reaches a fact",
    );
    assert(
      !JSON.stringify(await routeRows(f)).includes(CANARY),
      "no payload text reaches a route",
    );
    // Only the issue was read, with a token narrowed to its repository and
    // to metadata and issues read.
    assertEquals(f.github.tokenRequests.length, 1);
    assertEquals(f.github.tokenRequests[0].repositoryIds, [r.repositoryId]);
    assertEquals(f.github.tokenRequests[0].permissions, {
      metadata: "read",
      issues: "read",
    });
  });
});

Deno.test("issue 71 processor: a pull request read through an issue route is never a ticket", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedPullRequest(r.repositoryId, { number: 5, headSha: SHA_A });
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 5, "opened"),
    });
    assertEquals(await run(f, created.id), {
      kind: "ignored",
      code: "pull_request_not_ticket",
      notBefore: null,
      tally: null,
    });
    assertEquals(await factRows(f), []);
    const state = await routeState(f, created.id);
    assertEquals([state.status, state.outcome_code], [
      "ignored",
      "pull_request_not_ticket",
    ]);
  });
});

Deno.test("issue 71 processor: a suspended installation, a revoked or archived connection or a deselected repository between receipt and processing ignores the route without a provider call", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const change = (sql: string, id: string) => f.pgDatabase.query(sql, [id]);
    const cases: {
      name: string;
      code: string;
      break: () => Promise<unknown>;
      restore: () => Promise<unknown>;
    }[] = [
      {
        name: "installation suspended",
        code: "installation_suspended",
        break: () =>
          change(
            "update bakery.integration_installations set status = 'suspended' where id = $1",
            r.installationRowId,
          ),
        restore: () =>
          change(
            "update bakery.integration_installations set status = 'enabled' where id = $1",
            r.installationRowId,
          ),
      },
      {
        name: "installation revoked",
        code: "installation_revoked",
        break: () =>
          change(
            "update bakery.integration_installations set status = 'revoked' where id = $1",
            r.installationRowId,
          ),
        restore: () =>
          change(
            "update bakery.integration_installations set status = 'enabled' where id = $1",
            r.installationRowId,
          ),
      },
      {
        name: "connection revoked",
        code: "connection_not_enabled",
        break: () =>
          change(
            "update bakery.integration_connections set status = 'revoked' where id = $1",
            r.connection.connectionId,
          ),
        restore: () =>
          change(
            "update bakery.integration_connections set status = 'enabled' where id = $1",
            r.connection.connectionId,
          ),
      },
      {
        name: "connection archived",
        code: "connection_not_enabled",
        break: () =>
          change(
            "update bakery.integration_connections set archived_at = now() where id = $1",
            r.connection.connectionId,
          ),
        restore: () =>
          change(
            "update bakery.integration_connections set archived_at = null where id = $1",
            r.connection.connectionId,
          ),
      },
      {
        name: "resource deselected",
        code: "unselected_repository",
        break: () =>
          change(
            "update bakery.integration_resources set selected = false where id = $1",
            r.resource.id,
          ),
        restore: () =>
          change(
            "update bakery.integration_resources set selected = true where id = $1",
            r.resource.id,
          ),
      },
      {
        name: "resource unavailable",
        code: "unselected_repository",
        break: () =>
          change(
            "update bakery.integration_resources set available = false where id = $1",
            r.resource.id,
          ),
        restore: () =>
          change(
            "update bakery.integration_resources set available = true where id = $1",
            r.resource.id,
          ),
      },
    ];
    for (const scenario of cases) {
      const created = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 1, "edited"),
      });
      await scenario.break();
      const callsBefore = f.github.calls.length;
      const outcome = await run(f, created.id);
      await scenario.restore();
      assertEquals(
        outcome,
        { kind: "ignored", code: scenario.code, notBefore: null, tally: null },
        scenario.name,
      );
      assertEquals(f.github.calls.length, callsBefore, scenario.name);
      const state = await routeState(f, created.id);
      assertEquals(
        [state.status, state.outcome_code, state.attempts],
        ["ignored", scenario.code, 1],
        scenario.name,
      );
    }
    assertEquals(await factRows(f), [], "no fact was written");
    assertEquals(f.github.tokenRequests.length, 0, "no token was minted");
  });
});

Deno.test("issue 71 processor: a rate limit defers the route for the wait GitHub named and the recovery cron sends it again", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    f.github.failNext("issue", "rate_limited");
    const limited = await run(f, created.id);
    assertEquals(limited.kind, "deferred");
    if (limited.kind === "skipped") throw new Error("not skipped");
    assertEquals(limited.code, "rate_limited");
    const wait = Date.parse(limited.notBefore!) - Date.now();
    assert(wait > 100_000 && wait <= 125_000, `waits about 120 s, not ${wait}`);
    const deferred = await routeState(f, created.id);
    assertEquals(
      [deferred.status, deferred.outcome_code, deferred.attempts],
      ["deferred", "rate_limited", 1],
    );
    assertEquals(await factRows(f), []);

    // Not due: recovery leaves it and a direct claim skips it.
    assertEquals(
      (await dueRoutes(f.runtimePgDatabase!)).map(({ id }) => id),
      [],
    );
    assertEquals(await run(f, created.id), {
      kind: "skipped",
      reason: "not_due",
    });
    assertEquals((await routeState(f, created.id)).attempts, 1);

    // Due: the recovery cron sends the event the processor reads its route from.
    await makeDue(f, created.id);
    const recovery = capture();
    createIntegrationIntakeRecovery({
      client: recovery.client,
      database: f.runtimePgDatabase!,
    });
    assertEquals(await recovery.run(), { rearmed: 1 });
    assertEquals(recovery.sent.length, 1);
    assertEquals(recovery.sent[0].payload, {
      name: "bakery/intake.received.v1",
      data: {
        aggregateId: created.id,
        payload: { inboundEventId: created.inbound_event_id },
      },
    });
    const retried = await run(f, created.id);
    assertEquals(
      retried.kind === "skipped" ? null : retried.code,
      "fact_written",
    );
    const done = await routeState(f, created.id);
    assertEquals([done.status, done.attempts], ["completed", 2]);
    assertEquals((await factRows(f)).length, 1);
  });
});

Deno.test("issue 71 processor: a token GitHub refuses settles the route permission_missing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    // GitHub suspended the installation before Bakery knew: it refuses the narrowed token.
    f.github.setInstallationState(r.installationId, "suspended");
    assertEquals(await run(f, created.id), {
      kind: "ignored",
      code: "permission_missing",
      notBefore: null,
      tally: null,
    });
    assertEquals(f.github.repositoryReadCalls().length, 0, "no read was made");
    assertEquals(await factRows(f), []);
    const state = await routeState(f, created.id);
    assertEquals([state.status, state.outcome_code], [
      "ignored",
      "permission_missing",
    ]);
  });
});

Deno.test("issue 71 processor: an installation outage defers with a growing back-off and the eleventh claim fails the route for good", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    f.github.failNext("issue", "server_error", MAX_ROUTE_ATTEMPTS);
    for (let attempt = 1; attempt <= MAX_ROUTE_ATTEMPTS; attempt++) {
      if (attempt > 1) await makeDue(f, created.id);
      const outcome = await run(f, created.id);
      assertEquals(outcome.kind, "deferred", `attempt ${attempt}`);
      if (outcome.kind === "skipped") throw new Error("not skipped");
      assertEquals(outcome.code, "provider_error");
      const wait = Date.parse(outcome.notBefore!) - Date.now();
      const expected = retryDelaySeconds(attempt) * 1000;
      assert(
        wait > expected - 15_000 && wait <= expected,
        `attempt ${attempt} waits about ${expected} ms, not ${wait}`,
      );
      const state = await routeState(f, created.id);
      assertEquals([state.status, state.attempts], ["deferred", attempt]);
    }
    assertEquals(retryDelaySeconds(MAX_ROUTE_ATTEMPTS), 3600);

    // The next claim does not read GitHub: it ends the route.
    await makeDue(f, created.id);
    const callsBefore = f.github.calls.length;
    assertEquals(await run(f, created.id), {
      kind: "failed",
      code: "max_attempts",
      notBefore: null,
      tally: null,
    });
    assertEquals(f.github.calls.length, callsBefore);
    const failed = await routeState(f, created.id);
    assertEquals(
      [failed.status, failed.outcome_code, failed.attempts],
      ["failed", "max_attempts", MAX_ROUTE_ATTEMPTS],
    );
    // Recovery never sends a failed route, and a replay is a no-op.
    assertEquals((await dueRoutes(f.runtimePgDatabase!)).length, 0);
    const recovery = capture();
    createIntegrationIntakeRecovery({
      client: recovery.client,
      database: f.runtimePgDatabase!,
    });
    assertEquals(await recovery.run(), { rearmed: 0 });
    assertEquals(await run(f, created.id), {
      kind: "skipped",
      reason: "terminal",
    });
    assertEquals(await factRows(f), []);
  });
});

Deno.test("issue 71 processor: a settled route is skipped, a fresh claim is left alone and a stale one is taken over", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    assertEquals(await run(f, crypto.randomUUID()), {
      kind: "skipped",
      reason: "not_found",
    });

    // Another worker holds a fresh claim.
    await f.pgDatabase.query(
      "update bakery.inbound_event_routes set status = 'processing', updated_at = now() where id = $1",
      [created.id],
    );
    const callsBefore = f.github.calls.length;
    assertEquals(await run(f, created.id), {
      kind: "skipped",
      reason: "in_progress",
    });
    assertEquals(f.github.calls.length, callsBefore);
    assertEquals((await routeState(f, created.id)).attempts, 0);

    // Its claim is older than ten minutes: the worker died, so the route is taken over.
    await f.pgDatabase.query(
      "update bakery.inbound_event_routes set updated_at = now() - interval '11 minutes' where id = $1",
      [created.id],
    );
    const recovered = await run(f, created.id);
    assertEquals(
      recovered.kind === "skipped" ? null : recovered.code,
      "fact_written",
    );
    const settled = await routeState(f, created.id);
    assertEquals([settled.status, settled.attempts], ["completed", 1]);
    const [fact] = await factRows(f);

    // Replaying the settled route changes nothing and reads nothing.
    const afterCalls = f.github.calls.length;
    assertEquals(await run(f, created.id), {
      kind: "skipped",
      reason: "terminal",
    });
    assertEquals(f.github.calls.length, afterCalls);
    assertEquals(await routeState(f, created.id), settled);
    assertEquals((await factRows(f))[0].version, fact.version);
  });
});

Deno.test("issue 71 processor: two workers racing for one route process it once", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => run(f, created.id)),
    );
    assertEquals(outcomes.filter(({ kind }) => kind === "completed").length, 1);
    assertEquals(
      outcomes.filter(({ kind }) => kind === "skipped").length,
      3,
    );
    const state = await routeState(f, created.id);
    assertEquals([state.status, state.attempts], ["completed", 1]);
    assertEquals((await factRows(f)).length, 1);
  });
});

Deno.test("issue 71 processor: an issue GitHub moved out of a repository that still exists is recorded gone as transferred", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [
      { number: 1, updatedAt: T1 },
      { number: 2, updatedAt: T1 },
    ]);
    const first = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    await run(f, first.id);
    const [before] = await factRows(f);
    assertEquals(before.state, "open");

    f.github.transferIssue(r.repositoryId, 1);
    f.github.transferIssue(r.repositoryId, 2);
    const transferred = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "transferred"),
    });
    assertEquals(await run(f, transferred.id), {
      kind: "completed",
      code: "issue_transferred",
      notBefore: null,
      tally: null,
    });
    const [after] = await factRows(f);
    assertEquals([after.state, after.version], ["gone", before.version + 1]);
    assertEquals(after.external_id, before.external_id);
    assertEquals(
      await discoveryRows(f),
      [],
      "the repository is intact: no rescan",
    );

    // An issue that was never stored has nothing to mark, and none is invented.
    const unseen = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 2, "transferred"),
    });
    const outcome = await run(f, unseen.id);
    assertEquals(
      outcome.kind === "skipped" ? null : outcome.code,
      "issue_transferred",
    );
    assertEquals((await factRows(f)).length, 1);
  });
});

Deno.test("issue 71 processor: a renamed repository completes repository_moved, writes no fact and queues a discovery", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const first = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    await run(f, first.id);
    const [before] = await factRows(f);

    f.github.renameRepository(r.repositoryId, "renamed-on-github");
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "edited"),
    });
    assertEquals(await run(f, created.id), {
      kind: "completed",
      code: "repository_moved",
      notBefore: null,
      tally: null,
    });
    assertEquals(await factRows(f), [before], "the stored fact is untouched");
    const [discovery] = await discoveryRows(f);
    assertEquals(discovery.organization_id, f.organizationId);
    assertEquals(discovery.connection_id, r.connection.connectionId);
    assertEquals(discovery.status, "queued");
    assertEquals(
      discovery.requested_by,
      await creatorOf(f, r.connection.connectionId),
    );
    assertEquals(
      await traceOf(f, discovery.id, "integration.discovery_requested"),
      await traceOf(f, created.id, "intake.received"),
      "a rescan a moved repository causes keeps the delivery's trace",
    );
  });
});

Deno.test("issue 71 processor: a 404 or 410 records the issue gone only while the repository still has its id", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [
      { number: 1, updatedAt: T1 },
      { number: 2, updatedAt: T1 },
    ]);
    const read = async (number: number, action: string) => {
      const created = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, number, action),
      });
      return { created, outcome: await run(f, created.id) };
    };
    await read(1, "opened");
    await read(2, "opened");
    assertEquals((await factRows(f)).map(({ state }) => state), [
      "open",
      "open",
    ]);

    // Deleted (410): the repository answers with its id, so the issue is gone.
    f.github.deleteIssue(r.repositoryId, 1);
    const deleted = await read(1, "deleted");
    assertEquals(deleted.outcome, {
      kind: "completed",
      code: "fact_gone",
      notBefore: null,
      tally: null,
    });
    const gone = (await factRows(f)).find(({ number }) => number === 1)!;
    assertEquals(gone.state, "gone");
    // An unknown number (404) with nothing stored has nothing to mark.
    const unknown = await read(99, "edited");
    assertEquals(
      unknown.outcome.kind === "skipped" ? null : unknown.outcome.code,
      "fact_absent",
    );
    assertEquals((await factRows(f)).length, 2);

    // A repository name another repository took over: the token does not
    // reach it, so the repository id cannot be confirmed and nothing is recorded.
    const open = (await factRows(f)).find(({ number }) => number === 2)!;
    const oldName = (await f.pgDatabase.query<{ display_name: string }>(
      "select display_name from bakery.integration_resources where id = $1",
      [r.resource.id],
    )).rows[0].display_name.split("/")[1];
    f.github.renameRepository(r.repositoryId, "moved-away");
    r.connection.installation.repositories.push({
      id: 650_000_001,
      name: oldName,
      private: true,
      archived: false,
      permissions: null,
    });
    f.github.deleteIssue(r.repositoryId, 2);
    const reused = await read(2, "edited");
    assertEquals(reused.outcome, {
      kind: "completed",
      code: "repository_moved",
      notBefore: null,
      tally: null,
    });
    assertEquals(
      (await factRows(f)).find(({ number }) => number === 2),
      open,
      "the fact of the reused name's issue is not marked gone",
    );
    assertEquals(
      await discoveryRows(f),
      [],
      "a vanished path queues no rescan",
    );
  });
});

Deno.test("issue 71 processor: a repository id that differs from the stored one is never read as the same repository", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const first = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    await run(f, first.id);
    const [before] = await factRows(f);
    // GitHub answers the name with a different repository: it was reused.
    const reused: GitHubAppClient = {
      ...f.github.client,
      readRepositoryIdentity: () =>
        Promise.resolve({ kind: "present", id: r.repositoryId + 1 }),
    };
    f.github.deleteIssue(r.repositoryId, 1);
    const gone = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "deleted"),
    });
    assertEquals((await run(f, gone.id, reused)).kind, "completed");
    assertEquals(
      (await routeState(f, gone.id)).outcome_code,
      "repository_moved",
    );
    assertEquals(await factRows(f), [before]);
    assertEquals(await discoveryRows(f), []);

    // A moved issue path under a reused name is a moved repository, which rescans.
    f.github.seedIssues(r.repositoryId, [{ number: 3, updatedAt: T1 }]);
    f.github.transferIssue(r.repositoryId, 3);
    const moved = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 3, "transferred"),
    });
    assertEquals((await run(f, moved.id, reused)).kind, "completed");
    assertEquals(
      (await routeState(f, moved.id)).outcome_code,
      "repository_moved",
    );
    assertEquals(await factRows(f), [before]);
    assertEquals((await discoveryRows(f)).length, 1);
  });
});

// ------------------------------------------------- pull requests and checks

Deno.test("issue 71 processor: a tracked pull request is read fresh and stored only when newer", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      await withPgTransaction(
        f.runtimePgDatabase!,
        (transaction) =>
          registerPullRequest(transaction, {
            organizationId: f.organizationId,
            taskId: seed.taskId,
            repositoryId: seed.repositoryId,
            providerNumber: 7,
            url: "https://github.com/example/repo/pull/7",
            headSha: SHA_A,
            baseSha: SHA_B,
          }),
      );
      const pullRow = async () =>
        (await f.pgDatabase.query<{
          status: string;
          head_sha: string;
          merged_sha: string | null;
          provider_updated_at: Date | null;
          observed_started_at: Date;
          last_observed_at: Date;
          version: number;
        }>(
          "select * from bakery.pull_requests where repository_id = $1 and provider_number = 7",
          [seed.repositoryId],
        )).rows[0];
      const deliver = (action: string) =>
        routed(r, {
          event: "pull_request",
          payload: pullRequestPayload(r, 7, SHA_C, action),
        });

      f.github.seedPullRequest(r.repositoryId, {
        number: 7,
        headSha: SHA_C,
        baseSha: SHA_B,
        merged: true,
        mergedSha: SHA_C,
        updatedAt: T2,
      });
      const merged = await deliver("closed");
      const first = await run(f, merged.id);
      assertEquals(
        first.kind === "skipped" ? null : first.code,
        "fact_written",
      );
      const row = await pullRow();
      assertEquals([row.status, row.head_sha, row.merged_sha], [
        "merged",
        SHA_C,
        SHA_C,
      ]);
      assertEquals(
        row.provider_updated_at?.toISOString(),
        "2026-10-30T11:00:00.000Z",
      );
      assertEquals(f.github.tokenRequests[0].permissions, {
        metadata: "read",
        pull_requests: "read",
      });

      // The same read again writes nothing.
      const again = await run(f, (await deliver("closed")).id);
      assertEquals(
        again.kind === "skipped" ? null : again.code,
        "fact_unchanged",
      );
      // It only moves the read clock: a later-started read confirmed the state.
      const afterRepeat = await pullRow();
      assertEquals(afterRepeat.version, row.version);
      assertEquals(
        [afterRepeat.status, afterRepeat.head_sha, afterRepeat.merged_sha],
        [row.status, row.head_sha, row.merged_sha],
      );
      assertEquals(afterRepeat.provider_updated_at, row.provider_updated_at);
      assert(
        afterRepeat.observed_started_at > row.observed_started_at,
        "the confirming read began later and moves the stored read start",
      );
      assert(
        afterRepeat.last_observed_at > row.last_observed_at,
        "the confirming read moves the observation time",
      );

      // A delayed delivery whose read answers an older state is stale.
      f.github.seedPullRequest(r.repositoryId, {
        number: 7,
        headSha: SHA_A,
        baseSha: SHA_B,
        merged: false,
        state: "open",
        updatedAt: T1,
      });
      const stale = await run(f, (await deliver("synchronize")).id);
      assertEquals(stale.kind === "skipped" ? null : stale.code, "fact_stale");
      // The stale read moves nothing, not even a clock: the row is as the repeat left it.
      assertEquals(await pullRow(), afterRepeat);

      // Unregistered between receipt and processing: nothing to keep, no read.
      const orphaned = await deliver("edited");
      await f.pgDatabase.query(
        "delete from bakery.pull_requests where repository_id = $1",
        [seed.repositoryId],
      );
      const callsBefore = f.github.calls.length;
      assertEquals(await run(f, orphaned.id), {
        kind: "ignored",
        code: "untracked_pull_request",
        notBefore: null,
        tally: null,
      });
      assertEquals(f.github.calls.length, callsBefore);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 processor: a pull request that GitHub no longer serves is gone or its repository moved, never a fact", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      for (const number of [7, 8]) {
        await withPgTransaction(
          f.runtimePgDatabase!,
          (transaction) =>
            registerPullRequest(transaction, {
              organizationId: f.organizationId,
              taskId: seed.taskId,
              repositoryId: seed.repositoryId,
              providerNumber: number,
              url: `https://github.com/example/repo/pull/${number}`,
              headSha: SHA_A,
              baseSha: SHA_B,
            }),
        );
      }
      const deliver = (number: number) =>
        routed(r, {
          event: "pull_request",
          payload: pullRequestPayload(r, number, SHA_A, "edited"),
        });
      // Pull request 8 is unknown to GitHub (404) while the repository answers.
      const missing = await deliver(8);
      assertEquals(await run(f, missing.id), {
        kind: "completed",
        code: "pull_request_gone",
        notBefore: null,
        tally: null,
      });
      assertEquals(await discoveryRows(f), []);
      // The repository was renamed: pull requests cannot move, so it is the repository.
      f.github.renameRepository(r.repositoryId, "renamed-for-pulls");
      const moved = await deliver(7);
      assertEquals(await run(f, moved.id), {
        kind: "completed",
        code: "repository_moved",
        notBefore: null,
        tally: null,
      });
      assertEquals((await discoveryRows(f)).length, 1);
      assertEquals(await factRows(f), []);
      const status = await f.pgDatabase.query<
        { status: string; version: number }
      >(
        "select status, version from bakery.pull_requests where repository_id = $1 order by provider_number",
        [seed.repositoryId],
      );
      assertEquals(status.rows.map((row) => [row.status, row.version]), [
        ["open", 1],
        ["open", 1],
      ]);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 processor: check runs of a tracked head are stored from the read, with an unknown author kept and unorderable runs counted", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      for (const [number, headSha] of [[7, SHA_A], [8, SHA_B]] as const) {
        await withPgTransaction(
          f.runtimePgDatabase!,
          (transaction) =>
            registerPullRequest(transaction, {
              organizationId: f.organizationId,
              taskId: seed.taskId,
              repositoryId: seed.repositoryId,
              providerNumber: number,
              url: `https://github.com/example/repo/pull/${number}`,
              headSha,
              baseSha: SHA_C,
            }),
        );
      }
      f.github.seedCheckRuns(r.repositoryId, SHA_A, [
        { name: "build", completedAt: T2, startedAt: T1 },
        {
          name: "orphaned",
          appId: null,
          appSlug: null,
          completedAt: T2,
          startedAt: T1,
        },
        {
          name: "running",
          status: "in_progress",
          conclusion: null,
          startedAt: T3,
          completedAt: null,
        },
        {
          name: "queued",
          status: "queued",
          conclusion: null,
          startedAt: null,
          completedAt: null,
        },
      ]);
      const created = await routed(r, {
        event: "check_run",
        payload: checkRunPayload(r, SHA_A),
      });
      assertEquals(await run(f, created.id), {
        kind: "completed",
        code: "fact_written",
        notBefore: null,
        tally: { written: 3, unchanged: 0, stale: 0, skipped: 1 },
      });
      const facts = await factRows(f);
      assertEquals(facts.length, 3, "the run with no time is not stored");
      for (const fact of facts) {
        assertEquals(fact.kind, "check_run");
        assertEquals(fact.head_sha, SHA_A);
        assertEquals(fact.number, null);
        assertEquals(fact.organization_id, f.organizationId);
        assertEquals(fact.resource_id, r.resource.id);
      }
      const byName = Object.fromEntries(
        facts.map((fact) => [fact.summary.name as string, fact]),
      );
      assertEquals(
        byName.build.provider_updated_at.toISOString(),
        "2026-10-30T11:00:00.000Z",
      );
      assertEquals(
        byName.running.provider_updated_at.toISOString(),
        "2026-10-30T12:00:00.000Z",
      );
      assertEquals([byName.running.state, byName.running.conclusion], [
        "in_progress",
        null,
      ]);
      assertEquals(byName.build.conclusion, "success");
      // GitHub no longer has the App that made this run: the author is unknown.
      assertEquals(byName.orphaned.summary.appId, null);
      assertEquals(byName.orphaned.summary.appSlug, null);
      assert(typeof byName.build.summary.appId === "number");
      assertEquals(f.github.tokenRequests[0].permissions, {
        metadata: "read",
        checks: "read",
      });

      // A check_suite event for the same head reads the same runs and writes nothing new.
      const suite = await routed(r, {
        event: "check_suite",
        payload: checkSuitePayload(r, SHA_A),
      });
      assertEquals(await run(f, suite.id), {
        kind: "completed",
        code: "fact_unchanged",
        notBefore: null,
        tally: { written: 0, unchanged: 3, stale: 0, skipped: 1 },
      });
      assertEquals((await factRows(f)).map(({ version }) => version), [
        1,
        1,
        1,
      ]);

      // More than four pages of 50 are cut off and the route says so.
      f.github.seedCheckRuns(
        r.repositoryId,
        SHA_B,
        Array.from({ length: 205 }, (_, index) => ({
          name: `job-${index}`,
          completedAt: fakeTimestamp(Date.parse(T1) + index * 1000),
          startedAt: T1,
        })),
      );
      const before = f.github.repositoryReadCalls().length;
      const big = await routed(r, {
        event: "check_run",
        payload: checkRunPayload(r, SHA_B),
      });
      assertEquals(await run(f, big.id), {
        kind: "completed",
        code: "checks_truncated",
        notBefore: null,
        tally: { written: 200, unchanged: 0, stale: 0, skipped: 0 },
      });
      assertEquals(f.github.repositoryReadCalls().length - before, 4);
      assertEquals((await factRows(f)).length, 203);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

// ------------------------------------------------------- lifecycle and discovery

Deno.test("issue 71 processor: suspend and unsuspend deliveries move the installation through the reconcile and a second route makes no provider call", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { organizationId, second } = await sharedSecondConnection(r);
    const other = second.resources.find((row) =>
      row.external_id !== r.resource.external_id
    )!;
    await selectAndEnable(f, second.connectionId, other, organizationId);

    f.github.setInstallationState(r.installationId, "suspended");
    const suspend = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "suspend"),
    });
    const suspendRoutes = await routeRows(f, suspend.eventId);
    assertEquals(suspendRoutes.length, 2, "one route per connection");
    const readsBefore = f.github.installationReads().length;
    const one = await run(f, suspendRoutes[0].id);
    assertEquals(
      one.kind === "skipped" ? null : one.code,
      "installation_transitioned",
    );
    assertEquals(f.github.installationReads().length, readsBefore + 1);
    const status = async () =>
      (await f.pgDatabase.query<{ status: string }>(
        "select status from bakery.integration_installations where id = $1",
        [r.installationRowId],
      )).rows[0].status;
    assertEquals(await status(), "suspended");
    // The installation was just reconciled: the other connection's route adds no read.
    const two = await run(f, suspendRoutes[1].id);
    assertEquals(two.kind === "skipped" ? null : two.code, "already_current");
    assertEquals(f.github.installationReads().length, readsBefore + 1);
    for (const route of suspendRoutes) {
      assertEquals((await routeState(f, route.id)).status, "completed");
    }

    // A resource event on the suspended installation is never executed.
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    await f.pgDatabase.query(
      "update bakery.integration_installations set status = 'enabled' where id = $1",
      [r.installationRowId],
    );
    const resource = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    await f.pgDatabase.query(
      "update bakery.integration_installations set status = 'suspended' where id = $1",
      [r.installationRowId],
    );
    const callsBefore = f.github.calls.length;
    assertEquals((await run(f, resource.id)).kind, "ignored");
    assertEquals(f.github.calls.length, callsBefore);

    // GitHub unsuspends: the lifecycle event routes while Bakery still says suspended.
    f.github.setInstallationState(r.installationId, "active");
    const unsuspend = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "unsuspend"),
    });
    const unsuspendRoutes = await routeRows(f, unsuspend.eventId);
    assertEquals(unsuspendRoutes.length, 2);
    const back = await run(f, unsuspendRoutes[0].id);
    assertEquals(
      back.kind === "skipped" ? null : back.code,
      "installation_transitioned",
    );
    assertEquals(await status(), "enabled");
    const reads = f.github.installationReads().length;
    const backTwo = await run(f, unsuspendRoutes[1].id);
    assertEquals(
      backTwo.kind === "skipped" ? null : backTwo.code,
      "already_current",
    );
    assertEquals(f.github.installationReads().length, reads);
    // The receipt from the suspension was never re-routed by the unsuspend.
    assertEquals((await routeRows(f, suspend.eventId)).length, 2);
  });
});

Deno.test("issue 71 processor: installation_repositories queues one discovery for the connection's creator and a second route finds it active", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const added = (action: string) =>
      routed(r, {
        event: "installation_repositories",
        payload: installationPayload(r, action),
      });
    const one = await added("added");
    const two = await added("removed");
    assertEquals(
      await run(f, one.id),
      {
        kind: "completed",
        code: "discovery_queued",
        notBefore: null,
        tally: null,
      },
    );
    const [discovery] = await discoveryRows(f);
    assertEquals(discovery.organization_id, f.organizationId);
    assertEquals(discovery.connection_id, r.connection.connectionId);
    assertEquals(discovery.status, "queued");
    assertEquals(
      discovery.requested_by,
      await creatorOf(f, r.connection.connectionId),
      "a webhook has no principal: the connection's creator asks",
    );
    // The discovery carries the trace of the delivery that caused it.
    const routeTrace = await traceOf(f, one.id, "intake.received");
    assert(routeTrace !== null && routeTrace !== "", "the route has a trace");
    assertNotEquals(
      routeTrace,
      await traceOf(f, two.id, "intake.received"),
      "each delivery has its own trace",
    );
    assertEquals(
      await traceOf(f, discovery.id, "integration.discovery_requested"),
      routeTrace,
    );
    const events = await f.pgDatabase.query<{ aggregate_id: string }>(
      `select aggregate_id from bakery.domain_events
        where event_type = 'integration.discovery_requested'
          and organization_id = $1`,
      [f.organizationId],
    );
    assertEquals(events.rows.map((row) => row.aggregate_id), [discovery.id]);
    assertEquals(
      await run(f, two.id),
      {
        kind: "completed",
        code: "discovery_active",
        notBefore: null,
        tally: null,
      },
    );
    assertEquals((await discoveryRows(f)).length, 1);
    assertEquals(
      f.github.calls.length,
      0,
      "queueing a discovery reads nothing",
    );

    // A suspended installation takes no discovery.
    await f.pgDatabase.query(
      "update bakery.integration_discoveries set status = 'completed' where id = $1",
      [discovery.id],
    );
    const three = await added("added");
    await f.pgDatabase.query(
      "update bakery.integration_installations set status = 'suspended' where id = $1",
      [r.installationRowId],
    );
    assertEquals(
      await run(f, three.id),
      {
        kind: "ignored",
        code: "installation_suspended",
        notBefore: null,
        tally: null,
      },
    );
    assertEquals((await discoveryRows(f)).length, 1);
  });
});

Deno.test("issue 71 processor: a discovery whose route has lost its intake.received event is still queued, under a fresh trace id", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const added = () =>
      routed(r, {
        event: "installation_repositories",
        payload: installationPayload(r, "added"),
      });
    const lost = await added();
    const kept = await added();
    // The event's outbox rows go first: they reference it.
    await f.pgDatabase.query(
      `delete from bakery.outbox
        where event_id in (
          select id from bakery.domain_events
           where aggregate_id = $1 and event_type = 'intake.received')`,
      [lost.id],
    );
    const deleted = await f.pgDatabase.query(
      `delete from bakery.domain_events
        where aggregate_id = $1 and event_type = 'intake.received'`,
      [lost.id],
    );
    assertEquals(deleted.rowCount, 1, "the route's receipt event is gone");
    assertEquals(
      await run(f, lost.id),
      {
        kind: "completed",
        code: "discovery_queued",
        notBefore: null,
        tally: null,
      },
      "a missing trace does not stop the discovery",
    );
    const [discovery] = await discoveryRows(f);
    assertEquals(discovery.status, "queued");
    const trace = await traceOf(
      f,
      discovery.id,
      "integration.discovery_requested",
    );
    assert(
      trace !== null &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          trace,
        ),
      `the discovery carries a fresh trace id, not ${JSON.stringify(trace)}`,
    );
    assertNotEquals(
      trace,
      await traceOf(f, kept.id, "intake.received"),
      "and not another delivery's trace",
    );
  });
});

// ------------------------------------------------------ Inngest functions

Deno.test("issue 71 processor: the intake function reads the route from the event's aggregate id and the recovery sends only due routes", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const intake = capture();
    createIntegrationIntakeWorkflow({
      client: intake.client,
      ...dependenciesOf(f),
    });
    assertEquals({
      id: intake.config().id,
      retries: intake.config().retries,
      concurrency: intake.config().concurrency,
      triggers: intake.config().triggers,
    }, {
      id: "bakery-integration-intake",
      retries: 3,
      concurrency: [{ limit: 4 }],
      triggers: [{ event: "bakery/intake.received.v1" }],
    });
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    await assertRejects(
      () => intake.run({ data: { payload: {} } }),
      Error,
      "INTEGRATION_INTAKE_EVENT_INVALID",
    );
    await assertRejects(
      () => intake.run({ data: { aggregateId: "not-a-uuid" } }),
      Error,
      "INTEGRATION_INTAKE_EVENT_INVALID",
    );
    const result = await intake.run({
      data: {
        aggregateId: created.id,
        payload: { inboundEventId: created.inbound_event_id },
      },
    }) as { kind: string; code: string };
    assertEquals([result.kind, result.code], ["completed", "fact_written"]);
    assertEquals((await routeState(f, created.id)).status, "completed");

    // One route in each state; only pending-and-old, deferred-and-due and
    // processing-and-stale are listed.
    const states = [
      ["pending_fresh", "pending", "now()", "now()", false],
      ["pending_old", "pending", "now() - interval '2 minutes'", "now()", true],
      [
        "deferred_due",
        "deferred",
        "now()",
        "now() - interval '1 second'",
        true,
      ],
      [
        "deferred_waiting",
        "deferred",
        "now()",
        "now() + interval '1 hour'",
        false,
      ],
      ["processing_fresh", "processing", "now()", "now()", false],
      [
        "processing_stale",
        "processing",
        "now() - interval '11 minutes'",
        "now()",
        true,
      ],
      ["failed", "failed", "now() - interval '1 day'", "now()", false],
      ["completed", "completed", "now() - interval '1 day'", "now()", false],
      ["ignored", "ignored", "now() - interval '1 day'", "now()", false],
    ] as const;
    const expected: string[] = [];
    let number = 10;
    for (const [name, status, updatedAt, notBefore, isDue] of states) {
      const route = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, number++, name),
      });
      await f.pgDatabase.query(
        `update bakery.inbound_event_routes
            set status = $2, updated_at = ${updatedAt}, not_before = ${notBefore}
          where id = $1`,
        [route.id, status],
      );
      if (isDue) expected.push(route.id);
    }
    const listed = await dueRoutes(f.runtimePgDatabase!);
    assertEquals(listed.map(({ id }) => id).sort(), expected.sort());
    assertEquals(
      (await dueRoutes(f.runtimePgDatabase!, 1)).length,
      1,
      "the batch is bounded",
    );
    const recovery = capture();
    createIntegrationIntakeRecovery({
      client: recovery.client,
      database: f.runtimePgDatabase!,
    });
    assertEquals({
      id: recovery.config().id,
      retries: recovery.config().retries,
      concurrency: recovery.config().concurrency,
      triggers: recovery.config().triggers,
    }, {
      id: "bakery-integration-intake-recovery",
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    });
    assertEquals(await recovery.run(), { rearmed: 3 });
    assertEquals(
      recovery.sent.map((entry) =>
        (entry.payload as { data: { aggregateId: string } }).data.aggregateId
      ).sort(),
      expected.sort(),
    );
    for (const entry of recovery.sent) {
      assertEquals(
        (entry.payload as { name: string }).name,
        "bakery/intake.received.v1",
      );
    }
    assertNotEquals(new Set(recovery.sent.map(({ id }) => id)).size, 0);
    assertEquals(
      new Set(recovery.sent.map(({ id }) => id)).size,
      3,
      "each rearm is its own step",
    );
  });
});

// ------------------------------------- reads, races, locks and unclassified failures

/** Registers pull request 7 at `SHA_A` for a task, so pull request and check routes track it. */
async function trackPullRequest(
  f: GitHubAppFixture,
  seed: Awaited<ReturnType<typeof seedTaskAndRepository>>,
): Promise<void> {
  await withPgTransaction(
    f.runtimePgDatabase!,
    (transaction) =>
      registerPullRequest(transaction, {
        organizationId: f.organizationId,
        taskId: seed.taskId,
        repositoryId: seed.repositoryId,
        providerNumber: 7,
        url: "https://github.com/example/repo/pull/7",
        headSha: SHA_A,
        baseSha: SHA_B,
      }),
  );
}

Deno.test("issue 71 processor: every read is timed before it is sent and holds no database connection", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      await trackPullRequest(f, seed);
      f.github.seedIssues(r.repositoryId, [
        { number: 1, updatedAt: T1 },
        { number: 2, updatedAt: T1 },
      ]);
      f.github.seedPullRequest(r.repositoryId, {
        number: 7,
        headSha: SHA_A,
        baseSha: SHA_B,
        updatedAt: T2,
      });
      f.github.seedCheckRuns(r.repositoryId, SHA_A, [
        { name: "build", completedAt: T2, startedAt: T1 },
      ]);
      // Issue 2 is stored, then deleted on GitHub, so a later read marks it gone.
      const opened = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 2, "opened"),
      });
      await run(f, opened.id);
      const storedBefore = (await factRows(f)).find(({ number }) =>
        number === 2
      )!;
      f.github.deleteIssue(r.repositoryId, 2);

      const pool = f.runtimePgDatabase!;
      const reads: { method: string; at: number; held: number }[] = [];
      const github = disturbed(f, async (method) => {
        reads.push({
          method,
          at: Date.now(),
          held: pool.totalCount - pool.idleCount,
        });
        // Time passes inside the call, so a clock taken after it differs from one taken before.
        await sleep(30);
      });
      const issue = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 1, "opened"),
      });
      const pull = await routed(r, {
        event: "pull_request",
        payload: pullRequestPayload(r, 7, SHA_A, "edited"),
      });
      const check = await routed(r, {
        event: "check_run",
        payload: checkRunPayload(r, SHA_A),
      });
      const gone = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 2, "deleted"),
      });
      const startedAt = Date.now();
      for (const created of [issue, pull, check, gone]) {
        assertEquals((await run(f, created.id, github)).kind, "completed");
      }
      assertEquals(reads.map(({ method }) => method), [
        "readIssue",
        "readPullRequest",
        "listCheckRuns",
        "readIssue",
        "readRepositoryIdentity",
      ]);
      assertEquals(
        reads.map(({ held }) => held),
        [0, 0, 0, 0, 0],
        "no transaction or pooled connection is held across a provider call",
      );

      const facts = await factRows(f);
      const issueFact = facts.find(({ number }) => number === 1)!;
      const checkFact = facts.find(({ kind }) => kind === "check_run")!;
      const goneFact = facts.find(({ number }) => number === 2)!;
      const pullRow = (await f.pgDatabase.query<
        { observed_started_at: Date }
      >(
        "select observed_started_at from bakery.pull_requests where repository_id = $1 and provider_number = 7",
        [seed.repositoryId],
      )).rows[0];
      const stamps: [string, Date, number][] = [
        ["issue", issueFact.observed_started_at, reads[0].at],
        ["pull request", pullRow.observed_started_at, reads[1].at],
        ["check run", checkFact.observed_started_at, reads[2].at],
        ["issue marked gone", goneFact.observed_started_at, reads[3].at],
      ];
      for (const [name, stored, calledAt] of stamps) {
        assert(
          stored.getTime() <= calledAt,
          `the ${name} read clock (${stored.toISOString()}) is taken before the call at ${calledAt}`,
        );
        assert(
          stored.getTime() >= startedAt,
          `the ${name} read clock is the time of this read, not an older one`,
        );
      }
      assertEquals(goneFact.state, "gone");
      assert(
        goneFact.observed_started_at > storedBefore.observed_started_at,
        "the gone read began after the read that stored the issue",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 processor: a repository, connection or installation lost during the provider read ends the route ignored with nothing stored", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      await trackPullRequest(f, seed);
      f.github.seedIssues(r.repositoryId, [
        { number: 1, updatedAt: T1 },
        { number: 2, updatedAt: T1 },
        { number: 3, updatedAt: T1 },
      ]);
      f.github.seedPullRequest(r.repositoryId, {
        number: 7,
        headSha: SHA_A,
        baseSha: SHA_B,
        updatedAt: T2,
      });
      f.github.seedCheckRuns(r.repositoryId, SHA_A, [
        { name: "build", completedAt: T2, startedAt: T1 },
      ]);
      // Issues 2 and 3 are stored, so a gone or transferred mark has a fact to mark.
      for (const number of [2, 3]) {
        const stored = await routed(r, {
          event: "issues",
          payload: issuesPayload(r, number, "opened"),
        });
        await run(f, stored.id);
      }
      const storedFacts = await factRows(f);
      assertEquals(storedFacts.length, 2);

      const change = (sql: string, id: string) => () =>
        f.pgDatabase.query(sql, [id]);
      const losses = [
        {
          name: "resource deselected",
          code: "unselected_repository",
          lose: change(
            "update bakery.integration_resources set selected = false where id = $1",
            r.resource.id,
          ),
          restore: change(
            "update bakery.integration_resources set selected = true where id = $1",
            r.resource.id,
          ),
        },
        {
          name: "resource unavailable",
          code: "unselected_repository",
          lose: change(
            "update bakery.integration_resources set available = false where id = $1",
            r.resource.id,
          ),
          restore: change(
            "update bakery.integration_resources set available = true where id = $1",
            r.resource.id,
          ),
        },
        {
          name: "resource archived",
          code: "unselected_repository",
          lose: change(
            "update bakery.integration_resources set archived_at = now() where id = $1",
            r.resource.id,
          ),
          restore: change(
            "update bakery.integration_resources set archived_at = null where id = $1",
            r.resource.id,
          ),
        },
        {
          name: "connection revoked",
          code: "connection_not_enabled",
          lose: change(
            "update bakery.integration_connections set status = 'revoked' where id = $1",
            r.connection.connectionId,
          ),
          restore: change(
            "update bakery.integration_connections set status = 'enabled' where id = $1",
            r.connection.connectionId,
          ),
        },
        {
          name: "connection archived",
          code: "connection_not_enabled",
          lose: change(
            "update bakery.integration_connections set archived_at = now() where id = $1",
            r.connection.connectionId,
          ),
          restore: change(
            "update bakery.integration_connections set archived_at = null where id = $1",
            r.connection.connectionId,
          ),
        },
        {
          name: "installation suspended",
          code: "installation_suspended",
          lose: change(
            "update bakery.integration_installations set status = 'suspended' where id = $1",
            r.installationRowId,
          ),
          restore: change(
            "update bakery.integration_installations set status = 'enabled' where id = $1",
            r.installationRowId,
          ),
        },
      ];
      // `at` is the read the loss lands before; none means the first read.
      const subjects: {
        name: string;
        make: () => Promise<RouteRow>;
        at?: string;
      }[] = [
        {
          name: "issue",
          make: () =>
            routed(r, {
              event: "issues",
              payload: issuesPayload(r, 1, "edited"),
            }),
        },
        {
          name: "pull request",
          make: () =>
            routed(r, {
              event: "pull_request",
              payload: pullRequestPayload(r, 7, SHA_A, "edited"),
            }),
        },
        {
          name: "check run",
          make: () =>
            routed(r, {
              event: "check_run",
              payload: checkRunPayload(r, SHA_A),
            }),
        },
        // A read that would mark a stored fact gone: GitHub has no issue 2.
        {
          name: "gone issue",
          make: () =>
            routed(r, {
              event: "issues",
              payload: issuesPayload(r, 2, "deleted"),
            }),
        },
        // GitHub answers 301 for issue 3 and the repository still has its id:
        // the loss lands between the identity read and the write that marks it.
        {
          name: "transferred issue",
          make: () =>
            routed(r, {
              event: "issues",
              payload: issuesPayload(r, 3, "transferred"),
            }),
          at: "readRepositoryIdentity",
        },
      ];
      f.github.deleteIssue(r.repositoryId, 2);
      f.github.transferIssue(r.repositoryId, 3);
      for (const loss of losses) {
        for (const subject of subjects) {
          const created = await subject.make();
          const outcome = await run(
            f,
            created.id,
            disturbed(
              f,
              subject.at === undefined
                ? once(loss.lose)
                : onceAt(subject.at, loss.lose),
            ),
          );
          await loss.restore();
          assertEquals(
            outcome,
            {
              kind: "ignored",
              code: loss.code,
              notBefore: null,
              tally: null,
            },
            `${loss.name}: ${subject.name} ${created.id}`,
          );
          const state = await routeState(f, created.id);
          assertEquals(
            [state.status, state.outcome_code, state.attempts],
            ["ignored", loss.code, 1],
            `${loss.name}: ${subject.name}`,
          );
        }
      }
      assertEquals(
        await factRows(f),
        storedFacts,
        "no fact was written and neither stored one was marked gone or transferred",
      );
      const pull = (await f.pgDatabase.query<
        { provider_updated_at: Date | null; version: number; status: string }
      >(
        "select provider_updated_at, version, status from bakery.pull_requests where repository_id = $1",
        [seed.repositoryId],
      )).rows[0];
      assertEquals(
        [pull.provider_updated_at, pull.version, pull.status],
        [null, 1, "open"],
        "the pull request row was not observed",
      );

      // With the authority intact the same routes do write.
      const control = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 1, "edited"),
      });
      assertEquals((await run(f, control.id)).kind, "completed");
      assertEquals((await factRows(f)).length, 3);

      // With the authority intact the transfer is recorded: the loss above, not the read, stopped it.
      const transferred = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, 3, "transferred"),
      });
      assertEquals((await run(f, transferred.id)).kind, "completed");
      assertEquals(
        (await factRows(f)).find(({ number }) => number === 3)?.state,
        "gone",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 processor: a worker whose claim another took over writes nothing, even while the taker is still processing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    // Mid-read, a second worker takes the stale claim over: a new version, still processing.
    const slow = disturbed(
      f,
      once(() =>
        f.pgDatabase.query(
          `update bakery.inbound_event_routes
              set version = version + 1, attempts = attempts + 1,
                  updated_at = now()
            where id = $1`,
          [created.id],
        )
      ),
    );
    assertEquals(await run(f, created.id, slow), {
      kind: "skipped",
      reason: "superseded",
    });
    const state = await routeState(f, created.id);
    assertEquals(
      [state.status, state.outcome_code, state.attempts],
      ["processing", null, 2],
      "the taker's claim is untouched",
    );
    assertEquals(await factRows(f), [], "the slow worker's write rolled back");
  });
});

Deno.test("issue 71 processor: a check run the read reports for another commit is never stored", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      await trackPullRequest(f, seed);
      f.github.seedCheckRuns(r.repositoryId, SHA_A, [
        { name: "build", completedAt: T2, startedAt: T1 },
      ]);
      const github: GitHubAppClient = {
        ...f.github.client,
        listCheckRuns: async (request, signal) => {
          const page = await f.github.client.listCheckRuns(request, signal);
          const [first] = page.checkRuns;
          return {
            ...page,
            checkRuns: [...page.checkRuns, {
              ...first,
              id: first.id + 1_000_000,
              name: "other-commit",
              headSha: SHA_B,
            }],
          };
        },
      };
      const created = await routed(r, {
        event: "check_run",
        payload: checkRunPayload(r, SHA_A),
      });
      assertEquals(await run(f, created.id, github), {
        kind: "completed",
        code: "fact_written",
        notBefore: null,
        tally: { written: 1, unchanged: 0, stale: 0, skipped: 1 },
      });
      const facts = await factRows(f);
      assertEquals(facts.map(({ summary }) => summary.name), ["build"]);
      assertEquals(facts.map(({ head_sha }) => head_sha), [SHA_A]);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 processor: a discovery locks the installation row before the connection row", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const rows = {
      installation: {
        id: r.installationRowId,
        lock:
          "select id from bakery.integration_installations where id = $1 for update",
        probe:
          "select id from bakery.integration_installations where id = $1 for update nowait",
      },
      connection: {
        id: r.connection.connectionId,
        lock:
          "select id from bakery.integration_connections where id = $1 for update",
        probe:
          "select id from bakery.integration_connections where id = $1 for update nowait",
      },
    } as const;
    // Holds one row's lock, lets the processor run into it, and reports whether
    // the processor already holds the other row while it waits.
    const whileWaiting = async (
      held: "installation" | "connection",
      other: "installation" | "connection",
      action: string,
      expectLocked: boolean,
    ) => {
      const created = await routed(r, {
        event: "installation_repositories",
        payload: installationPayload(r, action),
      });
      const holder = await f.pgDatabase.connect();
      const prober = await f.pgDatabase.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("begin");
        await holder.query(rows[held].lock, [rows[held].id]);
        const { pid } = (await holder.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        )).rows[0];
        pending = run(f, created.id);
        await waitUntil(
          async () =>
            (await prober.query<{ n: number }>(
              `select count(*)::int as n from pg_locks as l
                where not l.granted and $1::int = any(pg_blocking_pids(l.pid))`,
              [pid],
            )).rows[0].n > 0,
          `the processor to wait for the ${held} row`,
        );
        if (expectLocked) {
          const refused = await assertRejects(() =>
            prober.query(rows[other].probe, [rows[other].id])
          );
          assertEquals(
            (refused as { code?: string }).code,
            "55P03",
            `the ${other} row is locked while the processor waits for the ${held}`,
          );
        } else {
          const free = await prober.query(rows[other].probe, [rows[other].id]);
          assertEquals(
            free.rowCount,
            1,
            `the ${other} row is free while the processor waits for the ${held}`,
          );
        }
        await holder.query("commit");
        const outcome = await pending;
        assertEquals((outcome as { kind: string }).kind, "completed");
      } finally {
        await holder.query("rollback").catch(() => undefined);
        await pending?.catch(() => undefined);
        holder.release();
        prober.release();
      }
    };
    // Waiting on the installation, nothing else is held yet; waiting on the
    // connection, the installation is already held: installation, then connection.
    await whileWaiting("installation", "connection", "added", false);
    await whileWaiting("connection", "installation", "removed", true);
  });
});

Deno.test("issue 71 processor: a failure after the claim that the processor does not classify releases the claim with the back-off and is rethrown", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [
      { number: 1, updatedAt: T1 },
      { number: 2, updatedAt: T1 },
      { number: 3, updatedAt: T1 },
      { number: 4, updatedAt: T1 },
    ]);
    const pool = f.runtimePgDatabase!;
    const waitOf = async (id: string) =>
      (await f.pgDatabase.query<{ wait: number }>(
        `select extract(epoch from (not_before - now()))::float8 as wait
           from bakery.inbound_event_routes where id = $1`,
        [id],
      )).rows[0].wait;
    const aborted = new AbortController();
    const failures: {
      name: string;
      number: number;
      attempt: (id: string) => Promise<unknown>;
      /** The error the caller sees, or null when the read failure is classified. */
      rethrown: string | null;
    }[] = [
      {
        name: "a read that throws an ordinary error",
        number: 1,
        attempt: (id) =>
          run(
            f,
            id,
            disturbed(
              f,
              once(() => Promise.reject(new Error("injected read failure"))),
            ),
          ),
        rethrown: null,
      },
      {
        name: "an abort during the read",
        number: 2,
        attempt: (id) =>
          processRoute(
            dependenciesOf(
              f,
              disturbed(
                f,
                once(() => {
                  aborted.abort(new Error("injected shutdown"));
                  return Promise.reject(new Error("injected read failure"));
                }),
              ),
            ),
            id,
            aborted.signal,
          ),
        rethrown: "injected shutdown",
      },
      {
        name: "the database failing while the authority is read",
        number: 3,
        attempt: (id) =>
          processRoute(
            { ...dependenciesOf(f), database: flakyDatabase(pool, 2) },
            id,
            new AbortController().signal,
          ),
        rethrown: "injected connection failure",
      },
      {
        name: "the database failing while the route settles",
        number: 4,
        attempt: (id) =>
          processRoute(
            { ...dependenciesOf(f), database: flakyDatabase(pool, 3) },
            id,
            new AbortController().signal,
          ),
        rethrown: "injected connection failure",
      },
    ];
    let completed = 0;
    for (const failure of failures) {
      const created = await routed(r, {
        event: "issues",
        payload: issuesPayload(r, failure.number, "opened"),
      });
      if (failure.rethrown === null) {
        const outcome = await failure.attempt(created.id) as {
          kind: string;
          code: string;
        };
        assertEquals([outcome.kind, outcome.code], [
          "deferred",
          "provider_error",
        ], failure.name);
      } else {
        await assertRejects(
          () => failure.attempt(created.id),
          Error,
          failure.rethrown,
          failure.name,
        );
      }
      // Not stuck in `processing` for ten minutes: deferred, back-off 60 s, attempts kept.
      const released = await routeState(f, created.id);
      assertEquals(
        [released.status, released.outcome_code, released.attempts],
        ["deferred", "provider_error", 1],
        failure.name,
      );
      const wait = await waitOf(created.id);
      assert(
        wait > 45 && wait <= 60,
        `${failure.name}: waits about 60 s, not ${wait}`,
      );
      assertEquals((await factRows(f)).length, completed, failure.name);
      assertEquals(
        await run(f, created.id),
        { kind: "skipped", reason: "not_due" },
        `${failure.name}: a retry before the back-off ends is not in progress`,
      );

      // Due again: the next run, by the function's retry or the recovery cron, finishes it.
      await makeDue(f, created.id);
      const listed = await dueRoutes(f.runtimePgDatabase!);
      assert(listed.some(({ id }) => id === created.id), failure.name);
      const finished = await run(f, created.id);
      assertEquals(
        finished.kind === "skipped" ? null : finished.code,
        "fact_written",
        failure.name,
      );
      completed += 1;
      const done = await routeState(f, created.id);
      assertEquals(
        [done.status, done.attempts],
        ["completed", 2],
        failure.name,
      );
      assertEquals((await factRows(f)).length, completed, failure.name);
    }
  });
});

Deno.test("issue 71 processor: releasing a failed claim leaves a route another worker took over alone", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    f.github.seedIssues(r.repositoryId, [{ number: 1, updatedAt: T1 }]);
    const created = await routed(r, {
      event: "issues",
      payload: issuesPayload(r, 1, "opened"),
    });
    const aborted = new AbortController();
    const slow = disturbed(
      f,
      once(async () => {
        // The taker claims the stale route (version and attempts move) and is still working.
        await f.pgDatabase.query(
          `update bakery.inbound_event_routes
              set version = version + 1, attempts = attempts + 1,
                  updated_at = now()
            where id = $1`,
          [created.id],
        );
        aborted.abort(new Error("injected shutdown"));
        throw new Error("injected read failure");
      }),
    );
    await assertRejects(
      () => run(f, created.id, slow, aborted.signal),
      Error,
      "injected shutdown",
    );
    const state = await routeState(f, created.id);
    assertEquals(
      [state.status, state.outcome_code, state.attempts],
      ["processing", null, 2],
      "the taker's claim is not released by the worker that lost it",
    );
  });
});
