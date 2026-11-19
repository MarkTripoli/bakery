import { assert, assertEquals } from "@std/assert";
import { openCoordinationFixture } from "../helpers/coordination-fixture.ts";
import {
  claimDueRoutes,
  type ProbeTransport,
  type ProbeTransportResult,
  runDueProbes,
} from "../../apps/server/src/modules/execution/provider-probe.ts";

/**
 * #26 slice 3 against a real database: the lease, the schedule and the refusals.
 *
 * Everything runs as the application role, so the grants the probe needs are the
 * ones under test. The transport is a stand-in that answers from a script, because
 * the network is not what is being tested; the claim, the generation fence, the
 * health upsert and the rescheduling are.
 */

type Fixture = Awaited<ReturnType<typeof openCoordinationFixture>>;

async function seedRoute(
  fx: Fixture,
  values: {
    status?: string;
    nextProbeAt?: string | null;
    endpoint?: string;
    leaseExpiresAt?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fx.ownerPg.query(
    `insert into bakery.provider_routes (
       id, organization_id, provider, endpoint, model, harness, billing_route,
       credential_location, status, next_probe_at
     ) values ($1, $2, 'openai', $3, 'gpt-5', 'pi', 'api_metered',
       'harness_host', $4, $5)`,
    [
      id,
      fx.organizationId,
      values.endpoint ?? "https://api.provider.example/v1",
      values.status ?? "active",
      values.nextProbeAt ?? null,
    ],
  );
  if (values.leaseExpiresAt !== undefined && values.leaseExpiresAt !== null) {
    await fx.ownerPg.query(
      `insert into bakery.provider_route_health (
         organization_id, route_id, health, probe_lease_expires_at
       ) values ($1, $2, 'unverified', $3)`,
      [fx.organizationId, id, values.leaseExpiresAt],
    );
  }
  return id;
}

const answer = (result: ProbeTransportResult): ProbeTransport => () =>
  Promise.resolve(result);

async function route(fx: Fixture, id: string) {
  const result = await fx.ownerPg.query(
    `select health, incident_id, incident_generation, next_probe_at,
            inference_verified_at, last_probe_at
       from bakery.provider_routes where id = $1`,
    [id],
  );
  return result.rows[0] as {
    health: string;
    incident_id: string | null;
    incident_generation: number;
    next_probe_at: Date | null;
    inference_verified_at: Date | null;
    last_probe_at: Date | null;
  };
}

async function health(fx: Fixture, id: string) {
  const result = await fx.ownerPg.query(
    `select consecutive_failures, probe_lease_expires_at, reason, next_probe_at
       from bakery.provider_route_health where route_id = $1`,
    [id],
  );
  return result.rows[0] as {
    consecutive_failures: number;
    probe_lease_expires_at: Date | null;
    reason: string | null;
    next_probe_at: Date | null;
  } | undefined;
}

/** Makes a route due now, so the next run probes it. */
async function makeDue(fx: Fixture, id: string) {
  await fx.ownerPg.query(
    "update bakery.provider_routes set next_probe_at = now() - interval '1 second' where id = $1",
    [id],
  );
}

const secondsFromNow = (date: Date | null) =>
  date === null ? NaN : (date.getTime() - Date.now()) / 1000;

Deno.test("probe claim: only active, due, unleased routes are claimed", async () => {
  const fx = await openCoordinationFixture();
  try {
    const never = await seedRoute(fx);
    const past = await seedRoute(fx, { nextProbeAt: "2020-01-01T00:00:00Z" });
    const future = await seedRoute(fx, { nextProbeAt: "2999-01-01T00:00:00Z" });
    const disabled = await seedRoute(fx, { status: "disabled" });
    const revoked = await seedRoute(fx, { status: "revoked" });
    const leased = await seedRoute(fx, {
      leaseExpiresAt: "2999-01-01T00:00:00Z",
    });
    const expired = await seedRoute(fx, {
      leaseExpiresAt: "2020-01-01T00:00:00Z",
    });

    const claimed = await claimDueRoutes(fx.appPg, {
      limit: 50,
      leaseSeconds: 30,
    });
    const ids = new Set(claimed.map((route) => route.routeId));
    // A route never probed has no schedule and is due at once; an expired lease
    // is a missed wake and is claimed again.
    for (const id of [never, past, expired]) assert(ids.has(id), id);
    for (const id of [future, disabled, revoked, leased]) {
      assert(!ids.has(id), id);
    }
    // Claiming took a lease on each, so an immediate second claim finds nothing.
    assertEquals(
      (await claimDueRoutes(fx.appPg, { limit: 50, leaseSeconds: 30 })).length,
      0,
    );
    for (const id of [never, past, expired]) {
      assert((await health(fx, id))!.probe_lease_expires_at !== null);
    }
  } finally {
    await fx.close();
  }
});

Deno.test("probe claim: two processes claiming at once take different routes", async () => {
  const fx = await openCoordinationFixture();
  try {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => seedRoute(fx)),
    );
    const [first, second] = await Promise.all([
      claimDueRoutes(fx.appPg, { limit: 4, leaseSeconds: 30 }),
      claimDueRoutes(fx.appPg, { limit: 4, leaseSeconds: 30 }),
    ]);
    const all = [...first, ...second].map((route) => route.routeId);
    assertEquals(new Set(all).size, all.length, "no route claimed twice");
    assertEquals(all.length, 6);
    assertEquals(new Set(all), new Set(ids));
  } finally {
    await fx.close();
  }
});

Deno.test("probe: an unreachable route opens no incident, is counted, and is retried with backoff", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    const results = await runDueProbes(fx.appPg, {
      transport: answer({ kind: "timeout" }),
      random: () => 0.5,
    });
    assertEquals(results.length, 1);
    const state = await route(fx, id);
    // Ruling on #26: no incident until something can close it. The route keeps
    // its circuit state, so a transient outage cannot remove it.
    assertEquals(state.health, "unverified");
    assertEquals(state.incident_id, null);
    assertEquals(state.incident_generation, 0);
    const delay = secondsFromNow(state.next_probe_at);
    assert(delay > 25 && delay <= 31, String(delay));
    const row = (await health(fx, id))!;
    assertEquals(row.consecutive_failures, 1);
    assertEquals(row.reason, "timeout");
    assertEquals(row.probe_lease_expires_at, null);
    const incidents = await fx.ownerPg.query(
      "select count(*)::int as n from bakery.provider_incidents where route_id = $1",
      [id],
    );
    assertEquals(incidents.rows[0].n, 0);

    // Not due yet: nothing is claimed.
    assertEquals(
      (await runDueProbes(fx.appPg, { transport: answer({ kind: "timeout" }) }))
        .length,
      0,
    );

    // The next failure backs off to about a minute, still with no incident.
    await makeDue(fx, id);
    await runDueProbes(fx.appPg, {
      transport: answer({ kind: "network_error" }),
      random: () => 0.5,
    });
    const again = await route(fx, id);
    assertEquals(again.incident_id, null);
    const second = secondsFromNow(again.next_probe_at);
    assert(second > 55 && second <= 61, String(second));
    assertEquals((await health(fx, id))!.consecutive_failures, 2);
    const after = await fx.ownerPg.query(
      "select count(*)::int as n from bakery.provider_incidents where route_id = $1",
      [id],
    );
    assertEquals(after.rows[0].n, 0);
  } finally {
    await fx.close();
  }
});

Deno.test("probe: a 429 waits at least as long as the provider asked", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    await runDueProbes(fx.appPg, {
      transport: answer({ kind: "response", status: 429, retryAfter: "120" }),
      random: () => 0.5,
    });
    const delay = secondsFromNow((await route(fx, id)).next_probe_at);
    assert(delay > 115 && delay <= 121, String(delay));
    // A slowdown opens no incident either; the route keeps its state.
    assertEquals((await route(fx, id)).health, "unverified");
    assertEquals((await route(fx, id)).incident_id, null);
    assertEquals((await health(fx, id))!.reason, "rate_limited");
  } finally {
    await fx.close();
  }
});

Deno.test("probe: reachable proves nothing about inference and clears the failure count", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    await runDueProbes(fx.appPg, { transport: answer({ kind: "timeout" }) });
    assertEquals((await health(fx, id))!.consecutive_failures, 1);
    await makeDue(fx, id);
    await runDueProbes(fx.appPg, {
      transport: answer({ kind: "response", status: 200, retryAfter: null }),
      random: () => 0.5,
    });
    const state = await route(fx, id);
    // Reachable is not healthy: the route is still unverified, with no inference
    // proof and no incident.
    assertEquals(state.health, "unverified");
    assertEquals(state.inference_verified_at, null);
    assertEquals(state.incident_id, null);
    const row = (await health(fx, id))!;
    assertEquals(row.consecutive_failures, 0);
    assertEquals(row.reason, null);
    // Reachable is looked at again on the steady interval.
    const delay = secondsFromNow(state.next_probe_at);
    assert(delay > 290 && delay <= 301, String(delay));
  } finally {
    await fx.close();
  }
});

Deno.test("probe: a redirect proves nothing: no reachable credit, no failure, schedule only", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    // A failure first, so there is a count and a reason a redirect must not touch.
    await runDueProbes(fx.appPg, { transport: answer({ kind: "timeout" }) });
    const before = (await health(fx, id))!;
    assertEquals(before.consecutive_failures, 1);
    assertEquals(before.reason, "timeout");
    await makeDue(fx, id);
    await runDueProbes(fx.appPg, {
      transport: answer({ kind: "response", status: 302, retryAfter: null }),
      random: () => 0.5,
    });
    const after = (await health(fx, id))!;
    // Neither cleared (reachable would) nor increased (a failure would).
    assertEquals(after.consecutive_failures, 1);
    assertEquals(after.reason, "timeout");
    assertEquals(after.probe_lease_expires_at, null);
    const state = await route(fx, id);
    assertEquals(state.health, "unverified");
    assertEquals(state.incident_id, null);
    assertEquals(state.inference_verified_at, null);
    const delay = secondsFromNow(state.next_probe_at);
    assert(delay > 290 && delay <= 301, String(delay));
    const success = await fx.ownerPg.query(
      "select last_success_at from bakery.provider_route_health where route_id = $1",
      [id],
    );
    assertEquals(success.rows[0].last_success_at, null);
  } finally {
    await fx.close();
  }
});

Deno.test("probe: a refused host leaves the route alone and is retried rarely", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    const results = await runDueProbes(fx.appPg, {
      transport: answer({ kind: "refused" }),
    });
    assertEquals(results[0]!.kind, "refused");
    const state = await route(fx, id);
    // Not the provider's fault: no incident, no health change.
    assertEquals(state.health, "unverified");
    assertEquals(state.incident_id, null);
    assertEquals(state.incident_generation, 0);
    const delay = secondsFromNow(state.next_probe_at);
    assert(delay > 3_500 && delay <= 3_601, String(delay));
    assertEquals((await health(fx, id))!.probe_lease_expires_at, null);
    const incidents = await fx.ownerPg.query(
      "select count(*)::int as n from bakery.provider_incidents where route_id = $1",
      [id],
    );
    assertEquals(incidents.rows[0].n, 0);
  } finally {
    await fx.close();
  }
});

Deno.test("probe: a result under a generation the route has moved past is stale and releases its lease", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    // While the probe is in flight, another writer opens an incident on the route.
    const transport: ProbeTransport = async () => {
      await fx.ownerPg.query(
        "update bakery.provider_routes set incident_generation = 5 where id = $1",
        [id],
      );
      return { kind: "timeout" };
    };
    const results = await runDueProbes(fx.appPg, { transport });
    const first = results[0]!;
    assertEquals(first.kind, "recorded");
    assertEquals(
      first.kind === "recorded" ? first.result.kind : null,
      "stale",
    );
    const state = await route(fx, id);
    assertEquals(state.incident_generation, 5);
    assertEquals(state.incident_id, null);
    assertEquals((await health(fx, id))!.probe_lease_expires_at, null);
  } finally {
    await fx.close();
  }
});

Deno.test("probe: a disabled route is not probed, and a result for one that was withdrawn mid-probe is ignored", async () => {
  const fx = await openCoordinationFixture();
  try {
    const id = await seedRoute(fx);
    const transport: ProbeTransport = async () => {
      await fx.ownerPg.query(
        "update bakery.provider_routes set status = 'disabled' where id = $1",
        [id],
      );
      return { kind: "timeout" };
    };
    const results = await runDueProbes(fx.appPg, { transport });
    const first = results[0]!;
    assertEquals(
      first.kind === "recorded" ? first.result : null,
      { kind: "ignored", reason: "route_not_active" },
    );
    assertEquals((await route(fx, id)).health, "unverified");
    // And a disabled route is never claimed again.
    await makeDue(fx, id);
    assertEquals(
      (await runDueProbes(fx.appPg, { transport: answer({ kind: "timeout" }) }))
        .length,
      0,
    );
  } finally {
    await fx.close();
  }
});
