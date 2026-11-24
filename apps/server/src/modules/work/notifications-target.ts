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

export type ResolvedTarget =
  | {
    status: "available";
    targetKind: NotificationTargetKind;
    path: string;
    anchor: string | null;
    viaDocumentGrant?: true;
  }
  | {
    status: "part_unavailable";
    targetKind: NotificationTargetKind;
    path: string;
    anchor: null;
    viaDocumentGrant?: true;
  }
  | {
    status: "unavailable";
    targetKind: NotificationTargetKind;
    path: null;
    anchor: null;
  };

type TargetScope = {
  organizationId: string;
  recipientId: string;
  accessScope?: AccessScope;
};

type TargetRow = Pick<
  NotificationRow,
  "targetKind" | "targetId" | "targetAnchor" | "taskId" | "runId"
>;

type GrantHit = { versionId: string; deleted: boolean; name: string };

type PageFacts = {
  tasks: Map<string, string>;
  existing: Set<string>;
  versions: Map<string, { artifactId: string; revision: number; name: string }>;
  comments: Map<string, { artifactId: string; revision: number }>;
  grants: Map<string, GrantHit>;
  readsTasks: boolean;
};

const UNAVAILABLE = (targetKind: NotificationTargetKind): ResolvedTarget => ({
  status: "unavailable",
  targetKind,
  path: null,
  anchor: null,
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

async function reachableTasks(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<Map<string, string>> {
  const taskIds = [
    ...new Set(
      rows.flatMap((row) => row.taskId === null ? [] : [row.taskId]),
    ),
  ];
  if (taskIds.length === 0) return new Map();
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
  return new Map(found.rows.map((row) => [row.id, row.title ?? ""]));
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

async function grantFacts(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<Map<string, GrantHit>> {
  const ids = idsOf(rows, ["comment"]);
  if (ids.length === 0) return new Map();
  const found = await transaction.query<
    {
      commentId: string;
      versionId: string;
      deleted: boolean;
      name: string | null;
    }
  >(
    `select comment.id as "commentId", version.id as "versionId",
       comment.deleted_at is not null as deleted, artifact.name
     from bakery.artifact_comments as comment
     join bakery.artifact_versions as version
       on version.organization_id = comment.organization_id
      and version.id = comment.artifact_version_id
     join bakery.artifact_access_grants as grant_row
       on grant_row.organization_id = version.organization_id
      and grant_row.artifact_id = version.artifact_id
     left join bakery.artifacts as artifact
       on artifact.organization_id = version.organization_id
      and artifact.id = version.artifact_id
     where comment.organization_id = $1::uuid and comment.id = any($2::uuid[])
       and grant_row.principal_id = $3::uuid and grant_row.revoked_at is null`,
    [scope.organizationId, ids, scope.recipientId],
  );
  const hits = new Map<string, GrantHit>();
  for (const row of found.rows) {
    if (hits.has(row.commentId)) continue;
    hits.set(row.commentId, {
      versionId: row.versionId,
      deleted: row.deleted,
      name: row.name?.trim() ?? "",
    });
  }
  return hits;
}

async function pageFacts(
  transaction: PgTransactionClient,
  scope: TargetScope,
  rows: readonly TargetRow[],
): Promise<PageFacts> {
  const hasComment = rows.some((row) => row.targetKind === "comment");
  const [tasks, existing, versions, comments, grants, readsTasks] =
    await Promise.all([
      reachableTasks(transaction, scope, rows),
      existingTargets(transaction, scope.organizationId, rows),
      versionFacts(transaction, scope.organizationId, rows),
      commentFacts(transaction, scope.organizationId, rows),
      grantFacts(transaction, scope, rows),
      hasComment
        ? memberRoleHolds(
          transaction,
          scope.organizationId,
          scope.recipientId,
          "task:read",
        )
        : Promise.resolve(true),
    ]);
  return { tasks, existing, versions, comments, grants, readsTasks };
}

function grantTarget(facts: PageFacts, row: TargetRow): ResolvedTarget {
  const hit = facts.grants.get(row.targetId);
  if (hit === undefined) return UNAVAILABLE("comment");
  const path = `/files/versions/${hit.versionId}`;
  return hit.deleted
    ? {
      status: "part_unavailable",
      targetKind: "comment",
      path,
      anchor: null,
      viaDocumentGrant: true,
    }
    : {
      status: "available",
      targetKind: "comment",
      path,
      anchor: `comment:${row.targetId}`,
      viaDocumentGrant: true,
    };
}

function resolveFromFacts(facts: PageFacts, row: TargetRow): ResolvedTarget {
  const targetKind = asTargetKind(row.targetKind);
  if (targetKind === null) return UNAVAILABLE("comment");
  const viaGrant = () =>
    targetKind === "comment"
      ? grantTarget(facts, row)
      : UNAVAILABLE(targetKind);
  if (targetKind === "comment") {
    const document = grantTarget(facts, row);
    if (document.status !== "unavailable" && !facts.readsTasks) {
      return document;
    }
  }
  if (row.taskId === null || !facts.tasks.has(row.taskId)) return viaGrant();
  if (!facts.existing.has(`${targetKind}:${row.targetId}`)) {
    return {
      status: "part_unavailable",
      targetKind,
      path: taskPath(row.taskId),
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
      path: `${taskPath(row.taskId)}/artifacts/${located.artifactId}`,
      anchor: targetKind === "document_version"
        ? `version:${located.revision}`
        : `comment:${row.targetId}`,
    };
  }
  return {
    status: "available",
    targetKind,
    path: taskPath(row.taskId),
    anchor: targetKind === "conversation_message"
      ? `message:${row.targetId}`
      : row.targetAnchor,
  };
}

function titleFromFacts(
  facts: PageFacts,
  row: TargetRow,
  target: ResolvedTarget,
): string | null {
  if (target.status !== "unavailable" && target.viaDocumentGrant) {
    return facts.grants.get(row.targetId)?.name || null;
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
