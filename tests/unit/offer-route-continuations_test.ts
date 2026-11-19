import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { listRouteContinuations } from "../../apps/server/src/modules/execution/route-continuations.ts";

/**
 * The route continuation offers without a database (#26 slice 6a).
 *
 * The integration file runs the query against real rows. These tests pin the
 * decisions that do not need one: a terminal run and an absent run, the
 * organization as a predicate on every statement, the shape of an offer, and
 * the one reason a candidate route gives for not being eligible.
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
  incident_id: INCIDENT,
  incident_generation: 2,
};

const route = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  provider: "anthropic",
  model: "claude-x",
  harness: "pi",
  billing_route: "api_metered",
  status: "active",
  health: "healthy",
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
  // The stalled-step query is scoped to the run and excludes terminal jobs and
  // steps that were already continued for this incident generation.
  const stalledQuery = recorded[1]!;
  assertEquals(stalledQuery.values[1], RUN);
  assert(/j\.status <> all/.test(stalledQuery.sql));
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
  // No estimate exists yet; the budget recheck that fills it is a later slice.
  assertEquals(offer.estimatedIncrementalCost, null);
});

Deno.test("the source route is never a candidate, and every other route is listed", async () => {
  const { transaction } = stand({
    run: { status: "running" },
    stalled: [stalledRow],
    candidates: [route(SOURCE), route("e1"), route("e2")],
  });
  const targets =
    (await listRouteContinuations(context(transaction), {})).offers[0]!.targets;
  assertEquals(targets.map((target) => target.routeId), ["e1", "e2"]);
});

Deno.test("a candidate gives exactly one reason for not being eligible, or none", async () => {
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
      route("harness", { harness: "codex" }),
      route("down", { health: "open" }),
      // Several reasons at once: the one a person would fix first is reported.
      route("disabled-and-codex", { status: "disabled", harness: "codex" }),
      route("codex-and-down", { harness: "codex", health: "open" }),
    ],
  });
  const targets =
    (await listRouteContinuations(context(transaction), {})).offers[0]!.targets;
  const by = (id: string) => targets.find((target) => target.routeId === id)!;
  for (const id of ["ok", "degraded", "unverified"]) {
    assertEquals(by(id).eligible, true, id);
    assertEquals(by(id).ineligibleReason, null, id);
  }
  assertEquals(by("disabled").ineligibleReason, "route_not_active");
  assertEquals(by("revoked").ineligibleReason, "route_not_active");
  assertEquals(by("harness").ineligibleReason, "different_harness");
  assertEquals(by("down").ineligibleReason, "route_open");
  assertEquals(by("disabled-and-codex").ineligibleReason, "route_not_active");
  assertEquals(by("codex-and-down").ineligibleReason, "different_harness");
  for (const id of ["disabled", "revoked", "harness", "down"]) {
    assertEquals(by(id).eligible, false, id);
  }
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
