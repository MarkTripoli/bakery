import { assert, assertEquals } from "@std/assert";
import {
  type ProbeOutcome,
  recordProbeResult,
} from "../../apps/server/src/modules/execution/provider-incidents.ts";

/**
 * The probe writer's decisions without a database (#26 slice 2, writes; AC1 and
 * AC2).
 *
 * The integration file runs the same function against Postgres, where the lock,
 * the upsert and the one-open-incident index execute. These tests pin the
 * decisions that do not need one, and the two rules a database run can hide:
 *
 *  - a result carrying any generation but the route's current one changes
 *    nothing, so a stale probe cannot open, advance or close an incident;
 *  - only a proven inference closes an incident. A failure keeps it open and an
 *    answered health read keeps it open too.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const ROUTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INCIDENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-11-19T12:00:00.000Z");

type Statement = { sql: string; values: readonly unknown[] };

type World = {
  route?: {
    status: string;
    health: string;
    incident_id: string | null;
    incident_generation: number;
  } | null;
  health?: { evidence_watermark: string | null; consecutive_failures: number };
  incident?: { id: string; generation: number; severity: string };
};

function stand(world: World) {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      if (/from bakery\.provider_routes/.test(sql)) {
        return Promise.resolve({
          rows: world.route === null || world.route === undefined
            ? []
            : [world.route],
        });
      }
      if (/from bakery\.provider_route_health/.test(sql)) {
        return Promise.resolve({ rows: world.health ? [world.health] : [] });
      }
      if (/from bakery\.provider_incidents/.test(sql)) {
        return Promise.resolve({
          rows: world.incident ? [world.incident] : [],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { transaction, recorded };
}

const writes = (recorded: Statement[]) =>
  recorded.filter(({ sql }) => /^\s*(insert|update|delete)/i.test(sql));

const route = (overrides: Partial<NonNullable<World["route"]>> = {}) => ({
  status: "active",
  health: "unverified",
  incident_id: null,
  incident_generation: 0,
  ...overrides,
});

const failure = (
  evidenceWatermark: string,
  severity: "degraded" | "outage" = "outage",
): ProbeOutcome => ({
  kind: "failure",
  reason: "timeout",
  severity,
  evidenceWatermark,
});

const probe = (
  transaction: ReturnType<typeof stand>["transaction"],
  generation: number,
  outcome: ProbeOutcome,
) =>
  recordProbeResult(transaction as never, {
    organizationId: ORG,
    routeId: ROUTE,
    generation,
    observedAt: NOW,
    outcome,
  });

const openWorld = (severity = "outage"): World => ({
  route: route({
    health: "open",
    incident_id: INCIDENT,
    incident_generation: 3,
  }),
  health: { evidence_watermark: "w-old", consecutive_failures: 2 },
  incident: { id: INCIDENT, generation: 3, severity },
});

Deno.test("an unknown route and a withdrawn route are ignored and write nothing", async () => {
  for (
    const world of [
      { route: null },
      { route: route({ status: "disabled" }) },
      { route: route({ status: "revoked" }) },
    ] as World[]
  ) {
    const { transaction, recorded } = stand(world);
    const result = await probe(transaction, 0, failure("w1"));
    assertEquals(result.kind, "ignored");
    assertEquals(writes(recorded), []);
  }
});

Deno.test("a result under any generation but the current one is stale and writes nothing", async () => {
  // The route is at generation 3: an older probe (2) and a newer one (4) are
  // both refused, for every outcome, including the one that would close.
  for (const generation of [2, 4]) {
    for (
      const outcome of [
        failure("w1"),
        { kind: "reachable", evidenceWatermark: "w2" },
        { kind: "inference_proven", evidenceWatermark: "w3" },
      ] as ProbeOutcome[]
    ) {
      const { transaction, recorded } = stand(openWorld());
      const result = await probe(transaction, generation, outcome);
      assertEquals(result, { kind: "stale", currentGeneration: 3 });
      assertEquals(writes(recorded), [], `${generation} ${outcome.kind}`);
    }
  }
});

Deno.test("the same evidence applied twice is a duplicate and counts once", async () => {
  const { transaction, recorded } = stand(openWorld());
  const result = await probe(transaction, 3, failure("w-old"));
  assertEquals(result, { kind: "duplicate", generation: 3 });
  assertEquals(writes(recorded), []);
});

Deno.test("a failure on a route with no incident opens the next generation", async () => {
  const { transaction, recorded } = stand({
    route: route({ incident_generation: 2 }),
  });
  const result = await probe(transaction, 2, failure("w1"));
  assertEquals(result.kind, "opened");
  assertEquals(result.kind === "opened" ? result.generation : null, 3);
  const insert = writes(recorded).find(({ sql }) =>
    /insert into bakery\.provider_incidents/.test(sql)
  )!;
  // generation is the fourth value: the incident keeps the number it opened with.
  assertEquals(insert.values[3], 3);
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values.slice(2, 5).map(String), [
    "open",
    insert.values[0] as string,
    "3",
  ]);
  const healthUpsert = writes(recorded).find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  assertEquals(healthUpsert.values[4], 1);
});

Deno.test("a degraded failure shows the route as degraded, not open", async () => {
  const { transaction, recorded } = stand({ route: route() });
  await probe(transaction, 0, failure("w1", "degraded"));
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values[2], "degraded");
});

Deno.test("a failure on an open incident extends it and never opens a second", async () => {
  const { transaction, recorded } = stand(openWorld());
  const result = await probe(transaction, 3, failure("w-new"));
  assertEquals(result, {
    kind: "updated",
    incidentId: INCIDENT,
    generation: 3,
  });
  assert(
    !writes(recorded).some(({ sql }) =>
      /insert into bakery\.provider_incidents/.test(sql)
    ),
  );
  const healthUpsert = writes(recorded).find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  assertEquals(healthUpsert.values[4], 3);
});

Deno.test("an incident escalates to outage and a quieter probe never de-escalates it", async () => {
  const { transaction, recorded } = stand(openWorld("outage"));
  await probe(transaction, 3, failure("w-new", "degraded"));
  const update = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_incidents/.test(sql)
  )!;
  assertEquals(update.values[2], "outage");
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values[2], "open");

  const degraded = stand(openWorld("degraded"));
  await probe(degraded.transaction, 3, failure("w-new", "outage"));
  const escalated = writes(degraded.recorded).find(({ sql }) =>
    /update bakery\.provider_incidents/.test(sql)
  )!;
  assertEquals(escalated.values[2], "outage");
});

Deno.test("an answered health read keeps the incident open and proves nothing", async () => {
  const { transaction, recorded } = stand(openWorld());
  const result = await probe(transaction, 3, {
    kind: "reachable",
    evidenceWatermark: "w-reach",
  });
  assertEquals(result, {
    kind: "updated",
    incidentId: INCIDENT,
    generation: 3,
  });
  assert(!writes(recorded).some(({ sql }) => /status = 'recovered'/.test(sql)));
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  // Health stays open, the incident stays attached, and the inference flag is off.
  assertEquals(routeUpdate.values[2], "open");
  assertEquals(routeUpdate.values[3], INCIDENT);
  assertEquals(routeUpdate.values[6], false);
  const healthUpsert = writes(recorded).find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  assertEquals(healthUpsert.values[3], "reachable_inference_unverified");
  assertEquals(healthUpsert.values[4], 0);
});

Deno.test("a proven inference closes the incident, marks the route healthy and records the proof", async () => {
  const { transaction, recorded } = stand(openWorld());
  const result = await probe(transaction, 3, {
    kind: "inference_proven",
    evidenceWatermark: "w-proof",
  });
  assertEquals(result, {
    kind: "recovered",
    incidentId: INCIDENT,
    generation: 3,
  });
  const close = writes(recorded).find(({ sql }) =>
    /status = 'recovered'/.test(sql)
  )!;
  assertEquals(close.values.slice(0, 2), [ORG, INCIDENT]);
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values[2], "healthy");
  assertEquals(routeUpdate.values[3], null);
  // The generation is kept: the line is monotonic and never rewinds.
  assertEquals(routeUpdate.values[4], 3);
  assertEquals(routeUpdate.values[6], true);
});

Deno.test("a proven inference on a route with no incident marks it healthy without closing anything", async () => {
  const { transaction, recorded } = stand({ route: route() });
  const result = await probe(transaction, 0, {
    kind: "inference_proven",
    evidenceWatermark: "w-proof",
  });
  assertEquals(result, { kind: "updated", incidentId: null, generation: 0 });
  assert(
    !writes(recorded).some(({ sql }) => /provider_incidents/.test(sql)),
  );
});

Deno.test("every statement is scoped to the organization and the route is locked first", async () => {
  const { transaction, recorded } = stand(openWorld());
  await probe(transaction, 3, failure("w-new"));
  assert(/for update/.test(recorded[0]!.sql));
  for (const { sql, values } of recorded) {
    assertEquals(values[0], ORG, sql);
    assert(/organization_id/.test(sql), sql);
  }
});
