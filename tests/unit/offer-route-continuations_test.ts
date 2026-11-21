import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  ineligibleReason,
  listRouteContinuations,
  readRunsWaitingOnModel,
  UNAVAILABLE_ROUTE_NAMES_CAP,
} from "../../apps/server/src/modules/execution/route-continuations.ts";

/**
 * The route continuation offers without a database (#26 slice 6a).
 *
 * The integration file runs the query against real rows. These tests pin the
 * decisions that do not need one: a terminal run and an absent run, the
 * organization as a predicate on every statement, the shape of an offer, and
 * the one reason a candidate route gives for not being eligible, the counts the
 * unusable routes are told as, the price flag and the display names.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INCIDENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Statement = { sql: string; values: readonly unknown[] };

function stand(world: {
  run?: { status: string } | null;
  stalled?: Record<string, unknown>[];
  candidates?: Record<string, unknown>[];
  /** Account ids that have a billing identity, and identities with a price. */
  accounts?: Record<string, string>;
  priced?: string[];
}) {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      if (/from bakery\.workflow_runs\s+where/.test(sql)) {
        return Promise.resolve({
          rows: world.run === null || world.run === undefined
            ? []
            : [world.run],
        });
      }
      if (/join bakery\.run_steps/.test(sql)) {
        return Promise.resolve({ rows: world.stalled ?? [] });
      }
      if (/from bakery\.provider_routes\s+where/.test(sql)) {
        return Promise.resolve({ rows: world.candidates ?? [] });
      }
      if (/from bakery\.model_provider_accounts/.test(sql)) {
        const identity = world.accounts?.[String(values[1])];
        return Promise.resolve({
          rows: identity === undefined ? [] : [{ billing_identity: identity }],
        });
      }
      if (/from bakery\.provider_pricing_snapshots/.test(sql)) {
        const key = `${values[0]}/${values[2]}/${values[1]}/${values[3]}`;
        return Promise.resolve({
          rows: (world.priced ?? []).includes(key)
            ? [{ id: "snap", pricing_metadata_snapshot: "{}" }]
            : [],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { transaction, recorded };
}

const context = (transaction: unknown, id: string | undefined = RUN) =>
  ({
    params: id === undefined ? {} : { id },
    signal: new AbortController().signal,
    transaction,
    authority: { organizationId: ORG, subject: { principalId: "p" } },
  }) as unknown as ActionContext;

const stalledRow = {
  run_step_id: STEP,
  step_key: "implement",
  run_version: 4,
  source_route_id: SOURCE,
  source_harness: "pi",
  source_provider: "anthropic",
  source_model: "claude-x",
  source_billing_route: "subscription",
  source_health: "open",
  incident_id: INCIDENT,
  incident_generation: 2,
  incident_reason: "quota_exhausted",
  incident_opened_at: new Date("2026-11-20T10:00:00.000Z"),
  incident_next_probe_at: new Date("2026-11-20T10:05:00.000Z"),
};

const route = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  provider: "anthropic",
  model: "claude-x",
  harness: "pi",
  billing_route: "api_metered",
  status: "active",
  health: "healthy",
  provider_account_id: null,
  ...overrides,
});

Deno.test("an absent run, and another organization's run, is not found", async () => {
  const { transaction, recorded } = stand({ run: null });
  const error = await assertRejects(
    () => listRouteContinuations(context(transaction), {}),
    StandardError,
  );
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
  // The run is looked up inside the organization, so a foreign id is absent.
  assertEquals(recorded[0]!.values, [ORG, RUN]);
  assertEquals(recorded.length, 1);
});

Deno.test("a request with no run id is not found", async () => {
  const { transaction } = stand({});
  await assertRejects(
    () => listRouteContinuations(context(transaction, undefined), {}),
    StandardError,
  );
});

Deno.test("a terminal run has no offers and asks nothing further", async () => {
  for (const status of ["completed", "failed", "canceled", "blocked"]) {
    const { transaction, recorded } = stand({ run: { status } });
    const result = await listRouteContinuations(context(transaction), {});
    assertEquals(result, { runId: RUN, offers: [] }, status);
    assertEquals(recorded.length, 1, status);
  }
});

Deno.test("a run with nothing stalled has no offers and does not list routes", async () => {
  const { transaction, recorded } = stand({
    run: { status: "running" },
    stalled: [],
  });
  assertEquals(
    await listRouteContinuations(context(transaction), {}),
    { runId: RUN, offers: [] },
  );
  assert(
    !recorded.some(({ sql }) =>
      /from bakery\.provider_routes\s+where/.test(sql)
    ),
  );
});

Deno.test("every statement is a select inside the organization", async () => {
  const { transaction, recorded } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE)],
  });
  await listRouteContinuations(context(transaction), {});
  assertEquals(recorded.length, 3);
  for (const { sql, values } of recorded) {
    assert(/^\s*select/i.test(sql), sql);
    assertEquals(values[0], ORG, sql);
    assert(/organization_id/.test(sql), sql);
  }
  // The stalled-step query is scoped to the run, counts only a job sitting
  // queued (a leased or running attempt is still working), and excludes steps
  // that were already continued for this incident generation.
  const stalledQuery = recorded[1]!;
  assertEquals(stalledQuery.values[1], RUN);
  assert(/j\.status = any/.test(stalledQuery.sql));
  assertEquals(stalledQuery.values[2], ["queued"]);
  // Only an open incident stalls a step: a route may still point at one that has
  // recovered or been superseded, and that link must not make an offer.
  assert(/i\.status = 'open'/.test(stalledQuery.sql));
  assert(/not exists[\s\S]*route_continuations/.test(stalledQuery.sql));
});

Deno.test("an offer names the incident generation and run version a submission must carry", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE), route("e1")],
  });
  const result = await listRouteContinuations(context(transaction), {});
  assertEquals(result.offers.length, 1);
  const offer = result.offers[0]!;
  assertEquals(offer.runStepId, STEP);
  assertEquals(offer.stepKey, "implement");
  assertEquals(offer.incidentId, INCIDENT);
  assertEquals(offer.incidentGeneration, 2);
  assertEquals(offer.sourceRouteId, SOURCE);
  assertEquals(offer.runVersion, 4);
  // No estimate exists yet: null is unknown, never free.
  assertEquals(offer.targets[0]!.estimatedIncrementalCost, null);
});

Deno.test("an offer names what the step waits on, why, since when and the next check", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow, {
      ...stalledRow,
      run_step_id: "f1",
      incident_next_probe_at: null,
    }],
    candidates: [route(SOURCE)],
  });
  const [offer, unscheduled] = (await listRouteContinuations(
    context(transaction),
    {},
  )).offers;
  assertEquals(offer!.source, {
    provider: "anthropic",
    model: "claude-x",
    providerName: "Anthropic",
    modelName: "claude-x",
    harness: "pi",
    billingRoute: "subscription",
    health: "open",
  });
  assertEquals(offer!.reason, "quota_exhausted");
  assertEquals(offer!.since, "2026-11-20T10:00:00.000Z");
  assertEquals(offer!.nextCheckAt, "2026-11-20T10:05:00.000Z");
  assertEquals(unscheduled!.nextCheckAt, null);
});

Deno.test("the runs read asks once per page which runs wait on a model, by the offers' rule", async () => {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      return Promise.resolve({ rows: [{ run_id: RUN }] });
    },
  };
  assertEquals(
    await readRunsWaitingOnModel(transaction as never, ORG, []),
    new Set(),
  );
  assertEquals(recorded.length, 0);
  const waiting = await readRunsWaitingOnModel(transaction as never, ORG, [
    RUN,
    STEP,
  ]);
  assertEquals(waiting, new Set([RUN]));
  assertEquals(recorded.length, 1);
  const { sql, values } = recorded[0]!;
  assertEquals(values.slice(0, 2), [ORG, [RUN, STEP]]);
  assert(/i\.status = 'open'/.test(sql));
  assert(/not exists[\s\S]*route_continuations/.test(sql));
  assert(/r\.status <> all\(\$4::text\[\]\)/.test(sql));
});

Deno.test("the source route is never a candidate, and every other usable route is listed", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE), route("e1"), route("e2")],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  assertEquals(offer.targets.map((target) => target.routeId), ["e1", "e2"]);
  assertEquals(offer.unavailable, []);
});

Deno.test("a candidate gives exactly one reason for not being eligible, or none", () => {
  const reason = (overrides: Record<string, unknown>) =>
    ineligibleReason(
      route("r", overrides) as Parameters<typeof ineligibleReason>[0],
      "pi",
    );
  assertEquals(reason({}), null);
  assertEquals(reason({ health: "degraded" }), null);
  assertEquals(reason({ health: "unverified" }), null);
  assertEquals(reason({ status: "disabled" }), "route_not_active");
  assertEquals(reason({ status: "revoked" }), "route_not_active");
  assertEquals(reason({ harness: "codex" }), "different_harness");
  assertEquals(reason({ health: "open" }), "route_open");
  // Several reasons at once: the one a person would fix first is reported.
  assertEquals(
    reason({ status: "disabled", harness: "codex" }),
    "route_not_active",
  );
  assertEquals(
    reason({ harness: "codex", health: "open" }),
    "different_harness",
  );
});

const TURNED_OFF = {
  provider: "anthropic",
  model: "claude-x",
  providerName: "Anthropic",
  modelName: "claude-x",
};

Deno.test("only usable routes are targets; the rest are counts per reason, never rows", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [
      route(SOURCE),
      route("ok"),
      route("degraded", { health: "degraded" }),
      route("unverified", { health: "unverified" }),
      route("disabled", { status: "disabled" }),
      route("revoked", { status: "revoked" }),
      route("codex-1", { harness: "codex" }),
      route("codex-2", { harness: "codex" }),
      route("claude", { harness: "claude_code" }),
      route("down", { health: "open", provider: "openai", model: "gpt-5" }),
      route("disabled-and-codex", { status: "disabled", harness: "codex" }),
      route("codex-and-down", { harness: "codex", health: "open" }),
    ],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  assertEquals(offer.targets.map((target) => target.routeId), [
    "ok",
    "degraded",
    "unverified",
  ]);
  assertEquals(offer.unavailable, [
    // Turned off routes are named too, so a person sees which to turn on.
    {
      reason: "route_not_active",
      count: 3,
      routes: [TURNED_OFF, TURNED_OFF, TURNED_OFF],
    },
    {
      reason: "different_harness",
      count: 4,
      harnesses: [
        { harness: "codex", count: 3 },
        { harness: "claude_code", count: 1 },
      ],
    },
    {
      reason: "route_open",
      count: 1,
      routes: [{
        provider: "openai",
        model: "gpt-5",
        providerName: "OpenAI",
        modelName: "gpt-5",
      }],
    },
  ]);
});

Deno.test("open routes are named at most up to the cap, and still all counted", async () => {
  const down = Array.from(
    { length: UNAVAILABLE_ROUTE_NAMES_CAP + 5 },
    (_, n) => route(`down-${n}`, { health: "open", model: `m-${n}` }),
  );
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE), ...down],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  assertEquals(offer.targets, []);
  const open = offer.unavailable[0]!;
  assertEquals(open.reason, "route_open");
  assertEquals(open.count, UNAVAILABLE_ROUTE_NAMES_CAP + 5);
  assertEquals(open.routes!.length, UNAVAILABLE_ROUTE_NAMES_CAP);
  assertEquals(open.routes![0]!.model, "m-0");
});

Deno.test("turned off routes are named at most up to the cap, and still all counted", async () => {
  const off = Array.from(
    { length: UNAVAILABLE_ROUTE_NAMES_CAP + 2 },
    (_, n) => route(`off-${n}`, { status: "disabled", model: `m-${n}` }),
  );
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE), ...off],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  const turnedOff = offer.unavailable[0]!;
  assertEquals(turnedOff.reason, "route_not_active");
  assertEquals(turnedOff.count, UNAVAILABLE_ROUTE_NAMES_CAP + 2);
  assertEquals(turnedOff.routes!.length, UNAVAILABLE_ROUTE_NAMES_CAP);
  assertEquals(turnedOff.routes![0], {
    provider: "anthropic",
    model: "m-0",
    providerName: "Anthropic",
    modelName: "m-0",
  });
});

Deno.test("a target is priced only with an account and an active price for its pin", async () => {
  const { transaction, recorded } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [
      route(SOURCE),
      route("priced", { provider_account_id: "acct-1" }),
      route("no-price", { provider_account_id: "acct-1", model: "claude-z" }),
      route("no-account", { provider_account_id: null }),
      route("unknown-account", { provider_account_id: "acct-gone" }),
      route("local", { billing_route: "local", provider_account_id: "acct-1" }),
    ],
    accounts: { "acct-1": "identity-1" },
    priced: ["anthropic/claude-x/identity-1/api"],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  const priced = Object.fromEntries(
    offer.targets.map((target) => [target.routeId, target.priced]),
  );
  assertEquals(priced, {
    priced: true,
    "no-price": false,
    "no-account": false,
    "unknown-account": false,
    local: false,
  });
  // The account read is inside the organization like every other statement.
  for (
    const { sql, values } of recorded.filter(({ sql }) =>
      /model_provider_accounts/.test(sql)
    )
  ) {
    assertEquals(values[0], ORG);
    assert(/organization_id = \$1/.test(sql));
  }
});

Deno.test("providers and models carry names a person reads, or their key", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [
      route(SOURCE),
      route("o", { provider: "openrouter", model: "x/y" }),
      route("k", { provider: "some-new-lab", model: "nova-1" }),
    ],
  });
  const offer = (await listRouteContinuations(context(transaction), {}))
    .offers[0]!;
  assertEquals(offer.source.providerName, "Anthropic");
  assertEquals(offer.source.modelName, "claude-x");
  assertEquals(
    offer.targets.map((
      { providerName, modelName },
    ) => [providerName, modelName]),
    [["OpenRouter", "x/y"], ["some-new-lab", "nova-1"]],
  );
});

Deno.test("the stalled-step query returns one row per step in a fixed order", async () => {
  const { transaction, recorded } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE)],
  });
  await listRouteContinuations(context(transaction), {});
  const sql =
    recorded.find(({ sql }) => /join bakery\.run_steps/.test(sql))!.sql;
  // Several live jobs, or several routes sharing a pin, must not multiply the offer.
  assert(/distinct on \(s\.id\)/.test(sql));
  // The tie-break is fixed, so the same data always gives the same offer.
  assert(/order by s\.id, i\.opened_at, pr\.id, j\.id/.test(sql));
});
