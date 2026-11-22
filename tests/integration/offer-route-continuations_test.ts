import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { readRunsWaitingOnModel } from "../../apps/server/src/modules/execution/route-continuations.ts";
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
    source: {
      provider: string;
      model: string;
      providerName: string;
      modelName: string;
      harness: string;
      billingRoute: string;
      health: string;
    };
    reason: string;
    since: string;
    nextCheckAt: string | null;
    runVersion: number;
    targets: {
      routeId: string;
      providerName: string;
      modelName: string;
      harness: string;
      health: string;
      priced: boolean;
      estimatedIncrementalCost: string | null;
    }[];
    unavailable: {
      reason: string;
      count: number;
      harnesses?: { harness: string; count: number }[];
      routes?: {
        provider: string;
        model: string;
        providerName: string;
        modelName: string;
      }[];
    }[];
  }[];
};

const PIN = {
  provider: "anthropic",
  model: "claude-x",
  harness: "pi",
  billingRoute: "api",
  billingAccountId: "acct-continuation-a",
};

/** Provider accounts already seeded, by fixture then organization and identity. */
const accounts = new WeakMap<Fixture, Map<string, string>>();

/** The organization's provider account for a billing identity, created once. */
async function seedAccount(
  fixture: Fixture,
  organizationId: string,
  billingIdentity: string,
): Promise<string> {
  const known = accounts.get(fixture) ?? new Map<string, string>();
  accounts.set(fixture, known);
  const key = `${organizationId}/${billingIdentity}`;
  const existing = known.get(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await fixture.fx.ownerPg.query(
    `insert into bakery.model_provider_accounts (
       id, organization_id, provider, billing_identity, identity_hash,
       billing_route, display_identity
     ) values ($1, $2, $3, $4, $5, 'api', 'continuation')`,
    [id, organizationId, PIN.provider, billingIdentity, `h-${id}`],
  );
  known.set(key, id);
  return id;
}

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
      options.jobStatus ?? "queued",
      JSON.stringify({ harness: pin.harness }),
      JSON.stringify({
        provider: pin.provider,
        model: pin.model,
        billingRoute: pin.billingRoute,
        billingAccountId: pin.billingAccountId,
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
    billingAccountId?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const organizationId = values.organizationId ?? fixture.fx.organizationId;
  const accountId = await seedAccount(
    fixture,
    organizationId,
    values.billingAccountId ?? PIN.billingAccountId,
  );
  await fixture.fx.ownerPg.query(
    `insert into bakery.provider_routes (
       id, organization_id, provider, endpoint, model, harness, billing_route,
       credential_location, status, health, provider_account_id
     ) values ($1, $2, $3, 'https://api.provider.example/v1', $4, $5, $6,
       'harness_host', $7, $8, $9)`,
    [
      id,
      organizationId,
      values.provider ?? PIN.provider,
      values.model ?? PIN.model,
      values.harness ?? PIN.harness,
      values.billingRoute ?? "api_metered",
      values.status ?? "active",
      values.health ?? "healthy",
      accountId,
    ],
  );
  return id;
}

/**
 * An account of the organization with a unique billing identity, and, when
 * `model` is given, an active API price for that model. Pricing snapshots are
 * global, so the identity is unique and the caller deletes the price after.
 */
async function seedPricedAccount(
  fixture: Fixture,
  model: string | null,
): Promise<{ accountId: string; billingIdentity: string }> {
  const billingIdentity = `offer-${crypto.randomUUID()}`;
  const accountId = await seedAccount(
    fixture,
    fixture.fx.organizationId,
    billingIdentity,
  );
  const pg = fixture.fx.ownerPg;
  if (model !== null) {
    await pg.query(
      `insert into bakery.provider_pricing_snapshots (
         provider, billing_account_id, model, billing_type,
         pricing_metadata_snapshot, source_reference, effective_from
       ) values ($1, $2, $3, 'api', 'offer-test-v1', 'offer-test', clock_timestamp())`,
      [PIN.provider, billingIdentity, model],
    );
  }
  return { accountId, billingIdentity };
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

Deno.test("route continuations: a step pinned to a route with an open incident is offered, with the usable routes and counts of the rest", async () => {
  const fixture = await openApprovalFixture();
  const identities: string[] = [];
  try {
    const run = await seedRun(fixture);
    const source = await seedRoute(fixture);
    const incident = await openIncident(fixture, source);
    const priced = await seedPricedAccount(fixture, "claude-y");
    const unpriced = await seedPricedAccount(fixture, null);
    identities.push(priced.billingIdentity, unpriced.billingIdentity);
    const eligible = await seedRoute(fixture, {
      model: "claude-y",
      billingAccountId: priced.billingIdentity,
    });
    // Same account, but no price for this model.
    const noPrice = await seedRoute(fixture, {
      model: "claude-z",
      billingAccountId: unpriced.billingIdentity,
    });
    // The default account, with no price for this model.
    const defaultAccount = await seedRoute(fixture, { model: "claude-w" });
    await seedRoute(fixture, { status: "disabled" });
    await seedRoute(fixture, { harness: "codex" });
    await seedRoute(fixture, { harness: "codex", model: "gpt-5" });
    await seedRoute(fixture, { health: "open", model: "claude-down" });

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
    // What the card names without a second read (#70).
    assertEquals(offer.source, {
      provider: PIN.provider,
      model: PIN.model,
      providerName: "Anthropic",
      modelName: PIN.model,
      harness: PIN.harness,
      billingRoute: "api_metered",
      health: "open",
    });
    assertEquals(offer.reason, "timeout");
    assert(!Number.isNaN(Date.parse(offer.since)));
    assertEquals(offer.nextCheckAt, null);
    // Only usable routes are targets, in creation order, each with its price
    // flag from the same lookup the admit refuses with.
    assertEquals(
      offer.targets.map(({ routeId, priced }) => [routeId, priced]),
      [[eligible, true], [noPrice, false], [defaultAccount, false]],
    );
    for (const target of offer.targets) {
      assertEquals(target.providerName, "Anthropic");
      assertEquals(target.estimatedIncrementalCost, null);
    }
    assertEquals(
      offer.targets.find((t) => t.routeId === eligible)!.modelName,
      "claude-y",
    );
    // The rest are counts per reason, never rows.
    assertEquals(offer.unavailable, [
      {
        reason: "route_not_active",
        count: 1,
        routes: [{
          provider: PIN.provider,
          model: PIN.model,
          providerName: "Anthropic",
          modelName: PIN.model,
        }],
      },
      {
        reason: "different_harness",
        count: 2,
        harnesses: [{ harness: "codex", count: 2 }],
      },
      {
        reason: "route_open",
        count: 1,
        routes: [{
          provider: PIN.provider,
          model: "claude-down",
          providerName: "Anthropic",
          modelName: "claude-down",
        }],
      },
    ]);
  } finally {
    await fixture.fx.ownerPg.query(
      `delete from bakery.provider_pricing_snapshots
        where billing_account_id = any($1::text[])`,
      [identities],
    );
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

Deno.test("route continuations: a step with two matching routes, or two live jobs, gets one offer", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    // Two endpoints of one provider share a pin, and both are down.
    const first = await seedRoute(fixture);
    const second = await seedRoute(fixture);
    await openIncident(fixture, first);
    await openIncident(fixture, second);
    // A second live job on the same step (another action) with the same pin.
    await fixture.fx.ownerPg.query(
      `insert into bakery.jobs (id, organization_id, run_step_id, action, input,
         requirements, status, current_fence, agent_config, billing)
       select gen_random_uuid(), organization_id, run_step_id, 'harness.review',
         '{}', '{}', 'queued', 1, agent_config, billing
       from bakery.jobs where id = $1`,
      [run.jobId],
    );
    const result = await offersOk(fixture, run.runId);
    assertEquals(result.offers.length, 1);
    assertEquals(result.offers[0]!.runStepId, run.stepId);
    // The same data always gives the same offer.
    const again = await offersOk(fixture, run.runId);
    assertEquals(
      again.offers[0]!.sourceRouteId,
      result.offers[0]!.sourceRouteId,
    );
    assertEquals(again.offers[0]!.incidentId, result.offers[0]!.incidentId);
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: a closed incident still linked to the route offers nothing", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    const source = await seedRoute(fixture);
    const incident = await openIncident(fixture, source);
    assertEquals((await offersOk(fixture, run.runId)).offers.length, 1);
    // The incident recovers or is superseded while the route still points at it
    // (the pointer is cleared by the writer that closes it, and a stale link is
    // exactly the state a reader must not trust).
    for (const status of ["recovered", "superseded"]) {
      await fixture.fx.ownerPg.query(
        "update bakery.provider_incidents set status = $2, closed_at = now() where id = $1",
        [incident, status],
      );
      const link = await fixture.fx.ownerPg.query(
        "select incident_id from bakery.provider_routes where id = $1",
        [source],
      );
      assertEquals(link.rows[0].incident_id, incident);
      assertEquals(
        (await offersOk(fixture, run.runId)).offers,
        [],
        status,
      );
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: an incident on one account's route does not stall a run billing another account", async () => {
  const fixture = await openApprovalFixture();
  try {
    const onA = await seedRun(fixture, {
      pin: { billingAccountId: "acct-continuation-a" },
    });
    const onB = await seedRun(fixture, {
      pin: { billingAccountId: "acct-continuation-b" },
    });
    // Two routes share the pin; only account A's is down.
    const routeA = await seedRoute(fixture, {
      billingAccountId: "acct-continuation-a",
    });
    await seedRoute(fixture, { billingAccountId: "acct-continuation-b" });
    await openIncident(fixture, routeA);

    const offeredA = await offersOk(fixture, onA.runId);
    assertEquals(offeredA.offers.length, 1);
    assertEquals(offeredA.offers[0]!.sourceRouteId, routeA);
    assertEquals((await offersOk(fixture, onB.runId)).offers, []);

    const runs = await withPgTransaction(
      fixture.fx.ownerPg,
      (transaction) =>
        readRunsWaitingOnModel(transaction, fixture.fx.organizationId, [
          onA.runId,
          onB.runId,
        ]),
    );
    assertEquals([...runs], [onA.runId]);
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
    // And a queued one does.
    const queued = await seedRun(fixture, { jobStatus: "queued" });
    assertEquals((await offersOk(fixture, queued.runId)).offers.length, 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: a leased or running job behind an open incident is not offered, and is once it is queued again", async () => {
  const fixture = await openApprovalFixture();
  try {
    const route = await seedRoute(fixture);
    await openIncident(fixture, route);
    for (const jobStatus of ["leased", "running"]) {
      // An attempt in flight is still working: one probe failure on its route
      // does not make the step wait on a model.
      const run = await seedRun(fixture, { jobStatus });
      assertEquals((await offersOk(fixture, run.runId)).offers, [], jobStatus);
      // The attempt ends and the job is requeued behind the same incident.
      await fixture.fx.ownerPg.query(
        "update bakery.jobs set status = 'queued' where id = $1",
        [run.jobId],
      );
      const offered = await offersOk(fixture, run.runId);
      assertEquals(offered.offers.length, 1, jobStatus);
      assertEquals(offered.offers[0]!.runStepId, run.stepId);
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

Deno.test("route continuations: a viewer cannot read the offers, and is told the run is not found", async () => {
  const fixture = await openApprovalFixture();
  try {
    const run = await seedRun(fixture);
    // A read the caller may not make answers "not found", not "forbidden", so a
    // viewer cannot learn that the run exists (authorize.ts: a denied read).
    await expectStatus(
      await offers(fixture, run.runId, fixture.fx.viewer),
      404,
      "viewer",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("route continuations: another organization's run is absent, not forbidden", async () => {
  const fixture = await openApprovalFixture();
  const foreignOrg = crypto.randomUUID();
  try {
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
    // The foreign rows name a principal of this fixture, which the fixture removes
    // on close; the organization's own cascade clears them first.
    await fixture.fx.ownerPg.query(
      "delete from bakery.organizations where id = $1",
      [foreignOrg],
    );
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
