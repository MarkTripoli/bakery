import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { WorkTransaction } from "../../work/work-transaction.ts";
import { redactCommentAnchor } from "./redaction.ts";
import type { AnchorVersion } from "./anchors.ts";
import type { OrganizationBlobStore } from "../../catalog/storage-port.ts";
import { assertStoredBytes } from "../stored-bytes.ts";

export type CommentRow = {
  readonly id: string;
  readonly artifact_version_id: string;
  readonly parent_comment_id: string | null;
  readonly author_id: string;
  readonly author_name: string | null;
  readonly body: string;
  readonly anchor: unknown;
  readonly status: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: Date | null;
  readonly deleted_at: Date | null;
  readonly deleted_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly row_version: number;
  readonly cursor_created_at: string;
};
export type CommentVersion = AnchorVersion & {
  readonly artifact_id: string;
  readonly blob_id: string | null;
  readonly size_bytes: number;
  readonly task_id: string;
  readonly conversation_id: string | null;
  readonly application_id: string | null;
  readonly repository_id: string | null;
};
export const commentColumns =
  `c.id,c.artifact_version_id,c.parent_comment_id,c.author_id,
  (select left(nullif(btrim(author.display_name), ''), 200) from bakery.principals author
    where author.id = c.author_id) as author_name,
  case when c.deleted_at is null then c.body else '' end as body,
  c.anchor,c.status,c.resolved_by,c.resolved_at,c.deleted_at,c.deleted_by,c.created_at,c.updated_at,c.row_version,
  to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at`;

export function toComment(row: CommentRow) {
  return contractSchemas.ArtifactComment.parse({
    id: row.id,
    artifactVersionId: row.artifact_version_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.deleted_at === null ? row.body : null,
    anchor: row.anchor === null ? null : redactCommentAnchor(
      contractSchemas.CommentAnchor.parse(row.anchor),
      row.deleted_at !== null,
    ),
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.row_version,
    rootId: row.parent_comment_id,
  });
}

export async function loadVersion(
  work: WorkTransaction,
  id: string,
  options: {
    readonly lock?: boolean;
    readonly bytes?: boolean;
    /**
     * Where a blob-backed version's bytes come from. Absent, a version with no
     * inline content reads as having none - which is what a purged version
     * looks like, and what every caller saw before versions could name a blob.
     */
    readonly blobStore?: OrganizationBlobStore;
  } = {},
): Promise<CommentVersion> {
  if (options.lock) {
    await work.transaction.query(
      `select a.id from bakery.artifacts a
      join bakery.artifact_versions v on v.organization_id=a.organization_id and v.artifact_id=a.id
      where v.organization_id=$1 and v.id=$2 for update of a`,
      [work.organizationId, id],
    );
  }
  const result = await work.transaction.query<CommentVersion>(
    `select v.id,v.artifact_id,v.task_id,v.blob_id,case when $3::boolean then v.content when v.content is null then null else ''::bytea end as content,
    v.media_type,v.sha256,v.size_bytes,v.subject_head_sha,v.subject_base_sha,t.conversation_id,t.application_id,t.repository_id
    from bakery.artifact_versions v join bakery.tasks t on t.organization_id=v.organization_id and t.id=v.task_id
    where v.organization_id=$1 and v.id=$2 and v.publication_status='current' ${
      options.lock ? "for update of v for share of t" : ""
    }`,
    [work.organizationId, id, options.bytes ?? false],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // A version that names a blob has no inline content, and every caller that
  // asked for bytes wants the bytes, not the storage shape. Resolving here
  // keeps that difference in one place instead of in each caller's null check.
  if (options.bytes && row.content === null && row.blob_id !== null) {
    if (!options.blobStore) {
      throw new StandardError({ code: "INTERNAL" });
    }
    const bytes = await options.blobStore.read(
      work.organizationId,
      row.sha256,
      Number(row.size_bytes),
    );
    await assertStoredBytes(
      { size_bytes: row.size_bytes, sha256: row.sha256 },
      bytes,
    );
    return { ...row, content: bytes };
  }
  return row;
}

export async function loadComment(
  work: WorkTransaction,
  id: string,
  lock = false,
): Promise<CommentRow> {
  const result = await work.transaction.query<CommentRow>(
    `select ${commentColumns} from bakery.artifact_comments c
    where c.organization_id=$1 and c.id=$2 ${lock ? "for update of c" : ""}`,
    [work.organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}
