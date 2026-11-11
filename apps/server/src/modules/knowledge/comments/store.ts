import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { parseStrongIfMatch, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { z } from "zod";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import { validateAnchor } from "./anchors.ts";
import {
  type CommentRow,
  type CommentVersion,
  loadComment,
  loadVersion,
  toComment,
} from "./rows.ts";

type CreateInput = z.infer<typeof contractSchemas.ArtifactCommentCreate>;
type UpdateInput = z.infer<typeof contractSchemas.ArtifactCommentUpdate>;

export function validateCommentBody(body: string): void {
  if (body.length === 0 || new TextEncoder().encode(body).byteLength > 10240) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

async function recordChange(
  context: ActionContext,
  version: CommentVersion,
  change: {
    readonly row: CommentRow;
    readonly rootVersion: number;
    readonly created: boolean;
  },
) {
  const work = requireWorkTransaction(context);
  const { row, rootVersion, created } = change;
  await appendDomainEvent(work.transaction, {
    organizationId: work.organizationId,
    applicationId: version.application_id,
    repositoryId: version.repository_id,
    conversationId: version.conversation_id,
    taskId: version.task_id,
    eventType: created
      ? "artifact.comment_created"
      : "artifact.comment_updated",
    aggregateId: row.id,
    aggregateVersion: row.row_version,
    payload: {
      resourceId: row.id,
      resourceVersion: row.row_version,
      artifactId: version.artifact_id,
      artifactVersionId: version.id,
      rootId: row.parent_comment_id ?? row.id,
      rootVersion,
    },
    traceId: context.traceId,
  });
  await appendAudit(work.transaction, {
    organizationId: work.organizationId,
    principalId: work.principalId,
    operation: created ? "artifactComments.create" : "artifactComments.update",
    resourceType: "artifact_comment",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      artifactId: version.artifact_id,
      artifactVersionId: version.id,
      rootId: row.parent_comment_id ?? row.id,
      rootVersion,
    },
  });
}

export async function createComment(
  context: ActionContext,
  input: CreateInput,
) {
  const work = requireWorkTransaction(context);
  validateCommentBody(input.body);
  const version = await loadVersion(work, context.params.id, {
    lock: true,
    bytes: true,
  });
  if (version.content === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  let rootVersion = 1;
  if (input.rootId) {
    if (input.anchor) throw new StandardError({ code: "UNPROCESSABLE" });
    const root = await loadComment(work, input.rootId, true);
    if (
      root.artifact_version_id !== version.id || root.parent_comment_id !== null
    ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    if (root.deleted_at !== null) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    rootVersion = root.row_version + 1;
    await work.transaction.query(
      `update bakery.artifact_comments set row_version=row_version+1,updated_at=now()
      where organization_id=$1 and id=$2`,
      [work.organizationId, root.id],
    );
  } else if (input.anchor) validateAnchor(input.anchor, version);
  const inserted = await work.transaction.query<{ id: string }>(
    `insert into bakery.artifact_comments
    (organization_id,artifact_version_id,parent_comment_id,author_id,body,anchor,status)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      work.organizationId,
      version.id,
      input.rootId ?? null,
      work.principalId,
      input.body,
      input.anchor ?? null,
      input.rootId ? null : "open",
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new StandardError({ code: "INTERNAL" });
  const row = await loadComment(work, id);
  await recordChange(context, version, { row, rootVersion, created: true });
  return toComment(row);
}

export async function updateComment(
  context: ActionContext,
  input: UpdateInput,
) {
  const work = requireWorkTransaction(context);
  if (Object.keys(input).length === 0) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (input.body !== undefined) validateCommentBody(input.body);
  const observed = await loadComment(work, context.params.id);
  const version = await loadVersion(work, observed.artifact_version_id, {
    lock: true,
  });
  const root = await loadComment(
    work,
    observed.parent_comment_id ?? observed.id,
    true,
  );
  const row = observed.parent_comment_id
    ? await loadComment(work, observed.id, true)
    : root;
  const expected = parseStrongIfMatch(context.request.headers.get("if-match"));
  if (String(row.row_version) !== String(expected)) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (input.resolved !== undefined && row.parent_comment_id !== null) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (
    row.deleted_at !== null &&
    (input.body !== undefined || input.resolved !== undefined)
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  if (input.body !== undefined && row.author_id !== work.principalId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const deletionOwner = input.deleted === false && row.deleted_at !== null
    ? row.deleted_by
    : row.author_id;
  if (input.deleted !== undefined && deletionOwner !== work.principalId) {
    const admin = await work.transaction.query(
      `select 1 from bakery.organization_memberships
      where organization_id=$1 and principal_id=$2 and role='admin' and status='active'`,
      [work.organizationId, work.principalId],
    );
    if (admin.rows.length !== 1) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  }
  if (
    input.deleted === false && root.parent_comment_id === null &&
    root.status === "open" && version.content === null
  ) throw new StandardError({ code: "STATE_CONFLICT" });
  if (input.resolved === false && version.content === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  await work.transaction.query(
    `update bakery.artifact_comments set
    body=coalesce($3,body),
    status=case when $4::boolean is null then status when $4 then 'resolved' else 'open' end,
    resolved_by=case when $4::boolean is null then resolved_by when $4 then $6::uuid else null end,
    resolved_at=case when $4::boolean is null then resolved_at when $4 then now() else null end,
    deleted_at=case when $5::boolean is null then deleted_at when $5 then coalesce(deleted_at,now()) else null end,
    deleted_by=case when $5::boolean is null then deleted_by when $5 then coalesce(deleted_by,$6::uuid) else null end,
    row_version=row_version+1,updated_at=now() where organization_id=$1 and id=$2`,
    [
      work.organizationId,
      row.id,
      input.body ?? null,
      input.resolved ?? null,
      input.deleted ?? null,
      work.principalId,
    ],
  );
  if (row.parent_comment_id) {
    await work.transaction.query(
      `update bakery.artifact_comments
    set row_version=row_version+1,updated_at=now() where organization_id=$1 and id=$2`,
      [work.organizationId, root.id],
    );
  }
  const updated = await loadComment(work, row.id);
  await recordChange(context, version, {
    row: updated,
    rootVersion: root.row_version + 1,
    created: false,
  });
  return toComment(updated);
}
