import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type AccessScope,
  accessScopeClause,
} from "../auth/application/bindings.ts";
import type { NotificationRow } from "./notifications-postgres.ts";
import { memberRoleHolds } from "../conversation/mentions.ts";

/**
 * A resolved destination. `path` is a validated internal route, never an
 * external URL and never built from user text; `available` false means the
 * target is gone or the reader may not reach it, and in that case no title is
 * returned so a protected name cannot leak through a stale inbox row.
 */
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

/** `/tasks/{id}` with an in-page anchor when the design needs an exact place. */
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

const GRANT_KINDS = new Set<NotificationTargetKind>([
  "conversation_message",
  "document_version",
  "comment",
]);

/** Narrows a stored `target_kind` text column to the contract's closed union. */
function asTargetKind(value: string): NotificationTargetKind | null {
  return TARGET_KINDS.has(value) ? (value as NotificationTargetKind) : null;
}

type Scope = {
  organizationId: string;
  recipientId: string;
  accessScope?: AccessScope;
};

type TargetRow = Pick<
  NotificationRow,
  "targetKind" | "targetId" | "targetAnchor" | "taskId" | "runId"
>;

/**
 * Reauthorizes a stored target against the reader's *current* authority and
 * returns the internal route and anchor, or an unavailable result.
 *
 * Every branch runs the same resource scope the ordinary list reads use, so a
 * notification can never become a side door: a person who has lost access to a
 * task loses it here too, and the row degrades to "no longer available" rather
 * than showing a title they may no longer see. Notification identity is not an
 * input to any authority check.
 */
export async function resolveNotificationTarget(
  transaction: PgTransactionClient,
  scope: Scope,
  row: TargetRow,
): Promise<ResolvedTarget> {
  const targetKind = asTargetKind(row.targetKind);
  if (targetKind === null) return UNAVAILABLE("comment", "unknown");
  const grantable = GRANT_KINDS.has(targetKind);
  const task = row.taskId === null
    ? "none"
    : await taskAccess(transaction, scope, row.taskId);
  if (
    row.taskId !== null && task === "open" &&
    (!grantable ||
      await memberRoleHolds(
        transaction,
        scope.organizationId,
        scope.recipientId,
        "task:read",
      ))
  ) return await resolveTaskTarget(transaction, scope, row, targetKind);
  if (grantable) {
    return await resolveSharedTarget(transaction, scope, row, targetKind);
  }
  if (task === "none") return UNAVAILABLE(targetKind, "unknown");
  return UNAVAILABLE(
    targetKind,
    task === "missing" ? "gone" : "no_longer_shared",
  );
}

async function taskAccess(
  transaction: PgTransactionClient,
  scope: Scope,
  taskId: string,
): Promise<"open" | "hidden" | "missing"> {
  const values: unknown[] = [scope.organizationId, taskId];
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
  const task = await transaction.query<{ id: string }>(
    `select id from bakery.tasks
     where organization_id = $1::uuid and id = $2::uuid${scopeSql}`,
    values,
  );
  if (task.rows.length > 0) return "open";
  if (scope.accessScope === undefined) return "missing";
  const exists = await transaction.query<{ id: string }>(
    `select id from bakery.tasks
     where organization_id = $1::uuid and id = $2::uuid`,
    [scope.organizationId, taskId],
  );
  return exists.rows.length > 0 ? "hidden" : "missing";
}

async function resolveTaskTarget(
  transaction: PgTransactionClient,
  scope: Scope,
  row: TargetRow,
  targetKind: NotificationTargetKind,
): Promise<ResolvedTarget> {
  const taskId = row.taskId as string;
  const exists = await targetExists(transaction, scope.organizationId, row);
  if (!exists) {
    return {
      status: "part_unavailable",
      targetKind,
      path: taskPath(taskId),
      anchor: null,
    };
  }
  if (targetKind === "document_version" || targetKind === "comment") {
    const located = await transaction.query<
      { artifactId: string; revision: number }
    >(
      targetKind === "document_version"
        ? `select artifact_id as "artifactId", revision
             from bakery.artifact_versions
            where organization_id = $1::uuid and id = $2::uuid`
        : `select version.artifact_id as "artifactId", version.revision
             from bakery.artifact_comments as comment
             join bakery.artifact_versions as version
               on version.organization_id = comment.organization_id
              and version.id = comment.artifact_version_id
            where comment.organization_id = $1::uuid and comment.id = $2::uuid`,
      [scope.organizationId, row.targetId],
    );
    const found = located.rows[0];
    if (found !== undefined) {
      return {
        status: "available",
        targetKind,
        path: `${taskPath(taskId)}/artifacts/${found.artifactId}`,
        anchor: targetKind === "document_version"
          ? `version:${found.revision}`
          : `comment:${row.targetId}`,
      };
    }
  }
  return {
    status: "available",
    targetKind,
    path: taskPath(taskId),
    anchor: row.targetAnchor,
  };
}

type SharedRow = {
  containerId: string;
  versionId: string | null;
  revision: number | null;
  partDeleted: boolean;
  grantLive: boolean | null;
  sharedByName: string | null;
  sharedAt: Date | null;
};

const DOCUMENT_GRANT_JOIN =
  `left join bakery.artifact_access_grants as grant_row
         on grant_row.organization_id = version.organization_id
        and grant_row.artifact_id = version.artifact_id
        and grant_row.principal_id = $3::uuid
       left join bakery.principals as granter
         on granter.id = grant_row.granted_by`;

const GRANT_COLUMNS = `grant_row.id is null as "noGrant",
       grant_row.revoked_at is null as "grantLive",
       granter.display_name as "sharedByName",
       grant_row.granted_at as "sharedAt"`;

const SHARED_SQL: Record<
  "comment" | "document_version" | "conversation_message",
  string
> = {
  comment: `select version.artifact_id as "containerId",
       version.id as "versionId", version.revision,
       comment.deleted_at is not null as "partDeleted", ${GRANT_COLUMNS}
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
       ${DOCUMENT_GRANT_JOIN}
      where comment.organization_id = $1::uuid and comment.id = $2::uuid`,
  document_version: `select version.artifact_id as "containerId",
       version.id as "versionId", version.revision,
       false as "partDeleted", ${GRANT_COLUMNS}
       from bakery.artifact_versions as version
       ${DOCUMENT_GRANT_JOIN}
      where version.organization_id = $1::uuid and version.id = $2::uuid`,
  conversation_message: `select message.conversation_id as "containerId",
       null::uuid as "versionId", null::integer as revision,
       false as "partDeleted", ${GRANT_COLUMNS}
       from bakery.messages as message
       left join bakery.conversation_access_grants as grant_row
         on grant_row.organization_id = message.organization_id
        and grant_row.conversation_id = message.conversation_id
        and grant_row.principal_id = $3::uuid
       left join bakery.principals as granter
         on granter.id = grant_row.granted_by
      where message.organization_id = $1::uuid and message.id = $2::uuid`,
};

async function resolveSharedTarget(
  transaction: PgTransactionClient,
  scope: Scope,
  row: TargetRow,
  targetKind: NotificationTargetKind,
): Promise<ResolvedTarget> {
  const found = await transaction.query<SharedRow & { noGrant: boolean }>(
    SHARED_SQL[targetKind as keyof typeof SHARED_SQL],
    [scope.organizationId, row.targetId, scope.recipientId],
  );
  const hit = found.rows[0];
  if (hit === undefined) return UNAVAILABLE(targetKind, "gone");
  const sharedBy: SharedBy = hit.noGrant ? {} : {
    ...(hit.sharedByName === null ? {} : { sharedByName: hit.sharedByName }),
    ...(hit.sharedAt === null ? {} : { sharedAt: hit.sharedAt.toISOString() }),
  };
  if (hit.noGrant || hit.grantLive !== true) {
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

async function targetExists(
  transaction: PgTransactionClient,
  organizationId: string,
  row: Pick<NotificationRow, "targetKind" | "targetId" | "taskId">,
): Promise<boolean> {
  const byId = (table: string, extra = "") =>
    transaction.query<{ id: string }>(
      `select id from ${table}
       where organization_id = $1::uuid and id = $2::uuid
         and task_id = $3::uuid${extra}`,
      [organizationId, row.targetId, row.taskId],
    );
  switch (row.targetKind) {
    case "question":
    case "approval": {
      // Approvals are questions of kind 'approval' (0115), so one lookup covers
      // both and the kind check keeps the two from swapping.
      const kind = row.targetKind === "approval" ? "approval" : "question";
      const found = await byId(
        "bakery.questions",
        ` and kind = '${kind === "approval" ? "approval" : "question"}'`,
      );
      return found.rows.length > 0;
    }
    case "run_step": {
      // A step hangs off its run, which carries the task link; the step table
      // itself has no task column, so scope through the run rather than byId.
      const found = await transaction.query<{ id: string }>(
        `select step.id from bakery.run_steps as step
           join bakery.workflow_runs as run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
          where step.organization_id = $1::uuid and step.id = $2::uuid
            and run.task_id = $3::uuid`,
        [organizationId, row.targetId, row.taskId],
      );
      return found.rows.length > 0;
    }
    case "comment": {
      const found = await transaction.query<{ id: string }>(
        `select id from bakery.artifact_comments
         where organization_id = $1::uuid and id = $2::uuid
           and deleted_at is null`,
        [organizationId, row.targetId],
      );
      return found.rows.length > 0;
    }
    case "document_version": {
      const found = await byId("bakery.artifact_versions");
      return found.rows.length > 0;
    }
    case "run": {
      const found = await transaction.query<{ id: string }>(
        `select id from bakery.workflow_runs
         where organization_id = $1::uuid and id = $2::uuid
           and task_id = $3::uuid`,
        [organizationId, row.targetId, row.taskId],
      );
      return found.rows.length > 0;
    }
    case "conversation_message": {
      // A message's own task link is through the conversation; the task page
      // still hosts it, so existence is enough to route to the task anchor.
      const found = await transaction.query<{ id: string }>(
        `select id from bakery.messages
         where organization_id = $1::uuid and id = $2::uuid`,
        [organizationId, row.targetId],
      );
      return found.rows.length > 0;
    }
    default:
      return false;
  }
}

/**
 * The safe title for a destination's second line, resolved only when the reader
 * may reach it. Mirrors `resolveNotificationTarget`'s authorization exactly, so
 * a row whose target is unavailable shows no title at all.
 */
export async function resolveDestinationSummary(
  transaction: PgTransactionClient,
  scope: {
    organizationId: string;
    recipientId: string;
    accessScope?: AccessScope;
  },
  row: NotificationRow,
): Promise<{ title: string | null; available: boolean }> {
  const target = await resolveNotificationTarget(transaction, scope, row);
  if (target.status === "unavailable") {
    return { title: null, available: false };
  }
  const title = target.viaGrant
    ? await sharedTitle(transaction, scope.organizationId, row)
    : await destinationTitle(transaction, scope.organizationId, row);
  return { title, available: true };
}

const SHARED_TITLE_SQL: Record<string, string> = {
  comment: `select artifact.name
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
       join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
      where comment.organization_id = $1::uuid and comment.id = $2::uuid`,
  document_version: `select artifact.name
       from bakery.artifact_versions as version
       join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
      where version.organization_id = $1::uuid and version.id = $2::uuid`,
  conversation_message: `select conversation.title as name
       from bakery.messages as message
       join bakery.conversations as conversation
         on conversation.organization_id = message.organization_id
        and conversation.id = message.conversation_id
      where message.organization_id = $1::uuid and message.id = $2::uuid`,
};

async function sharedTitle(
  transaction: PgTransactionClient,
  organizationId: string,
  row: NotificationRow,
): Promise<string | null> {
  const sql = SHARED_TITLE_SQL[row.targetKind];
  if (sql === undefined) return null;
  const found = await transaction.query<{ name: string | null }>(sql, [
    organizationId,
    row.targetId,
  ]);
  const name = found.rows[0]?.name?.trim();
  return name ? name : null;
}

async function destinationTitle(
  transaction: PgTransactionClient,
  organizationId: string,
  row: NotificationRow,
): Promise<string | null> {
  // The task title is the destination for run, step, approval, question and
  // message rows; a document version names its artifact. Either way the title
  // is the stored row's own name, never a re-rendered string.
  if (row.targetKind === "document_version") {
    const version = await transaction.query<{ name: string }>(
      `select artifact.name
       from bakery.artifact_versions as version
       join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
         and artifact.id = version.artifact_id
       where version.organization_id = $1::uuid and version.id = $2::uuid`,
      [organizationId, row.targetId],
    );
    const name = version.rows[0]?.name?.trim();
    if (name) return name;
  }
  if (row.taskId === null) return null;
  const task = await transaction.query<{ title: string }>(
    `select title from bakery.tasks
     where organization_id = $1::uuid and id = $2::uuid`,
    [organizationId, row.taskId],
  );
  const title = task.rows[0]?.title?.trim();
  return title ? title : null;
}
