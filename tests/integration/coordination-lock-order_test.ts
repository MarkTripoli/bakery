import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { claimEffect } from "../../apps/server/src/modules/effects/claim.ts";
import { prepareEffect } from "../../apps/server/src/modules/effects/index.ts";
import {
  assertNoDeadlock,
  type Hold,
  holdRow,
  lockWaiters,
  raceInOrder,
  settled,
  waitFor,
} from "../helpers/lock-race.ts";
import {
  claimDepsFor,
  effectRegistry,
  type EffectRig,
  forceEffectStatus,
  persistReleaseEvidence,
  seededEffectRig,
} from "../helpers/external-effects.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { cancelCoordinationPlanCommand } from "../../apps/server/src/modules/work/coordination-command.ts";
import {
  bindProviderCallIntent,
  findProviderUsageReceiptCandidates,
  reconcileProviderUsageReceipt,
  recordProviderUsageReceipt,
  releaseWorkflowAction,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import { reconcileBudgetLedger } from "../../apps/server/src/modules/work/budget-recovery.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  eventBody,
  postWorkerResult,
  type RegisteredWorker,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedLegacyLeasedModelAttempt } from "../helpers/worker-execution/legacy-attempt.ts";
import {
  admitFundedModelRun as admit,
  type AdmittedJob,
  fundedModelPolicy,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

// Lock-order regressions: each case pins one interleaving with a third
// transaction that holds a row lock, waits until both racers are queued on
// Postgres locks, then releases it. Under an inverted order the two racers
// wait on each other and Postgres aborts one with 40P01 (deadlock_detected).

const ITERATIONS = 3;

async function insertTask(
  database: PgDatabase,
  scope: {
    organizationId: string;
    applicationId: string;
    repositoryId: string | null;
    principalId: string;
  },
  title: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await database.query(
    `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      scope.organizationId,
      scope.applicationId,
      scope.repositoryId,
      title,
      scope.principalId,
    ],
  );
  await database.query(
    `insert into bakery.tasks (id, organization_id, application_id, repository_id, conversation_id, title, description, task_type, status, priority, created_by)
     values ($1, $2, $3, $4, $5, $6, '', 'epic', 'draft', 50, $7)`,
    [
      id,
      scope.organizationId,
      scope.applicationId,
      scope.repositoryId,
      conversationId,
      title,
      scope.principalId,
    ],
  );
  return id;
}

/** One materialized plan whose lanes are the given child tasks (independent). */
async function insertPlan(
  database: PgDatabase,
  scope: {
    organizationId: string;
    applicationId: string;
    principalId: string;
  },
  parentTaskId: string,
  lanes: readonly { childTaskId: string; repositoryId: string | null }[],
  budgetLimitUsd: string | null = null,
): Promise<string> {
  const planId = crypto.randomUUID();
  await database.query(
    `insert into bakery.coordination_plans (id, organization_id, application_id, parent_task_id, revision, spec, digest, budget_limit_usd, status, created_by)
     values ($1, $2, $3, $4, 1, '{}'::jsonb, $5, $6, 'materialized', $7)`,
    [
      planId,
      scope.organizationId,
      scope.applicationId,
      parentTaskId,
      "c".repeat(64),
      budgetLimitUsd,
      scope.principalId,
    ],
  );
  for (const [position, lane] of lanes.entries()) {
    await database.query(
      `insert into bakery.coordination_lanes (organization_id, application_id, plan_id, lane_key, position, repository_id, child_task_id, prerequisites, declared_outputs, lane_digest, status)
       values ($1, $2, $3, $4, $5, $6, $7, '{}'::text[], '[]'::jsonb, $8, 'ready')`,
      [
        scope.organizationId,
        scope.applicationId,
        planId,
        `lane-${position}`,
        position,
        lane.repositoryId,
        lane.childTaskId,
        "d".repeat(64),
      ],
    );
  }
  return planId;
}

async function deleteCoordination(
  database: PgDatabase,
  organizationId: string,
): Promise<void> {
  // The shared worker teardown does not know the coordination tables.
  for (const table of ["coordination_lanes", "coordination_plans"]) {
    await database.query(
      `delete from bakery.${table} where organization_id = $1`,
      [organizationId],
    );
  }
}

/** Calls the cancel command the way the action registry does, on `database`. */
function cancelPlan(
  database: PgDatabase,
  fixture: WorkerFixture,
  planId: string,
): Promise<unknown> {
  return withPgTransaction(
    database,
    async (transaction) =>
      await cancelCoordinationPlanCommand(
        {
          request: new Request("http://test/"),
          params: { id: planId },
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
          signal: new AbortController().signal,
          transaction,
          authority: {
            organizationId: fixture.organizationId,
            subject: { principalId: fixture.principalId },
          },
          commandMetadata: {},
        } as unknown as ActionContext,
        {},
      ),
  );
}

type LeasedLane = {
  planId: string;
  taskId: string;
  attemptId: string;
  postResult(): Promise<Response>;
};

/** A lane child with a live leased attempt that has already acknowledged. */
async function leasedLane(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
): Promise<LeasedLane> {
  const db = fixture.pgDatabase;
  const job = await seedEligibleJob(
    db,
    fixture.organizationId,
    fixture.principalId,
  );
  const repository = (await db.query<{ repository_id: string | null }>(
    `select repository_id from bakery.tasks where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.taskId],
  )).rows[0].repository_id;
  const scope = {
    organizationId: fixture.organizationId,
    applicationId: job.applicationId,
    repositoryId: repository,
    principalId: fixture.principalId,
  };
  const parent = await insertTask(db, scope, "parent");
  const sibling = await insertTask(db, scope, "sibling");
  const planId = await insertPlan(db, scope, parent, [
    { childTaskId: job.taskId, repositoryId: repository },
    { childTaskId: sibling, repositoryId: repository },
  ]);
  const assignment = await seedLegacyLeasedModelAttempt(
    fixture,
    worker,
    job.jobId,
  );
  const eventId = crypto.randomUUID();
  const event = await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/events`,
    eventBody(assignment, eventId, "1", "2026-09-20T00:00:01.000Z"),
    { idempotencyKey: eventId },
  );
  assertEquals(event.status, 200);
  return {
    planId,
    taskId: job.taskId,
    attemptId: assignment.attemptId,
    postResult: () =>
      workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "2",
          status: "completed",
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: job.sessionId,
            artifacts: [],
          },
        },
        { idempotencyKey: crypto.randomUUID() },
      ),
  };
}

async function planStatus(database: PgDatabase, planId: string) {
  return (await database.query<{ status: string }>(
    `select status from bakery.coordination_plans where id = $1`,
    [planId],
  )).rows[0].status;
}

Deno.test("coordination cancel and an in-flight worker result never deadlock", () =>
  withWorkerFixture(async (fixture) => {
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 4);
    try {
      const worker = await registeredWorker(fixture, {
        name: "e06-lock-order-cancel",
      });

      // Result first: it holds the worker host and queues on its attempt; the
      // cancel then queues behind the host. Old order: the cancel held every
      // job and the result's job lock closed the cycle.
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const lane = await leasedLane(fixture, worker);
        const hold = await holdRow(
          side,
          `select id from bakery.job_attempts where id = $1 for update`,
          [lane.attemptId],
        );
        const result = lane.postResult();
        await waitFor(
          "result queued",
          async () => await lockWaiters(side) >= 1,
        );
        const cancel = cancelPlan(side, fixture, lane.planId);
        const cancelDone = settled(cancel);
        await waitFor(
          "cancel queued",
          async () => cancelDone() || await lockWaiters(side) >= 2,
        );
        hold.release();
        await hold.done;
        const [resultOutcome, cancelOutcome] = await Promise.allSettled([
          result,
          cancel,
        ]);
        if (cancelOutcome.status === "rejected") throw cancelOutcome.reason;
        assert(resultOutcome.status === "fulfilled");
        assertEquals(resultOutcome.value.status, 200, "the result applies");
        await resultOutcome.value.body?.cancel();
        assertEquals(await planStatus(side, lane.planId), "canceled");
        const child = await side.query<{ status: string }>(
          `select status from bakery.tasks where id = $1`,
          [lane.taskId],
        );
        assertEquals(child.rows[0].status, "completed", "evidence stays");
      }

      // Cancel first: it holds the host, attempt and jobs and queues on the
      // parent task; the result queues behind the host. Old order: the cancel
      // asked for the host only after the jobs, while the result held it.
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const lane = await leasedLane(fixture, worker);
        const parent = (await side.query<{ parent_task_id: string }>(
          `select parent_task_id from bakery.coordination_plans where id = $1`,
          [lane.planId],
        )).rows[0].parent_task_id;
        const hold = await holdRow(
          side,
          `select id from bakery.tasks where id = $1 for update`,
          [parent],
        );
        const cancel = cancelPlan(side, fixture, lane.planId);
        const cancelDone = settled(cancel);
        await waitFor(
          "cancel queued",
          async () => cancelDone() || await lockWaiters(side) >= 1,
        );
        const result = lane.postResult();
        const resultDone = settled(result);
        await waitFor(
          "result queued",
          async () =>
            cancelDone() || resultDone() || await lockWaiters(side) >= 2,
        );
        hold.release();
        await hold.done;
        const [resultOutcome, cancelOutcome] = await Promise.allSettled([
          result,
          cancel,
        ]);
        if (cancelOutcome.status === "rejected") throw cancelOutcome.reason;
        assert(resultOutcome.status === "fulfilled");
        // The cooperative cancel wins the attempt, so the late success is a
        // typed terminal refusal, never a server error.
        assertEquals(resultOutcome.value.status, 409);
        const problem = await resultOutcome.value.json();
        assertEquals(problem.code, "ALREADY_TERMINAL");
        assertEquals(await planStatus(side, lane.planId), "canceled");
      }
    } finally {
      await deleteCoordination(fixture.pgDatabase, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

Deno.test("coordination cancel falls back to the durable cancel only without live worker authority", () =>
  withWorkerFixture(async (fixture) => {
    try {
      const worker = await registeredWorker(fixture, {
        name: "e06-cancel-fallback",
      });
      const lane = await leasedLane(fixture, worker);
      // The attempt still says leased, but its lease has run out: the
      // cooperative cancel refuses with STATE_CONFLICT and the plan cancel
      // moves run and task to canceled directly.
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [lane.attemptId],
      );
      await cancelPlan(fixture.pgDatabase, fixture, lane.planId);
      const state = (await fixture.pgDatabase.query<
        { task: string; run: string }
      >(
        `select task.status as task, run.status as run
           from bakery.tasks task
           join bakery.workflow_runs run
             on run.organization_id = task.organization_id
            and run.id = task.current_run_id
          where task.id = $1`,
        [lane.taskId],
      )).rows[0];
      assertEquals(state, { task: "canceled", run: "canceled" });
      assertEquals(
        await planStatus(fixture.pgDatabase, lane.planId),
        "canceled",
      );
    } finally {
      await deleteCoordination(fixture.pgDatabase, fixture.organizationId);
    }
  }));

/** Running backends that wait on a lock held by backend `pid`. */
async function blockedBy(database: PgDatabase, pid: number): Promise<number> {
  const result = await database.query<{ count: number }>(
    `select count(*)::int as count from pg_stat_activity
      where $1::int = any(pg_blocking_pids(pid))`,
    [pid],
  );
  return result.rows[0].count;
}

Deno.test("coordination cancel retakes host locks for an attempt leased after its host read", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 4);
    const holds: Hold[] = [];
    let cancel: Promise<unknown> = Promise.resolve();
    try {
      const first = await registeredWorker(fixture, {
        name: "e06-retake-h1",
      });
      const second = await registeredWorker(fixture, {
        name: "e06-retake-h2",
      });
      const lane = await leasedLane(fixture, first);
      const h1 = first.registration.workerHostId;
      const h2 = second.registration.workerHostId;
      const jobId = (await db.query<{ job_id: string }>(
        `select job_id from bakery.job_attempts where id = $1`,
        [lane.attemptId],
      )).rows[0].job_id;
      const parent = (await db.query<{ parent_task_id: string }>(
        `select parent_task_id from bakery.coordination_plans where id = $1`,
        [lane.planId],
      )).rows[0].parent_task_id;

      // The parent task hold parks the cancel once its scope is locked, so
      // the test can see which hosts it holds. The H1 hold parks the cancel's
      // host statement after it took its snapshot (live hosts = {H1}).
      const parentHold = await holdRow(
        side,
        `select id, pg_backend_pid() as pid from bakery.tasks
          where id = $1 for update`,
        [parent],
      );
      holds.push(parentHold);
      const hostHold = await holdRow(
        side,
        `select id from bakery.worker_hosts where id = $1 for update`,
        [h1],
      );
      holds.push(hostHold);
      cancel = cancelPlan(side, fixture, lane.planId);
      const cancelDone = settled(cancel);
      await waitFor(
        "cancel queued on H1",
        async () => cancelDone() || await lockWaiters(side) >= 1,
      );
      assert(!cancelDone(), "the cancel waits on host H1");

      // A worker on H2 leases a live attempt in the plan's run and commits.
      // The parked host statement's snapshot never sees it; the attempt
      // statement that follows does, so H2 is missing and the cancel must
      // drop its locks and retake hosts {H1, H2} before the attempts.
      await db.query(
        `insert into bakery.job_attempts (
           organization_id, job_id, worker_host_id, worker_session_id,
           worker_session_generation, attempt_no, fence, lease_token_hash,
           lease_expires_at, status
         ) select host.organization_id, $2, host.id, host.worker_session_id,
                  host.worker_session_generation, 2, 2, $4,
                  clock_timestamp() + interval '45 seconds', 'leased'
             from bakery.worker_hosts host
            where host.organization_id = $1 and host.id = $3`,
        [
          fixture.organizationId,
          jobId,
          h2,
          await sha256Hex(crypto.randomUUID()),
        ],
      );
      hostHold.release();
      await hostHold.done;

      await waitFor(
        "cancel queued on the parent task",
        async () => cancelDone() || await blockedBy(side, parentHold.pid) >= 1,
      );
      assert(!cancelDone(), "the cancel waits on the parent task");
      const probe = await side.query<{ id: string }>(
        `select id from bakery.worker_hosts where id = $1
          for update skip locked`,
        [h2],
      );
      assertEquals(
        probe.rows.length,
        0,
        "the cancel holds H2, which only the retake locks",
      );

      parentHold.release();
      await parentHold.done;
      await cancel;
      assertEquals(await planStatus(side, lane.planId), "canceled");
    } finally {
      // A failed assertion must not leave the cancel parked behind a hold.
      for (const hold of holds) hold.release();
      await Promise.allSettled([...holds.map((hold) => hold.done), cancel]);
      await deleteCoordination(fixture.pgDatabase, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

const usagePolicyPrice = "budget-test-price-v1";

function usageReceipt(run: AdmittedJob): UsageReceipt {
  return {
    usageFactId: `${run.runId}-lock-order`,
    providerCallId: `${run.runId}-provider-call-lock-order`,
    provider: "openai",
    billingAccountId: String(run.billing?.billingAccountId),
    model: String(run.billing?.model),
    billingRoute: "api",
    pricingMetadataSnapshot: usagePolicyPrice,
    inputTokens: "1",
    outputTokens: "2",
    costUsd: "0.01",
    measurement: "reported",
    occurredAt: new Date().toISOString(),
  };
}

async function publishProviderReceipt(
  database: PgDatabase,
  run: AdmittedJob,
  receipt: UsageReceipt,
): Promise<void> {
  await withPgTransaction(database, async (transaction) => {
    await bindProviderCallIntent(transaction, {
      organizationId: run.organizationId,
      installationReservationId: run.installationReservationId,
      providerCallId: receipt.providerCallId,
    });
    const callIntent = (await transaction.query<{ id: string }>(
      `select provider_call_intent_id as id
         from bakery.budget_action_intents
        where organization_id = $1 and installation_reservation_id = $2`,
      [run.organizationId, run.installationReservationId],
    )).rows[0];
    assertExists(callIntent);
    await recordProviderUsageReceipt(transaction, {
      organizationId: run.organizationId,
      providerCallIntentId: callIntent.id,
      receipt,
    });
  });
}

Deno.test("a budgeted lane reservation and a sibling's settling result never deadlock", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 4);
    try {
      await seedProviderPricingSnapshot(db);
      const worker = await registeredWorker(fixture, {
        name: "e06-lock-order-budget",
        slots: 8,
      });
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const settling = await admit(
          db,
          await seedRun(db, fixture.organizationId, fixture.principalId, {
            reservationUsd: "0.1",
            stepKey: `settle-${iteration}`,
          }),
        );
        const reserving = await seedRun(
          db,
          fixture.organizationId,
          fixture.principalId,
          {
            reservationUsd: "0.1",
            stepKey: `reserve-${iteration}`,
            applicationId: settling.applicationId,
          },
        );
        const scope = {
          organizationId: fixture.organizationId,
          applicationId: settling.applicationId,
          repositoryId: null,
          principalId: fixture.principalId,
        };
        const parent = await insertTask(db, scope, "budget parent");
        await insertPlan(db, scope, parent, [
          { childTaskId: settling.taskId, repositoryId: settling.repositoryId },
          {
            childTaskId: reserving.taskId,
            repositoryId: reserving.repositoryId,
          },
        ], "1.0");

        const assignment = await claimAssignment(fixture, worker);
        assertEquals(assignment.jobId, settling.jobId);
        const receipt = usageReceipt(settling);
        await publishProviderReceipt(db, settling, receipt);

        // The settling result queues on its run row (held here). Old order:
        // it held the installation account by then, the sibling reservation
        // took the parent task and queued on that account, and the result's
        // plan reconcile then asked for the parent task.
        const hold = await holdRow(
          side,
          `select id from bakery.workflow_runs where id = $1 for update`,
          [settling.runId],
        );
        const result = postWorkerResult(fixture, worker, assignment, {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "failed",
          fault: {
            type: "about:blank",
            title: "Worker execution failed",
            status: 500,
            detail: "lock order test",
            code: "LOCK_ORDER_TEST_FAILURE",
            requestId: crypto.randomUUID(),
            retryable: false,
          },
          usage: receipt,
        }, crypto.randomUUID());
        await waitFor(
          "result queued",
          async () => await lockWaiters(side) >= 1,
        );
        const reservation = admit(side, reserving);
        const reservationDone = settled(reservation);
        await waitFor(
          "reservation queued or done",
          async () => reservationDone() || await lockWaiters(side) >= 2,
        );
        hold.release();
        await hold.done;
        const [resultOutcome, reservationOutcome] = await Promise.allSettled([
          result,
          reservation,
        ]);
        if (reservationOutcome.status === "rejected") {
          throw reservationOutcome.reason;
        }
        assert(resultOutcome.status === "fulfilled");
        assertEquals(
          resultOutcome.value.status,
          200,
          await resultOutcome.value.clone().text(),
        );
        await resultOutcome.value.body?.cancel();
        const runAccount = await db.query<{ settled: string }>(
          `select settled_usd::text as settled from bakery.budget_accounts
            where scope = 'run' and organization_id = $1 and run_id = $2`,
          [fixture.organizationId, settling.runId],
        );
        assertEquals(Number(runAccount.rows[0].settled), 0.01);
        // Keep the next iteration's claim on its own settling lane.
        const admitted = reservationOutcome.value;
        await db.query(
          `update bakery.jobs set status = 'canceled', updated_at = now(),
                  version = version + 1
            where organization_id = $1 and id = $2`,
          [fixture.organizationId, admitted.jobId],
        );
      }
    } finally {
      await deleteCoordination(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

/**
 * A funded run whose model step failed with unknown usage and whose provider
 * receipt arrived later: one candidate for the budget recovery cron.
 */
async function unknownUsageRun(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  stepKey: string,
  applicationId?: string,
): Promise<{ run: AdmittedJob; usageFactId: string }> {
  const db = fixture.pgDatabase;
  const run = await admit(
    db,
    await seedRun(db, fixture.organizationId, fixture.principalId, {
      reservationUsd: "0.1",
      stepKey,
      ...(applicationId ? { applicationId } : {}),
    }),
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, run.jobId);
  const known = usageReceipt(run);
  const unknown: UsageReceipt = {
    ...known,
    costUsd: null,
    measurement: "unknown",
  };
  await withPgTransaction(db, async (transaction) => {
    await bindProviderCallIntent(transaction, {
      organizationId: run.organizationId,
      installationReservationId: run.installationReservationId,
      providerCallId: unknown.providerCallId,
    });
  });
  const response = await postWorkerResult(fixture, worker, assignment, {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: "1",
    status: "failed",
    fault: {
      type: "about:blank",
      title: "Worker execution failed",
      status: 500,
      detail: "lock order test",
      code: "LOCK_ORDER_TEST_FAILURE",
      requestId: crypto.randomUUID(),
      retryable: false,
    },
    usage: unknown,
  }, crypto.randomUUID());
  assertEquals(response.status, 200, await response.clone().text());
  await response.body?.cancel();
  await publishProviderReceipt(db, run, known);
  return { run, usageFactId: known.usageFactId };
}

/** Recovery settled the candidate; a swallowed 40P01 shows as its failure. */
async function assertRecovered(
  database: PgDatabase,
  run: AdmittedJob,
  usageFactId: string,
  recovered: { providerReceipts: number },
): Promise<void> {
  const usage = (await database.query<
    { id: string; measurement: string }
  >(
    `select id, measurement from bakery.usage_records
      where organization_id = $1 and usage_fact_id = $2`,
    [run.organizationId, usageFactId],
  )).rows[0];
  assertExists(usage);
  const failure = (await database.query<{ code: string }>(
    `select error_code as code from bakery.budget_reconciliation_failures
      where candidate_kind = 'provider-receipt' and organization_id = $1
        and candidate_id = $2`,
    [run.organizationId, usage.id],
  )).rows[0];
  assertEquals(
    failure,
    undefined,
    `recovery must not fail on a lock cycle (${failure?.code})`,
  );
  assertEquals(usage.measurement, "reported");
  assert(recovered.providerReceipts >= 1);
}

/** The shared worker teardown does not know the recovery failure table. */
async function deleteRecoveryFailures(
  database: PgDatabase,
  organizationId: string,
): Promise<void> {
  await database.query(
    `delete from bakery.budget_reconciliation_failures
      where organization_id = $1`,
    [organizationId],
  );
}

async function cancelJob(
  database: PgDatabase,
  organizationId: string,
  jobId: string,
): Promise<void> {
  await database.query(
    `update bakery.jobs set status = 'canceled', updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, jobId],
  );
}

Deno.test("budget recovery and a sibling lane reservation never deadlock", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      const worker = await registeredWorker(fixture, {
        name: "e06-lock-order-recovery-plan",
        slots: 8,
      });
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const { run: settling, usageFactId } = await unknownUsageRun(
          fixture,
          worker,
          `recover-${iteration}`,
        );
        const reserving = await seedRun(
          db,
          fixture.organizationId,
          fixture.principalId,
          {
            reservationUsd: "0.1",
            stepKey: `reserve-${iteration}`,
            applicationId: settling.applicationId,
          },
        );
        const scope = {
          organizationId: fixture.organizationId,
          applicationId: settling.applicationId,
          repositoryId: null,
          principalId: fixture.principalId,
        };
        const parent = await insertTask(db, scope, "recovery parent");
        await insertPlan(db, scope, parent, [
          { childTaskId: settling.taskId, repositoryId: settling.repositoryId },
          {
            childTaskId: reserving.taskId,
            repositoryId: reserving.repositoryId,
          },
        ], "1.0");

        // The sibling reservation queues on the plan parent (held here) with
        // nothing of the budget locked; recovery queues behind it. Old order:
        // recovery held the installation account by then and asked for the
        // parent inside settlement, while the reservation, granted the parent
        // first, asked for that account.
        const hold = await holdRow(
          side,
          `select id from bakery.tasks where id = $1 for update`,
          [parent],
        );
        const reservation = admit(side, reserving);
        const reservationDone = settled(reservation);
        await waitFor(
          "reservation queued",
          async () => reservationDone() || await lockWaiters(side) >= 1,
        );
        const recovery = reconcileBudgetLedger(side);
        const recoveryDone = settled(recovery);
        await waitFor(
          "recovery queued",
          async () =>
            reservationDone() || recoveryDone() ||
            await lockWaiters(side) >= 2,
        );
        hold.release();
        await hold.done;
        const [reservationOutcome, recoveryOutcome] = await Promise.allSettled([
          reservation,
          recovery,
        ]);
        if (reservationOutcome.status === "rejected") {
          throw reservationOutcome.reason;
        }
        if (recoveryOutcome.status === "rejected") throw recoveryOutcome.reason;
        await assertRecovered(db, settling, usageFactId, recoveryOutcome.value);
        await cancelJob(
          db,
          fixture.organizationId,
          reservationOutcome.value.jobId,
        );
      }
    } finally {
      await deleteRecoveryFailures(db, fixture.organizationId);
      await deleteCoordination(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

Deno.test("budget recovery and the next step's reservation on the same run never deadlock", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      const worker = await registeredWorker(fixture, {
        name: "e06-lock-order-recovery-run",
        slots: 8,
      });
      const repository = createBakeryPostgresWorkflowRepository({
        database: side,
        maxAttempts: 1,
        budgetPolicy: fundedModelPolicy,
      });
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const { run, usageFactId } = await unknownUsageRun(
          fixture,
          worker,
          `next-step-${iteration}`,
        );
        // The run moves on to the next iteration of its step; no plan.
        await db.query(
          `update bakery.workflow_runs set status = 'running',
                  engine_owner_token = null, engine_owner_lease_expires_at = null
            where organization_id = $1 and id = $2`,
          [run.organizationId, run.runId],
        );
        await db.query(
          `insert into bakery.run_steps (
             id, organization_id, run_id, step_key, position, iteration,
             status, input
           )
           select gen_random_uuid(), organization_id, run_id, step_key,
                  position, 1, 'pending', input
             from bakery.run_steps
            where organization_id = $1 and id = $2`,
          [run.organizationId, run.runStepId],
        );
        const owner = await repository.acquireEngineOwner(
          run.runId,
          crypto.randomUUID(),
          60_000,
        );
        assertExists(owner);

        // The next step's admission queues on the run row (held here) with
        // nothing of the budget locked; recovery queues behind it. Old order:
        // recovery held the installation account and asked for the run inside
        // settlement, while the admission, granted the run first, asked for
        // that account.
        const hold = await holdRow(
          side,
          `select id from bakery.workflow_runs where id = $1 for update`,
          [run.runId],
        );
        const reservation = repository.admit({
          runId: run.runId,
          stepKey: run.stepKey,
          iteration: 1,
          actionVersion: run.workflowVersionId,
        }, owner);
        const reservationDone = settled(reservation);
        await waitFor(
          "next step queued",
          async () => reservationDone() || await lockWaiters(side) >= 1,
        );
        const recovery = reconcileBudgetLedger(side);
        const recoveryDone = settled(recovery);
        await waitFor(
          "recovery queued",
          async () =>
            reservationDone() || recoveryDone() ||
            await lockWaiters(side) >= 2,
        );
        hold.release();
        await hold.done;
        const [reservationOutcome, recoveryOutcome] = await Promise.allSettled([
          reservation,
          recovery,
        ]);
        await repository.releaseEngineOwner(owner);
        if (reservationOutcome.status === "rejected") {
          throw reservationOutcome.reason;
        }
        if (recoveryOutcome.status === "rejected") throw recoveryOutcome.reason;
        const jobId = reservationOutcome.value.jobId;
        assertExists(jobId, "the next step reserved and queued a job");
        await assertRecovered(db, run, usageFactId, recoveryOutcome.value);
        await cancelJob(db, fixture.organizationId, jobId);
      }
    } finally {
      await deleteRecoveryFailures(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

type EffectStage = {
  rig: EffectRig;
  effectId: string;
};

async function prepareRunEffect(
  database: PgDatabase,
  run: AdmittedJob,
  key: string,
): Promise<EffectStage> {
  const rig = await seededEffectRig(
    database,
    run.organizationId,
    run.principalId,
  );
  const prepared = await prepareEffect({
    database,
    registry: effectRegistry,
    snapshots: rig.port,
  }, {
    organizationId: run.organizationId,
    envelope: rig.envelope,
    input: rig.input(),
    idempotencyKey: key,
    runStepId: run.runStepId,
    budgetReservationId: run.runReservationId,
  });
  return { rig, effectId: prepared.effectId };
}

function claimOn(
  database: PgDatabase,
  organizationId: string,
  stage: EffectStage,
) {
  return claimEffect(claimDepsFor(database, stage.rig), {
    organizationId,
    effectId: stage.effectId,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  });
}

Deno.test("an effect claim and a settling worker result never deadlock in either order", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      const worker = await registeredWorker(fixture, {
        name: "effect-lock-order-settle",
        slots: 8,
      });
      for (const order of ["claim-first", "result-first"] as const) {
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const run = await admit(
            db,
            await seedRun(db, fixture.organizationId, fixture.principalId, {
              reservationUsd: "0.1",
              stepKey: `effect-settle-${order}-${iteration}`,
            }),
          );
          const assignment = await claimAssignment(fixture, worker);
          assertEquals(assignment.jobId, run.jobId);
          const receipt = usageReceipt(run);
          await publishProviderReceipt(db, run, receipt);
          const effect = await prepareRunEffect(
            db,
            run,
            `settle-${order}-${iteration}`,
          );
          const claim = () => claimOn(side, fixture.organizationId, effect);
          const result = () =>
            postWorkerResult(fixture, worker, assignment, {
              leaseToken: assignment.leaseToken,
              fence: assignment.fence,
              localSeq: "1",
              status: "failed",
              fault: {
                type: "about:blank",
                title: "Worker execution failed",
                status: 500,
                detail: "effect lock order test",
                code: "EFFECT_LOCK_ORDER_FAILURE",
                requestId: crypto.randomUUID(),
                retryable: false,
              },
              usage: receipt,
            }, crypto.randomUUID());
          const hold = await holdRow(
            side,
            `select id from bakery.workflow_runs where id = $1 for update`,
            [run.runId],
          );
          const [claimOutcome, resultOutcome] = order === "claim-first"
            ? await raceInOrder(side, hold, claim, result)
            : await raceInOrder(side, hold, result, claim).then((
              [r, c],
            ) => [c, r] as const);
          assertNoDeadlock(claimOutcome);
          assertNoDeadlock(resultOutcome);
          if (claimOutcome.status === "rejected") throw claimOutcome.reason;
          if (resultOutcome.status === "rejected") throw resultOutcome.reason;
          const body = await resultOutcome.value.text();
          // The worker's own terminal result settles its usage in either
          // order (a live effect never refuses it). The claim wins only when
          // it ran first; after the terminal result the job is finished and
          // the claim is blocked.
          assertEquals(
            claimOutcome.value.outcome,
            order === "claim-first" ? "claimed" : "blocked",
            order,
          );
          assertEquals(resultOutcome.value.status, 200, body);
          const state = (await db.query<
            { effect: string; held: number; usage: number }
          >(
            `select (select status from bakery.external_effects where id = $1) as effect,
                    (select count(*)::int from bakery.budget_reservations
                      where id = any($2::uuid[]) and status = 'held') as held,
                    (select count(*)::int from bakery.usage_records
                      where organization_id = $3 and run_step_id = $4) as usage`,
            [
              effect.effectId,
              [
                run.installationReservationId,
                run.runReservationId,
              ],
              fixture.organizationId,
              run.runStepId,
            ],
          )).rows[0];
          assertEquals(
            state.effect,
            order === "claim-first" ? "submitted" : "failed",
            order,
          );
          assertEquals(state.held, 0, order);
          assertEquals(state.usage, 1, order);
          await db.query(
            `update bakery.external_effects set status = 'failed',
                    failure_code = 'test_forced', version = version + 1
              where id = $1`,
            [effect.effectId],
          );
          await cancelJob(db, fixture.organizationId, run.jobId);
        }
      }
    } finally {
      await deleteRecoveryFailures(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

Deno.test("an effect claim and a budget release never deadlock in either order", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      for (const order of ["claim-first", "release-first"] as const) {
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const run = await admit(
            db,
            await seedRun(db, fixture.organizationId, fixture.principalId, {
              reservationUsd: "0.1",
              stepKey: `effect-release-${order}-${iteration}`,
            }),
          );
          const effect = await prepareRunEffect(
            db,
            run,
            `release-${order}-${iteration}`,
          );
          const evidenceId = await persistReleaseEvidence(db, run);
          const claim = () => claimOn(side, fixture.organizationId, effect);
          const release = () =>
            withPgTransaction(
              side,
              (transaction) =>
                releaseWorkflowAction(transaction, {
                  organizationId: fixture.organizationId,
                  installationReservationId: run.installationReservationId,
                  evidenceId,
                }),
            );
          const hold = await holdRow(
            side,
            `select id from bakery.jobs where id = $1 for update`,
            [run.jobId],
          );
          const [claimOutcome, releaseOutcome] = order === "claim-first"
            ? await raceInOrder(side, hold, claim, release)
            : await raceInOrder(side, hold, release, claim).then((
              [r, c],
            ) => [c, r] as const);
          assertNoDeadlock(claimOutcome);
          assertNoDeadlock(releaseOutcome);
          if (claimOutcome.status === "rejected") throw claimOutcome.reason;
          // The job is terminal, so the claim never dispatches.
          assertEquals(claimOutcome.value.outcome, "blocked", order);
          const state =
            (await db.query<{ effect: string; reservation: string }>(
              `select (select status from bakery.external_effects where id = $1) as effect,
                    (select status from bakery.budget_reservations where id = $2) as reservation`,
              [effect.effectId, run.installationReservationId],
            )).rows[0];
          assertEquals(state.effect, "failed");
          if (releaseOutcome.status === "rejected") {
            // Release lost the race to a live (prepared) effect.
            assertEquals(
              (releaseOutcome.reason as StandardError).params?.reason,
              "external_effect_in_flight",
            );
            assertEquals(state.reservation, "held");
            assertEquals(order, "release-first");
          } else {
            assertEquals(state.reservation, "released");
          }
        }
      }
    } finally {
      await closePgDatabase(side);
    }
  }));

Deno.test("budget recovery skips a candidate an effect pins mid-flight", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      const run = await admit(
        db,
        await seedRun(db, fixture.organizationId, fixture.principalId, {
          reservationUsd: "0.1",
          stepKey: "effect-recovery-race",
        }),
      );
      const ids = [run.installationReservationId, run.runReservationId];
      await persistReleaseEvidence(db, run);
      // Only the installation reservation expires, so a prepared effect on the
      // run reservation pins it.
      await db.query(
        `update bakery.budget_reservations
            set expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [run.installationReservationId],
      );
      const hold = await holdRow(
        side,
        `select id from bakery.jobs where id = $1 for update`,
        [run.jobId],
      );
      const recovery = reconcileBudgetLedger(side);
      const recoveryDone = settled(recovery);
      await waitFor(
        "recovery queued on the failed job",
        async () => await lockWaiters(side, hold.pid) >= 1,
      );
      assert(!recoveryDone(), "recovery must be queued, not finished");
      // The candidate query already ran; now the effect becomes live.
      const effect = await prepareRunEffect(db, run, "recovery-race");
      hold.release();
      await hold.done;
      assertEquals((await recovery).releases, 0);
      const failures = await db.query(
        `select 1 from bakery.budget_reconciliation_failures
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(failures.rows.length, 0);
      const held = await db.query<{ status: string }>(
        `select status from bakery.budget_reservations where id = any($1::uuid[])`,
        [ids],
      );
      assertEquals(held.rows.map((row) => row.status), ["held", "held"]);
      await forceEffectStatus(
        db,
        fixture.organizationId,
        effect.effectId,
        "failed",
      );
      assertEquals((await reconcileBudgetLedger(side)).releases, 1);
    } finally {
      await deleteRecoveryFailures(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));

async function reservationStates(
  database: PgDatabase,
  run: AdmittedJob,
): Promise<string[]> {
  const rows = await database.query<{ status: string }>(
    `select status from bakery.budget_reservations
      where id = any($1::uuid[]) order by id`,
    [[run.installationReservationId, run.runReservationId]],
  );
  return rows.rows.map((row) => row.status);
}

async function usageMeasurement(
  database: PgDatabase,
  run: AdmittedJob,
  usageFactId: string,
): Promise<string> {
  const rows = await database.query<{ measurement: string }>(
    `select measurement from bakery.usage_records
      where organization_id = $1 and usage_fact_id = $2`,
    [run.organizationId, usageFactId],
  );
  return rows.rows[0]!.measurement;
}

Deno.test("a receipt settles nothing once an effect turns live after candidate selection", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
    try {
      await seedProviderPricingSnapshot(db);
      const worker = await registeredWorker(fixture, {
        name: "e09-receipt-live-effect",
        slots: 8,
      });

      // Direct guard: the candidate was selected before the effect existed.
      const direct = await unknownUsageRun(fixture, worker, "receipt-direct");
      const candidate = (await withPgTransaction(
        db,
        (transaction) => findProviderUsageReceiptCandidates(transaction, 1_000),
      )).find((row) =>
        row.installationReservationId === direct.run.installationReservationId
      );
      assertExists(candidate, "the receipt must be a recovery candidate");
      const before = await reservationStates(db, direct.run);
      const directEffect = await prepareRunEffect(
        db,
        direct.run,
        "receipt-direct",
      );
      const refusal = await assertRejects(
        () =>
          withPgTransaction(
            db,
            (transaction) =>
              reconcileProviderUsageReceipt(transaction, candidate),
          ),
        StandardError,
      );
      assertEquals(refusal.code, "STATE_CONFLICT");
      assertEquals(refusal.params?.reason, "external_effect_in_flight");
      assertEquals(await reservationStates(db, direct.run), before);
      assertEquals(
        await usageMeasurement(db, direct.run, direct.usageFactId),
        "unknown",
      );

      // Through recovery: a scoped hold lets the candidate query run first,
      // then the effect becomes live before settlement takes its scope.
      const raced = await unknownUsageRun(fixture, worker, "receipt-raced");
      const racedBefore = await reservationStates(db, raced.run);
      const hold = await holdRow(
        side,
        `select id from bakery.run_steps where id = $1 for no key update`,
        [raced.run.runStepId],
      );
      const recovery = reconcileBudgetLedger(side);
      const recoveryDone = settled(recovery);
      await waitFor(
        "recovery queued on the raced run step",
        async () => await lockWaiters(side, hold.pid) >= 1,
      );
      assert(!recoveryDone(), "recovery must be queued, not finished");
      const racedEffect = await prepareRunEffect(
        db,
        raced.run,
        "receipt-raced",
      );
      hold.release();
      await hold.done;
      await recovery;
      const failures = await db.query(
        `select 1 from bakery.budget_reconciliation_failures
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(failures.rows.length, 0);
      assertEquals(await reservationStates(db, raced.run), racedBefore);
      assertEquals(
        await usageMeasurement(db, raced.run, raced.usageFactId),
        "unknown",
      );
      for (const effect of [directEffect, racedEffect]) {
        await forceEffectStatus(
          db,
          fixture.organizationId,
          effect.effectId,
          "failed",
        );
      }
    } finally {
      await deleteRecoveryFailures(db, fixture.organizationId);
      await closePgDatabase(side);
    }
  }));
