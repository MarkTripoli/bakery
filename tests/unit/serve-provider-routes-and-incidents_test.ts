import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import {
  createProviderReadHandlers,
  toProviderIncident,
  toProviderRoute,
  toRouteHealth,
} from "../../apps/server/src/modules/execution/provider-reads.ts";

/**
 * #26 slice 2 without a database: what the handlers decide, and what the SQL
 * they emit is allowed to ask for.
 *
 * The integration file drives the same handlers through the mounted route
 * against a real database, which is where the filters and the keyset actually
 * execute. These tests cover the decisions that do not need one, and they pin
 * the two things a database run can hide because the data happens to agree:
 *
 *  - the organization is a predicate in the query, not a filter afterwards, so
 *    a row from another organization is never loaded;
 *  - every statement is a `select`. A read that could write is a read nobody
 *    reviewed.
 */

const SECRET = "provider-read-cursor-secret";
// The cursor binding compares ids as UUIDs, so the fixture uses real ones
// rather than placeholders that would make every assertion a false negative.
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
// A cursor's position is (time, id) and the id is a UUID, so the stand-in rows
// carry real ones: a placeholder would fail binding validation and look like a
// handler bug.
const ROUTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUTE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROUTE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * A page as a test reads it.
 *
 * The handler's declared output is the contract's JSON value, which is the right
 * type for a transport but useless in an assertion. This narrows it once here
 * rather than casting at every use.
 */
type Page = { items: { id: string }[]; nextCursor: string | null };

function asPage(value: unknown): Page {
  return value as Page;
}

type Recorded = { sql: string; values: readonly unknown[] };

/**
 * A transaction stand-in that answers each statement from a queue.
 *
 * It records what was asked so a test can assert on the statement itself: the
 * shape of the query is the thing under test here, and a stand-in that answered
 * from a table would only prove the stand-in works.
 */
function recordingTransaction(
  answers: readonly { rows: unknown[] }[],
) {
  const recorded: Recorded[] = [];
  let index = 0;
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      const answer = answers[index++] ?? { rows: [] };
      return Promise.resolve(answer);
    },
  };
  return { transaction, recorded };
}

function context(
  transaction: {
    query: (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{ rows: unknown[] }>;
  },
  params: Record<string, string> = {},
): ActionContext {
  // The context the router hands a handler once authority has been established:
  // a transaction and the organization actor it was authorized as. Building it
  // here rather than stubbing `requireWorkTransaction` keeps the handler on the
  // same access path production takes.
  return {
    params,
    signal: new AbortController().signal,
    transaction,
    authority: {
      organizationId: ORG_ID,
      subject: { principalId: PRINCIPAL_ID },
    },
  } as unknown as ActionContext;
}

const routeRow = {
  id: "route-1",
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  region: null,
  model: "gpt-5",
  harness: "pi",
  billing_route: "api_metered",
  provider_account_id: null,
  worker_binding_id: null,
  credential_location: "harness_host",
  status: "active",
  health: "degraded",
  incident_id: "incident-1",
  incident_generation: 2,
  last_probe_at: new Date("2026-11-18T09:00:00.000Z"),
  next_probe_at: null,
  inference_verified_at: null,
  created_at: new Date("2026-11-18T08:00:00.000Z"),
  updated_at: new Date("2026-11-18T09:00:00.000Z"),
  version: 3,
};

const incidentRow = {
  id: "incident-1",
  route_id: "route-1",
  generation: 2,
  status: "open",
  severity: "outage",
  reason: "credential_invalid",
  first_failure_at: new Date("2026-11-18T07:00:00.000Z"),
  last_failure_at: new Date("2026-11-18T09:00:00.000Z"),
  last_probe_at: null,
  next_probe_at: null,
  evidence_watermark: null,
  affected_task_count: 4,
  recovered_task_count: 1,
  switched_task_count: 0,
  still_blocked_task_count: 3,
  opened_at: new Date("2026-11-18T07:00:00.000Z"),
  closed_at: null,
  updated_at: new Date("2026-11-18T09:00:00.000Z"),
  version: 1,
};

Deno.test("a route projects every contract field, with nulls as null", () => {
  const route = toProviderRoute(routeRow);
  assertEquals(route.id, "route-1");
  assertEquals(route.health, "degraded");
  assertEquals(route.incidentId, "incident-1");
  assertEquals(route.incidentGeneration, 2);
  assertEquals(route.lastProbeAt, "2026-11-18T09:00:00.000Z");
  // The nullable fields are `null`, not absent: a reader must be able to tell
  // "no probe yet" from "the key vanished".
  assertEquals(route.nextProbeAt, null);
  assertEquals(route.region, null);
  assertEquals(route.providerAccountId, null);
  assertEquals(route.workerBindingId, null);
  // Reachability is not inference proof, and this row has none.
  assertEquals(route.inferenceVerifiedAt, null);
});

Deno.test("health carries reachability and inference proof as separate facts", () => {
  const health = toRouteHealth({
    route_id: "route-1",
    health: "open",
    reason: "reachable_inference_unverified",
    reason_since: null,
    consecutive_failures: 5,
    consecutive_inference_trials: 2,
    evidence_watermark: "sha256:abc",
    last_failure_at: new Date("2026-11-18T09:00:00.000Z"),
    last_success_at: null,
    last_probe_at: null,
    next_probe_at: null,
    probe_lease_expires_at: null,
    corroboration: "status_page",
    incident_id: "incident-1",
    incident_generation: 2,
    inference_verified_at: null,
    updated_at: new Date("2026-11-18T09:00:00.000Z"),
  });
  // A status page proves the service is reachable; it says nothing about the
  // inference path, so the two columns stay independent here.
  assertEquals(health.corroboration, "status_page");
  assertEquals(health.inferenceVerifiedAt, null);
  assertEquals(health.consecutiveFailures, 5);
  assertEquals(health.consecutiveInferenceTrials, 2);
  assertEquals(health.reasonSince, null);
});

Deno.test("health says how long a reason has held, and a redirect is a reason", () => {
  const health = toRouteHealth({
    route_id: "route-1",
    health: "unverified",
    reason: "redirected",
    reason_since: new Date("2026-11-19T12:00:00.000Z"),
    consecutive_failures: 0,
    consecutive_inference_trials: 0,
    evidence_watermark: "probe:1",
    last_failure_at: null,
    last_success_at: null,
    last_probe_at: new Date("2026-11-19T12:05:00.000Z"),
    next_probe_at: null,
    probe_lease_expires_at: null,
    corroboration: "none",
    incident_id: null,
    incident_generation: 0,
    inference_verified_at: null,
    updated_at: new Date("2026-11-19T12:05:00.000Z"),
  });
  assertEquals(health.reason, "redirected");
  // Since the reason began, not since the last probe: the two differ.
  assertEquals(health.reasonSince, "2026-11-19T12:00:00.000Z");
  assertEquals(health.lastProbeAt, "2026-11-19T12:05:00.000Z");
});

Deno.test("an incident's task counts are its own, not recomputed", () => {
  const incident = toProviderIncident(incidentRow);
  assertEquals(incident.affectedTaskCount, 4);
  assertEquals(incident.recoveredTaskCount, 1);
  assertEquals(incident.switchedTaskCount, 0);
  assertEquals(incident.stillBlockedTaskCount, 3);
  // An open incident has not closed.
  assertEquals(incident.closedAt, null);
  assertEquals(incident.generation, 2);
});

Deno.test("the route list scopes by organization inside the query", async () => {
  const { transaction, recorded } = recordingTransaction([{
    rows: [{
      ...routeRow,
      cursor_created_at: "2026-11-18T08:00:00.000000Z",
    }],
  }]);
  const handlers = createProviderReadHandlers(SECRET);
  await handlers.listRoutes(context(transaction), { limit: 10 });

  const [query] = recorded;
  assert(query);
  // The organization is a predicate, so a row from elsewhere is never loaded
  // and cannot leak through a missing filter downstream.
  assert(/where organization_id = \$1/.test(query.sql));
  assertEquals(query.values[0], ORG_ID);
  // A read may not write. Asserting the verb here is cheap and catches a
  // copy-paste from a command handler.
  assert(/^\s*select\b/i.test(query.sql.trim()));
});

Deno.test("the route list fetches one row beyond the page to know it continues", async () => {
  const rows = [
    {
      ...routeRow,
      id: ROUTE_A,
      cursor_created_at: "2026-11-18T09:00:00.000000Z",
    },
    {
      ...routeRow,
      id: ROUTE_B,
      cursor_created_at: "2026-11-18T08:00:00.000000Z",
    },
    {
      ...routeRow,
      id: ROUTE_C,
      cursor_created_at: "2026-11-18T07:00:00.000000Z",
    },
  ];
  const { transaction, recorded } = recordingTransaction([{ rows }]);
  const handlers = createProviderReadHandlers(SECRET);
  const page = asPage(
    await handlers.listRoutes(context(transaction), { limit: 2 }),
  );

  // `limit + 1` is what makes "is there another page" answerable without a
  // second count query.
  assertEquals(recorded[0]!.values.at(-1), 3);
  assertEquals(page.items.map((item) => item.id), [ROUTE_A, ROUTE_B]);
  assert(page.nextCursor !== null);

  // The last page answers null rather than a cursor that would return nothing.
  const exhausted = recordingTransaction([{ rows: rows.slice(0, 1) }]);
  const lastPage = asPage(
    await createProviderReadHandlers(SECRET).listRoutes(
      context(exhausted.transaction),
      { limit: 2 },
    ),
  );
  assertEquals(lastPage.nextCursor, null);
});

Deno.test("the next page asks for keys after the cursor, not an offset", async () => {
  const { transaction, recorded } = recordingTransaction([
    // Two rows for a page of one: the second is what proves the page continues,
    // and the cursor must name the first.
    {
      rows: [
        {
          ...routeRow,
          id: ROUTE_A,
          cursor_created_at: "2026-11-18T09:00:00.000000Z",
        },
        {
          ...routeRow,
          id: ROUTE_B,
          cursor_created_at: "2026-11-18T08:00:00.000000Z",
        },
      ],
    },
    { rows: [] },
  ]);
  const handlers = createProviderReadHandlers(SECRET);
  const first = asPage(
    await handlers.listRoutes(context(transaction), { limit: 1 }),
  );
  assert(first.nextCursor !== null);
  await handlers.listRoutes(context(transaction), {
    limit: 1,
    cursor: first.nextCursor,
  });

  const paged = recorded[1]!;
  // A keyset comparison, never an offset: an offset would skip or repeat rows
  // when another route is created between two pages.
  assert(/\(created_at, id\) < \(\$4, \$5::uuid\)/.test(paged.sql));
  assertEquals(paged.values[3], "2026-11-18T09:00:00.000000Z");
  assertEquals(paged.values[4], ROUTE_A);
  assert(!/offset/i.test(paged.sql));
});

Deno.test("a cursor replayed under a different filter is refused", async () => {
  const { transaction } = recordingTransaction([
    {
      rows: [
        {
          ...routeRow,
          id: ROUTE_A,
          cursor_created_at: "2026-11-18T09:00:00.000000Z",
        },
        {
          ...routeRow,
          id: ROUTE_B,
          cursor_created_at: "2026-11-18T08:00:00.000000Z",
        },
      ],
    },
  ]);
  const handlers = createProviderReadHandlers(SECRET);
  const first = asPage(
    await handlers.listRoutes(context(transaction), {
      limit: 1,
      health: "healthy",
    }),
  );
  assert(first.nextCursor !== null);

  // The same cursor names a page of "healthy routes"; asking for every route
  // with it is a different question, and answering it would return a page from
  // the wrong one.
  await assertRejects(
    () =>
      handlers.listRoutes(context(transaction), {
        limit: 1,
        cursor: first.nextCursor,
      }),
    StandardError,
  );
});

Deno.test("the incident list filters on the three named axes", async () => {
  const { transaction, recorded } = recordingTransaction([{ rows: [] }]);
  const handlers = createProviderReadHandlers(SECRET);
  await handlers.listIncidents(context(transaction), {
    routeId: "route-1",
    status: "open",
    severity: "outage",
    limit: 5,
  });
  const [query] = recorded;
  assert(query);
  assert(/route_id = \$2/.test(query.sql));
  assert(/status = \$3/.test(query.sql));
  assert(/severity = \$4/.test(query.sql));
  assertEquals(query.values.slice(0, 4), [
    ORG_ID,
    "route-1",
    "open",
    "outage",
  ]);
  assert(/^\s*select\b/i.test(query.sql.trim()));
});

Deno.test("an unknown id is absent, and no read settles for a partial row", async () => {
  const { transaction } = recordingTransaction([{ rows: [] }]);
  const handlers = createProviderReadHandlers(SECRET);
  for (
    const read of [
      handlers.getRoute,
      handlers.getRouteHealth,
      handlers.getIncident,
    ]
  ) {
    await assertRejects(
      () => read(context(transaction, { id: "missing" }), undefined),
      StandardError,
    );
  }
});

Deno.test("a route with no health row answers from the route's own projection", async () => {
  const { transaction, recorded } = recordingTransaction([
    // No health row...
    { rows: [] },
    // ...but the route exists, and it carries the same projection.
    {
      rows: [{
        id: "route-1",
        health: "degraded",
        updated_at: new Date("2026-11-18T09:30:00.000Z"),
      }],
    },
  ]);
  const handlers = createProviderReadHandlers(SECRET);
  const health = await handlers.getRouteHealth(
    context(transaction, { id: "route-1" }),
    undefined,
  );
  assertEquals(health.health, "degraded");
  assertEquals(health.consecutiveFailures, 0);
  assertEquals(health.corroboration, "none");
  // `updatedAt` is non-null in the contract, so it comes from the route rather
  // than being invented or left out.
  assertEquals(health.updatedAt, "2026-11-18T09:30:00.000Z");
  // The second statement is the existence proof, not a health read.
  assert(/from bakery\.provider_routes/.test(recorded[1]!.sql));
});

Deno.test("the registered policy matches the catalog for all five reads", () => {
  // QA could not boot the server at 22c86c60: the catalog said every provider
  // read was `none` while the handlers registered
  // `RequiredAuthenticatedContext`, and `createApp` compares the two. The
  // handler tests never saw it because they call the handler directly with a
  // context they built themselves.
  //
  // This is that comparison without a database: the same rows `createApp` reads,
  // checked against the fact the handlers register. The full boot (which needs
  // PostgreSQL) lives in the recovery lane.
  const reads = [
    "providerRoutes.list",
    "providerRoutes.get",
    "providerRoutes.health",
    "providerIncidents.list",
    "providerIncidents.get",
  ] as const;
  for (const action of reads) {
    const row = catalogActions.find((entry) => entry.action === action);
    assert(row !== undefined, `catalog has no row for ${action}`);
    assertEquals(
      row.organizationContext,
      "required_authenticated_context",
      `${action} is organization-scoped in the catalog, as the handler registers`,
    );
    assertEquals(row.access, "Developer", `${action} access agrees`);
  }
});
