import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  loadTaskScope,
  lockApplication,
  type TaskScopeRow,
  toIso,
} from "./postgres.ts";

type TaskDependencyRow = {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  condition: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  application_id: string;
  repository_id: string | null;
  conversation_id: string;
};

type DependencyInput = {
  dependsOnTaskId: string;
  condition: string;
};

const DEPENDENCY_COLUMNS = `
  d.id, d.task_id, d.depends_on_task_id, d.condition,
  d.created_at, d.updated_at, d.version,
  owner.application_id, owner.repository_id, owner.conversation_id`;

function toTaskDependency(row: TaskDependencyRow) {
  if (row.condition !== "completed") {
    throw new Error("WORK_READ_TASK_DEPENDENCY_INVALID");
  }
  return {
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    condition: "completed" as const,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

function assertDependencyOwnerEditable(task: TaskScopeRow): void {
  if (
    task.status !== "draft" || task.archived_at !== null ||
    task.current_run_id !== null
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "task_not_editable" },
    });
  }
}

async function appendDependencyFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: "taskDependencies.create" | "taskDependencies.delete";
    dependencyId: string;
    taskId: string;
    version: number;
    applicationId: string;
    repositoryId: string | null;
    conversationId: string;
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type, resource_id,
       outcome, request_id, trace_id, details
     ) values ($1, $2, $3, 'task_dependency', $4, 'succeeded', $5, $6, '{}'::jsonb)`,
    [
      options.organizationId,
      options.principalId,
      options.operation,
      options.dependencyId,
      options.requestId,
      options.traceId,
    ],
  );
  const sequence = await nextOrganizationSequence(
    transaction,
    options.organizationId,
  );
  const event = await transaction.query<{ id: string }>(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       application_id, repository_id, task_id, conversation_id, aggregate_id,
       aggregate_version, payload, trace_id
     ) values ($1, $2, 'task.dependencies_changed', 1, $3, $4, $5, $6,
       $7, $8, $9::jsonb, $10)
     returning id`,
    [
      options.organizationId,
      sequence,
      options.applicationId,
      options.repositoryId,
      options.taskId,
      options.conversationId,
      options.dependencyId,
      options.version,
      JSON.stringify({
        resourceId: options.dependencyId,
        resourceVersion: options.version,
      }),
      options.traceId,
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("DOMAIN_EVENT_INSERT_FAILED");
}

export async function createTaskDependencyCommand(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as DependencyInput;
  if (value.condition !== "completed") {
    throw unprocessable(["condition"], "condition_unsupported");
  }
  const taskId = context.params.id;
  if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const owner = await loadTaskScope(
    transaction,
    organizationId,
    taskId,
    undefined,
    false,
  );
  await lockApplication(transaction, organizationId, owner.application_id);
  const lockedOwner = await loadTaskScope(
    transaction,
    organizationId,
    taskId,
    owner.application_id,
  );
  assertDependencyOwnerEditable(lockedOwner);
  if (value.dependsOnTaskId.toLowerCase() === lockedOwner.id.toLowerCase()) {
    throw unprocessable(["dependsOnTaskId"], "self_dependency");
  }
  const prerequisite = await loadTaskScope(
    transaction,
    organizationId,
    value.dependsOnTaskId,
    owner.application_id,
  );
  if (prerequisite.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "prerequisite_archived" },
    });
  }

  const reachesOwner = await transaction.query(
    `with recursive reachable(task_id) as (
       select $3::uuid
       union
       select dependency.depends_on_task_id
       from bakery.task_dependencies dependency
       join reachable on reachable.task_id = dependency.task_id
       where dependency.organization_id = $1
     )
     select 1 from reachable where task_id = $2 limit 1`,
    [organizationId, taskId, value.dependsOnTaskId],
  );
  if (reachesOwner.rows.length !== 0) {
    throw unprocessable(["dependsOnTaskId"], "dependency_cycle");
  }

  const inserted = await transaction.query<TaskDependencyRow>(
    `insert into bakery.task_dependencies (
       organization_id, task_id, depends_on_task_id, condition, version
     ) values ($1, $2, $3, 'completed', 1)
     on conflict (organization_id, task_id, depends_on_task_id) do nothing
     returning id, task_id, depends_on_task_id, condition,
       created_at, updated_at, version,
       $4::uuid as application_id, $5::uuid as repository_id,
       $6::uuid as conversation_id`,
    [
      organizationId,
      taskId,
      value.dependsOnTaskId,
      lockedOwner.application_id,
      lockedOwner.repository_id,
      lockedOwner.conversation_id,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  await appendDependencyFacts(transaction, {
    organizationId,
    principalId,
    operation: "taskDependencies.create",
    dependencyId: row.id,
    taskId: row.task_id,
    version: row.version,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toTaskDependency(row);
}

export async function deleteTaskDependencyCommand(
  context: ActionContext,
  _input: unknown,
): Promise<null> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const taskId = context.params.id;
  const dependencyId = context.params.dependencyId;
  if (!taskId || !dependencyId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const owner = await loadTaskScope(
    transaction,
    organizationId,
    taskId,
    undefined,
    false,
  );
  await lockApplication(transaction, organizationId, owner.application_id);
  const lockedOwner = await loadTaskScope(
    transaction,
    organizationId,
    taskId,
    owner.application_id,
  );
  assertDependencyOwnerEditable(lockedOwner);
  const edge = await transaction.query<TaskDependencyRow>(
    `select ${DEPENDENCY_COLUMNS}
     from bakery.task_dependencies d
     join bakery.tasks owner
       on owner.organization_id = d.organization_id and owner.id = d.task_id
     where d.organization_id = $1 and d.task_id = $2 and d.id = $3`,
    [organizationId, taskId, dependencyId],
  );
  const row = edge.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const deleted = await transaction.query(
    `delete from bakery.task_dependencies
     where organization_id = $1 and task_id = $2 and id = $3`,
    [organizationId, taskId, dependencyId],
  );
  if (deleted.rowCount !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  await appendDependencyFacts(transaction, {
    organizationId,
    principalId,
    operation: "taskDependencies.delete",
    dependencyId: row.id,
    version: row.version + 1,
    taskId: row.task_id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return null;
}
