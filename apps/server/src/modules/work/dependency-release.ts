import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";
import { resolveDependencyReadiness } from "./dependency-readiness.ts";
import { requestRunStart } from "./run-start.ts";
import { appendTaskProjectionEvent } from "./postgres.ts";

/** Run reason admission records when a prerequisite task is not completed. */
export const DEPENDENCY_INCOMPLETE = "dependency_incomplete";

const TERMINAL_TASK_STATUSES = ["completed", "failed", "canceled"] as const;

type DependentRun = {
  run_id: string;
  run_version: number;
  task_id: string;
  application_id: string;
  repository_id: string | null;
  conversation_id: string;
  admission_trace_id: string | null;
};

/** What a terminal prerequisite does to a run blocked on it. */
export type DependencyRelease =
  | { kind: "queued" }
  | { kind: "canceled"; reason: string; dependencyTaskId: string }
  | { kind: "blocked" };

/**
 * Decides a blocked run's outcome from its prerequisites' current statuses:
 * queued when every one is completed (the admission rule,
 * `resolveDependencyReadiness`), canceled naming the first prerequisite that
 * ended failed or canceled, else still blocked.
 */
export function decideDependencyRelease(
  dependencies: readonly { taskId: string; status: string }[],
): DependencyRelease {
  if (resolveDependencyReadiness(dependencies).status === "queued") {
    return { kind: "queued" };
  }
  const ended = dependencies.find((dependency) =>
    dependency.status === "failed" || dependency.status === "canceled"
  );
  if (ended) {
    return {
      kind: "canceled",
      reason: `dependency_${ended.status}`,
      dependencyTaskId: ended.taskId,
    };
  }
  return { kind: "blocked" };
}

/**
 * Terminal-task hook: re-evaluates the runs blocked with
 * `dependency_incomplete` on tasks that depend on `taskId`. A run whose
 * prerequisites are now all completed moves blocked -> queued and starts the
 * way an admitted queued run starts (`requestRunStart`); a run with a failed or
 * canceled prerequisite moves blocked -> canceled with the reason and that
 * prerequisite in its audit, and its own dependants are released in turn
 * (`onCanceled`). Runs blocked for any other reason, and runs that were ever
 * requested, are left alone. Each run and then its task are row-locked and
 * re-checked under the lock, so a duplicate or concurrent completion signal
 * changes nothing. The frozen snapshot is never rewritten.
 */
export async function releaseDependentRuns(
  transaction: PgTransactionClient,
  input: { organizationId: string; taskId: string; traceId: string },
  onCanceled: (taskId: string) => Promise<void>,
): Promise<void> {
  const prerequisite = await transaction.query<{ status: string }>(
    `select status from bakery.tasks where organization_id = $1 and id = $2`,
    [input.organizationId, input.taskId],
  );
  const status = prerequisite.rows[0]?.status;
  if (
    status === undefined ||
    !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status)
  ) return;
  await lockBlockedDependants(transaction, input.organizationId, [
    input.taskId,
  ]);
  const candidates = await transaction.query<{ run_id: string }>(
    `select distinct run.id as run_id
       from bakery.task_dependencies dependency
       join bakery.tasks dependant
         on dependant.organization_id = dependency.organization_id
        and dependant.id = dependency.task_id
       join bakery.workflow_runs run
         on run.organization_id = dependant.organization_id
        and run.id = dependant.current_run_id
      where dependency.organization_id = $1
        and dependency.depends_on_task_id = $2
        and run.status = 'blocked'
      order by run.id`,
    [input.organizationId, input.taskId],
  );
  for (const { run_id } of candidates.rows) {
    await releaseRun(transaction, input, run_id, onCanceled);
  }
}

/**
 * The runs still blocked on `taskIds`, directly or through a chain of blocked
 * dependants, and their tasks, each list sorted by id
 * (`lockBlockedDependants` locks them).
 */
export async function findBlockedDependants(
  transaction: PgTransactionClient,
  organizationId: string,
  taskIds: readonly string[],
): Promise<{ runIds: string[]; taskIds: string[] }> {
  if (taskIds.length === 0) return { runIds: [], taskIds: [] };
  const closure = await transaction.query<{ task_id: string; run_id: string }>(
    `with recursive blocked(task_id, run_id) as (
       select dependant.id, run.id
         from bakery.task_dependencies dependency
         join bakery.tasks dependant
           on dependant.organization_id = dependency.organization_id
          and dependant.id = dependency.task_id
         join bakery.workflow_runs run
           on run.organization_id = dependant.organization_id
          and run.id = dependant.current_run_id
        where dependency.organization_id = $1
          and dependency.depends_on_task_id = any($2::uuid[])
          and run.status = 'blocked'
       union
       select dependant.id, run.id
         from blocked
         join bakery.task_dependencies dependency
           on dependency.organization_id = $1
          and dependency.depends_on_task_id = blocked.task_id
         join bakery.tasks dependant
           on dependant.organization_id = dependency.organization_id
          and dependant.id = dependency.task_id
         join bakery.workflow_runs run
           on run.organization_id = dependant.organization_id
          and run.id = dependant.current_run_id
        where run.status = 'blocked'
     )
     select task_id, run_id from blocked`,
    [organizationId, taskIds],
  );
  return {
    runIds: [...new Set(closure.rows.map((row) => row.run_id))].sort(),
    taskIds: [...new Set(closure.rows.map((row) => row.task_id))].sort(),
  };
}

/**
 * Row-locks, in the coordination lock order (runs by id, then tasks by id),
 * every run still blocked on `taskIds` directly or through a chain of blocked
 * dependants, and those runs' tasks. A release and its cancel cascade then
 * touch only rows already held, so a run lock never follows a task, parent or
 * plan lock taken by the cascade.
 */
export async function lockBlockedDependants(
  transaction: PgTransactionClient,
  organizationId: string,
  taskIds: readonly string[],
): Promise<void> {
  const { runIds, taskIds: dependantTaskIds } = await findBlockedDependants(
    transaction,
    organizationId,
    taskIds,
  );
  if (runIds.length === 0) return;
  await transaction.query(
    `select id from bakery.workflow_runs
      where organization_id = $1 and id = any($2::uuid[])
      order by id for update`,
    [organizationId, runIds],
  );
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1 and id = any($2::uuid[])
      order by id for update`,
    [organizationId, dependantTaskIds],
  );
}

async function releaseRun(
  transaction: PgTransactionClient,
  input: { organizationId: string; traceId: string },
  runId: string,
  onCanceled: (taskId: string) => Promise<void>,
): Promise<void> {
  // Lock order: the run, then its task (as cancel and materialize do).
  const locked = await transaction.query<DependentRun>(
    `select run.id as run_id, run.version as run_version, run.task_id,
            blocked_event.trace_id as admission_trace_id
       from bakery.workflow_runs run
       left join lateral (
         select event.trace_id from bakery.domain_events event
          where event.organization_id = run.organization_id
            and event.aggregate_id = run.id
            and event.event_type = 'run.blocked'
          order by event.organization_sequence asc
          limit 1
       ) blocked_event on true
      where run.organization_id = $1 and run.id = $2
        and run.status = 'blocked'
        and run.snapshot -> 'admission' ->> 'reason' = $3
        and not exists (
          select 1 from bakery.domain_events requested
           where requested.organization_id = run.organization_id
             and requested.aggregate_id = run.id
             and requested.event_type = 'run.requested'
        )
      for update of run`,
    [input.organizationId, runId, DEPENDENCY_INCOMPLETE],
  );
  const run = locked.rows[0];
  // Already released, or blocked for a reason this hook does not own.
  if (!run) return;
  const task = await transaction.query<
    Pick<
      DependentRun,
      "application_id" | "repository_id" | "conversation_id"
    >
  >(
    `select application_id, repository_id, conversation_id
       from bakery.tasks
      where organization_id = $1 and id = $2 and current_run_id = $3
        and status = 'blocked'
      for update`,
    [input.organizationId, run.task_id, run.run_id],
  );
  const taskRow = task.rows[0];
  if (!taskRow) return;
  const dependencies = await transaction.query<
    { task_id: string; status: string }
  >(
    `select dependency.depends_on_task_id as task_id, prerequisite.status
       from bakery.task_dependencies dependency
       join bakery.tasks prerequisite
         on prerequisite.organization_id = dependency.organization_id
        and prerequisite.id = dependency.depends_on_task_id
      where dependency.organization_id = $1 and dependency.task_id = $2
      order by dependency.created_at asc, dependency.id asc`,
    [input.organizationId, run.task_id],
  );
  const decision = decideDependencyRelease(
    dependencies.rows.map((row) => ({
      taskId: row.task_id,
      status: row.status,
    })),
  );
  if (decision.kind === "blocked") return;
  const traceId = run.admission_trace_id ?? input.traceId;
  const scope = { ...run, ...taskRow };
  if (decision.kind === "queued") {
    await resumeRun(transaction, input.organizationId, scope, traceId);
    return;
  }
  await cancelRun(transaction, input.organizationId, scope, traceId, decision);
  await onCanceled(run.task_id);
}

async function resumeRun(
  transaction: PgTransactionClient,
  organizationId: string,
  run: DependentRun,
  traceId: string,
): Promise<void> {
  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'queued', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'blocked'
      returning version`,
    [organizationId, run.run_id],
  );
  const runVersion = runUpdate.rows[0]?.version;
  if (runVersion === undefined) throw new Error("RUN_RESUME_CONFLICT");
  const taskVersion = await setTaskStatus(
    transaction,
    organizationId,
    run,
    "queued",
  );
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "runs.resume",
    resourceType: "workflow_run",
    resourceId: run.run_id,
    requestId: `dependency-release:${run.run_id}:${runVersion}`,
    traceId,
    details: {
      fromStatus: "blocked",
      status: "queued",
      resolvedReason: DEPENDENCY_INCOMPLETE,
    },
  });
  await requestRunStart(transaction, {
    organizationId,
    applicationId: run.application_id,
    repositoryId: run.repository_id,
    taskId: run.task_id,
    conversationId: run.conversation_id,
    runId: run.run_id,
    runVersion,
    traceId,
  });
  await appendTaskUpdated(
    transaction,
    organizationId,
    run,
    taskVersion,
    traceId,
  );
}

async function cancelRun(
  transaction: PgTransactionClient,
  organizationId: string,
  run: DependentRun,
  traceId: string,
  decision: Extract<DependencyRelease, { kind: "canceled" }>,
): Promise<void> {
  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'canceled', finished_at = now(), updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'blocked'
      returning version`,
    [organizationId, run.run_id],
  );
  const runVersion = runUpdate.rows[0]?.version;
  if (runVersion === undefined) throw new Error("RUN_RESUME_CONFLICT");
  const taskVersion = await setTaskStatus(
    transaction,
    organizationId,
    run,
    "canceled",
  );
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "runs.dependency_cancel",
    resourceType: "workflow_run",
    resourceId: run.run_id,
    requestId: `dependency-release:${run.run_id}:${runVersion}`,
    traceId,
    details: {
      fromStatus: "blocked",
      status: "canceled",
      reason: decision.reason,
      dependencyTaskId: decision.dependencyTaskId,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: run.application_id,
    repositoryId: run.repository_id,
    taskId: run.task_id,
    conversationId: run.conversation_id,
    eventType: "run.updated",
    aggregateId: run.run_id,
    aggregateVersion: runVersion,
    payload: { runId: run.run_id, version: runVersion },
    traceId,
  });
  await appendTaskUpdated(
    transaction,
    organizationId,
    run,
    taskVersion,
    traceId,
  );
}

async function setTaskStatus(
  transaction: PgTransactionClient,
  organizationId: string,
  run: DependentRun,
  status: "queued" | "canceled",
): Promise<number> {
  const result = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = $4, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and current_run_id = $3
        and status = 'blocked'
      returning version`,
    [organizationId, run.task_id, run.run_id, status],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new Error("RUN_RESUME_CONFLICT");
  return version;
}

async function appendTaskUpdated(
  transaction: PgTransactionClient,
  organizationId: string,
  run: DependentRun,
  taskVersion: number,
  traceId: string,
): Promise<void> {
  await appendTaskProjectionEvent(transaction, {
    organizationId,
    eventType: "tasks.updated",
    taskId: run.task_id,
    version: taskVersion,
    applicationId: run.application_id,
    repositoryId: run.repository_id,
    conversationId: run.conversation_id,
    traceId,
  });
}
