import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import { resolveExecutableBinding } from "../projects/binding.ts";
import {
  parseApprovalPolicy,
  type TaskApprovalPolicy,
} from "./stage-policy.ts";

const taskStatuses: Record<
  | "draft"
  | "queued"
  | "active"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled",
  true
> = {
  draft: true,
  queued: true,
  active: true,
  waiting_input: true,
  blocked: true,
  completed: true,
  failed: true,
  canceled: true,
};
type TaskStatus = keyof typeof taskStatuses;
function isTaskStatus(value: string): value is TaskStatus {
  return Object.hasOwn(taskStatuses, value);
}
const taskTypes: Record<"feature" | "bug" | "epic" | "maintenance", true> = {
  feature: true,
  bug: true,
  epic: true,
  maintenance: true,
};
type TaskType = keyof typeof taskTypes;
function isTaskType(value: string): value is TaskType {
  return Object.hasOwn(taskTypes, value);
}

export type TaskRow = {
  id: string;
  application_id: string;
  repository_id: string | null;
  conversation_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  task_type: string;
  status: string;
  priority: number;
  created_by: string;
  current_run_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  repository_profile_id: string | null;
  repository_profile_revision: number | null;
  repository_profile_digest: string | null;
  observation_id: string | null;
  observation_digest: string | null;
  base_sha: string | null;
  approval_policy: TaskApprovalPolicy | null;
  planning_only: boolean;
};
export type TaskScopeRow = Pick<
  TaskRow,
  | "id"
  | "application_id"
  | "repository_id"
  | "conversation_id"
  | "status"
  | "archived_at"
  | "current_run_id"
>;

type TaskCreateInput = {
  applicationId: string;
  repositoryId?: string | null;
  repositoryProfileId?: string;
  taskType: string;
  title: string;
  description?: string;
  priority?: number;
  parentId?: string | null;
  approvalPolicy?: unknown;
  planningOnly?: boolean;
};

type TaskUpdateInput = {
  title?: string;
  description?: string;
  priority?: number;
  planningOnly?: boolean;
};

export const TASK_COLUMNS = `id, application_id, repository_id, conversation_id,
  parent_task_id, title, description, task_type, status, priority, created_by,
  current_run_id, archived_at, created_at, updated_at, version,
  repository_profile_id, repository_profile_revision, repository_profile_digest,
  observation_id, observation_digest, base_sha, approval_policy, planning_only`;

export function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toTask(row: TaskRow) {
  if (!isTaskType(row.task_type) || !isTaskStatus(row.status)) {
    throw new Error("WORK_READ_TASK_INVALID");
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    taskType: row.task_type,
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by,
    currentRunId: row.current_run_id,
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
    repositoryProfileId: row.repository_profile_id,
    repositoryProfileRevision: row.repository_profile_revision,
    repositoryProfileDigest: row.repository_profile_digest,
    observationId: row.observation_id,
    observationDigest: row.observation_digest,
    baseSha: row.base_sha,
    approvalPolicy: row.approval_policy ?? null,
    planningOnly: row.planning_only,
  };
}
export async function lockApplication(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
): Promise<void> {
  const result = await transaction.query(
    `select id from bakery.applications
     where organization_id = $1 and id = $2
     for update`,
    [organizationId, applicationId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export async function loadTaskScope(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
  applicationId?: string,
  forUpdate = true,
): Promise<TaskScopeRow> {
  const result = await transaction.query<TaskScopeRow>(
    `select id, application_id, repository_id, conversation_id, status,
            archived_at, current_run_id
       from bakery.tasks
      where organization_id = $1 and id = $2
        and ($3::uuid is null or application_id = $3::uuid)
      ${forUpdate ? "for update" : ""}`,
    [organizationId, taskId, applicationId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function assertApplication(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
): Promise<void> {
  const result = await transaction.query(
    "select 1 from bakery.applications where organization_id = $1 and id = $2",
    [organizationId, applicationId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

async function assertParentTask(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  parentId: string,
): Promise<void> {
  const result = await transaction.query(
    `select 1 from bakery.tasks
     where organization_id = $1 and application_id = $2 and id = $3`,
    [organizationId, applicationId, parentId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export async function appendTaskProjectionEvent(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    eventType: "tasks.created" | "tasks.updated";
    taskId: string;
    version: number;
    applicationId: string;
    repositoryId: string | null;
    conversationId: string;
    traceId: string;
  },
): Promise<void> {
  const sequence = await nextOrganizationSequence(
    transaction,
    options.organizationId,
  );
  const event = await transaction.query<{ id: string }>(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       application_id, repository_id, task_id, conversation_id, aggregate_id,
       aggregate_version, payload, trace_id
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $6, $8, $9::jsonb, $10)
     returning id`,
    [
      options.organizationId,
      sequence,
      options.eventType,
      options.applicationId,
      options.repositoryId,
      options.taskId,
      options.conversationId,
      options.version,
      JSON.stringify({
        resourceId: options.taskId,
        resourceVersion: options.version,
      }),
      options.traceId,
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("DOMAIN_EVENT_INSERT_FAILED");
  await transaction.query(
    `insert into bakery.outbox (
       organization_id, event_id, destination, delivery_key, status
     ) values ($1, $2, 'inngest', $3, 'pending')`,
    [
      options.organizationId,
      eventId,
      `task:${options.taskId}:version:${options.version}`,
    ],
  );
}

async function appendSuccessFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: "tasks.create" | "tasks.update";
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
     ) values ($1, $2, $3, 'task', $4, 'succeeded', $5, $6, '{}'::jsonb)`,
    [
      options.organizationId,
      options.principalId,
      options.operation,
      options.taskId,
      options.requestId,
      options.traceId,
    ],
  );
  await appendTaskProjectionEvent(transaction, {
    organizationId: options.organizationId,
    eventType: options.operation === "tasks.create"
      ? "tasks.created"
      : "tasks.updated",
    taskId: options.taskId,
    version: options.version,
    applicationId: options.applicationId,
    repositoryId: options.repositoryId,
    conversationId: options.conversationId,
    traceId: options.traceId,
  });
}

export const createTaskCommand = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as TaskCreateInput;
  await assertApplication(transaction, organizationId, value.applicationId);
  if (value.parentId !== undefined && value.parentId !== null) {
    await assertParentTask(
      transaction,
      organizationId,
      value.applicationId,
      value.parentId,
    );
  }
  const repositoryId = value.repositoryId ?? null;
  if (repositoryId === null && value.repositoryProfileId !== undefined) {
    throw unprocessable(
      ["repositoryProfileId"],
      "repository_profile_requires_repository",
    );
  }
  const binding = repositoryId === null ? null : await resolveExecutableBinding(
    transaction,
    organizationId,
    value.applicationId,
    repositoryId,
  );
  if (
    binding !== null && value.repositoryProfileId !== undefined &&
    binding.repositoryProfileId !== value.repositoryProfileId
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_profile_selection_stale" },
    });
  }
  // Absent policy stores null: the legacy policy where the plan stage is
  // automatic. Only an explicit `human_approval` changes admission.
  const approvalPolicy = value.approvalPolicy === undefined
    ? null
    : parseApprovalPolicy(value.approvalPolicy);
  const taskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const description = value.description ?? "";
  const priority = value.priority ?? 50;
  await transaction.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, repository_id, title, created_by
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      organizationId,
      value.applicationId,
      repositoryId,
      value.title.slice(0, 500),
      principalId,
    ],
  );
  const inserted = await transaction.query<TaskRow>(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id, conversation_id,
       parent_task_id, title, description, task_type, status, priority,
       created_by, version, repository_profile_id, repository_profile_revision,
       repository_profile_digest, observation_id, observation_digest, base_sha,
       approval_policy, planning_only
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, 1, $12, $13, $14, $15, $16, $17,
       $18::jsonb, $19
     )
     returning ${TASK_COLUMNS}`,
    [
      taskId,
      organizationId,
      value.applicationId,
      repositoryId,
      conversationId,
      value.parentId ?? null,
      value.title,
      description,
      value.taskType,
      priority,
      principalId,
      binding?.repositoryProfileId ?? null,
      binding?.repositoryProfileRevision ?? null,
      binding?.repositoryProfileDigest ?? null,
      binding?.observationId ?? null,
      binding?.observationDigest ?? null,
      binding?.baseSha ?? null,
      approvalPolicy === null ? null : JSON.stringify(approvalPolicy),
      value.planningOnly ?? false,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("TASK_INSERT_FAILED");
  await appendSuccessFacts(transaction, {
    organizationId,
    principalId,
    operation: "tasks.create",
    taskId,
    version: row.version,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toTask(row);
};

export const updateTaskCommand = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as TaskUpdateInput;
  const taskId = context.params.id;
  if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const metadata = requireCommandMetadata(context);
  const expectedVersion = metadata.expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const updated = await transaction.query<TaskRow>(
    `update bakery.tasks
     set title = coalesce($4, title),
       description = coalesce($5, description),
       priority = coalesce($6, priority),
       planning_only = coalesce($7, planning_only),
       updated_at = now(),
       version = version + 1
     where organization_id = $1 and id = $2 and version = $3
     returning ${TASK_COLUMNS}`,
    [
      organizationId,
      taskId,
      expectedVersion,
      value.title ?? null,
      value.description ?? null,
      value.priority ?? null,
      value.planningOnly ?? null,
    ],
  );
  const row = updated.rows[0];
  if (!row) {
    const visible = await transaction.query(
      "select 1 from bakery.tasks where organization_id = $1 and id = $2",
      [organizationId, taskId],
    );
    throw new StandardError({
      code: visible.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await appendSuccessFacts(transaction, {
    organizationId,
    principalId,
    operation: "tasks.update",
    taskId,
    version: row.version,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toTask(row);
};
