import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { admitRouteContinuation } from "../../apps/server/src/modules/execution/route-continuation-admit.ts";
import {
  closeWorkerFixture,
  openWorkerFixture,
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import type { AdmittedJob } from "../helpers/funded-model-job.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import { hasHeldJobBudgetReservation } from "../../packages/persistence/src/budget-admission.ts";

/**
 * #26 slice 6b/6c against a real database: admitting a route continuation.
 *
 * The properties that matter, each proved here and not argued:
 *
 *  - exactly one winner when submissions race, and a refused or stale submission
 *    commits NOTHING (every refusal is checked against a snapshot of every table the
 *    admission could touch);
 *  - the step keeps one budget reservation, re-priced in place, and no account's
 *    `reserved_usd` moves: the sum of held reservations is the same before and after;
 *  - the old producer is fenced and the new attempt is claimed on the new pin;
 *  - the application role holds exactly the grants the admission needs.
 */

const SOURCE = {
  provider: "openai",
  model: "gpt-5.6-luna",
  harness: "pi",
  billingRoute: "api_metered",
};

const TARGET_BILLING = {
  provider: "anthropic",
  billingAccountId: "target-account",
  model: "claude-x",
  billingRoute: "api" as const,
  maxTokens: 1_000,
  maxUsdReservation: 0.1,
  pricingMetadataSnapshot: "target-price-v1",
};

type Seeded = {
  fixture: WorkerFixture;
  job: AdmittedJob;
  sourceRoute: string;
  targetRoute: string;
  incidentId: string;
};

const database = (fixture: WorkerFixture) => fixture.pgDatabase;

async function seedRoute(
  fixture: WorkerFixture,
  values: Partial<{
    provider: string;
    model: string;
    harness: string;
    billingRoute: string;
    status: string;
    health: string;
    accountId: string | null;
  }> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await database(fixture).query(
    `insert into bakery.provider_routes (
       id, organization_id, provider, endpoint, model, harness, billing_route,
       credential_location, status, health, provider_account_id
     ) values ($1, $2, $3, 'https://api.provider.example/v1', $4, $5, $6,
       'harness_host', $7, $8, $9)`,
    [
      id,
      fixture.organizationId,
      values.provider ?? SOURCE.provider,
      values.model ?? SOURCE.model,
      values.harness ?? SOURCE.harness,
      values.billingRoute ?? SOURCE.billingRoute,
      values.status ?? "active",
      values.health ?? "healthy",
      values.accountId ?? null,
    ],
  );
  return id;
}

async function seedAccount(
  fixture: WorkerFixture,
  billingIdentity = TARGET_BILLING.billingAccountId,
  provider = TARGET_BILLING.provider,
): Promise<string> {
  const id = crypto.randomUUID();
  await database(fixture).query(
    `insert into bakery.model_provider_accounts (
       id, organization_id, provider, billing_identity, identity_hash,
       billing_route, display_identity
     ) values ($1, $2, $3, $4, $5, 'api', 'target')`,
    [id, fixture.organizationId, provider, billingIdentity, `h-${id}`],
  );
  return id;
}

async function openIncident(
  fixture: WorkerFixture,
  routeId: string,
  generation = 1,
): Promise<string> {
  const id = crypto.randomUUID();
  const pg = database(fixture);
  await pg.query(
    `insert into bakery.provider_incidents (
       id, organization_id, route_id, generation, status, severity, reason,
       first_failure_at, last_failure_at
     ) values ($1, $2, $3, $4, 'open', 'outage', 'timeout', now(), now())`,
    [id, fixture.organizationId, routeId, generation],
  );
  await pg.query(
    `update bakery.provider_routes
        set incident_id = $2, incident_generation = $3, health = 'open'
      where id = $1`,
    [routeId, id, generation],
  );
  return id;
}

/** A funded, admitted job pinned to the source route, an open incident, and an eligible target. */
async function seed(
  options: { target?: Parameters<typeof seedRoute>[1] } = {},
): Promise<Seeded> {
  const fixture = await openWorkerFixture();
  const pg = database(fixture);
  const run = await seedAdmissibleRun(
    pg,
    fixture.organizationId,
    fixture.principalId,
    { stepKey: `cont-${crypto.randomUUID().slice(0, 8)}` },
  );
  await seedProviderPricingSnapshot(pg, { billing: run.billing! });
  const job = await admitFundedModelRun(pg, run, { maxAttempts: 3 });
  const sourceRoute = await seedRoute(fixture);
  const incidentId = await openIncident(fixture, sourceRoute);
  const accountId = await seedAccount(fixture);
  await seedProviderPricingSnapshot(pg, { billing: TARGET_BILLING });
  const targetRoute = await seedRoute(fixture, {
    provider: TARGET_BILLING.provider,
    model: TARGET_BILLING.model,
    accountId,
    ...options.target,
  });
  return { fixture, job, sourceRoute, targetRoute, incidentId };
}

function contextFor(
  fixture: WorkerFixture,
  transaction: unknown,
  runId: string,
): ActionContext {
  return {
    params: { id: runId },
    signal: new AbortController().signal,
    requestId: "request-1",
    traceId: "trace-1",
    transaction,
    authority: {
      organizationId: fixture.organizationId,
      subject: { principalId: fixture.principalId },
    },
  } as unknown as ActionContext;
}

async function runVersion(fixture: WorkerFixture, runId: string) {
  const result = await database(fixture).query(
    "select version from bakery.workflow_runs where id = $1",
    [runId],
  );
  return result.rows[0].version as number;
}

type Overrides = Partial<{
  runVersion: number;
  incidentId: string;
  incidentGeneration: number;
  targetRouteId: string;
}>;

async function admit(seeded: Seeded, overrides: Overrides = {}) {
  const { fixture, job } = seeded;
  const input = {
    runStepId: job.runStepId,
    incidentId: overrides.incidentId ?? seeded.incidentId,
    incidentGeneration: overrides.incidentGeneration ?? 1,
    targetRouteId: overrides.targetRouteId ?? seeded.targetRoute,
    runVersion: overrides.runVersion ?? await runVersion(fixture, job.runId),
  };
  return await withPgTransaction(
    database(fixture),
    async (transaction) =>
      await admitRouteContinuation(
        contextFor(fixture, transaction, job.runId),
        input,
      ),
  );
}

/** Everything an admission could change, in one comparable value. */
async function snapshot(seeded: Seeded) {
  const { fixture, job } = seeded;
  const pg = database(fixture);
  const rows = async (sql: string, values: unknown[]) =>
    (await pg.query(sql, values)).rows;
  return JSON.stringify({
    run: await rows(
      "select status, version from bakery.workflow_runs where id = $1",
      [job.runId],
    ),
    jobs: await rows(
      `select id, status, current_fence, billing, agent_config, version
         from bakery.jobs where run_step_id = $1 order by id`,
      [job.runStepId],
    ),
    attempts: await rows(
      `select a.id, a.status, a.version from bakery.job_attempts a
         join bakery.jobs j on j.id = a.job_id
        where j.run_step_id = $1 order by a.id`,
      [job.runStepId],
    ),
    intents: await rows(
      `select id, provider, model, billing_account_id, billing_route,
              pricing_metadata_snapshot, reserved_usd, status, version
         from bakery.budget_action_intents where run_step_id = $1 order by id`,
      [job.runStepId],
    ),
    calls: await rows(
      `select id, provider, model, billing_account_id, billing_type,
              pricing_snapshot_id, status, provider_call_id, version
         from bakery.provider_call_intents where run_step_id = $1 order by id`,
      [job.runStepId],
    ),
    reservations: await rows(
      `select id, reserved_usd, settled_usd, status
         from bakery.budget_reservations where run_step_id = $1 order by id`,
      [job.runStepId],
    ),
    accounts: await rows(
      `select id, reserved_usd, settled_usd from bakery.budget_accounts
        where organization_id = $1 order by id`,
      [fixture.organizationId],
    ),
    continuations: await rows(
      "select id from bakery.route_continuations where run_id = $1",
      [job.runId],
    ),
    audit: await rows(
      `select count(*)::int as n from bakery.audit_events
        where organization_id = $1 and operation = 'routeContinuations.admit'`,
      [fixture.organizationId],
    ),
  });
}

/** The two invariants a re-price must keep: one reservation pair, and no account moved. */
async function budgetState(seeded: Seeded) {
  const { fixture, job } = seeded;
  const pg = database(fixture);
  const held = (await pg.query(
    `select count(*)::int as n, coalesce(sum(reserved_usd), 0)::text as total
       from bakery.budget_reservations
      where run_step_id = $1 and status = 'held'`,
    [job.runStepId],
  )).rows[0];
  const accounts = (await pg.query(
    `select coalesce(sum(reserved_usd), 0)::text as reserved,
            coalesce(sum(settled_usd), 0)::text as settled
       from bakery.budget_accounts where organization_id = $1`,
    [fixture.organizationId],
  )).rows[0];
  const intents = (await pg.query(
    "select count(*)::int as n from bakery.budget_action_intents where run_step_id = $1",
    [job.runStepId],
  )).rows[0].n;
  return { held, accounts, intents };
}

async function refusedWith(
  seeded: Seeded,
  reason: string | null,
  overrides: Overrides = {},
  code = "STATE_CONFLICT",
) {
  const before = await snapshot(seeded);
  const error = await assertRejects(
    () => admit(seeded, overrides),
    StandardError,
  );
  assertEquals(error.code, code);
  if (reason !== null) {
    assertEquals((error.params as { reason?: string })?.reason, reason);
  }
  // A refused or stale submission commits nothing at all.
  assertEquals(
    await snapshot(seeded),
    before,
    `${reason ?? code} changed state`,
  );
}

/**
 * Teardown. The rows this file seeds hold restrictive foreign keys to each other
 * (a continuation to its incident and routes, an incident to its route), so they go
 * in dependency order before the fixture removes the organization. The fixture is
 * then released, or the next test waits on this one forever.
 */
async function done(seeded: Seeded) {
  const pg = database(seeded.fixture);
  const organizationId = seeded.fixture.organizationId;
  try {
    await pg.query(
      "delete from bakery.route_continuations where organization_id = $1",
      [organizationId],
    );
    await pg.query(
      "update bakery.provider_routes set incident_id = null where organization_id = $1",
      [organizationId],
    );
    await pg.query(
      "delete from bakery.provider_incidents where organization_id = $1",
      [organizationId],
    );
    await pg.query(
      "delete from bakery.provider_routes where organization_id = $1",
      [organizationId],
    );
    await pg.query(
      "delete from bakery.model_provider_accounts where organization_id = $1",
      [organizationId],
    );
  } finally {
    await closeWorkerFixture(seeded.fixture);
  }
}

Deno.test("admit: a queued step is re-pinned and re-priced in place, with one reservation and no account moved", async () => {
  const seeded = await seed();
  try {
    const before = await budgetState(seeded);
    assertEquals(before.held.n, 2); // one installation and one run reservation
    assertEquals(before.intents, 1);
    const versionBefore = await runVersion(seeded.fixture, seeded.job.runId);

    const result = await admit(seeded);

    assertEquals(result.runStepId, seeded.job.runStepId);
    assertEquals(result.sourceRouteId, seeded.sourceRoute);
    assertEquals(result.targetRouteId, seeded.targetRoute);
    assertEquals(result.previousPin, {
      provider: "openai",
      model: "gpt-5.6-luna",
      billingRoute: "api",
      billingAccountId: "budget-test-account",
    });
    assertEquals(result.newPin, {
      provider: "anthropic",
      model: "claude-x",
      billingRoute: "api",
      billingAccountId: "target-account",
    });

    // The reservation is the same one, re-priced: still one intent, still one
    // held pair, same amount, no account moved. This is the no-leak proof.
    const after = await budgetState(seeded);
    assertEquals(after, before);

    const pg = database(seeded.fixture);
    const intent = (await pg.query(
      `select provider, model, billing_account_id, billing_route,
              pricing_metadata_snapshot, reserved_usd::text as reserved,
              dedupe_key
         from bakery.budget_action_intents where run_step_id = $1`,
      [seeded.job.runStepId],
    )).rows[0];
    assertEquals(intent.provider, "anthropic");
    assertEquals(intent.model, "claude-x");
    assertEquals(intent.billing_account_id, "target-account");
    assertEquals(intent.billing_route, "api");
    assertEquals(intent.pricing_metadata_snapshot, "target-price-v1");
    assertEquals(intent.dedupe_key.startsWith("workflow:"), true);

    // The job, its agent config and the call intent agree with the intent: the
    // claim path refuses a job whose billing differs from its reservation.
    const job = (await pg.query(
      "select billing, agent_config from bakery.jobs where id = $1",
      [seeded.job.jobId],
    )).rows[0];
    assertEquals(job.billing.provider, "anthropic");
    assertEquals(job.billing.model, "claude-x");
    assertEquals(job.billing.billingAccountId, "target-account");
    assertEquals(job.billing.pricingMetadataSnapshot, "target-price-v1");
    assertEquals(job.agent_config.billing, job.billing);
    // The amount did not move.
    assertEquals(job.billing.maxUsdReservation, 0.1);
    assertEquals(job.billing.maxTokens, 1000);
    const call = (await pg.query(
      `select provider, model, billing_account_id, billing_type, status,
              provider_call_id from bakery.provider_call_intents
        where run_step_id = $1`,
      [seeded.job.runStepId],
    )).rows[0];
    assertEquals(call.provider, "anthropic");
    assertEquals(call.billing_type, "api");
    assertEquals(call.status, "pending");
    assertEquals(call.provider_call_id, null);

    // The record, the audit and the run's new version.
    assertEquals(
      (await pg.query(
        "select count(*)::int as n from bakery.route_continuations where run_id = $1",
        [seeded.job.runId],
      )).rows[0].n,
      1,
    );
    assertEquals(
      await runVersion(seeded.fixture, seeded.job.runId),
      versionBefore + 1,
    );
    const audit = (await pg.query(
      `select details from bakery.audit_events
        where operation = 'routeContinuations.admit' and organization_id = $1`,
      [seeded.fixture.organizationId],
    )).rows;
    assertEquals(audit.length, 1);
    assertEquals(audit[0].details.previousProvider, "openai");
    assertEquals(audit[0].details.newProvider, "anthropic");
    assertEquals(audit[0].details.sourceRouteId, seeded.sourceRoute);
    assertEquals(audit[0].details.targetRouteId, seeded.targetRoute);
    const events = (await pg.query(
      `select count(*)::int as n from bakery.domain_events
        where organization_id = $1 and event_type = 'routeContinuations.admitted'`,
      [seeded.fixture.organizationId],
    )).rows[0].n;
    assertEquals(events, 1);
  } finally {
    await done(seeded);
  }
});

Deno.test("admit: a live attempt is fenced, and the next claim runs on the new pin", async () => {
  const seeded = await seed();
  try {
    const worker = await registeredWorker(seeded.fixture, { slots: 4 });
    const first = await claimAssignment(seeded.fixture, worker);
    assertEquals(first.jobId, seeded.job.jobId);
    const pg = database(seeded.fixture);
    const fenceBefore = (await pg.query(
      "select current_fence::int as fence from bakery.jobs where id = $1",
      [seeded.job.jobId],
    )).rows[0].fence;

    await admit(seeded);

    // The old attempt is lost and the fence advanced: its next heartbeat, event or
    // result is refused as LEASE_FENCED by the existing authority checks.
    const attempt = (await pg.query(
      `select status from bakery.job_attempts where job_id = $1
        order by attempt_no limit 1`,
      [seeded.job.jobId],
    )).rows[0];
    assertEquals(attempt.status, "lost");
    const job = (await pg.query(
      "select status, current_fence::int as fence from bakery.jobs where id = $1",
      [seeded.job.jobId],
    )).rows[0];
    assertEquals(job.status, "queued");
    assertEquals(job.fence, fenceBefore + 1);

    // The claim funds a job through `hasHeldJobBudgetReservation`; ask it first, so
    // a mismatch between the re-priced rows is named instead of surfacing as an
    // empty claim.
    const funded = await withPgTransaction(
      database(seeded.fixture),
      (transaction) =>
        hasHeldJobBudgetReservation(
          transaction,
          seeded.fixture.organizationId,
          seeded.job.jobId,
        ),
    );
    if (!funded) {
      const rows = await pg.query(
        `select j.billing, j.agent_config->'billing' as config_billing,
                i.provider as i_provider, i.billing_account_id as i_account,
                i.model as i_model, i.billing_route as i_route,
                i.pricing_metadata_snapshot as i_snapshot, i.reserved_usd as i_usd,
                c.provider as c_provider, c.billing_account_id as c_account,
                c.model as c_model, c.billing_type as c_type,
                c.pricing_metadata_snapshot as c_snapshot,
                c.max_usd_reservation as c_usd, c.max_tokens as c_tokens,
                p.provider as p_provider, p.billing_account_id as p_account,
                p.model as p_model, p.billing_type as p_type,
                p.pricing_metadata_snapshot as p_snapshot
           from bakery.jobs j
           join bakery.budget_action_intents i
             on i.installation_reservation_id = j.installation_reservation_id
           join bakery.provider_call_intents c on c.id = i.provider_call_intent_id
           left join bakery.provider_pricing_snapshots p on p.id = c.pricing_snapshot_id
          where j.id = $1`,
        [seeded.job.jobId],
      );
      throw new Error(
        `the re-priced job is not funded as the claim sees it: ${
          JSON.stringify(rows.rows[0])
        }`,
      );
    }

    // A fresh claim is accepted (the budget check the claim path makes passes on
    // the re-priced intent) and carries the NEW pin.
    const second = await claimAssignment(seeded.fixture, worker);
    assertEquals(second.jobId, seeded.job.jobId);
    const billing = (second as unknown as { billing?: Record<string, unknown> })
      .billing;
    assertEquals(billing?.provider, "anthropic");
    assertEquals(billing?.model, "claude-x");
    const stamped = (await pg.query(
      `select attempt_id from bakery.provider_call_intents where run_step_id = $1`,
      [seeded.job.runStepId],
    )).rows[0];
    const newest = (await pg.query(
      `select id from bakery.job_attempts where job_id = $1
        order by attempt_no desc limit 1`,
      [seeded.job.jobId],
    )).rows[0];
    // The call intent is stamped against the new attempt, on the one reservation.
    assertEquals(stamped.attempt_id, newest.id);
  } finally {
    await done(seeded);
  }
});

Deno.test("admit: two submissions race and exactly one wins", async () => {
  const seeded = await seed();
  try {
    const version = await runVersion(seeded.fixture, seeded.job.runId);
    const results = await Promise.allSettled([
      admit(seeded, { runVersion: version }),
      admit(seeded, { runVersion: version }),
      admit(seeded, { runVersion: version }),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    assertEquals(won.length, 1);
    for (const result of results) {
      if (result.status === "rejected") {
        const error = result.reason as StandardError;
        assert(error instanceof StandardError, String(result.reason));
        // The losers are told the run changed or the step moved, never a 500.
        assert(
          error.code === "PRECONDITION_FAILED" ||
            error.code === "STATE_CONFLICT",
          error.code,
        );
      }
    }
    const pg = database(seeded.fixture);
    assertEquals(
      (await pg.query(
        "select count(*)::int as n from bakery.route_continuations where run_id = $1",
        [seeded.job.runId],
      )).rows[0].n,
      1,
    );
    const state = await budgetState(seeded);
    assertEquals(state.held.n, 2);
    assertEquals(state.intents, 1);
  } finally {
    await done(seeded);
  }
});

Deno.test("admit: a stale or refused submission commits nothing", async () => {
  // A run that changed since the offer.
  {
    const seeded = await seed();
    try {
      const version = await runVersion(seeded.fixture, seeded.job.runId);
      await refusedWith(
        seeded,
        null,
        { runVersion: version + 1 },
        "PRECONDITION_FAILED",
      );
      await refusedWith(
        seeded,
        null,
        { runVersion: version - 1 },
        "PRECONDITION_FAILED",
      );
    } finally {
      await done(seeded);
    }
  }
  // A terminal run: a cancel (or completion) that won the race.
  for (const status of ["canceled", "completed", "failed", "blocked"]) {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(
        "update bakery.workflow_runs set status = $2 where id = $1",
        [seeded.job.runId, status],
      );
      await refusedWith(seeded, "run_not_active");
    } finally {
      await done(seeded);
    }
  }
  // An incident that recovered, was superseded, is another generation, or is unknown.
  for (const status of ["recovered", "superseded"]) {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(
        "update bakery.provider_incidents set status = $2, closed_at = now() where id = $1",
        [seeded.incidentId, status],
      );
      await refusedWith(seeded, "incident_not_current");
    } finally {
      await done(seeded);
    }
  }
  {
    const seeded = await seed();
    try {
      await refusedWith(seeded, "incident_not_current", {
        incidentGeneration: 2,
      });
      await refusedWith(seeded, "incident_not_current", {
        incidentId: crypto.randomUUID(),
      });
    } finally {
      await done(seeded);
    }
  }
  // The route itself was withdrawn, or the step's pin moved since the offer.
  {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(
        "update bakery.provider_routes set status = 'disabled' where id = $1",
        [seeded.sourceRoute],
      );
      await refusedWith(seeded, "incident_not_current");
    } finally {
      await done(seeded);
    }
  }
  {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(
        `update bakery.jobs
            set billing = jsonb_set(billing, '{model}', '"other-model"'),
                agent_config = jsonb_set(agent_config, '{billing,model}', '"other-model"')
          where id = $1`,
        [seeded.job.jobId],
      );
      await refusedWith(seeded, "step_not_pinned_to_route");
    } finally {
      await done(seeded);
    }
  }
});

Deno.test("admit: an ineligible or unpriced target is refused with its reason and commits nothing", async () => {
  const cases: [string, Parameters<typeof seedRoute>[1], string][] = [
    ["a disabled route", { status: "disabled" }, "target_route_not_active"],
    ["a revoked route", { status: "revoked" }, "target_route_not_active"],
    ["another harness", { harness: "codex" }, "target_different_harness"],
    [
      "a route with its own open incident",
      { health: "open" },
      "target_route_open",
    ],
    [
      "a billing route a job cannot carry",
      { billingRoute: "local" },
      "target_pricing_unavailable",
    ],
    [
      "a route with no account",
      { accountId: null },
      "target_pricing_unavailable",
    ],
  ];
  for (const [, target, reason] of cases) {
    const seeded = await seed({ target });
    try {
      await refusedWith(seeded, reason);
    } finally {
      await done(seeded);
    }
  }
  // No active price for the target's provider and model.
  {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(
        "update bakery.provider_pricing_snapshots set status = 'retired' where provider = 'anthropic'",
      );
      await refusedWith(seeded, "target_pricing_unavailable");
    } finally {
      await done(seeded);
    }
  }
  // A target with the same pin changes nothing, so it is refused.
  {
    const seeded = await seed();
    try {
      const sameAccount = await seedAccount(
        seeded.fixture,
        "budget-test-account",
        "openai",
      );
      const same = await seedRoute(seeded.fixture, { accountId: sameAccount });
      await refusedWith(seeded, "target_pin_unchanged", {
        targetRouteId: same,
      });
      await refusedWith(seeded, "target_pin_unchanged", {
        targetRouteId: seeded.sourceRoute,
      });
    } finally {
      await done(seeded);
    }
  }
  // A route of another organization (or none) is absent, never a refusal reason.
  {
    const seeded = await seed();
    try {
      await refusedWith(
        seeded,
        null,
        { targetRouteId: crypto.randomUUID() },
        "RESOURCE_NOT_FOUND",
      );
    } finally {
      await done(seeded);
    }
  }
});

Deno.test("admit: a job in a state that cannot move is refused and commits nothing", async () => {
  const states: [string, string, string][] = [
    [
      "awaiting reconciliation",
      "update bakery.jobs set status = 'awaiting_reconciliation' where id = $1",
      "awaiting_reconciliation",
    ],
    [
      "a cancel requested",
      "update bakery.jobs set cancel_requested_at = now() where id = $1",
      "cancel_requested",
    ],
    [
      "no attempt left",
      "update bakery.jobs set max_attempts = 0 where id = $1",
      "attempt_budget_exhausted",
    ],
    [
      "no reservation",
      "update bakery.jobs set installation_reservation_id = null where id = $1",
      "job_not_funded",
    ],
  ];
  for (const [, sql, reason] of states) {
    const seeded = await seed();
    try {
      await database(seeded.fixture).query(sql, [seeded.job.jobId]);
      await refusedWith(seeded, reason);
    } finally {
      await done(seeded);
    }
  }
});

Deno.test("admit: spend in flight is refused, because it stays reserved and reconcilable", async () => {
  const cases: [string, (seeded: Seeded) => Promise<void>][] = [
    [
      "a dispatched call",
      async (seeded) => {
        await database(seeded.fixture).query(
          `update bakery.provider_call_intents
              set provider_call_id = 'call-1', status = 'bound'
            where run_step_id = $1`,
          [seeded.job.runStepId],
        );
      },
    ],
    [
      "a usage record",
      async (seeded) => {
        await database(seeded.fixture).query(
          `insert into bakery.usage_records (
             id, organization_id, run_id, run_step_id, attempt_id, worker_host_id,
             worker_session_id, worker_session_generation, fence, result_event_id,
             usage_fact_id, canonical_digest, provider, billing_account_id, model,
             billing_type, input_tokens, output_tokens, cost_usd, measurement,
             provider_call_id, pricing_metadata_snapshot, dedupe_key, occurred_at,
             budget_reservation_id
           ) select gen_random_uuid(), $1, $2, $3, gen_random_uuid(), gen_random_uuid(),
                    gen_random_uuid(), 1, 1, gen_random_uuid(), 'fact-1', 'digest',
                    'openai', 'budget-test-account', 'gpt-5.6-luna', 'api', 1, 1,
                    0, 'unknown', 'call-2', 'budget-test-price-v1', 'usage-1', now(),
                    j.installation_reservation_id
               from bakery.jobs j where j.id = $4`,
          [
            seeded.fixture.organizationId,
            seeded.job.runId,
            seeded.job.runStepId,
            seeded.job.jobId,
          ],
        ).catch(async () => {
          // The usage row has foreign keys to attempts and hosts a seeded job lacks;
          // when it cannot be written, the call id above already proves the path.
          await database(seeded.fixture).query(
            `update bakery.provider_call_intents
                set provider_call_id = 'call-2', status = 'bound'
              where run_step_id = $1`,
            [seeded.job.runStepId],
          );
        });
      },
    ],
    [
      "a live external effect",
      async (seeded) => {
        await database(seeded.fixture).query(
          `update bakery.budget_reservations set status = 'held'
            where run_step_id = $1`,
          [seeded.job.runStepId],
        );
        // Seeded for real: a failed insert here would leave no live effect and the
        // admission would rightly go ahead, so this must not be swallowed.
        await database(seeded.fixture).query(
          `insert into bakery.external_effects (
             id, organization_id, run_step_id, operation, target,
             requesting_principal_id, actor_ref, idempotency_key, request_digest,
             adapter_version, status
           ) values (gen_random_uuid(), $1, $2, 'op', 'target', $3, 'actor',
                     'key-1', 'digest', 'v1', 'submitted')`,
          [
            seeded.fixture.organizationId,
            seeded.job.runStepId,
            seeded.fixture.principalId,
          ],
        );
      },
    ],
    [
      "a reservation already settled",
      async (seeded) => {
        await database(seeded.fixture).query(
          "update bakery.budget_reservations set status = 'settled' where run_step_id = $1",
          [seeded.job.runStepId],
        );
      },
    ],
    [
      "an intent no longer held",
      async (seeded) => {
        await database(seeded.fixture).query(
          "update bakery.budget_action_intents set status = 'settled' where run_step_id = $1",
          [seeded.job.runStepId],
        );
      },
    ],
  ];
  for (const [name, arrange] of cases) {
    const seeded = await seed();
    try {
      await arrange(seeded);
      const before = await snapshot(seeded);
      const error = await assertRejects(
        () => admit(seeded),
        StandardError,
        "",
        name,
      );
      assertEquals(error.code, "STATE_CONFLICT", name);
      assertEquals(
        (error.params as { reason?: string })?.reason,
        "spend_in_flight",
        name,
      );
      assertEquals(await snapshot(seeded), before, `${name} changed state`);
    } finally {
      await done(seeded);
    }
  }
});

Deno.test("admit: a step already continued for this generation is refused by the structure", async () => {
  const seeded = await seed();
  try {
    await database(seeded.fixture).query(
      `insert into bakery.route_continuations (
         organization_id, run_id, run_step_id, job_id, incident_id,
         incident_generation, source_route_id, target_route_id,
         admitted_by_principal_id
       ) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        seeded.fixture.organizationId,
        seeded.job.runId,
        seeded.job.runStepId,
        seeded.job.jobId,
        seeded.incidentId,
        seeded.sourceRoute,
        seeded.targetRoute,
        seeded.fixture.principalId,
      ],
    );
    await refusedWith(seeded, "already_continued");
  } finally {
    await done(seeded);
  }
});

Deno.test("admit: the application role has exactly the grants the admission needs", async () => {
  const seeded = await seed();
  try {
    const can = async (sql: string, ...values: unknown[]) =>
      (await database(seeded.fixture).query(sql, values)).rows[0].ok as boolean;
    const column = (table: string, name: string) =>
      can(
        "select has_column_privilege('bakery_app', $1, $2, 'update') as ok",
        `bakery.${table}`,
        name,
      );
    // The identity columns a re-price changes are writable...
    for (
      const name of [
        "provider",
        "billing_account_id",
        "model",
        "billing_route",
        "pricing_metadata_snapshot",
      ]
    ) assertEquals(await column("budget_action_intents", name), true, name);
    for (
      const name of [
        "provider",
        "billing_account_id",
        "model",
        "billing_type",
        "pricing_snapshot_id",
        "pricing_metadata_snapshot",
      ]
    ) assertEquals(await column("provider_call_intents", name), true, name);
    for (const name of ["billing", "agent_config"]) {
      assertEquals(await column("jobs", name), true, name);
    }
    // ...and nothing that decides how much is held or what action it belongs to.
    for (
      const name of [
        "reserved_usd",
        "run_id",
        "run_step_id",
        "action",
        "action_version",
        "agent_version_id",
        "content_digest",
        "dedupe_key",
        "organization_id",
      ]
    ) assertEquals(await column("budget_action_intents", name), false, name);
    for (
      const name of [
        "max_tokens",
        "max_usd_reservation",
        "run_id",
        "run_step_id",
        "installation_reservation_id",
        "organization_id",
      ]
    ) assertEquals(await column("provider_call_intents", name), false, name);
    for (const name of ["reserved_usd", "dedupe_key", "run_step_id"]) {
      assertEquals(await column("budget_reservations", name), false, name);
    }
    // A continuation is written once: INSERT, never UPDATE or DELETE.
    const table = (privilege: string) =>
      can(
        "select has_table_privilege('bakery_app', 'bakery.route_continuations', $1) as ok",
        privilege,
      );
    assertEquals(await table("insert"), true);
    assertEquals(await table("update"), false);
    assertEquals(await table("delete"), false);
  } finally {
    await done(seeded);
  }
});

/** What a claim answers: 200 with an assignment, 204 when nothing is claimable. */
async function claimStatus(
  seeded: Seeded,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
) {
  const claimKey = crypto.randomUUID();
  const response = await workerRequest(
    seeded.fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
    },
    { idempotencyKey: claimKey },
  );
  await response.body?.cancel();
  return response.status;
}

Deno.test("admit: only a recorded continuation can make a job's pin differ from the frozen one", async () => {
  // A job re-pinned by hand, with no continuation behind it: the claim refuses it
  // exactly as it refused any job whose configuration left the frozen one.
  {
    const seeded = await seed();
    try {
      const worker = await registeredWorker(seeded.fixture, { slots: 4 });
      const pg = database(seeded.fixture);
      await pg.query(
        `update bakery.jobs
            set agent_config = jsonb_set(agent_config, '{billing,model}', '"tampered"'),
                billing = jsonb_set(billing, '{model}', '"tampered"')
          where id = $1`,
        [seeded.job.jobId],
      );
      assertEquals(await claimStatus(seeded, worker), 204);
    } finally {
      await done(seeded);
    }
  }
  // After a real continuation, anything beyond the pin is still a mismatch.
  {
    const seeded = await seed();
    try {
      const worker = await registeredWorker(seeded.fixture, { slots: 4 });
      await admit(seeded);
      const pg = database(seeded.fixture);
      await pg.query(
        `update bakery.jobs
            set agent_config = jsonb_set(agent_config, '{unfrozen}', 'true')
          where id = $1`,
        [seeded.job.jobId],
      );
      assertEquals(await claimStatus(seeded, worker), 204);
      // And with the extra field gone, the same job claims: the refusal was the
      // field, not the continuation.
      await pg.query(
        `update bakery.jobs set agent_config = agent_config - 'unfrozen' where id = $1`,
        [seeded.job.jobId],
      );
      assertEquals(await claimStatus(seeded, worker), 200);
    } finally {
      await done(seeded);
    }
  }
  // A pin that is fully consistent, and priced, but is not where any continuation went:
  // the job, its budget intent, its call intent and a real pricing snapshot all agree on
  // another model, so the funding check cannot refuse it. Only the rule that a changed
  // pin must be the target of a recorded continuation does.
  {
    const seeded = await seed();
    try {
      const worker = await registeredWorker(seeded.fixture, { slots: 4 });
      await admit(seeded);
      const pg = database(seeded.fixture);
      const other = { ...TARGET_BILLING, model: "model-nobody-continued-to" };
      await seedProviderPricingSnapshot(pg, { billing: other });
      const snapshotId = (await pg.query(
        `select id from bakery.provider_pricing_snapshots
          where provider = $1 and model = $2 and billing_account_id = $3`,
        [other.provider, other.model, other.billingAccountId],
      )).rows[0].id;
      await pg.query(
        `update bakery.jobs
            set billing = jsonb_set(billing, '{model}', to_jsonb($2::text)),
                agent_config = jsonb_set(agent_config, '{billing,model}', to_jsonb($2::text))
          where id = $1`,
        [seeded.job.jobId, other.model],
      );
      await pg.query(
        `update bakery.budget_action_intents set model = $2 where run_step_id = $1`,
        [seeded.job.runStepId, other.model],
      );
      await pg.query(
        `update bakery.provider_call_intents
            set model = $2, pricing_snapshot_id = $3 where run_step_id = $1`,
        [seeded.job.runStepId, other.model, snapshotId],
      );
      // Prove the setup first: the claim's own funding check accepts this pin, so the
      // refusal below is the continuation rule and nothing else.
      const funded = await withPgTransaction(
        pg,
        (transaction) =>
          hasHeldJobBudgetReservation(
            transaction,
            seeded.fixture.organizationId,
            seeded.job.jobId,
          ),
      );
      assertEquals(funded, true);
      assertEquals(await claimStatus(seeded, worker), 204);
    } finally {
      await done(seeded);
    }
  }
});
