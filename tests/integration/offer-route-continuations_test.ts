import { assertEquals } from "@std/assert";
import { openApprovalFixture } from "../helpers/scoped-approvals.ts";

/**
 * #26 slice 6a through the mounted route, against a real database: which steps
 * of a run are stalled behind a provider incident and which routes they could
 * continue on.
 *
 * What only a database can show: that the join from a job's pin to a route and
 * its incident finds exactly the steps it should and none it should not, that the
 * billing spelling maps (`api` is `api_metered`, and nothing maps to `local`),
 * that an already-continued step stops being offered, and that the route is
 * mounted and organization-scoped.
 */

type Fixture = Awaited<ReturnType<typeof openApprovalFixture>>;

type Offers = {
  runId: string;
  offers: {
    runStepId: string;
    stepKey: string;
    incidentId: string;
    incidentGeneration: number;
    sourceRouteId: string;
    runVersion: number;
    estimatedIncrementalCost: string | null;
    targets: {
      routeId: string;
      eligible: boolean;
      ineligibleReason: string | null;
      harness: string;
      health: string;
    }[];
  }[];
};

const PIN = {
  provider: "anthropic",
  model: "claude-x",
  harness: "pi",
  billingRoute: "api",
};

async function seedRun(
  fixture: Fixture,
  options: {
    pin?: Partial<typeof PIN>;
    runStatus?: string;
    jobStatus?: string;
    organizationId?: string;
  } = {},
): Promise<{ runId: string; stepId: string; jobId: string }> {
  const pg = fixture.fx.ownerPg;
  const organizationId = options.organizationId ?? fixture.fx.organizationId;
  const pin = { ...PIN, ...options.pin };
  const principalId = fixture.fx.admin.principalId;
  const ids = {
    application: crypto.randomUUID(),
    conversation: crypto.randomUUID(),
    task: crypto.randomUUID(),
    workflow: crypto.randomUUID(),
    version: crypto.randomUUID(),
    run: crypto.randomUUID(),
    step: crypto.randomUUID(),
    job: crypto.randomUUID(),
  };
  await pg.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'Continuation app')`,
    [ids.application, organizationId, `cont-${ids.application}`],
  );
  await pg.query(
    `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
     values ($1, $2, $3, 'Continuation', $4)`,
    [ids.conversation, organizationId, ids.application, principalId],
  );
  await pg.query(
    `insert into bakery.tasks (id, organization_id, application_id, conversation_id, title,
       description, task_type, status, created_by)
     values ($1, $2, $3, $4, 'Continuation task', 'fixture', 'feature', 'queued', $5)`,
    [ids.task, organizationId, ids.application, ids.conversation, principalId],
  );
  await pg.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Continuation workflow')`,
    [ids.workflow, organizationId, `cont-${ids.workflow}`],
  );
  await pg.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
       source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: c', '{"name":"c"}', $4, 'published', $5)`,
    [
      ids.version,
      organizationId,
      ids.workflow,
      `c-${ids.version}`,
      principalId,
    ],
  );
  await pg.query(
    `insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id,
       requested_by, status, snapshot, budget_limit_usd)
     values ($1, $2, $3, $4, $5, $6, '{"name":"c"}', 0)`,
    [
      ids.run,
      organizationId,
      ids.task,
      ids.version,
      principalId,
      options.runStatus ?? "running",
    ],
  );
  await pg.query(
    `insert into bakery.run_steps (id, organization_id, run_id, step_key, position, iteration,
       status, input) values ($1, $2, $3, 'implement', 1, 0, 'running', '{}')`,
    [ids.step, organizationId, ids.run],
  );
  await pg.query(
    `insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements,
       status, current_fence, agent_config, billing)
     values ($1, $2, $3, 'harness.implement', '{}', '{}', $4, 1, $5::jsonb, $6::jsonb)`,
    [
      ids.job,
      organizationId,
      ids.step,
      options.jobStatus ?? "running",
      JSON.stringify({ harness: pin.harness }),
      JSON.stringify({
        provider: pin.provider,
        model: pin.model,
        billingRoute: pin.billingRoute,
      }),
    ],
  );
  return { runId: ids.run, stepId: ids.step, jobId: ids.job };
}

async function seedRoute(
  fixture: Fixture,
  values: {
    provider?: string;
    model?: string;
    harness?: string;
    billingRoute?: string;
    status?: string;
    health?: string;
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.fx.ownerPg.query(
    `insert into bakery.provider_routes (
       id, organization_id, provider, endpoint, model, harness, billing_route,
       credential_location, status, health
     ) values ($1, $2, $3, 'https://api.provider.example/v1', $4, $5, $6,
       'harness_host', $7, $8)`,
    [
      id,
      values.organizationId ?? fixture.fx.organizationId,
      values.provider ?? PIN.provider,
      values.model ?? PIN.model,
      values.harness ?? PIN.harness,
      values.billingRoute ?? "api_metered",
      values.status ?? "active",
      values.health ?? "healthy",
    ],
  );
  return id;
}

/** Opens an incident on a route and points the route at it. */
async function openIncident(
  fixture: Fixture,
  routeId: string,
  generation = 1,
): Promise<string> {
  const id = crypto.randomUUID();
  const pg = fixture.fx.ownerPg;
  await pg.query(
    `insert into bakery.provider_incidents (
       id, organization_id, route_id, generation, status, severity, reason,
       first_failure_at, last_failure_at
     ) values ($1, $2, $3, $4, 'open', 'outage', 'timeout', now(), now())`,
    [id, fixture.fx.organizationId, routeId, generation],
  );
  await pg.query(
    `update bakery.provider_routes
        set incident_id = $2, incident_generation = $3, health = 'open'
      where id = $1`,
    [routeId, id, generation],
  );
  return id;
}

async function offers(
  fixture: Fixture,
  runId: string,
  principal = fixture.fx.developer,
) {
  return await fixture.call(
    await fixture.as(principal),
    "GET",
    `/v1/runs/${runId}/route-continuations`,
  );
}

async function offersOk(fixture: Fixture, runId: string): Promise<Offers> {
  const response = await offers(fixture, runId);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Offers;
}

Deno.test("route continuations: a step pinned to a route with an open incident is offered, with every other route and one reason each", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    const source = await seedRoute(fixture);
    const incident = await openIncident(fixture, source);
    const eligible = await seedRoute(fixture, { model: "claude-y" });
    const disabled = await seedRoute(fixture, { status: "disabled" });
    const codex = await seedRoute(fixture, { harness: "codex" });
    const down = await seedRoute(fixture, { health: "open" });

    const result = await offersOk(fixture, run.runId);
    assertEquals(result.runId, run.runId);
    assertEquals(result.offers.length, 1);
    const offer = result.offers[0]!;
    assertEquals(offer.runStepId, run.stepId);
    assertEquals(offer.stepKey, "implement");
    assertEquals(offer.incidentId, incident);
    assertEquals(offer.incidentGeneration, 1);
    assertEquals(offer.sourceRouteId, source);
    assertEquals(offer.runVersion, 1);
    assertEquals(offer.estimatedIncrementalCost, null);
    const reason = (id: string) =>
      offer.targets.find((target) => target.routeId === id);
    assertEquals(offer.targets.some((t) => t.routeId === source), false);
    assertEquals(reason(eligible)!.eligible, true);
    assertEquals(reason(disabled)!.ineligibleReason, "route_not_active");
    assertEquals(reason(codex)!.ineligibleReason, "different_harness");
    assertEquals(reason(down)!.ineligibleReason, "route_open");
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: nothing is offered without an open incident, or for a different pin", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    // A route with the same pin and no incident.
    const healthy = await seedRoute(fixture);
    assertEquals((await offersOk(fixture, run.runId)).offers, []);
    // A route with an incident but a different model, provider or harness.
    for (
      const other of [
        { model: "claude-z" },
        { provider: "openai" },
        { harness: "codex" },
        { billingRoute: "subscription" },
        { billingRoute: "local" },
      ]
    ) {
      const route = await seedRoute(fixture, other);
      await openIncident(fixture, route);
      assertEquals(
        (await offersOk(fixture, run.runId)).offers,
        [],
        JSON.stringify(other),
      );
    }
    // A disabled route is not probed and does not stall a step.
    const disabled = await seedRoute(fixture, { status: "disabled" });
    await openIncident(fixture, disabled);
    assertEquals((await offersOk(fixture, run.runId)).offers, []);
    void healthy;
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: the job's billing spelling maps, and local never matches", async () => {
  const fixture = await openApprovalFixture();
  try {
    const subscription = await seedRun(fixture, {
      pin: { billingRoute: "subscription" },
    });
    const route = await seedRoute(fixture, { billingRoute: "subscription" });
    await openIncident(fixture, route);
    assertEquals(
      (await offersOk(fixture, subscription.runId)).offers.length,
      1,
    );
    // An `api` job is not stalled by a subscription route's incident.
    const api = await seedRun(fixture);
    assertEquals((await offersOk(fixture, api.runId)).offers, []);
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: a finished job or a finished run offers nothing", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await seedRoute(fixture);
    await openIncident(fixture, route);
    for (const jobStatus of ["completed", "failed", "canceled"]) {
      const run = await seedRun(fixture, { jobStatus });
      assertEquals((await offersOk(fixture, run.runId)).offers, [], jobStatus);
    }
    for (const runStatus of ["completed", "failed", "canceled", "blocked"]) {
      const run = await seedRun(fixture, { runStatus });
      assertEquals((await offersOk(fixture, run.runId)).offers, [], runStatus);
    }
    // And a queued or running one does.
    for (const jobStatus of ["queued", "leased", "running"]) {
      const run = await seedRun(fixture, { jobStatus });
      assertEquals(
        (await offersOk(fixture, run.runId)).offers.length,
        1,
        jobStatus,
      );
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: a step already continued for this incident generation stops being offered, a newer generation is offered again", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    const source = await seedRoute(fixture);
    const target = await seedRoute(fixture, { model: "claude-y" });
    const incident = await openIncident(fixture, source, 1);
    assertEquals((await offersOk(fixture, run.runId)).offers.length, 1);

    await fixture.fx.ownerPg.query(
      `insert into bakery.route_continuations (
         organization_id, run_id, run_step_id, job_id, incident_id,
         incident_generation, source_route_id, target_route_id,
         admitted_by_principal_id
       ) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        fixture.fx.organizationId,
        run.runId,
        run.stepId,
        run.jobId,
        incident,
        source,
        target,
        fixture.fx.admin.principalId,
      ],
    );
    assertEquals((await offersOk(fixture, run.runId)).offers, []);

    // The route has a newer incident: a new generation is a new choice.
    await fixture.fx.ownerPg.query(
      "update bakery.provider_incidents set status = 'recovered', closed_at = now() where id = $1",
      [incident],
    );
    const second = await openIncident(fixture, source, 2);
    const again = await offersOk(fixture, run.runId);
    assertEquals(again.offers.length, 1);
    assertEquals(again.offers[0]!.incidentId, second);
    assertEquals(again.offers[0]!.incidentGeneration, 2);
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: the structure allows one continuation per step and generation", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    const source = await seedRoute(fixture);
    const target = await seedRoute(fixture, { model: "claude-y" });
    const incident = await openIncident(fixture, source);
    const insert = () =>
      fixture.fx.ownerPg.query(
        `insert into bakery.route_continuations (
           organization_id, run_id, run_step_id, job_id, incident_id,
           incident_generation, source_route_id, target_route_id,
           admitted_by_principal_id
         ) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
        [
          fixture.fx.organizationId,
          run.runId,
          run.stepId,
          run.jobId,
          incident,
          source,
          target,
          fixture.fx.admin.principalId,
        ],
      );
    await insert();
    let code: string | undefined;
    try {
      await insert();
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // 23505 is unique_violation: a second producer for one stalled step.
    assertEquals(code, "23505");
  } finally {
    await fixture.close();
  }
});

async function expectStatus(
  response: Response,
  status: number,
  what: string,
): Promise<void> {
  const body = await response.text();
  assertEquals(response.status, status, `${what}: ${response.status} ${body}`);
}

Deno.test("route continuations: a viewer cannot read the offers", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    await expectStatus(
      await offers(fixture, run.runId, fixture.fx.viewer),
      403,
      "viewer",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: another organization's run is absent, not forbidden", async () => {
  const fixture = await openApprovalFixture();
  try {
    const foreignOrg = crypto.randomUUID();
    await fixture.fx.ownerPg.query(
      `insert into bakery.organizations (
         id, slug, name, metadata, created_at, updated_at, version
       ) values ($1, $2, 'Foreign', '{}'::jsonb, now(), now(), 1)`,
      [foreignOrg, `foreign-${foreignOrg.slice(0, 8)}`],
    );
    const foreign = await seedRun(fixture, { organizationId: foreignOrg });
    await expectStatus(
      await offers(fixture, foreign.runId),
      404,
      "foreign run",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: a run that does not exist is absent", async () => {
  const fixture = await openApprovalFixture();
  try {
    await expectStatus(
      await offers(fixture, crypto.randomUUID()),
      404,
      "missing run",
    );
  } finally {
    await fixture.close();
  }
});
