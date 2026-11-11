import { StandardError } from "@bakery/contracts/http";
import { COORDINATOR_TURN_ACTION } from "@bakery/contracts/coordinator-turn";
import { releaseCoordinatorJobReservation } from "./coordinator-jobs.ts";
import { admitRepositoryExecutionJob } from "./repository-admission.ts";
import { appendAudit, appendDomainEvent } from "./event-audit.ts";
import { persistAssignmentRejectionBudgetEvidence } from "./budget-release.ts";
import type { PgTransactionClient } from "./postgres.ts";
import {
  assertBigIntAtLeast,
  type RequestMetadata,
  sessionGeneration,
  type WorkerIdentity,
} from "./types.ts";

export const RECLAIM_COORDINATOR_BATCH_SIZE = 500;

/** A task the attempt lifecycle moved to `failed` inside a transaction. */
export type FailedLifecycleTask = {
  organizationId: string;
  taskId: string;
  traceId: string;
};

const failedLifecycleTasks = new WeakMap<
  PgTransactionClient,
  Map<string, FailedLifecycleTask>
>();

/**
 * Persistence cannot import the server's coordination projection, so terminal
 * task failures made here are noted on the transaction and the server drains
 * them (takeFailedLifecycleTasks) before commit to reconcile coordination.
 */
function noteFailedLifecycleTask(
  transaction: PgTransactionClient,
  task: FailedLifecycleTask,
): void {
  const noted = failedLifecycleTasks.get(transaction) ?? new Map();
  noted.set(`${task.organizationId}:${task.taskId}`, task);
  failedLifecycleTasks.set(transaction, noted);
}

/** Returns, in task id order, and forgets the tasks noted on `transaction`. */
export function takeFailedLifecycleTasks(
  transaction: PgTransactionClient,
): FailedLifecycleTask[] {
  const noted = failedLifecycleTasks.get(transaction);
  failedLifecycleTasks.delete(transaction);
  return [...(noted?.values() ?? [])].sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
  );
}

type WorkflowLifecycleContext = {
  organizationId: string;
  jobId: string;
  runId: string;
  runStepId: string;
  taskId: string;
  applicationId: string;
  repositoryId: string | null;
  conversationId: string;
  originalTraceId: string | null;
  runStatus: string;
  stepStatus: string;
  taskStatus: string;
  taskCurrentRunId: string | null;
  jobStatus: string;
  maxAttempts: number;
};
async function loadWorkflowLifecycleContext(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<WorkflowLifecycleContext | null> {
  const result = await transaction.query<WorkflowLifecycleContext>(
    `select job.organization_id as "organizationId",
            job.id as "jobId", step.run_id as "runId",
            step.id as "runStepId",
            task.id as "taskId", task.application_id as "applicationId",
            task.repository_id as "repositoryId",
            task.conversation_id as "conversationId",
            original_request.trace_id as "originalTraceId",
            run.status as "runStatus", step.status as "stepStatus",
            task.status as "taskStatus", task.current_run_id as "taskCurrentRunId",
            job.status as "jobStatus", job.max_attempts as "maxAttempts"
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       join bakery.tasks task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
       left join lateral (
         select event.trace_id
           from bakery.domain_events event
          where event.organization_id = run.organization_id
            and event.aggregate_id = run.id
            and event.event_type = 'run.requested'
          order by event.organization_sequence asc
          limit 1
       ) original_request on true
      where job.organization_id = $1 and job.id = $2
      for update of job, step, run, task`,
    [organizationId, jobId],
  );
  return result.rows[0] ?? null;
}

const INVALID_ASSIGNMENT_PAYLOAD_CODE = "INVALID_ASSIGNMENT_PAYLOAD";
const INVALID_ASSIGNMENT_PAYLOAD_MESSAGE =
  "Queued assignment payload is invalid.";

export async function markJobAssignmentPayloadInvalid(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    jobId: string;
    currentFence: string | number;
    metadata: RequestMetadata;
    principalId: string | null;
    invalidFields: readonly string[];
  },
): Promise<boolean> {
  const context = await loadWorkflowLifecycleContext(
    transaction,
    options.organizationId,
    options.jobId,
  );
  const job = await transaction.query<{
    status: string;
    action: string;
    runStepId: string | null;
    conversationTurnId: string | null;
  }>(
    `select status, action, run_step_id as "runStepId",
            conversation_turn_id as "conversationTurnId"
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [options.organizationId, options.jobId],
  );
  const jobRow = job.rows[0];
  if (!jobRow || jobRow.status !== "queued") return false;
  const coordinatorJob = jobRow.action === COORDINATOR_TURN_ACTION &&
    jobRow.runStepId === null && jobRow.conversationTurnId !== null;
  if (
    context && (
      context.jobStatus !== "queued" ||
      protectedLifecycleStatus(context.runStatus) ||
      protectedLifecycleStatus(context.stepStatus) ||
      protectedLifecycleStatus(context.taskStatus) ||
      context.taskCurrentRunId !== context.runId
    )
  ) return false;
  if (
    !context && !coordinatorJob &&
    (jobRow.action !== "repository.inspect" || jobRow.runStepId)
  ) {
    return false;
  }
  const liveAttempt = await transaction.query(
    `select 1
       from bakery.job_attempts
      where organization_id = $1 and job_id = $2
        and status in ('leased', 'running', 'canceling')
        and lease_expires_at > clock_timestamp()
      limit 1`,
    [options.organizationId, options.jobId],
  );
  if (liveAttempt.rows[0]) return false;
  if (!context && jobRow.action === "repository.inspect") {
    const onboarding = await transaction.query(
      `select 1
         from bakery.repository_onboardings onboarding
         join bakery.jobs job
           on job.organization_id = onboarding.organization_id
          and job.application_id = onboarding.application_id
          and job.repository_id = onboarding.repository_id
          and job.id = onboarding.job_id
          and job.input = onboarding.input
        where job.organization_id = $1 and job.id = $2
        limit 1`,
      [options.organizationId, options.jobId],
    );
    if (!onboarding.rows[0]) return false;
  }
  const failed = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'failed', current_fence = current_fence + 1,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2 and status = 'queued'
        and current_fence = $3
      returning version`,
    [options.organizationId, options.jobId, options.currentFence.toString()],
  );
  const failedRow = failed.rows[0];
  if (!failedRow) return false;
  const latestAttempt = await transaction.query<{ id: string }>(
    `select id
       from bakery.job_attempts
      where organization_id = $1 and job_id = $2
        and status not in ('leased', 'running', 'canceling')
      order by attempt_no desc, id desc
      limit 1`,
    [options.organizationId, options.jobId],
  );
  const completedAttemptId = latestAttempt.rows[0]?.id;
  if (completedAttemptId) {
    await appendDomainEvent(transaction, {
      organizationId: options.organizationId,
      ...(context
        ? {
          applicationId: context.applicationId,
          repositoryId: context.repositoryId,
          taskId: context.taskId,
          conversationId: context.conversationId,
        }
        : {}),
      eventType: "job.updated",
      aggregateId: options.jobId,
      aggregateVersion: failedRow.version,
      payload: {
        jobId: options.jobId,
        attemptId: completedAttemptId,
        version: failedRow.version,
      },
      traceId: context?.originalTraceId ?? options.metadata.traceId,
    });
  }
  const safeError = {
    code: INVALID_ASSIGNMENT_PAYLOAD_CODE,
    message: INVALID_ASSIGNMENT_PAYLOAD_MESSAGE,
  };
  if (context) {
    await transaction.query(
      `update bakery.run_steps
          set status = 'failed', error = $3::jsonb,
              started_at = coalesce(started_at, current_timestamp),
              finished_at = current_timestamp, updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1 and id = $2
          and status not in ('completed', 'failed', 'canceled', 'blocked')`,
      [options.organizationId, context.runStepId, JSON.stringify(safeError)],
    );
    const run = await transaction.query<{ version: number }>(
      `update bakery.workflow_runs
          set status = 'failed', finished_at = current_timestamp,
              engine_owner_token = null, engine_owner_lease_expires_at = null,
              updated_at = current_timestamp, version = version + 1
        where organization_id = $1 and id = $2
          and status not in ('completed', 'failed', 'canceled', 'blocked')
        returning version`,
      [options.organizationId, context.runId],
    );
    if (run.rows[0]) {
      await appendDomainEvent(transaction, {
        organizationId: options.organizationId,
        applicationId: context.applicationId,
        repositoryId: context.repositoryId,
        taskId: context.taskId,
        conversationId: context.conversationId,
        eventType: "run.updated",
        aggregateId: context.runId,
        aggregateVersion: run.rows[0].version,
        payload: { runId: context.runId, version: run.rows[0].version },
        traceId: options.metadata.traceId,
      });
    }
    const task = await transaction.query<{ version: number }>(
      `update bakery.tasks
          set status = 'failed', updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1 and id = $2 and current_run_id = $3
          and status not in ('completed', 'failed', 'canceled')
        returning version`,
      [options.organizationId, context.taskId, context.runId],
    );
    if (task.rows[0]) {
      noteFailedLifecycleTask(transaction, {
        organizationId: options.organizationId,
        taskId: context.taskId,
        traceId: options.metadata.traceId,
      });
      await appendDomainEvent(transaction, {
        organizationId: options.organizationId,
        applicationId: context.applicationId,
        repositoryId: context.repositoryId,
        taskId: context.taskId,
        conversationId: context.conversationId,
        eventType: "tasks.updated",
        aggregateId: context.taskId,
        aggregateVersion: task.rows[0].version,
        payload: {
          resourceId: context.taskId,
          resourceVersion: task.rows[0].version,
        },
        traceId: options.metadata.traceId,
      });
    }
  }
  await appendAudit(transaction, {
    organizationId: options.organizationId,
    principalId: options.principalId,
    operation: "workers.claim.assignment_payload_rejected",
    resourceType: "job",
    resourceId: options.jobId,
    requestId: options.metadata.requestId,
    traceId: options.metadata.traceId,
    outcome: "denied",
    details: {
      code: INVALID_ASSIGNMENT_PAYLOAD_CODE,
      version: failedRow.version,
      invalidFields: options.invalidFields,
    },
  });
  await persistAssignmentRejectionBudgetEvidence(transaction, {
    organizationId: options.organizationId,
    jobId: options.jobId,
    jobVersion: failedRow.version,
  });
  if (coordinatorJob) {
    // No attempt ever ran, so no spend: return the run-less reservation.
    await releaseCoordinatorJobReservation(transaction, {
      organizationId: options.organizationId,
      jobId: options.jobId,
    });
  }
  return true;
}

function protectedLifecycleStatus(status: string): boolean {
  return ["completed", "failed", "canceled", "blocked"].includes(status);
}

async function attemptBudget(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<{ terminal: number; live: number } | null> {
  const result = await transaction.query<{
    terminal: string;
    live: string;
  }>(
    `select count(*) filter (
              where status not in ('leased', 'running', 'canceling')
            )::text as terminal,
            count(*) filter (
              where status in ('leased', 'running', 'canceling')
            )::text as live
       from bakery.job_attempts
      where organization_id = $1 and job_id = $2`,
    [organizationId, jobId],
  );
  const row = result.rows[0];
  return row
    ? { terminal: Number(row.terminal), live: Number(row.live) }
    : null;
}

async function finalizeWorkflowFailure(
  transaction: PgTransactionClient,
  context: WorkflowLifecycleContext,
  attemptId: string | null,
  metadata: RequestMetadata,
): Promise<void> {
  const jobUpdate = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'failed', updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [context.organizationId, context.jobId],
  );
  if (!jobUpdate.rows[0]) return;
  const latestAttempt = await transaction.query<{ id: string }>(
    `select id
       from bakery.job_attempts
      where organization_id = $1 and job_id = $2
        and status not in ('leased', 'running', 'canceling')
      order by attempt_no desc, id desc
      limit 1`,
    [context.organizationId, context.jobId],
  );
  const completedAttemptId = attemptId ?? latestAttempt.rows[0]?.id ?? null;
  if (completedAttemptId) {
    await appendDomainEvent(transaction, {
      organizationId: context.organizationId,
      applicationId: context.applicationId,
      repositoryId: context.repositoryId,
      taskId: context.taskId,
      conversationId: context.conversationId,
      eventType: "job.updated",
      aggregateId: context.jobId,
      aggregateVersion: jobUpdate.rows[0].version,
      payload: {
        jobId: context.jobId,
        attemptId: completedAttemptId,
        version: jobUpdate.rows[0].version,
      },
      traceId: context.originalTraceId ?? metadata.traceId,
    });
  }
  await transaction.query(
    `update bakery.run_steps
        set status = 'failed',
            error = jsonb_build_object(
              'code', 'ATTEMPT_BUDGET_EXHAUSTED',
              'message', 'The attempt budget is exhausted.'
            ),
            started_at = coalesce(started_at, current_timestamp),
            finished_at = current_timestamp,
            updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled', 'blocked')`,
    [context.organizationId, context.runStepId],
  );
  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'failed', finished_at = current_timestamp,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled', 'blocked')
      returning version`,
    [context.organizationId, context.runId],
  );
  if (runUpdate.rows[0]) {
    await appendDomainEvent(transaction, {
      organizationId: context.organizationId,
      applicationId: context.applicationId,
      repositoryId: context.repositoryId,
      taskId: context.taskId,
      conversationId: context.conversationId,
      eventType: "run.updated",
      aggregateId: context.runId,
      aggregateVersion: runUpdate.rows[0].version,
      payload: {
        runId: context.runId,
        version: runUpdate.rows[0].version,
      },
      traceId: context.originalTraceId ?? metadata.traceId,
    });
  }
  const taskUpdate = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = 'failed', updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1 and id = $2
        and current_run_id = $3
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [context.organizationId, context.taskId, context.runId],
  );
  if (taskUpdate.rows[0]) {
    noteFailedLifecycleTask(transaction, {
      organizationId: context.organizationId,
      taskId: context.taskId,
      traceId: context.originalTraceId ?? metadata.traceId,
    });
    await appendDomainEvent(transaction, {
      organizationId: context.organizationId,
      applicationId: context.applicationId,
      repositoryId: context.repositoryId,
      taskId: context.taskId,
      conversationId: context.conversationId,
      eventType: "tasks.updated",
      aggregateId: context.taskId,
      aggregateVersion: taskUpdate.rows[0].version,
      payload: {
        resourceId: context.taskId,
        resourceVersion: taskUpdate.rows[0].version,
      },
      traceId: context.originalTraceId ?? metadata.traceId,
    });
  }
}

export async function markJobAttemptBudgetExhausted(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
  attemptId: string | null,
  metadata: RequestMetadata,
): Promise<void> {
  const job = await transaction.query<{
    maxAttempts: number;
    status: string;
    action: string;
    runStepId: string | null;
  }>(
    `select max_attempts as "maxAttempts", status, action,
            run_step_id as "runStepId"
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, jobId],
  );
  const jobRow = job.rows[0];
  if (!jobRow || terminalJobStatus(jobRow.status)) return;
  const budget = await attemptBudget(transaction, organizationId, jobId);
  if (
    !budget || budget.live !== 0 || budget.terminal < jobRow.maxAttempts
  ) return;
  const context = await loadWorkflowLifecycleContext(
    transaction,
    organizationId,
    jobId,
  );
  if (context) {
    await finalizeWorkflowFailure(transaction, context, attemptId, metadata);
    return;
  }
  if (jobRow.action === COORDINATOR_TURN_ACTION) {
    await failCoordinatorJobAttemptsExhausted(
      transaction,
      organizationId,
      jobId,
      attemptId,
      metadata,
    );
    return;
  }
  if (jobRow.action !== "repository.inspect" || jobRow.runStepId !== null) {
    return;
  }
  // Only onboarding-backed inspections have a standalone terminal lifecycle.
  const inspection = await transaction.query<{
    applicationId: string;
    repositoryId: string;
    attemptId: string;
  }>(
    `select job.application_id as "applicationId",
            job.repository_id as "repositoryId", attempt.id as "attemptId"
       from bakery.jobs job
       join bakery.repository_onboardings onboarding
         on onboarding.organization_id = job.organization_id
        and onboarding.application_id = job.application_id
        and onboarding.repository_id = job.repository_id
        and onboarding.job_id = job.id
        and onboarding.input = job.input
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
      where job.organization_id = $1 and job.id = $2
        and job.run_step_id is null and job.action = 'repository.inspect'
        and attempt.status not in ('leased', 'running', 'canceling')
        and ($3::uuid is null or attempt.id = $3)
      order by attempt.attempt_no desc, attempt.id desc
      limit 1`,
    [organizationId, jobId, attemptId],
  );
  const inspectionRow = inspection.rows[0];
  if (!inspectionRow) return;
  const failed = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'failed', current_fence = current_fence + 1,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [organizationId, jobId],
  );
  const failedRow = failed.rows[0];
  if (!failedRow) return;
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: inspectionRow.applicationId,
    repositoryId: inspectionRow.repositoryId,
    eventType: "job.updated",
    aggregateId: jobId,
    aggregateVersion: failedRow.version,
    payload: {
      jobId,
      attemptId: inspectionRow.attemptId,
      version: failedRow.version,
    },
    traceId: metadata.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "jobs.attempt_budget_exhausted",
    resourceType: "job",
    resourceId: jobId,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: { code: "ATTEMPT_BUDGET_EXHAUSTED" },
  });
}

/**
 * A coordinator turn has one attempt and no run step. When that attempt ends
 * without a result (expired lease, quarantine) the job is `failed`, never
 * re-offered, and the funding reservation goes back to the account.
 */
async function failCoordinatorJobAttemptsExhausted(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
  attemptId: string | null,
  metadata: RequestMetadata,
): Promise<void> {
  const failed = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'failed', current_fence = current_fence + 1,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2
        and action = 'coordinator.turn' and run_step_id is null
        and conversation_turn_id is not null
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [organizationId, jobId],
  );
  const failedRow = failed.rows[0];
  if (!failedRow) return;
  const latestAttempt = await transaction.query<{ id: string }>(
    `select id
       from bakery.job_attempts
      where organization_id = $1 and job_id = $2
        and status not in ('leased', 'running', 'canceling')
        and ($3::uuid is null or id = $3)
      order by attempt_no desc, id desc
      limit 1`,
    [organizationId, jobId, attemptId],
  );
  const completedAttemptId = latestAttempt.rows[0]?.id;
  if (completedAttemptId) {
    await appendDomainEvent(transaction, {
      organizationId,
      eventType: "job.updated",
      aggregateId: jobId,
      aggregateVersion: failedRow.version,
      payload: {
        jobId,
        attemptId: completedAttemptId,
        version: failedRow.version,
      },
      traceId: metadata.traceId,
    });
  }
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "jobs.attempt_budget_exhausted",
    resourceType: "job",
    resourceId: jobId,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: { code: "ATTEMPT_BUDGET_EXHAUSTED" },
  });
  await releaseCoordinatorJobReservation(transaction, {
    organizationId,
    jobId,
  });
}

function terminalJobStatus(status: string): boolean {
  return ["completed", "failed", "canceled"].includes(status);
}

export async function reclaimExpiredAttempts(
  transaction: PgTransactionClient,
  organizationId?: string,
  metadata?: RequestMetadata,
  principalId: string | null = null,
  batchSize = RECLAIM_COORDINATOR_BATCH_SIZE,
): Promise<void> {
  const eventMetadata = metadata ?? {
    requestId: `reclaim:${organizationId ?? "all"}`,
    traceId: organizationId ?? "reclaim-coordinator",
  };
  const expired = await transaction.query<{
    id: string;
    organization_id: string;
    job_id: string;
    fence: string | number;
    currentFence: string | number;
  }>(
    `select attempt.id, attempt.organization_id, attempt.job_id,
            attempt.fence, job.current_fence as "currentFence"
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where ($1::uuid is null or attempt.organization_id = $1)
        and (
          attempt.status = 'quarantined' or
          (
            attempt.status in ('leased', 'running', 'canceling')
            and attempt.lease_expires_at <= clock_timestamp()
          )
        )
      order by attempt.lease_expires_at asc, attempt.id asc
      limit $2
      for update of attempt skip locked`,
    [organizationId ?? null, batchSize],
  );
  const lifecycleContexts = new Map<string, WorkflowLifecycleContext | null>();
  const lockOrder = [...expired.rows].sort((left, right) =>
    `${left.organization_id}:${left.job_id}`.localeCompare(
      `${right.organization_id}:${right.job_id}`,
    )
  );
  for (const candidate of lockOrder) {
    lifecycleContexts.set(
      `${candidate.organization_id}:${candidate.job_id}`,
      await loadWorkflowLifecycleContext(
        transaction,
        candidate.organization_id,
        candidate.job_id,
      ),
    );
  }
  for (const candidate of expired.rows) {
    assertBigIntAtLeast(candidate.fence, 1n);
    assertBigIntAtLeast(candidate.currentFence, 0n);
    const attemptUpdate = await transaction.query<{ version: number }>(
      `update bakery.job_attempts
          set status = 'lost', ended_at = current_timestamp,
              updated_at = current_timestamp, version = version + 1
        where organization_id = $1 and id = $2
          and (
            status = 'quarantined' or
            (
              status in ('leased', 'running', 'canceling')
              and lease_expires_at <= clock_timestamp()
            )
          )
        returning version`,
      [candidate.organization_id, candidate.id],
    );
    if (!attemptUpdate.rows[0]) continue;
    const budget = await transaction.query<{
      maxAttempts: number;
      terminalAttempts: string;
      liveAttempts: string;
    }>(
      `select job.max_attempts as "maxAttempts",
              count(*) filter (
                where attempt.status not in ('leased', 'running', 'canceling')
              )::text as "terminalAttempts",
              count(*) filter (
                where attempt.status in ('leased', 'running', 'canceling')
              )::text as "liveAttempts"
         from bakery.jobs job
         left join bakery.job_attempts attempt
           on attempt.organization_id = job.organization_id
          and attempt.job_id = job.id
        where job.organization_id = $1 and job.id = $2
        group by job.id`,
      [candidate.organization_id, candidate.job_id],
    );
    const budgetRow = budget.rows[0];
    if (
      budgetRow &&
      Number(budgetRow.terminalAttempts) >= budgetRow.maxAttempts &&
      Number(budgetRow.liveAttempts) === 0
    ) {
      await markJobAttemptBudgetExhausted(
        transaction,
        candidate.organization_id,
        candidate.job_id,
        candidate.id,
        eventMetadata,
      );
    } else {
      const jobUpdate = await transaction.query<{ version: number }>(
        `update bakery.jobs
            set status = 'queued', current_fence = current_fence + 1,
                updated_at = current_timestamp, version = version + 1
          where organization_id = $1 and id = $2
            and status in ('leased', 'running', 'awaiting_reconciliation')
          returning version`,
        [candidate.organization_id, candidate.job_id],
      );
      if (jobUpdate.rows[0]) {
        const context = lifecycleContexts.get(
          `${candidate.organization_id}:${candidate.job_id}`,
        ) ?? null;
        await appendDomainEvent(transaction, {
          organizationId: candidate.organization_id,
          ...(context
            ? {
              applicationId: context.applicationId,
              repositoryId: context.repositoryId,
              taskId: context.taskId,
              conversationId: context.conversationId,
            }
            : {}),
          eventType: "job.updated",
          aggregateId: candidate.job_id,
          aggregateVersion: jobUpdate.rows[0].version,
          payload: {
            jobId: candidate.job_id,
            attemptId: candidate.id,
            version: jobUpdate.rows[0].version,
          },
          traceId: context?.originalTraceId ?? eventMetadata.traceId,
        });
      }
    }
    await appendAudit(transaction, {
      organizationId: candidate.organization_id,
      principalId,
      operation: "workers.attempt_reclaimed",
      resourceType: "job_attempt",
      resourceId: candidate.id,
      requestId: eventMetadata.requestId,
      traceId: eventMetadata.traceId,
      details: { jobId: candidate.job_id, reason: "lease_expired" },
    });
  }
}

/**
 * Requeues a workflow job whose attempt just failed with a retryable fault.
 *
 * The caller has already set the attempt `failed`. The job goes back to
 * `queued` under a new fence when attempts remain, so a harness timeout gets
 * its remaining attempts like a lost lease does. This is safe because the
 * caller only asks when the failure reported no usage (the budget intent is
 * still held, so the re-claim is funded) and a retryable fault means the
 * worker confirmed the harness process is gone. A job with a cancel request,
 * an inspection job, an unfinished sibling attempt or a spent attempt budget
 * stays terminal: this returns false and the caller finishes the job.
 */
export async function requeueRetryableAttemptFailure(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    jobId: string;
    attemptId: string;
    fence: string;
    metadata: RequestMetadata;
  },
): Promise<boolean> {
  const job = await transaction.query<{
    status: string;
    action: string;
    runStepId: string | null;
    cancelRequestedAt: Date | null;
    currentFence: string | number;
    maxAttempts: number;
  }>(
    `select status, action, run_step_id as "runStepId",
            cancel_requested_at as "cancelRequestedAt",
            current_fence as "currentFence", max_attempts as "maxAttempts"
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [options.organizationId, options.jobId],
  );
  const row = job.rows[0];
  if (
    !row ||
    !["leased", "running"].includes(row.status) ||
    row.cancelRequestedAt !== null ||
    row.runStepId === null ||
    row.action === "repository.inspect" ||
    BigInt(row.currentFence) !== BigInt(options.fence)
  ) return false;
  const budget = await attemptBudget(
    transaction,
    options.organizationId,
    options.jobId,
  );
  if (!budget || budget.live !== 0 || budget.terminal >= row.maxAttempts) {
    return false;
  }
  const context = await loadWorkflowLifecycleContext(
    transaction,
    options.organizationId,
    options.jobId,
  );
  const update = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'queued', current_fence = current_fence + 1,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2
        and status in ('leased', 'running') and current_fence = $3
      returning version`,
    [options.organizationId, options.jobId, options.fence],
  );
  const version = update.rows[0]?.version;
  if (version === undefined) return false;
  await appendDomainEvent(transaction, {
    organizationId: options.organizationId,
    ...(context
      ? {
        applicationId: context.applicationId,
        repositoryId: context.repositoryId,
        taskId: context.taskId,
        conversationId: context.conversationId,
      }
      : {}),
    eventType: "job.updated",
    aggregateId: options.jobId,
    aggregateVersion: version,
    payload: { jobId: options.jobId, attemptId: options.attemptId, version },
    traceId: context?.originalTraceId ?? options.metadata.traceId,
  });
  return true;
}

export async function rebindLiveClaimAttempt(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string | null | undefined,
  authorityTime?: Date,
): Promise<boolean> {
  if (attemptId) {
    const attempt = await transaction.query<
      { job_id: string; run_step_id: string | null; action: string }
    >(
      `select job.id as job_id, job.run_step_id, job.action
         from bakery.job_attempts attempt
         join bakery.jobs job on job.organization_id = attempt.organization_id and job.id = attempt.job_id
        where attempt.organization_id = $1 and attempt.id = $2 and attempt.worker_host_id = $3`,
      [identity.host.organizationId, attemptId, identity.host.id],
    );
    const row = attempt.rows[0];
    if (row?.action === COORDINATOR_TURN_ACTION && row.run_step_id === null) {
      // Standalone job: no run admission. The host must still advertise the
      // model capability the claim required.
      const capabilities = Array.isArray(identity.host.capabilities)
        ? identity.host.capabilities
        : [];
      if (!capabilities.includes("model")) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
    } else if (row?.run_step_id !== null && row?.run_step_id !== undefined) {
      const requirements = await admitRepositoryExecutionJob(
        transaction,
        identity.host.organizationId,
        row.job_id,
      );
      const capabilities = Array.isArray(identity.host.capabilities)
        ? identity.host.capabilities
        : [];
      if (
        requirements.capabilities.some((capability) =>
          !capabilities.includes(capability)
        ) ||
        (requirements.platform !== undefined &&
          requirements.platform !== identity.host.os)
      ) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
    }
  }
  if (!attemptId || identity.host.workerSessionId === null) return false;
  const live = await transaction.query<{ id: string }>(
    `select attempt.id
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where attempt.organization_id = $1
        and attempt.worker_host_id = $2
        and attempt.id = $3
        and attempt.status in ('leased', 'running', 'canceling')
        and attempt.lease_expires_at > coalesce(
          $4::timestamptz,
          clock_timestamp()
        )
        and job.current_fence = attempt.fence
      for update of attempt, job`,
    [
      identity.host.organizationId,
      identity.host.id,
      attemptId,
      authorityTime ?? null,
    ],
  );
  if (!live.rows[0]) return false;
  const updated = await transaction.query(
    `update bakery.job_attempts
        set worker_session_id = $4,
            worker_session_generation = $5,
            updated_at = coalesce($6::timestamptz, current_timestamp),
            version = version + 1
      where organization_id = $1 and worker_host_id = $2 and id = $3`,
    [
      identity.host.organizationId,
      identity.host.id,
      attemptId,
      identity.host.workerSessionId,
      sessionGeneration(identity.host.workerSessionGeneration, 0n).toString(),
      authorityTime ?? null,
    ],
  );
  return updated.rowCount === 1;
}
