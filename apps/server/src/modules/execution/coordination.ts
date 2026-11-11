import {
  type DatabaseConfig,
  readDatabaseConfig,
  readEnvironmentSnapshot,
} from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import { COORDINATOR_TURN_ACTION } from "@bakery/contracts/coordinator-turn";
import { releaseCoordinatorJobReservation } from "@bakery/persistence";
import {
  assertApplicationDatabase,
  closePgDatabase,
  openPgDatabase,
} from "../../platform/database.ts";
import { sweepExecutionRetention as persistSweepExecutionRetention } from "@bakery/persistence/coordination";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { reconcileCoordinationForTerminalTask } from "../work/coordination-projection.ts";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import {
  COORDINATOR_POLL_MILLISECONDS,
  COORDINATOR_TRANSIENT_RETRY_DELAYS_MILLISECONDS,
} from "./shared.ts";
import { reclaimExpiredAttempts } from "@bakery/persistence/attempts";
import { reconcileFailedLifecycleTasks } from "../work/coordination-projection.ts";

type DenoSignalApi = {
  addSignalListener(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
};
const deno = (globalThis as typeof globalThis & { Deno: DenoSignalApi }).Deno;

function activeAttempt(status: string): boolean {
  return status === "leased" || status === "running" || status === "canceling";
}

export type WorkerControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "interrupt"
  | "steer_message"
  | "follow_up_message";

const workerCommandType: Record<
  WorkerControlAction,
  "steer" | "follow_up" | "cancel"
> = {
  pause: "steer",
  resume: "follow_up",
  cancel: "cancel",
  interrupt: "steer",
  steer_message: "steer",
  follow_up_message: "follow_up",
};

type WorkerHostRow = {
  id: string;
  workerSessionId: string | null;
  workerSessionGeneration: string | number;
};

type CurrentAttemptRow = {
  id: string;
  jobId: string;
  status: string;
  jobStatus: string;
  fence: string | number;
  currentFence: string | number;
  workerHostId: string;
  workerSessionId: string | null;
  workerSessionGeneration: string | number;
  leaseLive: boolean;
  sessionCurrent: boolean;
};
type StoredControlCommand = {
  id: string;
  commandType: string;
  payload: unknown;
  messageId: string | null;
  requestDigest: string;
};

type StoredControlReplay = StoredControlCommand;

function controlPayload(
  input: {
    action: WorkerControlAction;
    reason?: string;
    messageId?: string;
    body?: string;
  },
  attempt: CurrentAttemptRow,
  host: WorkerHostRow,
): string {
  const workerScoped = input.action === "resume";
  return JSON.stringify({
    controlAction: input.action,
    controlScope: workerScoped ? "worker" : "attempt",
    workerHostId: attempt.workerHostId,
    workerSessionId: workerScoped
      ? host.workerSessionId ?? ""
      : attempt.workerSessionId ?? "",
    workerSessionGeneration: String(
      workerScoped
        ? host.workerSessionGeneration
        : attempt.workerSessionGeneration,
    ),
    fence: String(attempt.fence),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.messageId === undefined
      ? {}
      : { messageId: input.messageId, body: input.body ?? "" }),
  });
}

type CancellationLifecycleRow = {
  runId: string;
  runStepId: string | null;
  taskId: string;
  applicationId: string;
  repositoryId: string | null;
  conversationId: string;
  runVersion: number;
  taskVersion: number;
};

async function finalizeCanceledLifecycle(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    jobId: string;
    /** Null when the job never had an attempt. */
    attemptId: string | null;
    jobVersion: number;
    action: string;
    runStepId: string | null;
    traceId: string;
  },
): Promise<void> {
  if (input.action === COORDINATOR_TURN_ACTION && input.runStepId === null) {
    // Standalone job: no run, step or task to cancel. The job is already
    // canceled; give the funding reservation back and announce the change.
    await releaseCoordinatorJobReservation(transaction, {
      organizationId: input.organizationId,
      jobId: input.jobId,
    });
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      eventType: "job.updated",
      aggregateId: input.jobId,
      aggregateVersion: input.jobVersion,
      payload: {
        jobId: input.jobId,
        attemptId: input.attemptId,
        version: input.jobVersion,
      },
      traceId: input.traceId,
    });
    return;
  }
  if (input.action === "repository.inspect" && input.runStepId === null) {
    const inspection = await transaction.query<{
      applicationId: string;
      repositoryId: string;
    }>(
      `select job.application_id as "applicationId",
              job.repository_id as "repositoryId"
         from bakery.jobs job
         join bakery.repository_onboardings onboarding
           on onboarding.organization_id = job.organization_id
          and onboarding.application_id = job.application_id
          and onboarding.repository_id = job.repository_id
          and onboarding.job_id = job.id
          and onboarding.input = job.input
        where job.organization_id = $1 and job.id = $2`,
      [input.organizationId, input.jobId],
    );
    const scope = inspection.rows[0];
    if (!scope) throw new StandardError({ code: "STATE_CONFLICT" });
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      applicationId: scope.applicationId,
      repositoryId: scope.repositoryId,
      eventType: "job.updated",
      aggregateId: input.jobId,
      aggregateVersion: input.jobVersion,
      payload: {
        jobId: input.jobId,
        attemptId: input.attemptId,
        version: input.jobVersion,
      },
      traceId: input.traceId,
    });
    return;
  }
  const lifecycleResult = await transaction.query<CancellationLifecycleRow>(
    `select step.run_id as "runId",
            step.id as "runStepId",
            run.task_id as "taskId",
            run.version as "runVersion",
            task.version as "taskVersion",
            task.application_id as "applicationId",
            task.repository_id as "repositoryId",
            task.conversation_id as "conversationId"
       from bakery.jobs as job
       join bakery.run_steps as step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs as run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
      where job.organization_id = $1
        and job.id = $2
      for update of step, run, task`,
    [input.organizationId, input.jobId],
  );
  const lifecycle = lifecycleResult.rows[0];
  if (!lifecycle) throw new StandardError({ code: "STATE_CONFLICT" });
  await cancelRunLifecycle(transaction, {
    organizationId: input.organizationId,
    lifecycle,
    traceId: input.traceId,
    emitJobEvents: async () => {
      await emitCanceledJobEvents(transaction, {
        organizationId: input.organizationId,
        lifecycle,
        jobId: input.jobId,
        attemptId: input.attemptId,
        jobVersion: input.jobVersion,
        traceId: input.traceId,
      });
    },
  });
}

/**
 * The job events of a canceled job. Their payloads require an attempt id, so a
 * job that never had an attempt emits none (the run events still follow).
 */
async function emitCanceledJobEvents(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    lifecycle: CancellationLifecycleRow;
    jobId: string;
    attemptId: string | null;
    jobVersion: number;
    traceId: string;
  },
): Promise<void> {
  const { lifecycle } = input;
  if (input.attemptId === null) return;
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: lifecycle.applicationId,
    repositoryId: lifecycle.repositoryId,
    taskId: lifecycle.taskId,
    conversationId: lifecycle.conversationId,
    eventType: "job.updated",
    aggregateId: input.jobId,
    aggregateVersion: input.jobVersion,
    payload: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      version: input.jobVersion,
    },
    traceId: input.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: lifecycle.applicationId,
    repositoryId: lifecycle.repositoryId,
    taskId: lifecycle.taskId,
    conversationId: lifecycle.conversationId,
    eventType: "job.completed",
    aggregateId: input.jobId,
    aggregateVersion: input.jobVersion,
    payload: {
      runId: lifecycle.runId,
      stepId: lifecycle.runStepId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      status: "canceled",
    },
    traceId: input.traceId,
    outboxDeliveryKey:
      `job:${input.jobId}:attempt:${input.attemptId}:completed`,
  });
}

/**
 * Moves the locked step, run and task to `canceled`, emits the job events the
 * caller supplies, then the run and task events, and reconciles coordination.
 * Both the worker-command cancel and the waiting-run cancel finish here.
 */
async function cancelRunLifecycle(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    lifecycle: CancellationLifecycleRow;
    traceId: string;
    emitJobEvents: () => Promise<void>;
  },
): Promise<void> {
  const { lifecycle } = input;
  if (lifecycle.runStepId !== null) {
    await transaction.query<{ version: number }>(
      `update bakery.run_steps
          set status = 'canceled',
              output = null,
              error = null,
              started_at = coalesce(started_at, current_timestamp),
              finished_at = current_timestamp,
              updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1
          and id = $2
          and status not in ('completed', 'failed', 'canceled', 'blocked')
        returning version`,
      [input.organizationId, lifecycle.runStepId],
    );
  }

  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'canceled',
            finished_at = current_timestamp,
            updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1
        and id = $2
        and status not in ('completed', 'failed', 'canceled', 'blocked')
      returning version`,
    [input.organizationId, lifecycle.runId],
  );
  const runVersion = runUpdate.rows[0]?.version ?? lifecycle.runVersion;

  const taskUpdate = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = 'canceled',
            updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1
        and id = $2
        and current_run_id = $3
        and status not in ('completed', 'failed', 'canceled', 'blocked')
      returning version`,
    [input.organizationId, lifecycle.taskId, lifecycle.runId],
  );
  const taskVersion = taskUpdate.rows[0]?.version ?? lifecycle.taskVersion;

  await input.emitJobEvents();
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: lifecycle.applicationId,
    repositoryId: lifecycle.repositoryId,
    taskId: lifecycle.taskId,
    conversationId: lifecycle.conversationId,
    eventType: "run.updated",
    aggregateId: lifecycle.runId,
    aggregateVersion: runVersion,
    payload: { runId: lifecycle.runId, version: runVersion },
    traceId: input.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: lifecycle.applicationId,
    repositoryId: lifecycle.repositoryId,
    taskId: lifecycle.taskId,
    conversationId: lifecycle.conversationId,
    eventType: "tasks.updated",
    aggregateId: lifecycle.taskId,
    aggregateVersion: taskVersion,
    payload: {
      resourceId: lifecycle.taskId,
      resourceVersion: taskVersion,
    },
    traceId: input.traceId,
  });
  await reconcileCoordinationForTerminalTask(transaction, {
    organizationId: input.organizationId,
    taskId: lifecycle.taskId,
    traceId: input.traceId,
  });
}

const LIVE_ATTEMPT_STATUSES_SQL = "('leased', 'running', 'canceling')";

/**
 * Cancels a run that has no live attempt: every unfinished job is `queued`
 * (waiting for a retry or never claimed) or the run is still waiting for
 * engine admission. No worker holds authority, so the server cancels directly
 * and no worker command is written.
 *
 * Throws STATE_CONFLICT when a claim won the race (a live attempt exists) or
 * a job is leased, running or awaiting reconciliation without a live lease:
 * those wait for lease reclaim or reconciliation, and the client retries into
 * the worker path.
 */
export async function cancelRunWithoutAttempt(
  transaction: PgTransactionClient,
  input: { organizationId: string; runId: string; traceId: string },
): Promise<void> {
  // Job rows first, like the result and claim paths, then step, run and task.
  const unfinishedJobs = () =>
    transaction.query<{ id: string; status: string; hasLive: boolean }>(
      `select job.id, job.status,
              exists (
                select 1 from bakery.job_attempts attempt
                 where attempt.organization_id = job.organization_id
                   and attempt.job_id = job.id
                   and attempt.status in ${LIVE_ATTEMPT_STATUSES_SQL}
              ) as "hasLive"
         from bakery.jobs job
         join bakery.run_steps step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
        where job.organization_id = $1 and step.run_id = $2
          and job.status not in ('completed', 'failed', 'canceled')
        order by step.position asc, step.iteration asc, job.id asc
        for update of job`,
      [input.organizationId, input.runId],
    );
  const jobs = (await unfinishedJobs()).rows;
  if (jobs.some((job) => job.status !== "queued" || job.hasLive)) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const lifecycleResult = await transaction.query<CancellationLifecycleRow>(
    `select run.id as "runId",
            step.id as "runStepId",
            run.task_id as "taskId",
            run.version as "runVersion",
            task.version as "taskVersion",
            task.application_id as "applicationId",
            task.repository_id as "repositoryId",
            task.conversation_id as "conversationId"
       from bakery.workflow_runs as run
       join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
       left join lateral (
         select candidate.id
           from bakery.run_steps as candidate
          where candidate.organization_id = run.organization_id
            and candidate.run_id = run.id
            and candidate.status not in
              ('completed', 'failed', 'canceled', 'blocked')
          order by candidate.position asc, candidate.iteration asc
          limit 1
       ) as step on true
      where run.organization_id = $1 and run.id = $2
      for update of run, task`,
    [input.organizationId, input.runId],
  );
  const lifecycle = lifecycleResult.rows[0];
  if (!lifecycle) throw new StandardError({ code: "STATE_CONFLICT" });
  if (lifecycle.runStepId !== null) {
    await transaction.query(
      `select 1 from bakery.run_steps
        where organization_id = $1 and id = $2 for update`,
      [input.organizationId, lifecycle.runStepId],
    );
  }
  if (jobs.length === 0) {
    // Engine admission may have inserted a job before the step lock.
    if ((await unfinishedJobs()).rows.length > 0) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
  }
  const canceledJobs: Array<{ id: string; version: number }> = [];
  for (const job of jobs) {
    const canceled = await transaction.query<{ version: number }>(
      `update bakery.jobs
          set status = 'canceled',
              cancel_requested_at = coalesce(
                cancel_requested_at, current_timestamp
              ),
              current_fence = current_fence + 1,
              updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1 and id = $2 and status = 'queued'
        returning version`,
      [input.organizationId, job.id],
    );
    const version = canceled.rows[0]?.version;
    if (version === undefined) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    canceledJobs.push({ id: job.id, version });
  }
  await cancelRunLifecycle(transaction, {
    organizationId: input.organizationId,
    lifecycle,
    traceId: input.traceId,
    emitJobEvents: async () => {
      for (const job of canceledJobs) {
        const last = await transaction.query<{ id: string }>(
          `select id from bakery.job_attempts
            where organization_id = $1 and job_id = $2
            order by attempt_no desc limit 1`,
          [input.organizationId, job.id],
        );
        await emitCanceledJobEvents(transaction, {
          organizationId: input.organizationId,
          lifecycle,
          jobId: job.id,
          attemptId: last.rows[0]?.id ?? null,
          jobVersion: job.version,
          traceId: input.traceId,
        });
      }
    },
  });
}

const SQL_BIGINT_MAX = 9_223_372_036_854_775_807n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertCanonicalSqlBigInt(value: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  try {
    if (BigInt(value) > SQL_BIGINT_MAX) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
  } catch (cause) {
    if (cause instanceof StandardError) throw cause;
    throw new StandardError({ code: "MALFORMED_REQUEST", cause });
  }
}

export async function resolveCanceledAttemptCleanup(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    workerHostId: string;
    attemptId: string;
    fence: string;
    attestingWorkerSessionId: string;
    attestingWorkerSessionGeneration: string;
    observerWorkerSessionId: string;
    observerWorkerSessionGeneration: string;
    exitedAt: string;
  },
): Promise<{ attemptId: string; status: "canceled"; cancellation: unknown }> {
  assertCanonicalSqlBigInt(input.fence);
  assertCanonicalSqlBigInt(input.attestingWorkerSessionGeneration);
  assertCanonicalSqlBigInt(input.observerWorkerSessionGeneration);
  if (
    !UUID_PATTERN.test(input.attestingWorkerSessionId) ||
    !UUID_PATTERN.test(input.observerWorkerSessionId)
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  if (!Number.isFinite(Date.parse(input.exitedAt))) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }

  const host = await transaction.query<{
    id: string;
    workerSessionId: string | null;
    workerSessionGeneration: string | number;
  }>(
    `select host.id,
            host.worker_session_id as "workerSessionId",
            host.worker_session_generation as "workerSessionGeneration"
       from bakery.job_attempts as attempt
       join bakery.worker_hosts as host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where attempt.organization_id = $1
        and attempt.id = $2
        and host.id = $3
      for update of host`,
    [input.organizationId, input.attemptId, input.workerHostId],
  );
  const hostRow = host.rows[0];
  if (!hostRow) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (
    hostRow.workerSessionId !== input.attestingWorkerSessionId ||
    String(hostRow.workerSessionGeneration) !==
      input.attestingWorkerSessionGeneration
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }

  const current = await transaction.query<{
    status: string;
    result: unknown;
    fence: string | number;
    workerSessionId: string | null;
    workerSessionGeneration: string | number | null;
    currentFence: string | number;
  }>(
    `select attempt.status,
            attempt.result,
            attempt.fence,
            job.current_fence as "currentFence",
            attempt.worker_session_id as "workerSessionId",
            attempt.worker_session_generation as "workerSessionGeneration"
       from bakery.job_attempts as attempt
       join bakery.jobs as job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.worker_hosts as host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where attempt.organization_id = $1
        and attempt.id = $2
        and host.id = $3
      for update of attempt, job`,
    [input.organizationId, input.attemptId, hostRow.id],
  );
  const row = current.rows[0];
  if (
    !row ||
    row.status !== "canceled" ||
    String(row.fence) !== input.fence ||
    String(row.currentFence) !== input.fence
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }

  let existingCancellation: Record<string, unknown> = {};
  if (
    row.result && typeof row.result === "object" &&
    !Array.isArray(row.result)
  ) {
    const cancellation = (row.result as Record<string, unknown>).cancellation;
    if (
      cancellation && typeof cancellation === "object" &&
      !Array.isArray(cancellation)
    ) {
      existingCancellation = cancellation as Record<string, unknown>;
    }
  }
  // Return the server-persisted observer on replay, even after session
  // rotation; never replace it with a caller-supplied observer.
  if (
    existingCancellation.processExited === true &&
    existingCancellation.cleanupStatus === "complete" &&
    existingCancellation.terminationStatus === "confirmed" &&
    existingCancellation.exitedAt === input.exitedAt
  ) {
    return {
      attemptId: input.attemptId,
      status: "canceled",
      cancellation: existingCancellation,
    };
  }
  // Bind the claimed observer to the execution session recorded on this
  // attempt. The database cannot independently verify process exit; this
  // still trusts the authenticated worker to attest honestly.
  if (
    row.workerSessionId === null ||
    row.workerSessionGeneration === null ||
    row.workerSessionId !== input.observerWorkerSessionId ||
    String(row.workerSessionGeneration) !==
      input.observerWorkerSessionGeneration
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const cancellation = {
    ...existingCancellation,
    processExited: true,
    exitedAt: input.exitedAt,
    cleanupStatus: "complete",
    terminationStatus: "confirmed",
    cleanupObserver: {
      observedBy: {
        workerSessionId: input.observerWorkerSessionId,
        workerSessionGeneration: input.observerWorkerSessionGeneration,
      },
      attestedBy: {
        workerSessionId: input.attestingWorkerSessionId,
        workerSessionGeneration: input.attestingWorkerSessionGeneration,
      },
    },
  };
  const updated = await transaction.query<{ result: unknown }>(
    `update bakery.job_attempts
        set result = jsonb_set(
          jsonb_set(coalesce(result, '{}'::jsonb),
            '{status}', '"canceled"'::jsonb, true),
            '{cancellation}', $4::jsonb, true),
            updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1
        and id = $2
        and status = 'canceled'
        and fence = $3
      returning result`,
    [
      input.organizationId,
      input.attemptId,
      input.fence,
      JSON.stringify(cancellation),
    ],
  );
  const result = updated.rows[0]?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const resolvedCancellation = (result as Record<string, unknown>)
    .cancellation;
  if (
    !resolvedCancellation || typeof resolvedCancellation !== "object" ||
    Array.isArray(resolvedCancellation)
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return {
    attemptId: input.attemptId,
    status: "canceled",
    cancellation: resolvedCancellation,
  };
}

export async function enqueueWorkerControlCommand(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    attemptId: string;
    action: WorkerControlAction;
    reason?: string;
    /** Binds the command to one conversation message: one delivery per attempt. */
    messageId?: string;
    body?: string;
    idempotencyKey: string;
    requestDigest: string;
    traceId: string;
  },
): Promise<StoredControlCommand> {
  await transaction.query(
    `select pg_advisory_xact_lock(
       hashtextextended($1::text, 0)
     )`,
    [
      `worker-control:${input.organizationId}:${input.attemptId}:${input.idempotencyKey}`,
    ],
  );
  const replay = await transaction.query<StoredControlReplay>(
    `select id,
            command_type as "commandType",
            payload,
            message_id as "messageId",
            request_digest as "requestDigest"
       from bakery.worker_commands
      where organization_id = $1
        and attempt_id = $2
        and idempotency_key = $3`,
    [input.organizationId, input.attemptId, input.idempotencyKey],
  );
  const replayed = replay.rows[0];
  if (replayed) {
    if (replayed.requestDigest !== input.requestDigest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return replayed;
  }

  if (input.messageId !== undefined) {
    const bound = await transaction.query<StoredControlReplay>(
      `select id,
              command_type as "commandType",
              payload,
              message_id as "messageId",
              request_digest as "requestDigest"
         from bakery.worker_commands
        where organization_id = $1 and attempt_id = $2 and message_id = $3`,
      [input.organizationId, input.attemptId, input.messageId],
    );
    // A message is delivered at most once per attempt, whatever the key.
    if (bound.rows[0]) return bound.rows[0];
  }

  // Worker transactions lock the host before the attempt and job. Keep the
  // control producer in that order so cancellation cannot deadlock heartbeat
  // or terminal-result reconciliation.
  const hostResult = await transaction.query<WorkerHostRow>(
    `select host.id,
            host.worker_session_id as "workerSessionId",
            host.worker_session_generation as "workerSessionGeneration"
       from bakery.job_attempts as attempt
       join bakery.worker_hosts as host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where attempt.organization_id = $1
        and attempt.id = $2
      for update of host`,
    [input.organizationId, input.attemptId],
  );
  const host = hostResult.rows[0];
  if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const attemptResult = await transaction.query<{
    id: string;
    jobId: string;
    status: string;
    fence: string | number;
    workerHostId: string;
    workerSessionId: string | null;
    workerSessionGeneration: string | number;
    leaseLive: boolean;
    sessionCurrent: boolean;
  }>(
    `select attempt.id,
            attempt.job_id as "jobId",
            attempt.status,
            attempt.fence,
            attempt.worker_host_id as "workerHostId",
            attempt.worker_session_id as "workerSessionId",
            attempt.worker_session_generation as "workerSessionGeneration",
            attempt.lease_expires_at > clock_timestamp() as "leaseLive",
            (
              attempt.worker_session_id = $3
              and attempt.worker_session_generation = $4
            ) is true as "sessionCurrent"
       from bakery.job_attempts as attempt
      where attempt.organization_id = $1
        and attempt.id = $2
        and attempt.worker_host_id = $5
      for update`,
    [
      input.organizationId,
      input.attemptId,
      host.workerSessionId,
      host.workerSessionGeneration,
      host.id,
    ],
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const jobResult = await transaction.query<{
    status: string;
    currentFence: string | number;
    action: string;
    runStepId: string | null;
  }>(
    `select status, current_fence as "currentFence",
            action, run_step_id as "runStepId"
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [input.organizationId, attempt.jobId],
  );
  const job = jobResult.rows[0];
  if (!job) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const current: CurrentAttemptRow = {
    ...attempt,
    jobStatus: job.status,
    currentFence: job.currentFence,
  };
  const workerScopeResume = input.action === "resume" &&
    host.workerSessionId !== null;
  if (
    ["completed", "failed", "canceled"].includes(current.jobStatus) &&
    !workerScopeResume
  ) {
    throw new StandardError({ code: "ALREADY_TERMINAL" });
  }
  if (input.action !== "resume" && current.workerSessionId === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const currentFence = BigInt(current.fence) === BigInt(current.currentFence);
  const liveAuthority = activeAttempt(current.status) &&
    current.leaseLive &&
    current.sessionCurrent &&
    currentFence;
  if (input.action === "cancel") {
    if (!liveAuthority) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const canceled = await transaction.query<{ id: string; version: number }>(
      `update bakery.jobs
          set cancel_requested_at = coalesce(cancel_requested_at, current_timestamp),
              status = 'canceled',
              updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1
          and id = $2
          and status not in ('completed', 'failed', 'canceled')
          and current_fence = $3
       returning id, version`,
      [input.organizationId, current.jobId, current.fence],
    );
    const cancellation = canceled.rows[0];
    if (!cancellation) {
      throw new StandardError({ code: "ALREADY_TERMINAL" });
    }
    const canceledAttempt = await transaction.query(
      `update bakery.job_attempts
          set status = 'canceled',
              result = $4::jsonb,
              ended_at = current_timestamp,
              updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1
          and id = $2
          and status in ('leased', 'running', 'canceling')
          and fence = $3
       returning id`,
      [
        input.organizationId,
        current.id,
        current.fence,
        JSON.stringify({
          status: "canceled",
          cancellation: {
            processExited: false,
            exitedAt: null,
            cleanupStatus: "pending",
            terminationStatus: "pending",
          },
        }),
      ],
    );
    if (!canceledAttempt.rows[0]) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    await finalizeCanceledLifecycle(transaction, {
      organizationId: input.organizationId,
      jobId: current.jobId,
      attemptId: current.id,
      jobVersion: cancellation.version,
      action: job.action,
      runStepId: job.runStepId,
      traceId: input.traceId,
    });
  } else if (!liveAuthority && !workerScopeResume) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const payload = controlPayload(input, current, host);
  const result = await transaction.query<StoredControlCommand>(
    `insert into bakery.worker_commands (
       organization_id,
       attempt_id,
       message_id,
       idempotency_key,
       request_digest,
       command_type,
       payload
     ) values ($1, $2, $7, $3, $4, $5, $6::jsonb)
     returning id,
               command_type as "commandType",
               payload,
               message_id as "messageId",
               request_digest as "requestDigest"`,
    [
      input.organizationId,
      input.attemptId,
      input.idempotencyKey,
      input.requestDigest,
      workerCommandType[input.action],
      payload,
      input.messageId ?? null,
    ],
  );
  const command = result.rows[0];
  if (!command) throw new Error("WORKER_CONTROL_COMMAND_NOT_CREATED");
  return command;
}

const executionCoordinatorDatabaseEnvironmentNames = [
  "BAKERY_APP_DATABASE_URL",
] as const;

function waitForCoordinatorPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timeout = setTimeout(finish, COORDINATOR_POLL_MILLISECONDS);
  signal.addEventListener("abort", finish, { once: true });
  function finish() {
    clearTimeout(timeout);
    signal.removeEventListener("abort", finish);
    resolve();
  }
  return promise;
}

function isTransientCoordinatorError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "40P01" || error.code === "40001";
}

function waitForCoordinatorRetry(
  signal: AbortSignal | undefined,
  milliseconds: number,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let finished = false;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    resolve(completed);
  };
  const onAbort = () => finish(false);
  const timeout = setTimeout(() => finish(true), milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export async function withCoordinatorRetry(
  work: () => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0;; attempt++) {
    if (signal?.aborted) return false;
    try {
      await work();
      return true;
    } catch (error) {
      if (!isTransientCoordinatorError(error)) throw error;
      const delay = COORDINATOR_TRANSIENT_RETRY_DELAYS_MILLISECONDS[attempt];
      if (delay === undefined) return false;
      if (!await waitForCoordinatorRetry(signal, delay)) return false;
    }
  }
}

// Heartbeat and retention both acquire worker_commands before touching
// worker_command_ack_tombstones. Retention must skip a command already held by
// a heartbeat, then collect tombstones only after command compaction.
export async function sweepExecutionRetention(
  transaction: PgTransactionClient,
): Promise<void> {
  return await persistSweepExecutionRetention(transaction);
}

export async function runExecutionCoordinatorTask(): Promise<void> {
  const databaseConfig: DatabaseConfig = readDatabaseConfig(
    readEnvironmentSnapshot(executionCoordinatorDatabaseEnvironmentNames),
    "application",
  );
  const database = openPgDatabase(databaseConfig.url);
  const controller = new AbortController();
  const stop = () => controller.abort();
  deno.addSignalListener("SIGINT", stop);
  deno.addSignalListener("SIGTERM", stop);
  try {
    await assertApplicationDatabase(database);
    while (!controller.signal.aborted) {
      const completed = await withCoordinatorRetry(
        () =>
          withPgTransaction(
            database,
            async (transaction) => {
              await reclaimExpiredAttempts(transaction);
              await reconcileFailedLifecycleTasks(transaction);
              await sweepExecutionRetention(transaction);
            },
            controller.signal,
          ),
        controller.signal,
      );
      if (!completed && !controller.signal.aborted) {
        console.error(
          "execution coordinator transaction retries exhausted; continuing",
        );
      }
      await waitForCoordinatorPoll(controller.signal);
    }
  } finally {
    deno.removeSignalListener("SIGINT", stop);
    deno.removeSignalListener("SIGTERM", stop);
    await closePgDatabase(database);
  }
}
export { activeAttempt };
