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
const NEXT = new Date("2026-11-19T12:00:30.000Z");

type Statement = { sql: string; values: readonly unknown[] };

type World = {
  route?: {
    status: string;
    health: string;
    incident_id: string | null;
    incident_generation: number;
    inference_verified_at: Date | null;
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
  inference_verified_at: null as Date | null,
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
    nextProbeAt: NEXT,
    incidents: "on",
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

Deno.test("the caller's next probe time is written to the route, its health row and the open incident", async () => {
  const { transaction, recorded } = stand(openWorld());
  await probe(transaction, 3, failure("w-new"));
  const mine = writes(recorded);
  const onRoute = mine.find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  const onHealth = mine.find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  const onIncident = mine.find(({ sql }) =>
    /update bakery\.provider_incidents/.test(sql)
  )!;
  assert(onRoute.values.includes(NEXT));
  assert(onHealth.values.includes(NEXT));
  assert(onIncident.values.includes(NEXT));
});

Deno.test("a null next probe time stops probing on all three", async () => {
  const { transaction, recorded } = stand({ route: route() });
  await recordProbeResult(transaction as never, {
    organizationId: ORG,
    routeId: ROUTE,
    generation: 0,
    observedAt: NOW,
    nextProbeAt: null,
    incidents: "on",
    outcome: failure("w1"),
  });
  for (const { sql, values } of writes(recorded)) {
    assert(
      !values.some((value) =>
        value instanceof Date && value.getTime() === NEXT.getTime()
      ),
      sql,
    );
  }
});

// -- incidents off: the probe's mode until the inference-trial slice -----------

const probeOff = (
  transaction: ReturnType<typeof stand>["transaction"],
  generation: number,
  outcome: ProbeOutcome,
) =>
  recordProbeResult(transaction as never, {
    organizationId: ORG,
    routeId: ROUTE,
    generation,
    observedAt: NOW,
    nextProbeAt: NEXT,
    incidents: "off",
    outcome,
  });

Deno.test("with incidents off, an unreachable probe opens no incident and leaves the route's circuit alone", async () => {
  for (
    const outcome of [
      failure("w1"),
      failure("w2", "degraded"),
      { ...failure("w3"), reason: "provider_error" as const },
    ]
  ) {
    const { transaction, recorded } = stand({ route: route() });
    const result = await probeOff(transaction, 0, outcome);
    assertEquals(result, { kind: "updated", incidentId: null, generation: 0 });
    // No incident is read for update, inserted or changed.
    assert(
      !recorded.some(({ sql }) => /bakery\.provider_incidents/.test(sql)),
      outcome.evidenceWatermark,
    );
    const routeUpdate = writes(recorded).find(({ sql }) =>
      /update bakery\.provider_routes/.test(sql)
    )!;
    // Health stays what it was, the incident and generation are unchanged, the
    // inference flag is off: only the probe times move.
    assertEquals(routeUpdate.values[2], "unverified");
    assertEquals(routeUpdate.values[3], null);
    assertEquals(routeUpdate.values[4], 0);
    assertEquals(routeUpdate.values[6], false);
    assert(routeUpdate.values.includes(NEXT));
  }
});

Deno.test("with incidents off, a failure is still counted, explained and scheduled", async () => {
  const { transaction, recorded } = stand({
    route: route(),
    health: { evidence_watermark: "w-old", consecutive_failures: 2 },
  });
  await probeOff(transaction, 0, failure("w-new"));
  const healthUpsert = writes(recorded).find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  // health, reason, consecutive failures, schedule.
  assertEquals(healthUpsert.values[2], "unverified");
  assertEquals(healthUpsert.values[3], "timeout");
  assertEquals(healthUpsert.values[4], 3);
  assert(healthUpsert.values.includes(NEXT));
});

Deno.test("with incidents off, a failure on a route that already has an open incident does not extend it", async () => {
  const { transaction, recorded } = stand(openWorld());
  const result = await probeOff(transaction, 3, failure("w-new"));
  assertEquals(result.kind, "updated");
  assert(
    !writes(recorded).some(({ sql }) =>
      /update bakery\.provider_incidents|insert into bakery\.provider_incidents/
        .test(sql)
    ),
  );
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  // The route keeps the incident and the state it already had.
  assertEquals(routeUpdate.values[2], "open");
  assertEquals(routeUpdate.values[3], INCIDENT);
  assertEquals(routeUpdate.values[4], 3);
});

Deno.test("with incidents off, the fence and duplicate rules still apply", async () => {
  const stale = stand(openWorld());
  assertEquals(
    await probeOff(stale.transaction, 2, failure("w1")),
    { kind: "stale", currentGeneration: 3 },
  );
  assertEquals(writes(stale.recorded), []);
  const duplicate = stand(openWorld());
  assertEquals(
    await probeOff(duplicate.transaction, 3, failure("w-old")),
    { kind: "duplicate", generation: 3 },
  );
  assertEquals(writes(duplicate.recorded), []);
});

Deno.test("with incidents off, reachable and a proven inference behave as before", async () => {
  const reachable = stand(openWorld());
  assertEquals(
    (await probeOff(reachable.transaction, 3, {
      kind: "reachable",
      evidenceWatermark: "w-reach",
    })).kind,
    "updated",
  );
  const proven = stand(openWorld());
  assertEquals(
    (await probeOff(proven.transaction, 3, {
      kind: "inference_proven",
      evidenceWatermark: "w-proof",
    })).kind,
    "recovered",
  );
});

// -- redirected: proves nothing ------------------------------------------------

const PROVEN = new Date("2026-11-18T00:00:00.000Z");

const redirect = (
  transaction: ReturnType<typeof stand>["transaction"],
  generation: number,
  mode: "on" | "off" = "off",
) =>
  recordProbeResult(transaction as never, {
    organizationId: ORG,
    routeId: ROUTE,
    generation,
    observedAt: NOW,
    nextProbeAt: NEXT,
    incidents: mode,
    outcome: { kind: "redirected", evidenceWatermark: "w-redirect" },
  });

Deno.test("a redirect makes a healthy route read unverified, and touches nothing else about it", async () => {
  for (const mode of ["on", "off"] as const) {
    const { transaction, recorded } = stand({
      route: route({ health: "healthy", inference_verified_at: PROVEN }),
    });
    const result = await redirect(transaction, 0, mode);
    assertEquals(result.kind, "updated");
    // No incident is read for update, inserted or changed.
    assert(
      !recorded.some(({ sql }) => /bakery\.provider_incidents/.test(sql)),
      mode,
    );
    const routeUpdate = writes(recorded).find(({ sql }) =>
      /update bakery\.provider_routes/.test(sql)
    )!;
    // The route reads unverified; the incident, generation and inference proof
    // are not in the statement at all.
    assertEquals(routeUpdate.values[2], "unverified");
    const set = routeUpdate.sql.split("where")[0]!;
    assert(!/incident|inference_verified/.test(set), set);
    assert(routeUpdate.values.includes(NEXT));
    const healthWrite = writes(recorded).find(({ sql }) =>
      /insert into bakery\.provider_route_health/.test(sql)
    )!;
    // The reason is a redirect, with the time it began; the failure count, the
    // success time and the failure time are not touched on conflict.
    assert(/'redirected'/.test(healthWrite.sql));
    assert(/reason_since/.test(healthWrite.sql));
    const onConflict = healthWrite.sql.split("on conflict")[1]!;
    assert(
      !/consecutive_failures|last_success_at|last_failure_at/.test(onConflict),
    );
    assert(!/inference_verified_at/.test(onConflict));
    assert(healthWrite.values.includes(NEXT));
    assert(healthWrite.values.includes(NOW));
  }
});

Deno.test("a redirect on a route with an open incident does not soften it", async () => {
  const { transaction, recorded } = stand(openWorld());
  await redirect(transaction, 3);
  const routeUpdate = writes(recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  // The incident is the stronger statement: health stays open.
  assertEquals(routeUpdate.values[2], "open");
  assert(
    !recorded.some(({ sql }) => /bakery\.provider_incidents/.test(sql)),
  );
});

Deno.test("reachable after a redirect returns a route that had proven inference to healthy", async () => {
  const proven = stand({
    route: route({ health: "unverified", inference_verified_at: PROVEN }),
    health: { evidence_watermark: "w-redirect", consecutive_failures: 0 },
  });
  await probeOff(proven.transaction, 0, {
    kind: "reachable",
    evidenceWatermark: "w-reach",
  });
  const routeUpdate = writes(proven.recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values[2], "healthy");
  const healthWrite = writes(proven.recorded).find(({ sql }) =>
    /insert into bakery\.provider_route_health/.test(sql)
  )!;
  // The reason clears, and so does its since-time.
  assertEquals(healthWrite.values[2], "healthy");
  assertEquals(healthWrite.values[3], null);
  assert(/when excluded\.reason is null then null/.test(healthWrite.sql));
});

Deno.test("reachable never makes a route healthy that has not proven inference", async () => {
  const never = stand({
    route: route({ health: "unverified", inference_verified_at: null }),
  });
  await probeOff(never.transaction, 0, {
    kind: "reachable",
    evidenceWatermark: "w-reach",
  });
  const routeUpdate = writes(never.recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(routeUpdate.values[2], "unverified");
  // And a route with an open incident stays as it is, proven or not.
  const open = stand({
    ...openWorld(),
    route: route({
      health: "open",
      incident_id: INCIDENT,
      incident_generation: 3,
      inference_verified_at: PROVEN,
    }),
  });
  await probe(open.transaction, 3, {
    kind: "reachable",
    evidenceWatermark: "w-reach",
  });
  const openUpdate = writes(open.recorded).find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(openUpdate.values[2], "open");
});

Deno.test("the since-time moves only when the reason changes", () => {
  // The SQL carries the rule, so it is pinned by the statement itself: a new
  // reason restarts the clock, the same reason keeps it, and no reason clears it.
  const { transaction, recorded } = stand({ route: route() });
  return probeOff(transaction, 0, failure("w1")).then(() => {
    const healthWrite = writes(recorded).find(({ sql }) =>
      /insert into bakery\.provider_route_health/.test(sql)
    )!;
    const onConflict = healthWrite.sql.split("on conflict")[1]!;
    assert(/when excluded\.reason is null then null/.test(onConflict));
    assert(
      /reason is distinct from excluded\.reason[\s\S]*then excluded\.last_probe_at/
        .test(onConflict),
    );
    assert(/else bakery\.provider_route_health\.reason_since/.test(onConflict));
  });
});

Deno.test("a redirect still obeys the fence and the duplicate rule", async () => {
  const stale = stand(openWorld());
  assertEquals(
    await recordProbeResult(stale.transaction as never, {
      organizationId: ORG,
      routeId: ROUTE,
      generation: 2,
      observedAt: NOW,
      nextProbeAt: NEXT,
      incidents: "off",
      outcome: { kind: "redirected", evidenceWatermark: "w1" },
    }),
    { kind: "stale", currentGeneration: 3 },
  );
  assertEquals(writes(stale.recorded), []);
  const duplicate = stand(openWorld());
  assertEquals(
    await recordProbeResult(duplicate.transaction as never, {
      organizationId: ORG,
      routeId: ROUTE,
      generation: 3,
      observedAt: NOW,
      nextProbeAt: NEXT,
      incidents: "off",
      outcome: { kind: "redirected", evidenceWatermark: "w-old" },
    }),
    { kind: "duplicate", generation: 3 },
  );
  assertEquals(writes(duplicate.recorded), []);
});
