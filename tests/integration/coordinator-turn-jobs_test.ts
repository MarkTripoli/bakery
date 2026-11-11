import { assert, assertEquals, assertRejects } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  cleanupSeededOrganizations,
  type Fixture,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import {
  claimAssignment,
  heartbeatRequest,
  postWorkerResult,
  resultBody,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import {
  problemCode,
  updateAttemptExpiry,
} from "../helpers/worker-execution.ts";
import { reclaimExpiredAttempts } from "../../packages/persistence/src/attempts.ts";
import {
  markJobAssignmentPayloadInvalid,
  markJobAttemptBudgetExhausted,
} from "../../packages/persistence/src/attempts.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import {
  rawClaim,
  withCoordinatorWorker,
  type WorkerFx,
} from "../helpers/coordinator-turn-jobs-worker.ts";
import {
  billing,
  fund as fundTurn,
  jobInput,
  policy,
  type Scope,
  seedAgentAndTurn,
  seedConversation,
} from "../helpers/coordinator-turn-jobs.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  reserveCoordinatorTurn,
} from "../../apps/server/src/modules/work/budget.ts";
import {
  cancelQueuedCoordinatorTurnJob,
  enqueueCoordinatorTurnJob,
  hasHeldCoordinatorTurnReservation,
  readCoordinatorTurnJob,
  releaseCoordinatorJobReservation,
  requestCoordinatorTurnJobCancel,
} from "../../packages/persistence/src/coordinator-jobs.ts";
import type { BillingConfig } from "../../packages/contracts/src/contracts.ts";

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await fixture.pgDatabase.query(
        `delete from bakery.jobs where conversation_turn_id is not null`,
      );
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

/** Application- and repository-scoped conversation with one active turn and a pinned agent. */
async function seedScope(
  fixture: Fixture,
  label: string,
  config: BillingConfig = billing,
): Promise<Scope> {
  const seed = await seedOrganization(fixture, label, { agent: false });
  return await seedAgentAndTurn(fixture.pgDatabase, seed, config);
}

const fund = (
  fixture: Fixture,
  scope: Scope,
  options: { budget?: typeof policy | undefined; billing?: unknown } = {},
) => fundTurn(fixture.runtimePgDatabase, scope, options);

async function installationReserved(fixture: Fixture): Promise<string> {
  const row = await fixture.pgDatabase.query<{ reserved: string }>(
    `select reserved_usd::text as reserved from bakery.budget_accounts
      where scope = 'installation'
        and period_start = date_trunc('month', clock_timestamp() at time zone 'UTC')
                           at time zone 'UTC'`,
  );
  return row.rows[0]?.reserved ?? "0.000000";
}

async function reasonOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return String(
      (error as { params?: { reason?: string } }).params?.reason ?? error,
    );
  }
  throw new Error("expected a rejection");
}

async function release(fixture: Fixture, scope: Scope): Promise<boolean> {
  const job = (await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.jobs
      where organization_id = $1 and conversation_turn_id = $2`,
    [scope.seed.organizationId, scope.turnId],
  )).rows[0];
  if (!job) return false;
  return await withPgTransaction(
    fixture.runtimePgDatabase,
    (tx) =>
      releaseCoordinatorJobReservation(tx, {
        organizationId: scope.seed.organizationId,
        jobId: job.id,
      }),
  );
}

async function jobRows(fixture: Fixture, scope: Scope) {
  return (await fixture.pgDatabase.query<{
    id: string;
    status: string;
    maxAttempts: number;
    runStepId: string | null;
    applicationId: string | null;
    repositoryId: string | null;
    profileId: string | null;
    observationId: string | null;
    action: string;
    requirements: unknown;
    skillRefs: unknown;
    reservationId: string | null;
  }>(
    `select id, status, max_attempts as "maxAttempts",
            run_step_id as "runStepId", application_id as "applicationId",
            repository_id as "repositoryId",
            repository_profile_id as "profileId",
            observation_id as "observationId", action, requirements,
            skill_refs as "skillRefs",
            installation_reservation_id as "reservationId"
       from bakery.jobs
      where organization_id = $1 and conversation_turn_id = $2`,
    [scope.seed.organizationId, scope.turnId],
  )).rows;
}

async function reservationCount(fixture: Fixture, scope: Scope) {
  return (await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count from bakery.budget_reservations
      where organization_id = $1 and dedupe_key = $2`,
    [scope.seed.organizationId, `coordinator-turn:${scope.turnId}`],
  )).rows[0].count;
}

Deno.test("enqueue twice gives one job, one reservation and one attempt", () =>
  withFixture(async (fixture) => {
    const scope = await seedScope(fixture, "cj-once");
    const before = await installationReserved(fixture);
    const first = await fund(fixture, scope);
    const second = await fund(fixture, scope);
    assertEquals(first.job.created, true);
    assertEquals(second.job.created, false);
    assertEquals(second.job.jobId, first.job.jobId);
    assertEquals(
      second.reservation.reservationId,
      first.reservation.reservationId,
    );
    const rows = await jobRows(fixture, scope);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].maxAttempts, 1);
    assertEquals(rows[0].status, "queued");
    assertEquals(rows[0].action, "coordinator.turn");
    assertEquals(rows[0].requirements, { capabilities: ["model"] });
    assertEquals(rows[0].skillRefs, []);
    assertEquals(await reservationCount(fixture, scope), 1);
    assertEquals(
      Number(await installationReserved(fixture)) - Number(before),
      0.25,
    );
    assert(await release(fixture, scope));
  }));

Deno.test("application and repository scoped conversation enqueues without a repository pin", () =>
  withFixture(async (fixture) => {
    const scope = await seedScope(fixture, "cj-scope");
    const scoped = await fixture.pgDatabase.query<{ a: string; r: string }>(
      `select application_id as a, repository_id as r
         from bakery.conversations where id = $1`,
      [scope.seed.conversationId],
    );
    assertEquals(scoped.rows[0].a, scope.seed.applicationId);
    assertEquals(scoped.rows[0].r, scope.seed.repositoryId);
    await fund(fixture, scope);
    const [row] = await jobRows(fixture, scope);
    assertEquals(row.runStepId, null);
    assertEquals(row.applicationId, null);
    assertEquals(row.repositoryId, null);
    assertEquals(row.profileId, null);
    assertEquals(row.observationId, null);
    assert(await release(fixture, scope));
  }));

Deno.test("subscription route reserves exactly the ceiling and zero is allowed", () =>
  withFixture(async (fixture) => {
    const exact = await seedScope(fixture, "cj-exact");
    const before = Number(await installationReserved(fixture));
    const funded = await fund(fixture, exact);
    assertEquals(Number(funded.reservation.reservedUsd), 0.25);
    assertEquals(Number(await installationReserved(fixture)) - before, 0.25);
    assert(await release(fixture, exact));

    const zeroBilling = {
      ...billing,
      maxUsdReservation: 0,
      pricingMetadataSnapshot: "coordinator-turn-jobs-price-zero",
    };
    const zero = await seedScope(fixture, "cj-zero", zeroBilling);
    const zeroBefore = Number(await installationReserved(fixture));
    const result = await fund(fixture, zero);
    assertEquals(Number(result.reservation.reservedUsd), 0);
    assertEquals(Number(await installationReserved(fixture)), zeroBefore);
    assert(
      await hasHeldCoordinatorTurnReservation(fixture.runtimePgDatabase, {
        organizationId: zero.seed.organizationId,
        jobId: result.job.jobId,
      }),
    );
    assert(await release(fixture, zero));
  }));

Deno.test("api route, missing policy and over-cap fund nothing and enqueue nothing", () =>
  withFixture(async (fixture) => {
    const apiBilling = {
      ...billing,
      billingRoute: "api" as const,
      pricingMetadataSnapshot: "coordinator-turn-jobs-price-api",
    };
    const api = await seedScope(fixture, "cj-api", apiBilling);
    assertEquals(
      await reasonOf(() => fund(fixture, api)),
      "coordinator_billing_unsupported",
    );
    assertEquals((await jobRows(fixture, api)).length, 0);
    assertEquals(await reservationCount(fixture, api), 0);

    const noPolicy = await seedScope(fixture, "cj-nopolicy");
    assertEquals(
      await reasonOf(() => fund(fixture, noPolicy, { budget: undefined })),
      "coordinator_budget_unconfigured",
    );
    assertEquals((await jobRows(fixture, noPolicy)).length, 0);

    const headroom = (await fixture.pgDatabase.query<{ room: string }>(
      `select coalesce(max(limit_usd - reserved_usd - settled_usd), 1)::text as room
         from bakery.budget_accounts
        where scope = 'installation'
          and period_start = date_trunc('month', clock_timestamp() at time zone 'UTC')
                             at time zone 'UTC'`,
    )).rows[0].room;
    const overBilling = {
      ...billing,
      maxUsdReservation: Math.min(1000, Number(headroom) + 1),
      pricingMetadataSnapshot: "coordinator-turn-jobs-price-over",
    };
    const over = await seedScope(fixture, "cj-over", overBilling);
    const before = await installationReserved(fixture);
    assertEquals(
      await reasonOf(() => fund(fixture, over)),
      "budget_cap_exceeded",
    );
    assertEquals((await jobRows(fixture, over)).length, 0);
    assertEquals(await reservationCount(fixture, over), 0);
    assertEquals(await installationReserved(fixture), before);
  }));

Deno.test("release is idempotent and restores the installation account", () =>
  withFixture(async (fixture) => {
    const scope = await seedScope(fixture, "cj-release");
    const before = Number(await installationReserved(fixture));
    const funded = await fund(fixture, scope);
    assertEquals(Number(await installationReserved(fixture)) - before, 0.25);
    assertEquals(await release(fixture, scope), true);
    assertEquals(await release(fixture, scope), false);
    assertEquals(Number(await installationReserved(fixture)), before);
    assertEquals(
      await hasHeldCoordinatorTurnReservation(fixture.runtimePgDatabase, {
        organizationId: scope.seed.organizationId,
        jobId: funded.job.jobId,
      }),
      false,
    );
    const turn = await seedScope(fixture, "cj-never");
    assertEquals(await release(fixture, turn), false);
  }));

Deno.test("cancel changes a queued job and zero rows once a worker holds it", () =>
  withFixture(async (fixture) => {
    const queued = await seedScope(fixture, "cj-cancel-queued");
    await fund(fixture, queued);
    const state = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        readCoordinatorTurnJob(tx, {
          organizationId: queued.seed.organizationId,
          turnId: queued.turnId,
        }),
    );
    assertEquals(state?.status, "queued");
    assertEquals(state?.attempt, null);
    assertEquals(
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (tx) =>
          cancelQueuedCoordinatorTurnJob(tx, {
            organizationId: queued.seed.organizationId,
            turnId: queued.turnId,
          }),
      ),
      true,
    );
    assertEquals((await jobRows(fixture, queued))[0].status, "canceled");
    assert(await release(fixture, queued));

    const claimed = await seedScope(fixture, "cj-cancel-claimed");
    await fund(fixture, claimed);
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'leased', current_fence = 1
        where organization_id = $1 and conversation_turn_id = $2`,
      [claimed.seed.organizationId, claimed.turnId],
    );
    assertEquals(
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (tx) =>
          cancelQueuedCoordinatorTurnJob(tx, {
            organizationId: claimed.seed.organizationId,
            turnId: claimed.turnId,
          }),
      ),
      false,
    );
    assertEquals((await jobRows(fixture, claimed))[0].status, "leased");
    assertEquals(
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (tx) =>
          requestCoordinatorTurnJobCancel(tx, {
            organizationId: claimed.seed.organizationId,
            turnId: claimed.turnId,
          }),
      ),
      true,
    );
    const marked = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        readCoordinatorTurnJob(tx, {
          organizationId: claimed.seed.organizationId,
          turnId: claimed.turnId,
        }),
    );
    assertEquals(marked?.status, "leased");
    assert(marked?.cancelRequestedAt);
    assert(await release(fixture, claimed));
  }));

Deno.test("enqueue refuses run and repository pins and mismatched input", () =>
  withFixture(async (fixture) => {
    const scope = await seedScope(fixture, "cj-pins");
    const reservation = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        reserveCoordinatorTurn(tx, {
          organizationId: scope.seed.organizationId,
          turnId: scope.turnId,
          agentVersionId: scope.agentVersionId,
          billing,
          policy,
        }),
    );
    const base = {
      organizationId: scope.seed.organizationId,
      turnId: scope.turnId,
      agentVersionId: scope.agentVersionId,
      agentConfig: scope.agentConfig,
      billing: billing as unknown as Record<string, unknown>,
      installationReservationId: reservation.reservationId,
      input: jobInput(scope),
    };
    for (const pin of ["runStepId", "repositoryId", "applicationId"]) {
      assertEquals(
        await reasonOf(() =>
          withPgTransaction(
            fixture.runtimePgDatabase,
            (tx) =>
              enqueueCoordinatorTurnJob(
                tx,
                { ...base, [pin]: crypto.randomUUID() } as typeof base,
              ),
          )
        ),
        "coordinator_job_pin_forbidden",
      );
    }
    assertEquals(
      await reasonOf(() =>
        withPgTransaction(
          fixture.runtimePgDatabase,
          (tx) =>
            enqueueCoordinatorTurnJob(tx, {
              ...base,
              input: { ...jobInput(scope), turnId: crypto.randomUUID() },
            }),
        )
      ),
      "coordinator_job_turn_mismatch",
    );
    await assertRejects(() =>
      withPgTransaction(
        fixture.runtimePgDatabase,
        (tx) =>
          enqueueCoordinatorTurnJob(tx, {
            ...base,
            input: { turnId: scope.turnId },
          }),
      )
    );
    assertEquals((await jobRows(fixture, scope)).length, 0);
  }));

/** Coordinator scope inside the worker fixture's own organization. */
async function seedWorkerScope(
  fixture: WorkerFx,
  label: string,
): Promise<Scope> {
  const seed = await seedConversation(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    label,
  );
  const scope = await seedAgentAndTurn(fixture.pgDatabase, seed);
  await fundTurn(fixture.runtimePgDatabase, scope);
  return scope;
}

Deno.test("a host advertising coordinator.turn with model claims the job once", () =>
  withCoordinatorWorker(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "coordinator-claim",
    });
    const scope = await seedWorkerScope(fixture, "cj-claim");
    const assignment = await claimAssignment(fixture, worker, {
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(assignment.action, "coordinator.turn");
    const rows = await fixture.pgDatabase.query<{
      status: string;
      maxAttempts: number;
      turnId: string;
      attempts: number;
    }>(
      `select job.status, job.max_attempts as "maxAttempts",
              job.conversation_turn_id as "turnId",
              (select count(*)::int from bakery.job_attempts attempt
                where attempt.job_id = job.id) as attempts
         from bakery.jobs job where job.id = $1`,
      [assignment.jobId],
    );
    assertEquals(rows.rows, [{
      status: "leased",
      maxAttempts: 1,
      turnId: scope.turnId,
      attempts: 1,
    }]);
    const input = assignment.input as { turnId: string };
    assertEquals(input.turnId, scope.turnId);
  }));

Deno.test("a host without the action or the model capability does not claim", () =>
  withCoordinatorWorker(async (fixture) => {
    const full = await registeredWorker(fixture, { name: "cj-no-action" });
    const gitOnly = await registeredWorker(fixture, {
      name: "cj-no-model",
      capabilities: ["git"],
    });
    await seedWorkerScope(fixture, "cj-nohost");
    const wrongAction = await rawClaim(fixture, full, {
      capabilities: ["model"],
      supportedActions: ["harness.implement"],
    });
    assertEquals(wrongAction.status, 204);
    await wrongAction.body?.cancel();
    const noModel = await rawClaim(fixture, gitOnly, {
      capabilities: ["git"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(noModel.status, 204);
    await noModel.body?.cancel();
    const attempts = await fixture.pgDatabase.query(
      `select 1 from bakery.job_attempts where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(attempts.rows.length, 0);
  }));

Deno.test("a canceled or terminal turn makes the job unclaimable", () =>
  withCoordinatorWorker(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "cj-turn-state" });
    const scope = await seedWorkerScope(fixture, "cj-turnstate");
    for (
      const status of ["cancel_requested", "canceled", "failed", "completed"]
    ) {
      await fixture.pgDatabase.query(
        `update bakery.conversation_turns set status = $3
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, scope.turnId, status],
      );
      const response = await rawClaim(fixture, worker, {
        capabilities: ["model"],
        supportedActions: ["coordinator.turn"],
      });
      assertEquals(response.status, 204, status);
      await response.body?.cancel();
    }
    const job = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.jobs where conversation_turn_id = $1`,
      [scope.turnId],
    );
    assertEquals(job.rows[0].status, "queued");
  }));

Deno.test("after one failed attempt the job is not offered again", () =>
  withCoordinatorWorker(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "cj-one-shot" });
    await seedWorkerScope(fixture, "cj-oneshot");
    const first = await claimAssignment(fixture, worker, {
      supportedActions: ["coordinator.turn"],
    });
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status = 'failed'
        where job_id = $1`,
      [first.jobId],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'queued' where id = $1`,
      [first.jobId],
    );
    const again = await rawClaim(fixture, worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(again.status, 204);
    await again.body?.cancel();
    const attempts = await fixture.pgDatabase.query(
      `select 1 from bakery.job_attempts where job_id = $1`,
      [first.jobId],
    );
    assertEquals(attempts.rows.length, 1);
  }));

// ---- Phase 3b: lifecycle and result ---------------------------------------

const goodOutput = {
  effects: [{ type: "reply", body: "Here is the plan." }],
  model: "claude-opus-5-5",
  claudeCodeVersion: "2.1.296",
};

function fault(retryable: boolean) {
  return {
    type: "about:blank",
    title: "Coordinator turn failed",
    status: 503,
    detail: "model timed out",
    code: "CLAUDE_COORDINATOR_TIMEOUT",
    requestId: crypto.randomUUID(),
    retryable,
    ...(retryable ? { retryAfterSeconds: 5 } : {}),
  };
}

type Claimed = {
  scope: Scope;
  assignment: WorkerAssignment;
  worker: Awaited<ReturnType<typeof registeredWorker>>;
};

async function claimCoordinator(
  fixture: WorkerFx,
  label: string,
): Promise<Claimed> {
  const worker = await registeredWorker(fixture, { name: `${label}-worker` });
  const scope = await seedWorkerScope(fixture, label);
  const assignment = await claimAssignment(fixture, worker, {
    supportedActions: ["coordinator.turn"],
  });
  return { scope, assignment, worker };
}

async function reservationState(
  fixture: WorkerFx,
  scope: Scope,
): Promise<{ status: string; accountReserved: string }> {
  const row = await fixture.pgDatabase.query<
    { status: string; accountReserved: string }
  >(
    `select reservation.status,
            account.reserved_usd::text as "accountReserved"
       from bakery.budget_reservations reservation
       join bakery.budget_accounts account
         on account.id = reservation.budget_account_id
      where reservation.organization_id = $1
        and reservation.dedupe_key = $2`,
    [fixture.organizationId, `coordinator-turn:${scope.turnId}`],
  );
  return row.rows[0];
}

async function jobState(fixture: WorkerFx, turnId: string) {
  const row = await fixture.pgDatabase.query<
    { status: string; attempts: number; fence: string }
  >(
    `select job.status, job.current_fence::text as fence,
            (select count(*)::int from bakery.job_attempts a
              where a.job_id = job.id) as attempts
       from bakery.jobs job where job.conversation_turn_id = $1`,
    [turnId],
  );
  return row.rows[0];
}

async function submit(
  fixture: WorkerFx,
  claimed: Claimed,
  body: Record<string, unknown>,
): Promise<Response> {
  return await postWorkerResult(
    fixture,
    claimed.worker,
    claimed.assignment,
    body,
    crypto.randomUUID(),
  );
}

Deno.test("a completed coordinator result ends the job and releases funding", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-done");
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "held",
    );
    const response = await submit(
      fixture,
      claimed,
      resultBody(claimed.assignment, { result: goodOutput }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(await jobState(fixture, claimed.scope.turnId), {
      status: "completed",
      attempts: 1,
      fence: claimed.assignment.fence,
    });
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "released",
    );
    const audit = await fixture.pgDatabase.query(
      `select 1 from bakery.audit_events
        where organization_id = $1 and operation = 'workers.result'
          and resource_id = $2`,
      [fixture.organizationId, claimed.assignment.attemptId],
    );
    assertEquals(audit.rows.length, 1);
    const read = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        readCoordinatorTurnJob(tx, {
          organizationId: fixture.organizationId,
          turnId: claimed.scope.turnId,
        }),
    );
    assertEquals(read?.status, "completed");
    assertEquals(read?.attempt?.status, "completed");
  }));

Deno.test("a failed coordinator result ends the job and releases funding", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-failed");
    const response = await submit(
      fixture,
      claimed,
      resultBody(claimed.assignment, {
        status: "failed",
        fault: fault(false),
      }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(
      (await jobState(fixture, claimed.scope.turnId)).status,
      "failed",
    );
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "released",
    );
  }));

Deno.test("a canceled coordinator result ends the job and releases funding", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-canceled");
    const response = await submit(
      fixture,
      claimed,
      resultBody(claimed.assignment, {
        status: "canceled",
        cancellation: {
          processExited: true,
          exitedAt: new Date().toISOString(),
          cleanupStatus: "complete",
        },
      }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(
      (await jobState(fixture, claimed.scope.turnId)).status,
      "canceled",
    );
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "released",
    );
  }));

Deno.test("a retryable fault still ends the job failed with one attempt", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-retryable");
    const response = await submit(
      fixture,
      claimed,
      resultBody(claimed.assignment, {
        status: "failed",
        fault: fault(true),
      }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const state = await jobState(fixture, claimed.scope.turnId);
    assertEquals(state.status, "failed");
    assertEquals(state.attempts, 1);
    const stored = await fixture.pgDatabase.query<
      { fault: Record<string, unknown> }
    >(
      `select result->'fault' as fault from bakery.job_attempts where id = $1`,
      [claimed.assignment.attemptId],
    );
    assertEquals(stored.rows[0].fault.retryable, false);
    assertEquals(stored.rows[0].fault.retryAfterSeconds, undefined);
    const again = await rawClaim(fixture, claimed.worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(again.status, 204);
    await again.body?.cancel();
  }));

Deno.test("an expired coordinator lease ends the job failed with no second attempt", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-expired");
    await updateAttemptExpiry(fixture.pgDatabase, claimed.assignment.attemptId);
    await withPgTransaction(
      fixture.pgDatabase,
      (tx) => reclaimExpiredAttempts(tx, fixture.organizationId),
    );
    const state = await jobState(fixture, claimed.scope.turnId);
    assertEquals(state.status, "failed");
    assertEquals(state.attempts, 1);
    const attempt = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.job_attempts where id = $1`,
      [claimed.assignment.attemptId],
    );
    assertEquals(attempt.rows[0].status, "lost");
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "released",
    );
    const again = await rawClaim(fixture, claimed.worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(again.status, 204);
    await again.body?.cancel();
    assertEquals((await jobState(fixture, claimed.scope.turnId)).attempts, 1);
  }));

Deno.test("a stale fence on a coordinator result gives LEASE_FENCED", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-fenced");
    await fixture.pgDatabase.query(
      `update bakery.jobs set current_fence = current_fence + 1
        where conversation_turn_id = $1`,
      [claimed.scope.turnId],
    );
    const response = await submit(
      fixture,
      claimed,
      resultBody(claimed.assignment, { result: goodOutput }),
    );
    assert(response.status >= 400);
    assertEquals(await problemCode(response), "LEASE_FENCED");
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "held",
    );
  }));

Deno.test("an invalid coordinator payload at claim fails the job and releases funding", () =>
  withCoordinatorWorker(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "cj-invalid" });
    const scope = await seedWorkerScope(fixture, "cj-invalid");
    const job = await fixture.pgDatabase.query<
      { id: string; fence: string }
    >(
      `select id, current_fence::text as fence from bakery.jobs
        where conversation_turn_id = $1`,
      [scope.turnId],
    );
    const rejected = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        markJobAssignmentPayloadInvalid(tx, {
          organizationId: fixture.organizationId,
          jobId: job.rows[0].id,
          currentFence: job.rows[0].fence,
          metadata: { requestId: "cj-invalid", traceId: "cj-invalid" },
          principalId: null,
          invalidFields: ["agentConfig"],
        }),
    );
    assert(rejected);
    assertEquals((await jobState(fixture, scope.turnId)).status, "failed");
    assertEquals((await jobState(fixture, scope.turnId)).attempts, 0);
    assertEquals((await reservationState(fixture, scope)).status, "released");
    const claim = await rawClaim(fixture, worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(claim.status, 204);
    await claim.body?.cancel();
  }));

Deno.test("attempt budget exhaustion fails a coordinator job and releases funding", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-budget");
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status = 'failed', ended_at = now()
        where id = $1`,
      [claimed.assignment.attemptId],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'queued' where conversation_turn_id = $1`,
      [claimed.scope.turnId],
    );
    await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        markJobAttemptBudgetExhausted(
          tx,
          fixture.organizationId,
          claimed.assignment.jobId,
          null,
          { requestId: "cj-budget", traceId: "cj-budget" },
        ),
    );
    assertEquals(
      (await jobState(fixture, claimed.scope.turnId)).status,
      "failed",
    );
    assertEquals(
      (await reservationState(fixture, claimed.scope)).status,
      "released",
    );
    const claim = await rawClaim(fixture, claimed.worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(claim.status, 204);
    await claim.body?.cancel();
  }));

Deno.test("a live coordinator attempt survives a heartbeat from its host", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-rebind");
    const response = await heartbeatRequest(fixture, claimed.worker, {
      activeAttemptIds: [claimed.assignment.attemptId],
    });
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
    const attempt = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.job_attempts where id = $1`,
      [claimed.assignment.attemptId],
    );
    assert(["leased", "running"].includes(attempt.rows[0].status));
  }));

Deno.test("attempt read answers for a coordinator attempt without run fields", () =>
  withCoordinatorWorker(async (fixture) => {
    const claimed = await claimCoordinator(fixture, "cj-read");
    const taskId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, conversation_id, title,
         task_type, status, priority, created_by
       ) values ($1, $2, $3, $4, 'plan', 'feature', 'queued', 50, $5)`,
      [
        taskId,
        fixture.organizationId,
        claimed.scope.seed.applicationId,
        claimed.scope.seed.conversationId,
        fixture.principalId,
      ],
    );
    try {
      const read = async (task: string) =>
        await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/jobs/${claimed.assignment.jobId}/attempts?taskId=${task}`,
            {
              headers: {
                cookie: fixture.adminCookie,
                origin: fixture.config.publicBaseUrl,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
      const ok = await read(taskId);
      assertEquals(ok.status, 200, await ok.clone().text());
      const page = await ok.json() as {
        items: { id: string; runStepId: string | null; taskId: string }[];
      };
      assertEquals(page.items.length, 1);
      assertEquals(page.items[0].id, claimed.assignment.attemptId);
      assertEquals(page.items[0].runStepId, null);
      assertEquals(page.items[0].taskId, taskId);
      const other = await read(crypto.randomUUID());
      assertEquals(other.status, 404);
      await other.body?.cancel();
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.tasks where id = $1`,
        [taskId],
      );
    }
  }));
