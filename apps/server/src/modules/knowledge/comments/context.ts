import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import type { OrganizationActor } from "../../auth/application/authority.ts";
import { authorize } from "../../auth/application/authorize.ts";
import {
  commentColumns,
  type CommentRow,
  loadComment,
  loadVersion,
  toComment,
} from "./rows.ts";

type Reference = z.infer<typeof contractSchemas.CommentReference>;
type Snapshot = z.infer<typeof contractSchemas.CommentSnapshot>;

export function boundedCommentContext(comments: readonly Snapshot[]) {
  const context = { comments: [...comments] };
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 32768) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: 32768 },
    });
  }
  return contractSchemas.CommentContext.parse(context);
}

export function sameCommentReferences(
  stored: unknown,
  references: readonly Reference[],
): boolean {
  if (stored === null) return references.length === 0;
  const parsed = contractSchemas.CommentContext.safeParse(stored);
  if (!parsed.success) return false;
  const roots = parsed.data.comments.filter((comment) =>
    comment.rootId === null
  );
  return roots.length === references.length &&
    roots.every((root, index) =>
      root.commentId === references[index]?.commentId.toLowerCase() &&
      root.version === references[index]?.expectedVersion
    );
}

export async function captureCommentContext(
  context: ActionContext,
  references: readonly Reference[],
) {
  if (references.length === 0) return null;
  const work = requireWorkTransaction(context);
  if (
    !("authority" in context) || typeof context.authority !== "object" ||
    context.authority === null
  ) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  if (!("organizationId" in context.authority)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  authorize(
    context.authority as OrganizationActor,
    "artifactComment:read",
    { action: "artifactComments.listAcrossVersions" },
  );
  if (
    references.length > 100 ||
    new Set(references.map((ref) => ref.commentId.toLowerCase())).size !==
      references.length
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  const conversation = await work.transaction.query<
    { application_id: string | null; repository_id: string | null }
  >(
    `select application_id,repository_id from bakery.conversations where organization_id=$1 and id=$2`,
    [work.organizationId, context.params.id],
  );
  const scope = conversation.rows[0];
  if (!scope) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // All mutations lock the artifact before roots. Stable ordering avoids cross-selection deadlocks.
  const candidates = await Promise.all(
    references.map((ref) => loadComment(work, ref.commentId)),
  );
  const versions = await Promise.all(
    candidates.map((row) => loadVersion(work, row.artifact_version_id)),
  );
  for (
    const version of [...versions].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id) || a.id.localeCompare(b.id)
    )
  ) {
    const locked = await loadVersion(work, version.id, { lock: true });
    if (
      locked.conversation_id !== context.params.id ||
      locked.application_id !== scope.application_id ||
      locked.repository_id !== scope.repository_id
    ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const snapshots: Snapshot[] = [];
  for (const reference of references) {
    const root = await loadComment(work, reference.commentId, true);
    if (root.parent_comment_id !== null || root.deleted_at !== null) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    if (root.row_version !== reference.expectedVersion) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    // At least 200 bytes of IDs per snapshot bounds the possible reply count.
    const replies = await work.transaction.query<CommentRow>(
      `select ${commentColumns} from bakery.artifact_comments c
      where c.organization_id=$1 and c.parent_comment_id=$2 and c.deleted_at is null order by c.created_at,c.id limit 201`,
      [work.organizationId, root.id],
    );
    if (replies.rows.length > 200) {
      throw new StandardError({
        code: "BODY_TOO_LARGE",
        params: { limit: 32768 },
      });
    }
    for (const row of [root, ...replies.rows]) {
      const comment = toComment(row);
      if (comment.body === null) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      snapshots.push({
        commentId: comment.id,
        version: comment.version,
        artifactVersionId: comment.artifactVersionId,
        rootId: comment.rootId,
        authorId: comment.authorId,
        body: comment.body,
        anchor: comment.anchor,
      });
      boundedCommentContext(snapshots);
    }
  }
  return boundedCommentContext(snapshots);
}
