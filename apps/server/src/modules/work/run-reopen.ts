import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requestRunStart } from "./run-start.ts";
import { appendTaskProjectionEvent } from "./postgres.ts";

/**
 * Puts a run that ended failed back in the queue, so the engine asks its plan
 * what to do next (chapter 25, one engine: the interpreter answers from the
 * pinned document and the recorded state, so a reopened run is just a run that
 * is asked again). It is a state change of a finished run, so it is narrow:
 * only a run whose own status and whose task are both `failed` reopens, only
 * through a caller that has already decided why, and a task that is a lane of a
 * coordination plan never does, because the plan's lane projection was settled
 * when the task ended and is not re-derived here.
 *
 * Reopening is idempotent by status: once the run is queued, a second call
 * finds it is no longer failed and refuses, so a replay never starts a second
 * engine pass. The caller serializes callers by locking the run row first.
 */
export async function reopenFailedRun(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly principalId: string;
    readonly requestId: string;
    readonly traceId: string;
    /** Stable code of why the run is reopened; goes to the audit log. */
    readonly reason: string;
  },
): Promise<void> {
  const { organizationId, runId } = input;
  const found = await transaction.query<
    {
      task_id: string;
      application_id: string;
      repository_id: string | null;
      conversation_id: string;
      run_status: string;
      task_status: string;
      coordinated: boolean;
    }
  >(
    `select run.task_id, task.application_id, task.repository_id,
            task.conversation_id,
            run.status as run_status, task.status as task_status,
            exists (
              select 1 from bakery.coordination_lanes lane
               where lane.organization_id = task.organization_id
                 and lane.child_task_id = task.id
            ) as coordinated
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id
        and task.id = run.task_id and task.current_run_id = run.id
      where run.organization_id = $1 and run.id = $2`,
    [organizationId, runId],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.run_status !== "failed" || row.task_status !== "failed") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_not_failed" },
    });
  }
  if (row.coordinated) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_in_coordination_plan" },
    });
  }
  const run = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'queued', finished_at = null, updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'failed'
      returning version`,
    [organizationId, runId],
  );
  const runVersion = run.rows[0]?.version;
  if (runVersion === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_not_failed" },
    });
  }
  const task = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = 'queued', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and current_run_id = $3
        and status = 'failed'
      returning version`,
    [organizationId, row.task_id, runId],
  );
  const taskVersion = task.rows[0]?.version;
  if (taskVersion === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_not_failed" },
    });
  }
  const traceId = input.traceId;
  await appendAudit(transaction, {
    organizationId,
    principalId: input.principalId,
    operation: "runs.reopen",
    resourceType: "workflow_run",
    resourceId: runId,
    requestId: input.requestId,
    traceId,
    details: {
      fromStatus: "failed",
      status: "queued",
      reason: input.reason,
    },
  });
  await requestRunStart(transaction, {
    organizationId,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    runId,
    runVersion,
    traceId,
  });
  await appendTaskProjectionEvent(transaction, {
    organizationId,
    eventType: "tasks.updated",
    taskId: row.task_id,
    version: taskVersion,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    traceId,
  });
}
