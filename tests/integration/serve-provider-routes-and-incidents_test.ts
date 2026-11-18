import { assert, assertEquals } from "@std/assert";
import { openApprovalFixture } from "../helpers/scoped-approvals.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

/**
 * #26 slice 2 through the mounted route: the five provider reads.
 *
 * The store lives in SQL, so these tests drive the real HTTP surface against a
 * real database rather than a stand-in. What they pin is the part a unit test
 * cannot see: that the route is mounted, that the organization filter is in the
 * query rather than in a later filter, that a cursor cannot be replayed under a
 * different question, and that a route's `health` is a projection while
 * `inferenceVerifiedAt` is separate proof.
 *
 * The fixture owns the rows directly because nothing in this slice writes them:
 * the monitoring work that opens an incident is a later slice, and seeding
 * through it would test that slice instead of this one.
 */

const ORG = () => crypto.randomUUID();

type Fixture = Awaited<ReturnType<typeof openApprovalFixture>>;

async function seedRoute(
  pg: PgTransactionClient,
  values: {
    organizationId: string;
    provider?: string;
    health?: string;
    status?: string;
    incidentGeneration?: number;
    inferenceVerifiedAt?: string | null;
    createdAt?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await pg.query(
    `insert into bakery.provider_routes (
        id, organization_id, provider, endpoint, region, model, harness,
        billing_route, credential_location, status, health, incident_generation,
        inference_verified_at, created_at, updated_at
      ) values ($1, $2, $3, $4, null, 'gpt-5', 'pi', 'api_metered',
        'harness_host', $5, $6, $7, $8,
        coalesce($9::timestamptz, now()), now())`,
    [
      id,
      values.organizationId,
      values.provider ?? "openai",
      "https://api.openai.example/v1",
      values.status ?? "active",
      values.health ?? "unverified",
      values.incidentGeneration ?? 0,
      values.inferenceVerifiedAt ?? null,
      values.createdAt ?? null,
    ],
  );
  return id;
}

async function seedHealth(
  pg: PgTransactionClient,
  values: {
    organizationId: string;
    routeId: string;
    health: string;
    reason?: string | null;
    consecutiveFailures?: number;
    corroboration?: string;
    incidentGeneration?: number;
  },
): Promise<void> {
  await pg.query(
    `insert into bakery.provider_route_health (
        organization_id, route_id, health, reason, consecutive_failures,
        corroboration, incident_generation, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      values.organizationId,
      values.routeId,
      values.health,
      values.reason ?? null,
      values.consecutiveFailures ?? 0,
      values.corroboration ?? "none",
      values.incidentGeneration ?? 0,
    ],
  );
}

async function seedIncident(
  pg: PgTransactionClient,
  values: {
    organizationId: string;
    routeId: string;
    generation: number;
    status?: string;
    severity?: string;
    reason?: string | null;
    openedAt?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const status = values.status ?? "open";
  await pg.query(
    `insert into bakery.provider_incidents (
        id, organization_id, route_id, generation, status, severity, reason,
        first_failure_at, last_failure_at, opened_at, closed_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7,
        coalesce($8::timestamptz, now()), coalesce($8::timestamptz, now()),
        coalesce($8::timestamptz, now()),
        case when $5 = 'open' then null else now() end, now())`,
    [
      id,
      values.organizationId,
      values.routeId,
      values.generation,
      status,
      values.severity ?? "outage",
      values.reason ?? "transport_failure",
      values.openedAt ?? null,
    ],
  );
  return id;
}

async function read(fixture: Fixture, path: string): Promise<Response> {
  // The reads are Developer access, so they are made as a developer of this
  // organization: the tests exercise the real access check rather than around it.
  return await fixture.call(
    await fixture.as(fixture.fx.developer),
    "GET",
    path,
  );
}

Deno.test("provider routes: a route reads back as the contract promises", async () => {
  const fixture = await openApprovalFixture();
  try {
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "degraded",
      incidentGeneration: 2,
      inferenceVerifiedAt: "2026-11-18T10:00:00.000Z",
    });

    const response = await read(fixture, `/v1/provider-routes/${routeId}`);
    assertEquals(response.status, 200);
    const route = await response.json() as Record<string, unknown>;
    assertEquals(route.id, routeId);
    assertEquals(route.provider, "openai");
    assertEquals(route.health, "degraded");
    assertEquals(route.incidentGeneration, 2);
    // The proof of the inference path is its own field, and a degraded route
    // still carries it: the two facts are independent.
    assertEquals(route.inferenceVerifiedAt, "2026-11-18T10:00:00.000Z");
    // A credential is never returned, only where it is kept.
    assertEquals(route.credentialLocation, "harness_host");
    assert(!("endpoint" in route) || typeof route.endpoint === "string");
  } finally {
    await fixture.close();
  }
});

Deno.test("provider routes: another organization's route is absent, not forbidden", async () => {
  const fixture = await openApprovalFixture();
  try {
    const foreignOrg = ORG();
    await fixture.fx.ownerPg.query(
      `insert into bakery.organizations (id, slug, name)
         values ($1, $2, $3) on conflict do nothing`,
      [foreignOrg, `foreign-${foreignOrg.slice(0, 8)}`, "Foreign"],
    );
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: foreignOrg,
    });

    // The id exists, but not for this caller: the read answers absent, so it
    // cannot be used to learn that another organization has such a route.
    const response = await read(fixture, `/v1/provider-routes/${routeId}`);
    assertEquals(response.status, 404);

    const list = await read(fixture, "/v1/provider-routes");
    const page = await list.json() as { items: { id: string }[] };
    assertEquals(page.items.some((item) => item.id === routeId), false);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider routes: the list pages by keyset and the cursor keeps its filters", async () => {
  const fixture = await openApprovalFixture();
  try {
    // Three routes, oldest to newest, so a descending page is the reverse.
    const oldest = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "healthy",
      createdAt: "2026-11-18T01:00:00.000Z",
    });
    const middle = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      createdAt: "2026-11-18T02:00:00.000Z",
    });
    const newest = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "healthy",
      createdAt: "2026-11-18T03:00:00.000Z",
    });

    const first = await read(fixture, "/v1/provider-routes?limit=2");
    assertEquals(first.status, 200);
    const page = await first.json() as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    assertEquals(page.items.map((item) => item.id), [newest, middle]);
    assert(page.nextCursor !== null);

    const second = await read(
      fixture,
      `/v1/provider-routes?limit=2&cursor=${
        encodeURIComponent(page.nextCursor)
      }`,
    );
    const rest = await second.json() as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    // No repeat and no gap: the page continues exactly where it stopped.
    assertEquals(rest.items.map((item) => item.id), [oldest]);
    assertEquals(rest.nextCursor, null);

    // The same cursor under a different filter is a different question, and is
    // refused rather than answered with a page from the first one.
    const replayed = await read(
      fixture,
      `/v1/provider-routes?limit=2&health=healthy&cursor=${
        encodeURIComponent(page.nextCursor)
      }`,
    );
    assertEquals(replayed.status >= 400, true);

    // The filter itself works: only the healthy routes.
    const healthy = await read(fixture, "/v1/provider-routes?health=healthy");
    const filtered = await healthy.json() as { items: { id: string }[] };
    assertEquals(filtered.items.map((item) => item.id), [newest, oldest]);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route health: a judged route reports its own monitoring state", async () => {
  const fixture = await openApprovalFixture();
  try {
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      incidentGeneration: 4,
    });
    await seedHealth(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId,
      health: "open",
      reason: "reachable_inference_unverified",
      consecutiveFailures: 3,
      incidentGeneration: 4,
    });

    const response = await read(
      fixture,
      `/v1/provider-routes/${routeId}/health`,
    );
    assertEquals(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assertEquals(health.routeId, routeId);
    assertEquals(health.health, "open");
    assertEquals(health.reason, "reachable_inference_unverified");
    assertEquals(health.consecutiveFailures, 3);
    assertEquals(health.incidentGeneration, 4);
    // Reachability never becomes inference proof: the row has none, so the read
    // reports none rather than deriving it from health.
    assertEquals(health.inferenceVerifiedAt, null);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider route health: a route nothing has judged answers unverified, not absent", async () => {
  const fixture = await openApprovalFixture();
  try {
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "unverified",
    });

    const response = await read(
      fixture,
      `/v1/provider-routes/${routeId}/health`,
    );
    // The route exists; nothing has judged it. Answering 404 would say the route
    // was missing, which is a different and false claim.
    assertEquals(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assertEquals(health.health, "unverified");
    assertEquals(health.consecutiveFailures, 0);
    assertEquals(health.corroboration, "none");
    assert(typeof health.updatedAt === "string");

    // An id that names no route is still absent.
    const missing = await read(
      fixture,
      `/v1/provider-routes/${crypto.randomUUID()}/health`,
    );
    assertEquals(missing.status, 404);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: an incident reads back with its generation", async () => {
  const fixture = await openApprovalFixture();
  try {
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      incidentGeneration: 1,
    });
    const incidentId = await seedIncident(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId,
      generation: 1,
      severity: "degraded",
    });

    const response = await read(
      fixture,
      `/v1/provider-incidents/${incidentId}`,
    );
    assertEquals(response.status, 200);
    const incident = await response.json() as Record<string, unknown>;
    assertEquals(incident.id, incidentId);
    assertEquals(incident.routeId, routeId);
    assertEquals(incident.generation, 1);
    assertEquals(incident.status, "open");
    assertEquals(incident.severity, "degraded");
    // An open incident has not closed, so the contract's nullable close time is
    // null rather than absent.
    assertEquals(incident.closedAt, null);
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: a route cannot hold two open incidents", async () => {
  const fixture = await openApprovalFixture();
  try {
    const routeId = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      incidentGeneration: 2,
    });
    await seedIncident(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId,
      generation: 1,
    });
    // Two open incidents would give the route two current generations, and every
    // stale-probe check in a later slice would be ambiguous. The database states
    // the rule once instead of each writer remembering it.
    let refused = false;
    try {
      await seedIncident(fixture.fx.ownerPg, {
        organizationId: fixture.fx.organizationId,
        routeId,
        generation: 2,
      });
    } catch {
      refused = true;
    }
    assertEquals(refused, true);

    // A closed one and an open one do coexist: that is the normal history.
    const closedId = await seedIncident(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId,
      generation: 3,
      status: "recovered",
    });
    assertEquals(typeof closedId, "string");
  } finally {
    await fixture.close();
  }
});

Deno.test("provider incidents: the list filters by route, status and severity", async () => {
  const fixture = await openApprovalFixture();
  try {
    const first = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      incidentGeneration: 1,
    });
    const second = await seedRoute(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      health: "open",
      incidentGeneration: 1,
    });
    const onFirst = await seedIncident(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId: first,
      generation: 1,
      severity: "outage",
      openedAt: "2026-11-18T04:00:00.000Z",
    });
    const onSecond = await seedIncident(fixture.fx.ownerPg, {
      organizationId: fixture.fx.organizationId,
      routeId: second,
      generation: 1,
      severity: "degraded",
      openedAt: "2026-11-18T05:00:00.000Z",
    });

    const all = await read(fixture, "/v1/provider-incidents");
    const page = await all.json() as { items: { id: string }[] };
    assertEquals(page.items.map((item) => item.id), [onSecond, onFirst]);

    const byRoute = await read(
      fixture,
      `/v1/provider-incidents?routeId=${first}`,
    );
    const routed = await byRoute.json() as { items: { id: string }[] };
    assertEquals(routed.items.map((item) => item.id), [onFirst]);

    const bySeverity = await read(
      fixture,
      "/v1/provider-incidents?severity=degraded",
    );
    const degraded = await bySeverity.json() as { items: { id: string }[] };
    assertEquals(degraded.items.map((item) => item.id), [onSecond]);

    // A closed incident is absent from an `open` page but present in the record.
    await fixture.fx.ownerPg.query(
      `update bakery.provider_incidents
          set status = 'recovered', closed_at = now()
        where id = $1`,
      [onFirst],
    );
    const open = await read(fixture, "/v1/provider-incidents?status=open");
    const stillOpen = await open.json() as { items: { id: string }[] };
    assertEquals(stillOpen.items.map((item) => item.id), [onSecond]);
    const recovered = await read(
      fixture,
      "/v1/provider-incidents?status=recovered",
    );
    const closed = await recovered.json() as { items: { id: string }[] };
    assertEquals(closed.items.map((item) => item.id), [onFirst]);
  } finally {
    await fixture.close();
  }
});
