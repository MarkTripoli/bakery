import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type AccessScope,
  accessScopeClause,
} from "../auth/application/bindings.ts";
import type { NotificationRow } from "./notifications-postgres.ts";
import { memberRoleHolds } from "../conversation/mentions.ts";

export type NotificationTargetKind =
  | "conversation_message"
  | "run"
  | "run_step"
  | "approval"
  | "question"
  | "document_version"
  | "comment";

export type UnavailableReason = "gone" | "no_longer_shared" | "unknown";

export type SharedBy = { sharedByName?: string; sharedAt?: string };

export type ResolvedTarget =
  | ({
    status: "available";
    targetKind: NotificationTargetKind;
    path: string;
    anchor: string | null;
    viaGrant?: true;
  } & SharedBy)
  | ({
    status: "part_unavailable";
    targetKind: NotificationTargetKind;
    path: string;
    anchor: null;
    viaGrant?: true;
  } & SharedBy)
  | ({
    status: "unavailable";
    targetKind: NotificationTargetKind;
    path: null;
    anchor: null;
    reason: UnavailableReason;
  } & SharedBy);

type TargetScope = {
  organizationId: string;
  recipientId: string;
  accessScope?: AccessScope;
};

type TargetRow = Pick<
  NotificationRow,
  "targetKind" | "targetId" | "targetAnchor" | "taskId" | "runId"
>;

type SharedHit = {
  containerId: string;
  versionId: string | null;
  revision: number | null;
  partDeleted: boolean;
  grantLive: boolean | null;
  name: string | null;
  sharedByName: string | null;
  sharedAt: Date | null;
};

type PageFacts = {
  tasks: Map<string, string>;
  taskExists: Set<string>;
  existing: Set<string>;
  versions: Map<string, { artifactId: string; revision: number; name: string }>;
  comments: Map<string, { artifactId: string; revision: number }>;
  shared: Map<string, SharedHit>;
  readsTasks: boolean;
};

const UNAVAILABLE = (
  targetKind: NotificationTargetKind,
  reason: UnavailableReason,
  sharedBy: SharedBy = {},
): ResolvedTarget => ({
  status: "unavailable",
  targetKind,
  path: null,
  anchor: null,
  reason,
  ...sharedBy,
});

function taskPath(taskId: string): string {
  return `/tasks/${taskId}`;
}

const TARGET_KINDS = new Set<string>([
  "conversation_message",
  "run",
  "run_step",
  "approval",
  "question",
  "document_version",
  "comment",
]);

const GRANT_KINDS = new Set<string>([
  "conversation_message",
  "document_version",
  "comment",
]);

function asTargetKind(value: string): NotificationTargetKind | null {
  return TARGET_KINDS.has(value) ? (value as NotificationTargetKind) : null;
}

function idsOf(
  rows: readonly TargetRow[],
  kinds: readonly string[],
): string[] {
  return [
    ...new Set(
      rows.filter((row) => kinds.includes(row.targetKind)).map((row) =>
        row.targetId
      ),
    ),
  ];
}

async function taskFacts(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<{ reachable: Map<string, string>; existing: Set<string> }> {
  const taskIds = [
    ...new Set(
      rows.flatMap((row) => row.taskId === null ? [] : [row.taskId]),
    ),
  ];
  if (taskIds.length === 0) {
    return { reachable: new Map(), existing: new Set() };
  }
  const values: unknown[] = [scope.organizationId, taskIds];
  let scopeSql = "";
  if (scope.accessScope !== undefined) {
    const scoped = accessScopeClause(
      scope.accessScope,
      { application: "application_id", repository: "repository_id" },
      values.length + 1,
    );
    values.push(...scoped.values);
    scopeSql = ` and ${scoped.sql}`;
  }
  const found = await transaction.query<{ id: string; title: string | null }>(
    `select id, title from bakery.tasks
     where organization_id = $1::uuid and id = any($2::uuid[])${scopeSql}`,
    values,
  );
  const reachable = new Map(
    found.rows.map((row) => [row.id, row.title ?? ""]),
  );
  const existing = new Set(reachable.keys());
  const hidden = taskIds.filter((id) => !existing.has(id));
  if (hidden.length > 0) {
    const rows_ = await transaction.query<{ id: string }>(
      `select id from bakery.tasks
       where organization_id = $1::uuid and id = any($2::uuid[])`,
      [scope.organizationId, hidden],
    );
    for (const row of rows_.rows) existing.add(row.id);
  }
  return { reachable, existing };
}

function pairsOf(rows: readonly TargetRow[], kinds: readonly string[]) {
  const scoped = rows.filter((row) =>
    kinds.includes(row.targetKind) && row.taskId !== null
  );
  return {
    targetIds: scoped.map((row) => row.targetId),
    taskIds: scoped.map((row) => row.taskId),
  };
}

const PAIRED_EXISTENCE: Record<string, string> = {
  question: `select q.id from bakery.questions as q
     join unnest($2::uuid[], $3::uuid[]) as input(target_id, task_id)
       on q.id = input.target_id and q.task_id = input.task_id
    where q.organization_id = $1::uuid and q.kind = 'question'`,
  approval: `select q.id from bakery.questions as q
     join unnest($2::uuid[], $3::uuid[]) as input(target_id, task_id)
       on q.id = input.target_id and q.task_id = input.task_id
    where q.organization_id = $1::uuid and q.kind = 'approval'`,
  run_step: `select step.id from bakery.run_steps as step
     join bakery.workflow_runs as run
       on run.organization_id = step.organization_id and run.id = step.run_id
     join unnest($2::uuid[], $3::uuid[]) as input(target_id, task_id)
       on step.id = input.target_id and run.task_id = input.task_id
    where step.organization_id = $1::uuid`,
  document_version: `select version.id from bakery.artifact_versions as version
     join unnest($2::uuid[], $3::uuid[]) as input(target_id, task_id)
       on version.id = input.target_id and version.task_id = input.task_id
    where version.organization_id = $1::uuid`,
  run: `select run.id from bakery.workflow_runs as run
     join unnest($2::uuid[], $3::uuid[]) as input(target_id, task_id)
       on run.id = input.target_id and run.task_id = input.task_id
    where run.organization_id = $1::uuid`,
};

async function existingTargets(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly TargetRow[],
): Promise<Set<string>> {
  const lookups = Object.entries(PAIRED_EXISTENCE).map(
    async ([kind, sql]) => {
      const pairs = pairsOf(rows, [kind]);
      if (pairs.targetIds.length === 0) return [];
      const found = await transaction.query<{ id: string }>(sql, [
        organizationId,
        pairs.targetIds,
        pairs.taskIds,
      ]);
      return found.rows.map((row) => `${kind}:${row.id}`);
    },
  );
  const commentIds = idsOf(rows, ["comment"]);
  const messageIds = idsOf(rows, ["conversation_message"]);
  const comments = commentIds.length === 0 ? [] : (await transaction.query<
    { id: string }
  >(
    `select id from bakery.artifact_comments
     where organization_id = $1::uuid and id = any($2::uuid[])
       and deleted_at is null`,
    [organizationId, commentIds],
  )).rows.map((row) => `comment:${row.id}`);
  const messages = messageIds.length === 0 ? [] : (await transaction.query<
    { id: string }
  >(
    `select id from bakery.messages
     where organization_id = $1::uuid and id = any($2::uuid[])`,
    [organizationId, messageIds],
  )).rows.map((row) => `conversation_message:${row.id}`);
  return new Set([
    ...(await Promise.all(lookups)).flat(),
    ...comments,
    ...messages,
  ]);
}

async function versionFacts(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly TargetRow[],
): Promise<PageFacts["versions"]> {
  const ids = idsOf(rows, ["document_version"]);
  if (ids.length === 0) return new Map();
  const found = await transaction.query<
    { id: string; artifactId: string; revision: number; name: string | null }
  >(
    `select version.id, version.artifact_id as "artifactId", version.revision,
       artifact.name
     from bakery.artifact_versions as version
     left join bakery.artifacts as artifact
       on artifact.organization_id = version.organization_id
      and artifact.id = version.artifact_id
     where version.organization_id = $1::uuid and version.id = any($2::uuid[])`,
    [organizationId, ids],
  );
  return new Map(
    found.rows.map((row) => [row.id, {
      artifactId: row.artifactId,
      revision: row.revision,
      name: row.name?.trim() ?? "",
    }]),
  );
}

async function commentFacts(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly TargetRow[],
): Promise<PageFacts["comments"]> {
  const ids = idsOf(rows, ["comment"]);
  if (ids.length === 0) return new Map();
  const found = await transaction.query<
    { id: string; artifactId: string; revision: number }
  >(
    `select comment.id, version.artifact_id as "artifactId", version.revision
     from bakery.artifact_comments as comment
     join bakery.artifact_versions as version
       on version.organization_id = comment.organization_id
      and version.id = comment.artifact_version_id
     where comment.organization_id = $1::uuid and comment.id = any($2::uuid[])`,
    [organizationId, ids],
  );
  return new Map(
    found.rows.map((row) => [row.id, {
      artifactId: row.artifactId,
      revision: row.revision,
    }]),
  );
}

const SHARED_GRANT_COLUMNS = `grant_row.revoked_at is null as "grantLive",
       granter.display_name as "sharedByName",
       grant_row.granted_at as "sharedAt"`;

const SHARED_SQL: Record<
  "conversation_message" | "document_version" | "comment",
  string
> = {
  conversation_message: `select message.id as "targetId",
       message.conversation_id as "containerId",
       null::uuid as "versionId", null::integer as revision,
       false as "partDeleted", conversation.title as name, ${SHARED_GRANT_COLUMNS}
       from bakery.messages as message
       join bakery.conversations as conversation
         on conversation.organization_id = message.organization_id
        and conversation.id = message.conversation_id
       left join bakery.conversation_access_grants as grant_row
         on grant_row.organization_id = message.organization_id
        and grant_row.conversation_id = message.conversation_id
        and grant_row.principal_id = $3::uuid
       left join bakery.principals as granter
         on granter.id = grant_row.granted_by
      where message.organization_id = $1::uuid
        and message.id = any($2::uuid[])`,
  document_version: `select version.id as "targetId",
       version.artifact_id as "containerId",
       version.id as "versionId", version.revision,
       false as "partDeleted", artifact.name as name, ${SHARED_GRANT_COLUMNS}
       from bakery.artifact_versions as version
       left join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
       left join bakery.artifact_access_grants as grant_row
         on grant_row.organization_id = version.organization_id
        and grant_row.artifact_id = version.artifact_id
        and grant_row.principal_id = $3::uuid
       left join bakery.principals as granter
         on granter.id = grant_row.granted_by
      where version.organization_id = $1::uuid
        and version.id = any($2::uuid[])`,
  comment: `select comment.id as "targetId",
       version.artifact_id as "containerId",
       version.id as "versionId", version.revision,
       comment.deleted_at is not null as "partDeleted",
       artifact.name as name, ${SHARED_GRANT_COLUMNS}
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
       left join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
       left join bakery.artifact_access_grants as grant_row
         on grant_row.organization_id = version.organization_id
        and grant_row.artifact_id = version.artifact_id
        and grant_row.principal_id = $3::uuid
       left join bakery.principals as granter
         on granter.id = grant_row.granted_by
      where comment.organization_id = $1::uuid
        and comment.id = any($2::uuid[])`,
};

async function sharedFacts(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<Map<string, SharedHit>> {
  const shared = new Map<string, SharedHit>();
  for (
    const kind of Object.keys(SHARED_SQL) as Array<
      keyof typeof SHARED_SQL
    >
  ) {
    const ids = idsOf(rows, [kind]);
    if (ids.length === 0) continue;
    const found = await transaction.query<
      {
        targetId: string;
        containerId: string;
        versionId: string | null;
        revision: number | null;
        partDeleted: boolean;
        grantLive: boolean | null;
        name: string | null;
        sharedByName: string | null;
        sharedAt: Date | null;
      }
    >(
      SHARED_SQL[kind],
      [scope.organizationId, ids, scope.recipientId],
    );
    for (const row of found.rows) {
      if (shared.has(row.targetId)) continue;
      shared.set(row.targetId, {
        containerId: row.containerId,
        versionId: row.versionId,
        revision: row.revision,
        partDeleted: row.partDeleted,
        grantLive: row.grantLive,
        name: row.name?.trim() ?? null,
        sharedByName: row.sharedByName,
        sharedAt: row.sharedAt,
      });
    }
  }
  return shared;
}

async function pageFacts(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<PageFacts> {
  const hasGrantable = rows.some((row) => GRANT_KINDS.has(row.targetKind));
  const [taskInfo, existing, versions, comments, shared, readsTasks] =
    await Promise.all([
      taskFacts(transaction, scope, rows),
      existingTargets(transaction, scope.organizationId, rows),
      versionFacts(transaction, scope.organizationId, rows),
      commentFacts(transaction, scope.organizationId, rows),
      sharedFacts(transaction, scope, rows),
      hasGrantable
        ? memberRoleHolds(
          transaction,
          scope.organizationId,
          scope.recipientId,
          "task:read",
        )
        : Promise.resolve(true),
    ]);
  return {
    tasks: taskInfo.reachable,
    taskExists: taskInfo.existing,
    existing,
    versions,
    comments,
    shared,
    readsTasks,
  };
}

function sharedByOf(hit: SharedHit): SharedBy {
  return {
    ...(hit.sharedByName === null ? {} : { sharedByName: hit.sharedByName }),
    ...(hit.sharedAt === null ? {} : { sharedAt: hit.sharedAt.toISOString() }),
  };
}

function sharedTarget(
  facts: PageFacts,
  row: TargetRow,
  targetKind: NotificationTargetKind,
): ResolvedTarget {
  const hit = facts.shared.get(row.targetId);
  if (hit === undefined) return UNAVAILABLE(targetKind, "gone");
  const sharedBy = sharedByOf(hit);
  if (hit.grantLive !== true) {
    return UNAVAILABLE(targetKind, "no_longer_shared", sharedBy);
  }
  if (targetKind === "conversation_message") {
    return {
      status: "available",
      targetKind,
      path: `/shared/conversations/${hit.containerId}?message=${row.targetId}`,
      anchor: `message:${row.targetId}`,
      viaGrant: true,
      ...sharedBy,
    };
  }
  const documentPath =
    `/shared/documents/${hit.containerId}?version=${hit.versionId}`;
  if (hit.partDeleted) {
    return {
      status: "part_unavailable",
      targetKind,
      path: documentPath,
      anchor: null,
      viaGrant: true,
      ...sharedBy,
    };
  }
  return targetKind === "comment"
    ? {
      status: "available",
      targetKind,
      path: `${documentPath}&comment=${row.targetId}`,
      anchor: `comment:${row.targetId}`,
      viaGrant: true,
      ...sharedBy,
    }
    : {
      status: "available",
      targetKind,
      path: documentPath,
      anchor: `version:${hit.revision}`,
      viaGrant: true,
      ...sharedBy,
    };
}

function taskTarget(
  facts: PageFacts,
  row: TargetRow,
  targetKind: NotificationTargetKind,
): ResolvedTarget {
  if (!facts.existing.has(`${targetKind}:${row.targetId}`)) {
    return {
      status: "part_unavailable",
      targetKind,
      path: taskPath(row.taskId as string),
      anchor: null,
    };
  }
  const located = targetKind === "document_version"
    ? facts.versions.get(row.targetId)
    : targetKind === "comment"
    ? facts.comments.get(row.targetId)
    : undefined;
  if (located !== undefined) {
    return {
      status: "available",
      targetKind,
      path: `${taskPath(row.taskId as string)}/artifacts/${located.artifactId}`,
      anchor: targetKind === "document_version"
        ? `version:${located.revision}`
        : `comment:${row.targetId}`,
    };
  }
  return {
    status: "available",
    targetKind,
    path: taskPath(row.taskId as string),
    anchor: row.targetAnchor,
  };
}

function taskUnavailableReason(
  facts: PageFacts,
  taskId: string | null,
): UnavailableReason {
  if (taskId === null) return "unknown";
  return facts.taskExists.has(taskId) ? "no_longer_shared" : "gone";
}

function resolveFromFacts(facts: PageFacts, row: TargetRow): ResolvedTarget {
  const targetKind = asTargetKind(row.targetKind);
  if (targetKind === null) return UNAVAILABLE("comment", "unknown");
  const grantable = GRANT_KINDS.has(targetKind);
  const taskReachable = row.taskId !== null && facts.tasks.has(row.taskId);
  if (taskReachable && (!grantable || facts.readsTasks)) {
    return taskTarget(facts, row, targetKind);
  }
  if (grantable) {
    return sharedTarget(facts, row, targetKind);
  }
  return UNAVAILABLE(
    targetKind,
    taskUnavailableReason(facts, row.taskId),
  );
}

function titleFromFacts(
  facts: PageFacts,
  row: TargetRow,
  target: ResolvedTarget,
): string | null {
  if (target.status !== "unavailable" && target.viaGrant) {
    return facts.shared.get(row.targetId)?.name ?? null;
  }
  if (row.targetKind === "document_version") {
    const name = facts.versions.get(row.targetId)?.name;
    if (name) return name;
  }
  if (row.taskId === null) return null;
  return facts.tasks.get(row.taskId)?.trim() || null;
}

export async function resolveNotificationTargets(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<ResolvedTarget[]> {
  const facts = await pageFacts(transaction, scope, rows);
  return rows.map((row) => resolveFromFacts(facts, row));
}

export async function resolveNotificationTarget(
  transaction: PgTransactionClient,
  scope: TargetScope,
  row: TargetRow,
): Promise<ResolvedTarget> {
  const [target] = await resolveNotificationTargets(transaction, scope, [row]);
  return target!;
}

export async function resolveDestinationSummaries(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<{ title: string | null; available: boolean }[]> {
  const facts = await pageFacts(transaction, scope, rows);
  return rows.map((row) => {
    const target = resolveFromFacts(facts, row);
    return target.status === "unavailable"
      ? { title: null, available: false }
      : { title: titleFromFacts(facts, row, target), available: true };
  });
}

export async function resolveDestinationSummary(
  transaction: PgTransactionClient,
  scope: TargetScope,
  row: TargetRow,
): Promise<{ title: string | null; available: boolean }> {
  const [summary] = await resolveDestinationSummaries(transaction, scope, [
    row,
  ]);
  return summary!;
}
