import { assert, assertEquals } from "@std/assert";
import { openApprovalFixture } from "../helpers/scoped-approvals.ts";
import { recordProbeResult } from "../../apps/server/src/modules/execution/provider-incidents.ts";

/**
 * #26 slice 2 (writes) against a real database: the route commands through the
 * mounted route, and the probe writer as the application role.
 *
 * What only a database can show, and what these pin:
 *
 *  - the application role holds exactly the grants the writers need: it can
 *    change a route's status, and it cannot rewrite a route's identity or delete
 *    a route, whatever the code says;
 *  - the generation fence holds under real locking: two probes of one route that
 *    both read generation N open exactly one incident;
 *  - the one-open-incident index, the health upsert and the route's projection
 *    agree, and the reads from slice 2 show what the writer wrote.
 */

type Fixture = Awaited<ReturnType<typeof openApprovalFixture>>;

const routeBody = {
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-5",
  harness: "pi",
  billingRoute: "api_metered",
  credentialLocation: "harness_host",
};

type Route = {
  id: string;
  status: string;
  health: string;
  version: number;
  incidentId: string | null;
  incidentGeneration: number;
  inferenceVerifiedAt: string | null;
  region: string | null;
};

async function createRoute(fixture: Fixture): Promise<Route> {
  const response = await fixture.call(
    await fixture.as(fixture.fx.admin),
    "POST",
    "/v1/provider-routes",
    { body: routeBody, key: crypto.randomUUID() },
  );
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as Route;
}

async function readRoute(fixture: Fixture, id: string): Promise<Route> {
  const response = await fixture.call(
    await fixture.as(fixture.fx.developer),
    "GET",
    `/v1/provider-routes/${id}`,
  );
  assertEquals(response.status, 200);
  return await response.json() as Route;
}

/** Runs the probe writer as the application role, in its own transaction. */
async function probe(
  fixture: Fixture,
  routeId: string,
  generation: number,
  outcome: Parameters<typeof recordProbeResult>[1]["outcome"],
) {
  const client = await fixture.fx.appPg.connect();
  try {
    await client.query("begin");
    const result = await recordProbeResult(client, {
      organizationId: fixture.fx.organizationId,
      routeId,
      generation,
      observedAt: new Date(),
      nextProbeAt: new Date(Date.now() + 30_000),
      incidents: "on",
      outcome,
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const failure = (watermark: string) => ({
  kind: "failure" as const,
  reason: "timeout" as const,
  severity: "outage" as const,
  evidenceWatermark: watermark,
});

Deno.test("provider route writes: an admin creates a route that starts active and unverified", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);
    assertEquals(route.status, "active");
    assertEquals(route.health, "unverified");
    assertEquals(route.incidentId, null);
    assertEquals(route.inferenceVerifiedAt, null);
    assertEquals(route.version, 1);
    assertEquals((await readRoute(fixture, route.id)).id, route.id);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route writes: a developer and a viewer cannot write", async () => {
  const fixture = await openApprovalFixture();
  try {
    for (const principal of [fixture.fx.developer, fixture.fx.viewer]) {
      const response = await fixture.call(
        await fixture.as(principal),
        "POST",
        "/v1/provider-routes",
        { body: routeBody, key: crypto.randomUUID() },
      );
      assertEquals(response.status, 403);
      await response.body?.cancel();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route writes: an account of another organization is refused", async () => {
  const fixture = await openApprovalFixture();
  try {
    const response = await fixture.call(
      await fixture.as(fixture.fx.admin),
      "POST",
      "/v1/provider-routes",
      {
        body: { ...routeBody, providerAccountId: crypto.randomUUID() },
        key: crypto.randomUUID(),
      },
    );
    assertEquals(response.status, 422);
    await response.body?.cancel();
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route writes: update is compare-and-swap, and revoked is final", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);
    const admin = await fixture.as(fixture.fx.admin);
    const patch = (
      body: unknown,
      ifMatch: number,
    ) =>
      fixture.call(admin, "PATCH", `/v1/provider-routes/${route.id}`, {
        body,
        key: crypto.randomUUID(),
        ifMatch,
      });

    const disabled = await patch({ status: "disabled" }, 1);
    assertEquals(disabled.status, 200);
    assertEquals((await disabled.json() as Route).version, 2);

    // A stale version is refused and the route is unchanged.
    const stale = await patch({ status: "active" }, 1);
    assertEquals(stale.status, 412);
    await stale.body?.cancel();
    assertEquals((await readRoute(fixture, route.id)).status, "disabled");

    const unchanged = await patch({ status: "disabled" }, 2);
    assertEquals(unchanged.status, 422);
    await unchanged.body?.cancel();

    const revoked = await patch({ status: "revoked" }, 2);
    assertEquals(revoked.status, 200);
    const reopened = await patch({ status: "active" }, 3);
    assertEquals(reopened.status, 409);
    await reopened.body?.cancel();
    const edited = await patch({ region: "eu" }, 3);
    assertEquals(edited.status, 409);
    await edited.body?.cancel();
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route writes: another organization's route is absent, not forbidden", async () => {
  const fixture = await openApprovalFixture();
  try {
    const foreignOrg = crypto.randomUUID();
    await fixture.fx.ownerPg.query(
      `insert into bakery.organizations (
         id, slug, name, metadata, created_at, updated_at, version
       ) values ($1, $2, $3, '{}'::jsonb, now(), now(), 1)`,
      [foreignOrg, `foreign-${foreignOrg.slice(0, 8)}`, "Foreign"],
    );
    const foreignRoute = crypto.randomUUID();
    await fixture.fx.ownerPg.query(
      `insert into bakery.provider_routes (
         id, organization_id, provider, endpoint, model, harness,
         billing_route, credential_location
       ) values ($1, $2, 'openai', 'https://x.example', 'm', 'pi',
         'api_metered', 'harness_host')`,
      [foreignRoute, foreignOrg],
    );
    const response = await fixture.call(
      await fixture.as(fixture.fx.admin),
      "PATCH",
      `/v1/provider-routes/${foreignRoute}`,
      {
        body: { status: "disabled" },
        key: crypto.randomUUID(),
        ifMatch: 1,
      },
    );
    assertEquals(response.status, 404);
    await response.body?.cancel();
    const row = await fixture.fx.ownerPg.query(
      "select status from bakery.provider_routes where id = $1",
      [foreignRoute],
    );
    assertEquals(row.rows[0].status, "active");
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route writes: the application role cannot rewrite a route's identity or delete it", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);
    const refused = async (sql: string) => {
      try {
        await fixture.fx.appPg.query(sql, [route.id]);
      } catch (error) {
        // 42501 is insufficient_privilege: the grant, not the code, is the wall.
        assertEquals((error as { code?: string }).code, "42501", sql);
        return;
      }
      throw new Error(`expected permission denied: ${sql}`);
    };
    await refused(
      "update bakery.provider_routes set endpoint = 'https://evil.example' where id = $1",
    );
    await refused(
      "update bakery.provider_routes set model = 'other' where id = $1",
    );
    await refused("delete from bakery.provider_routes where id = $1");
    // And the columns the writers do own are writable.
    await fixture.fx.appPg.query(
      "update bakery.provider_routes set region = 'eu' where id = $1",
      [route.id],
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: a stale probe cannot close a newer incident", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);

    const first = await probe(fixture, route.id, 0, failure("w1"));
    assertEquals(first.kind, "opened");
    assertEquals(first.kind === "opened" ? first.generation : -1, 1);
    let state = await readRoute(fixture, route.id);
    assertEquals(state.health, "open");
    assertEquals(state.incidentGeneration, 1);
    assert(state.incidentId !== null);

    // The same evidence again is a duplicate, and the failure is counted once.
    assertEquals(
      (await probe(fixture, route.id, 1, failure("w1"))).kind,
      "duplicate",
    );
    // A late result under the old generation is refused.
    assertEquals(
      (await probe(fixture, route.id, 0, failure("w2"))).kind,
      "stale",
    );

    // An answered health read keeps the incident open and proves nothing.
    const reachable = await probe(fixture, route.id, 1, {
      kind: "reachable",
      evidenceWatermark: "w3",
    });
    assertEquals(reachable.kind, "updated");
    state = await readRoute(fixture, route.id);
    assertEquals(state.health, "open");
    assertEquals(state.inferenceVerifiedAt, null);
    const health = await (await fixture.call(
      await fixture.as(fixture.fx.developer),
      "GET",
      `/v1/provider-routes/${route.id}/health`,
    )).json() as { reason: string; consecutiveFailures: number };
    assertEquals(health.reason, "reachable_inference_unverified");
    assertEquals(health.consecutiveFailures, 0);

    // A proven inference closes it; the generation is kept.
    const proven = await probe(fixture, route.id, 1, {
      kind: "inference_proven",
      evidenceWatermark: "w4",
    });
    assertEquals(proven.kind, "recovered");
    state = await readRoute(fixture, route.id);
    assertEquals(state.health, "healthy");
    assertEquals(state.incidentId, null);
    assertEquals(state.incidentGeneration, 1);
    assert(state.inferenceVerifiedAt !== null);

    // A new outage opens generation 2, and a late proof from generation 1 cannot
    // close it.
    const second = await probe(fixture, route.id, 1, failure("w5"));
    assertEquals(second.kind === "opened" ? second.generation : -1, 2);
    const late = await probe(fixture, route.id, 1, {
      kind: "inference_proven",
      evidenceWatermark: "w6",
    });
    assertEquals(late, { kind: "stale", currentGeneration: 2 });
    assertEquals((await readRoute(fixture, route.id)).health, "open");

    const incidents = await fixture.fx.ownerPg.query(
      `select generation, status from bakery.provider_incidents
        where route_id = $1 order by generation`,
      [route.id],
    );
    assertEquals(
      incidents.rows.map((row) => [row.generation, row.status]),
      [[1, "recovered"], [2, "open"]],
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: two probes that read the same generation open one incident", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);
    const results = await Promise.all([
      probe(fixture, route.id, 0, failure("a")),
      probe(fixture, route.id, 0, failure("b")),
    ]);
    assertEquals(
      results.map((result) => result.kind).sort(),
      ["opened", "stale"],
    );
    const count = await fixture.fx.ownerPg.query(
      "select count(*)::int as n from bakery.provider_incidents where route_id = $1 and status = 'open'",
      [route.id],
    );
    assertEquals(count.rows[0].n, 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: a disabled route ignores a result admitted before it was withdrawn", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await createRoute(fixture);
    const response = await fixture.call(
      await fixture.as(fixture.fx.admin),
      "PATCH",
      `/v1/provider-routes/${route.id}`,
      {
        body: { status: "disabled" },
        key: crypto.randomUUID(),
        ifMatch: 1,
      },
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const result = await probe(fixture, route.id, 0, failure("late"));
    assertEquals(result, { kind: "ignored", reason: "route_not_active" });
    assertEquals((await readRoute(fixture, route.id)).health, "unverified");
  } finally {
    await fixture.close();
  }
});
