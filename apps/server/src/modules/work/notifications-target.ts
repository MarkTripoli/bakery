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

export type ResolvedTarget =
  | {
    status: "available";
    targetKind: NotificationTargetKind;
    path: string;
    anchor: string | null;
    /** Reached through a direct document grant, not through the task. */
    viaDocumentGrant?: true;
  }
  | {
    // The task or document still opens but the inner part (step, card,
    // message, comment) is gone: open the page with no anchor and say so.
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

const UNAVAILABLE = (targetKind: NotificationTargetKind): ResolvedTarget => ({
  status: "unavailable",
  targetKind,
  path: null,
  anchor: null,
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

/** Narrows a stored `target_kind` text column to the contract's closed union. */
function asTargetKind(value: string): NotificationTargetKind | null {
  return TARGET_KINDS.has(value) ? (value as NotificationTargetKind) : null;
}

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
  scope: {
    organizationId: string;
    recipientId: string;
    accessScope?: AccessScope;
  },
  row: Pick<
    NotificationRow,
    "targetKind" | "targetId" | "targetAnchor" | "taskId" | "runId"
  >,
): Promise<ResolvedTarget> {
  const targetKind = asTargetKind(row.targetKind);
  if (targetKind === null) return UNAVAILABLE("comment");

  // A person who holds only a direct grant on the document cannot open its task
  // page, so a comment mention opens the document itself.
  const viaGrant = async () =>
    targetKind === "comment"
      ? await resolveDocumentGrantTarget(transaction, scope, row)
      : UNAVAILABLE(targetKind);

  // Someone who holds a live grant on the document and whose role cannot read
  // tasks is sent to the document, whatever the task's own scope says: the task
  // page is one they cannot open.
  if (targetKind === "comment") {
    const document = await resolveDocumentGrantTarget(transaction, scope, row);
    if (
      document.status !== "unavailable" &&
      !await memberRoleHolds(
        transaction,
        scope.organizationId,
        scope.recipientId,
        "task:read",
      )
    ) return document;
  }

  // Every other destination is reached through its task page. A target with no
  // task cannot be routed to a real surface yet, so it stays unavailable
  // rather than pointing at a guess.
  if (row.taskId === null) return await viaGrant();

  const values: unknown[] = [scope.organizationId, row.taskId];
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
  if (task.rows.length === 0) return await viaGrant();

  // Confirm the target row still exists inside this task, so a deleted step,
  // question or version reports a missing part rather than a dead anchor.
  const exists = await targetExists(transaction, scope.organizationId, row);
  if (!exists) {
    return {
      status: "part_unavailable",
      targetKind,
      path: taskPath(row.taskId),
      anchor: null,
    };
  }

  // Versions and comments live on the document page; everything else on the
  // task page. The anchor grammar is `kind:id`, with the version's number for
  // a version (`version:3`), so a reload or shared link lands in the same place.
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
        path: `${taskPath(row.taskId)}/artifacts/${found.artifactId}`,
        anchor: targetKind === "document_version"
          ? `version:${found.revision}`
          : `comment:${row.targetId}`,
      };
    }
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

/**
 * The destination of a comment mention for someone who may not open its task:
 * the document page, at the comment, while their grant on that document is
 * live. A revoked grant, a foreign comment or a deleted document answers
 * unavailable, so the row degrades to "no longer shared" and names nothing.
 */
async function resolveDocumentGrantTarget(
  transaction: PgTransactionClient,
  scope: { organizationId: string; recipientId: string },
  row: Pick<NotificationRow, "targetId">,
): Promise<ResolvedTarget> {
  const found = await transaction.query<
    { versionId: string; deleted: boolean }
  >(
    `select version.id as "versionId", comment.deleted_at is not null as deleted
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
       join bakery.artifact_access_grants as grant_row
         on grant_row.organization_id = version.organization_id
        and grant_row.artifact_id = version.artifact_id
      where comment.organization_id = $1::uuid and comment.id = $2::uuid
        and grant_row.principal_id = $3::uuid and grant_row.revoked_at is null`,
    [scope.organizationId, row.targetId, scope.recipientId],
  );
  const hit = found.rows[0];
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
  // Through a document grant only the document's own name may show, never the
  // task's title.
  const title = target.viaDocumentGrant
    ? await documentGrantTitle(transaction, scope.organizationId, row.targetId)
    : await destinationTitle(transaction, scope.organizationId, row);
  return { title, available: true };
}

async function documentGrantTitle(
  transaction: PgTransactionClient,
  organizationId: string,
  commentId: string,
): Promise<string | null> {
  const found = await transaction.query<{ name: string }>(
    `select artifact.name
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
       join bakery.artifacts as artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
      where comment.organization_id = $1::uuid and comment.id = $2::uuid`,
    [organizationId, commentId],
  );
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
