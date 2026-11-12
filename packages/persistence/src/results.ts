import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";
import { appendAudit, appendDomainEvent } from "./event-audit.ts";
import { appendAttemptEvent } from "./event-journal.ts";
import type { AttemptRow, RequestMetadata } from "./types.ts";
import { IDEMPOTENCY_REPLAY_TTL_SECONDS } from "./constants.ts";

export type LeaseRenewalReplay = {
  requestDigest: string;
  response: unknown;
};

export type RenewedLease = {
  leaseExpiresAt: Date;
  serverTime: Date;
};

export type FinalizedRunStep = {
  organizationId: string;
  runId: string;
  runStepId: string;
  taskId: string;
  jobId: string;
  jobVersion: number;
  attemptId: string;
  stepVersion: number;
  runVersion: number;
  runStatus: string;
  stepStatus: "completed" | "failed" | "canceled";
  applicationId: string;
  repositoryId: string | null;
  conversationId: string;
};

export type ResultJob = {
  action: string;
  runId: string | null;
  runStepId: string | null;
  cancelRequestedAt: Date | string | null;
  currentFence: string | number;
  installationReservationId: string | null;
  status: string;
};

export type ResultsRepository = {
  loadRenewalReplay(options: {
    organizationId: string;
    attemptId: string;
    workerHostId: string;
    idempotencyKey: string;
  }): Promise<LeaseRenewalReplay | undefined>;
  lockRenewal(options: {
    organizationId: string;
    attemptId: string;
    workerHostId: string;
    idempotencyKey: string;
  }): Promise<void>;
  renewLease(options: {
    organizationId: string;
    attemptId: string;
    workerHostId: string;
    leaseTokenHash: string;
    fence: string;
    leaseSeconds: number;
  }): Promise<RenewedLease | undefined>;
  saveRenewalReplay(options: {
    organizationId: string;
    attemptId: string;
    workerHostId: string;
    idempotencyKey: string;
    requestDigest: string;
    response: unknown;
  }): Promise<void>;
  loadResultJob(
    organizationId: string,
    jobId: string,
  ): Promise<ResultJob | undefined>;
  appendResultEvent(options: {
    organizationId: string;
    attemptId: string;
    localSeq: string;
    eventId: string;
    eventType: string;
    payload: unknown;
    payloadDigest: string;
    savedAck: unknown;
  }): Promise<void>;
  finishAttempt(options: {
    organizationId: string;
    attemptId: string;
    workerHostId: string;
    leaseTokenHash: string;
    fence: string;
    localSeq: string;
    payload: unknown;
    status: "completed" | "failed" | "canceled";
  }): Promise<boolean>;
  finishJob(options: {
    organizationId: string;
    jobId: string;
    fence: string;
    status: "completed" | "failed" | "canceled";
  }): Promise<boolean>;
  finalizeRunStep(options: {
    attempt: AttemptRow;
    status: "completed" | "failed" | "canceled";
    input: Record<string, unknown>;
    principalId: string;
    metadata: RequestMetadata;
  }): Promise<FinalizedRunStep>;
};

export function createResultsRepository(
  transaction: PgTransactionClient,
): ResultsRepository {
  return {
    async lockRenewal(options) {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-lease-renewal:${options.organizationId}:${options.attemptId}:${options.workerHostId}:${options.idempotencyKey}`],
      );
      await transaction.query(
        `delete from bakery.worker_lease_renewal_replays
         where organization_id = $1 and attempt_id = $2
           and worker_host_id = $3 and idempotency_key = $4
           and expires_at <= clock_timestamp()`,
        [
          options.organizationId,
          options.attemptId,
          options.workerHostId,
          options.idempotencyKey,
        ],
      );
    },
    async loadRenewalReplay(options) {
      const replay = await transaction.query<{
        request_digest: string;
        response: unknown;
      }>(
        `select request_digest, response
         from bakery.worker_lease_renewal_replays
         where organization_id = $1 and attempt_id = $2
           and worker_host_id = $3 and idempotency_key = $4
         and expires_at > clock_timestamp()`,
        [
          options.organizationId,
          options.attemptId,
          options.workerHostId,
          options.idempotencyKey,
        ],
      );
      const row = replay.rows[0];
      return row
        ? { requestDigest: row.request_digest, response: row.response }
        : undefined;
    },
    async renewLease(options) {
      const renewed = await transaction.query<{
        lease_expires_at: Date;
        server_time: Date;
      }>(
        `update bakery.job_attempts
         set lease_expires_at = clock_timestamp() + ($2::integer * interval '1 second'),
             updated_at = current_timestamp, version = version + 1
         where organization_id = $1 and id = $3
           and worker_host_id = $4 and lease_token_hash = $5
           and fence = $6 and status in ('leased', 'running', 'canceling')
           and lease_expires_at > clock_timestamp()
           and exists (
             select 1 from bakery.jobs job
             where job.organization_id = bakery.job_attempts.organization_id
               and job.id = bakery.job_attempts.job_id
               and job.current_fence = bakery.job_attempts.fence
           )
         returning lease_expires_at, clock_timestamp() as server_time`,
        [
          options.organizationId,
          options.leaseSeconds,
          options.attemptId,
          options.workerHostId,
          options.leaseTokenHash,
          options.fence,
        ],
      );
      const row = renewed.rows[0];
      return row
        ? { leaseExpiresAt: row.lease_expires_at, serverTime: row.server_time }
        : undefined;
    },
    async saveRenewalReplay(options) {
      await transaction.query(
        `insert into bakery.worker_lease_renewal_replays (
           organization_id, attempt_id, worker_host_id, idempotency_key,
           request_digest, response, expires_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb,
           clock_timestamp() + ($7::integer * interval '1 second'))`,
        [
          options.organizationId,
          options.attemptId,
          options.workerHostId,
          options.idempotencyKey,
          options.requestDigest,
          JSON.stringify(options.response),
          IDEMPOTENCY_REPLAY_TTL_SECONDS,
        ],
      );
    },
    async loadResultJob(organizationId, jobId) {
      const result = await transaction.query<ResultJob>(
        `select job.action, run.id as "runId",
                job.run_step_id as "runStepId",
                job.cancel_requested_at as "cancelRequestedAt",
                job.current_fence as "currentFence",
                job.installation_reservation_id as "installationReservationId",
                job.status
           from bakery.jobs job
           left join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           left join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
          where job.organization_id = $1 and job.id = $2
          for update of job`,
        [organizationId, jobId],
      );
      return result.rows[0];
    },
    async appendResultEvent(options) {
      await appendAttemptEvent(transaction, options);
    },
    async finishAttempt(options) {
      const result = await transaction.query<{ id: string }>(
        `update bakery.job_attempts
         set status = $2, last_event_seq = $3, result = $4::jsonb,
             ended_at = current_timestamp, updated_at = current_timestamp,
             version = version + 1
         where organization_id = $1 and id = $5
           and worker_host_id = $6 and lease_token_hash = $7
           and fence = $8 and status in ('leased', 'running', 'canceling')
           and lease_expires_at > clock_timestamp()
           and exists (
             select 1 from bakery.jobs job
             where job.organization_id = bakery.job_attempts.organization_id
               and job.id = bakery.job_attempts.job_id
               and job.current_fence = bakery.job_attempts.fence
           )
         returning id`,
        [
          options.organizationId,
          options.status,
          options.localSeq,
          JSON.stringify(options.payload),
          options.attemptId,
          options.workerHostId,
          options.leaseTokenHash,
          options.fence,
        ],
      );
      return result.rows.length === 1;
    },
    async finishJob(options) {
      const result = await transaction.query<{ id: string }>(
        `update bakery.jobs
         set status = $3, updated_at = current_timestamp, version = version + 1
         where organization_id = $1 and id = $2
           and current_fence = $4
           and status in ('leased', 'running', 'awaiting_reconciliation', 'canceling')
         returning id`,
        [options.organizationId, options.jobId, options.status, options.fence],
      );
      return result.rows.length === 1;
    },
    async finalizeRunStep(options) {
      return await finalizeRunStep(transaction, options);
    },
  };
}

/**
 * Whether a run was admitted to execute a compiled plan, which is when its
 * snapshot carries a `runtime` section (the frozen document and its pin). The
 * server's `planRuntimeFromSnapshot` makes the same own-key test and is the one
 * that validates the section; this only needs to know whose job it is to end
 * the run.
 */
export function carriesPlanRuntime(snapshot: unknown): boolean {
  return typeof snapshot === "object" && snapshot !== null &&
    !Array.isArray(snapshot) && Object.hasOwn(snapshot, "runtime");
}

async function finalizeRunStep(
  transaction: PgTransactionClient,
  options: {
    attempt: AttemptRow;
    status: "completed" | "failed" | "canceled";
    input: Record<string, unknown>;
    principalId: string;
    metadata: RequestMetadata;
  },
): Promise<FinalizedRunStep> {
  const { attempt, status, input, principalId, metadata } = options;
  const job = await transaction.query<{
    organization_id: string;
    id: string;
    version: number;
    run_step_id: string;
    run_id: string;
    run_status: string;
    run_version: number;
    run_snapshot: unknown;
    task_id: string;
    application_id: string;
    repository_id: string | null;
    conversation_id: string;
  }>(
    `select job.organization_id, job.id, job.version, job.run_step_id,
        run.id as run_id, run.status as run_status, run.version as run_version,
        run.snapshot as run_snapshot, run.task_id, task.application_id, task.repository_id, task.conversation_id
     from bakery.jobs job
     join bakery.run_steps step
       on step.organization_id = job.organization_id and step.id = job.run_step_id
     join bakery.workflow_runs run
       on run.organization_id = step.organization_id and run.id = step.run_id
     join bakery.tasks task
       on task.organization_id = run.organization_id and task.id = run.task_id
     where job.organization_id = $1 and job.id = $2
     for update of job, step, run`,
    [attempt.organizationId, attempt.jobId],
  );
  const jobRow = job.rows[0];
  if (!jobRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const stepStatus = status === "completed" ? "completed" : status;
  const output = status === "completed" ? input.result ?? null : null;
  const error = status === "failed" ? input.fault ?? null : null;
  const stepUpdate = await transaction.query<{ version: number }>(
    `update bakery.run_steps
     set status = $3, output = $4::jsonb, error = $5::jsonb,
         started_at = coalesce(started_at, current_timestamp),
         finished_at = current_timestamp, updated_at = current_timestamp,
         version = version + 1
     where organization_id = $1 and id = $2
       and status in ('pending', 'running', 'waiting')
     returning version`,
    [
      attempt.organizationId,
      jobRow.run_step_id,
      stepStatus,
      JSON.stringify(output),
      JSON.stringify(error),
    ],
  );
  const stepVersion = stepUpdate.rows[0]?.version;
  if (stepVersion === undefined) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const runState = await transaction.query<{
    status: string;
    version: number;
    statuses: string[];
  }>(
    `select run.status, run.version, array_agg(step.status)::text[] as statuses
     from bakery.workflow_runs run
     join bakery.run_steps step
       on step.organization_id = run.organization_id and step.run_id = run.id
     where run.organization_id = $1 and run.id = $2
     group by run.id, run.status, run.version`,
    [attempt.organizationId, jobRow.run_id],
  );
  const currentRun = runState.rows[0];
  if (!currentRun) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const statuses = currentRun.statuses ?? [];
  const advanced = currentRun.status === "queued"
    ? "running"
    : currentRun.status;
  // A compiled-plan run creates its rows on demand and treats a failed repeat
  // iteration as an outcome, so its rows cannot say when the run is finished:
  // the engine asks the interpreter and projects the end itself. Here such a
  // run only leaves `queued`.
  const nextRunStatus = carriesPlanRuntime(jobRow.run_snapshot)
    ? advanced
    : statuses.includes("failed")
    ? "failed"
    : statuses.includes("canceled")
    ? "canceled"
    : statuses.every((value) => value === "completed" || value === "skipped")
    ? "completed"
    : advanced;
  const terminal = (value: string) =>
    ["completed", "failed", "canceled", "blocked"].includes(value);
  if (terminal(currentRun.status) && nextRunStatus !== currentRun.status) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  let runVersion = currentRun.version;
  if (nextRunStatus !== currentRun.status) {
    const runUpdate = await transaction.query<{ version: number }>(
      `update bakery.workflow_runs
       set status = $3,
           started_at = coalesce(started_at, current_timestamp),
           finished_at = case when $3 in ('completed', 'failed', 'canceled')
             then current_timestamp else finished_at end,
           updated_at = current_timestamp, version = version + 1
       where organization_id = $1 and id = $2
         and status not in ('completed', 'failed', 'canceled', 'blocked')
       returning version`,
      [attempt.organizationId, jobRow.run_id, nextRunStatus],
    );
    runVersion = runUpdate.rows[0]?.version ?? runVersion;
    if (runUpdate.rows.length !== 1) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    if (terminal(nextRunStatus)) {
      await transaction.query(
        `update bakery.tasks
         set status = $3, updated_at = current_timestamp, version = version + 1
         where organization_id = $1 and id = $2
           and status not in ('completed', 'failed', 'canceled')`,
        [attempt.organizationId, jobRow.task_id, nextRunStatus],
      );
    }
  }
  await appendDomainEvent(transaction, {
    organizationId: attempt.organizationId,
    eventType: "job.completed",
    aggregateId: jobRow.id,
    aggregateVersion: jobRow.version,
    applicationId: jobRow.application_id,
    repositoryId: jobRow.repository_id,
    taskId: jobRow.task_id,
    conversationId: jobRow.conversation_id,
    payload: {
      runId: jobRow.run_id,
      stepId: jobRow.run_step_id,
      jobId: jobRow.id,
      attemptId: attempt.id,
      status,
    },
    traceId: metadata.traceId,
    outboxDeliveryKey: `job:${jobRow.id}:attempt:${attempt.id}:completed`,
  });
  if (runVersion !== currentRun.version) {
    await appendDomainEvent(transaction, {
      organizationId: attempt.organizationId,
      eventType: "run.updated",
      aggregateId: jobRow.run_id,
      aggregateVersion: runVersion,
      applicationId: jobRow.application_id,
      repositoryId: jobRow.repository_id,
      taskId: jobRow.task_id,
      conversationId: jobRow.conversation_id,
      payload: { runId: jobRow.run_id, version: runVersion },
      traceId: metadata.traceId,
    });
  }
  await appendAudit(transaction, {
    organizationId: attempt.organizationId,
    principalId,
    operation: "workers.result",
    resourceType: "job_attempt",
    resourceId: attempt.id,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: {
      jobId: attempt.jobId,
      runId: jobRow.run_id,
      stepId: jobRow.run_step_id,
      status,
      localSeq: input.localSeq,
      fence: String(input.fence),
    },
  });
  return {
    organizationId: attempt.organizationId,
    runId: jobRow.run_id,
    runStepId: jobRow.run_step_id,
    taskId: jobRow.task_id,
    jobId: jobRow.id,
    jobVersion: jobRow.version,
    attemptId: attempt.id,
    stepVersion,
    runVersion,
    runStatus: nextRunStatus,
    stepStatus,
    applicationId: jobRow.application_id,
    repositoryId: jobRow.repository_id,
    conversationId: jobRow.conversation_id,
  };
}
