import { MAX_ARTIFACT_BYTES } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { readBlobProbe } from "./blob-probes.ts";
import { storedMediaSafety } from "./media.ts";
import { assertStoredBytes } from "./stored-bytes.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import {
  hiddenArtifactIds,
  hiddenFromReviewer,
  hiddenVersionIds,
  reviewerIsolationOf,
} from "./reviewer-isolation.ts";

/** Not found for a reviewer session when the artifact is another step's transcript (O47). */
async function refuseHiddenArtifact(
  context: ActionContext,
  organizationId: string,
  artifactId: string,
): Promise<void> {
  const { transaction } = requireWorkTransaction(context);
  const isolation = await reviewerIsolationOf(
    transaction,
    context,
    organizationId,
  );
  const hidden = await hiddenArtifactIds(
    transaction,
    isolation,
    organizationId,
    [artifactId],
  );
  if (hidden.size) hiddenFromReviewer();
}

/** Not found for a reviewer session when the version is hidden from it (O47). */
async function refuseHiddenVersion(
  context: ActionContext,
  organizationId: string,
  versionId: string,
): Promise<void> {
  const { transaction } = requireWorkTransaction(context);
  const isolation = await reviewerIsolationOf(
    transaction,
    context,
    organizationId,
  );
  const hidden = await hiddenVersionIds(
    transaction,
    isolation,
    organizationId,
    [versionId],
  );
  if (hidden.size) hiddenFromReviewer();
}

const ARTIFACT_ORDERING = "createdAt:desc,id:desc";
const VERSION_ORDERING = "createdAt:desc,id:desc";
const MAX_PAGE_SIZE = 100;
const MAX_RANGE_HEADER_BYTES = 100;
/**
 * The largest blob-backed version a range request will read whole in order to
 * slice it. Above this the request is refused rather than served, because the
 * cost of serving it is the whole object in memory.
 */
const MAX_BLOB_RANGE_BYTES = 8 * 1024 * 1024;

type ArtifactRow = {
  id: string;
  task_id: string;
  artifact_type: string;
  name: string;
  current_version_id: string | null;
  pinned_at: Date | string | null;
  pinned_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};
type ArtifactCursorRow = ArtifactRow & {
  cursor_created_at: string;
};
type VersionRow = {
  retention_class: "transient" | "evidence";
  expires_at: Date | string | null;
  purged_at: Date | string | null;
  id: string;
  artifact_id: string;
  task_id: string;
  run_step_id: string | null;
  author_id: string;
  revision: number;
  subject_head_sha: string | null;
  subject_base_sha: string | null;
  metadata: unknown;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: Date | string;
  version: number;
  publication_status: "current" | "staged" | "refused";
  refused_kind_version_id: string | null;
  refused_rule_type: string | null;
  refused_reason: string | null;
};
type VersionCursorRow = VersionRow & {
  cursor_created_at: string;
};

type RangeSpec = {
  start: number | null;
  end: number | null;
};

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function pageSize(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return limit;
}

async function artifactBinding(
  organizationId: string,
  principalId: string,
  taskId: string | null,
  artifactType: string | null,
  repositoryId: string | null,
): Promise<CursorBinding> {
  return {
    action: "artifacts.list",
    principalId,
    organizationId,
    ordering: ARTIFACT_ORDERING,
    filters: await sha256Hex(
      canonicalJson({ artifactType, repositoryId, taskId }),
    ),
    schemaVersion: 1,
  };
}

function versionBinding(
  organizationId: string,
  principalId: string,
  artifactId: string,
): CursorBinding {
  return {
    action: "artifactVersions.list",
    principalId,
    organizationId,
    ordering: VERSION_ORDERING,
    filters: JSON.stringify({ artifactId }),
    schemaVersion: 1,
  };
}

function artifact(row: ArtifactRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    artifactType: row.artifact_type,
    name: row.name,
    currentVersionId: row.current_version_id,
    pinnedAt: row.pinned_at === null ? null : iso(row.pinned_at),
    pinnedBy: row.pinned_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function version(row: VersionRow) {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    revision: Number(row.revision),
    retentionClass: row.retention_class,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    purgedAt: row.purged_at === null ? null : iso(row.purged_at),
    runStepId: row.run_step_id,
    authorId: row.author_id,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    subjectHeadSha: row.subject_head_sha,
    subjectBaseSha: row.subject_base_sha,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.created_at),
    version: Number(row.version ?? 1),
    publicationStatus: row.publication_status,
    refusedKindVersionId: row.refused_kind_version_id,
    refusedRuleType: row.refused_rule_type,
    refusedReason: row.refused_reason,
  };
}

async function assertTask(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
) {
  const result = await transaction.query(
    "select id from bakery.tasks where organization_id=$1 and id=$2",
    [organizationId, taskId],
  );
  if (!result.rows.length) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export function parseRange(value: string | null): RangeSpec | null {
  if (value === null) return null;
  if (new TextEncoder().encode(value).byteLength > MAX_RANGE_HEADER_BYTES) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === "" && match[2] === "")) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const start = match[1] === "" ? null : Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (start !== null && !Number.isSafeInteger(start)) {
    return { start: Number.MAX_SAFE_INTEGER, end: null };
  }
  if (end !== null && !Number.isSafeInteger(end)) {
    return { start, end: Number.MAX_SAFE_INTEGER };
  }
  return { start, end };
}

export function resolveRange(
  range: RangeSpec,
  size: number,
): { start: number; end: number } | null {
  let start = range.start;
  let end = range.end;
  if (start === null) {
    start = Math.max(0, size - (end ?? 0));
    end = size - 1;
  } else {
    end = end ?? size - 1;
  }
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end < start || start >= size
  ) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function ifRangeMatches(value: string | null, sha256: string): boolean {
  return value === null || value.trim() === `"${sha256}"`;
}

export function ifNoneMatchMatches(
  value: string | null,
  sha256: string,
): boolean {
  if (value === null) return false;
  const etag = `"${sha256}"`;
  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

/**
 * Metadata of one readable artifact version: the same organization, task and
 * run-step scoping the content route uses. Purged content is
 * ARTIFACT_CONTENT_EXPIRED; anything malformed is INTERNAL.
 */
async function loadContentMetadata(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string | undefined,
) {
  const metadata = await transaction.query<
    Pick<VersionRow, "id" | "media_type" | "size_bytes" | "sha256"> & {
      purged_at: Date | null;
      blob_id: string | null;
    }
  >(
    `select v.id,v.media_type,v.size_bytes,v.sha256,v.purged_at,v.blob_id
           from bakery.artifact_versions v
           join bakery.artifacts a
             on a.organization_id=v.organization_id
            and a.id=v.artifact_id
            and a.task_id=v.task_id
           join bakery.tasks t
             on t.organization_id=v.organization_id and t.id=v.task_id
          where v.organization_id=$1
            and v.id=$2
            and (
              v.run_step_id is null or exists (
                select 1
                  from bakery.run_steps rs
                  join bakery.workflow_runs wr
                    on wr.organization_id=rs.organization_id and wr.id=rs.run_id
                 where rs.organization_id=v.organization_id
                   and rs.id=v.run_step_id
                   and wr.task_id=v.task_id
              )
            )`,
    [organizationId, versionId],
  );
  const row = metadata.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.purged_at !== null) {
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  const size = Number(row.size_bytes);
  const mediaSafety = storedMediaSafety(row.media_type);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_ARTIFACT_BYTES ||
    mediaSafety === null ||
    !/^[0-9a-f]{64}$/.test(row.sha256)
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return { row, size, mediaSafety };
}

type StoredVersion = Pick<VersionRow, "size_bytes" | "sha256">;

/**
 * The bytes of a version that carries them inline, checked against the digest
 * and size the version declares.
 *
 * The check is not ceremony: a version row is the server's claim about what its
 * bytes are, and a reader that served them without checking would turn a
 * corrupted row into a corrupted download with no way to tell which.
 */
async function readInlineBytes(
  stored: StoredVersion & { content: Buffer | null },
): Promise<Uint8Array> {
  if (stored.content === null) {
    // The XOR constraint makes this unreachable, and it is still refused rather
    // than assumed: a row with neither home is a row whose bytes cannot be
    // read, and guessing would hide the constraint being dropped.
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  await assertStoredBytes(stored, stored.content, {
    mismatch: "content-mismatch",
  });
  return stored.content;
}

function readInlineRange(
  stored: StoredVersion & {
    content: Buffer | null;
    content_size_bytes: number | null;
    content_sha256: string | null;
  },
  resolved: { start: number; end: number },
): Uint8Array {
  if (stored.content === null) {
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  const size = Number(stored.size_bytes);
  if (
    Number(stored.content_size_bytes) !== size ||
    stored.content_sha256 !== stored.sha256 ||
    stored.content.byteLength !== resolved.end - resolved.start + 1
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return stored.content;
}

/**
 * The bytes of a version that names a blob, read through the organization's
 * store and verified against the version's own digest and size.
 *
 * The store is asked for `(organizationId, sha256)` and never for a key, so a
 * version cannot name another organization's bytes even if its row were wrong:
 * the key is built from the organization the caller is already scoped to.
 */
export async function readBlobBytes(
  store: OrganizationBlobStore | undefined,
  organizationId: string,
  stored: StoredVersion,
): Promise<Uint8Array> {
  if (!store) {
    // A version that names a blob and a server with no store is a
    // misconfiguration, not a missing file: reporting it as expired would send
    // whoever reads it looking for a retention problem that does not exist.
    throw new StandardError({ code: "INTERNAL" });
  }
  const bytes = await store.read(
    organizationId,
    stored.sha256,
    Number(stored.size_bytes),
  );
  await assertStoredBytes(stored, bytes, { mismatch: "content-mismatch" });
  return bytes;
}

/**
 * A range of a blob-backed version.
 *
 * The store port has no ranged read yet, so this reads the whole object and
 * slices it. That is fine for the sizes a range request is actually used for -
 * a media player seeking, a client resuming a download - and it is a memory
 * blowout for a 1 KiB range on a 2 GiB object, which is why it is bounded
 * rather than merely documented. Over the ceiling the request is refused with a
 * typed code, so a client learns the server will not serve that range instead
 * of the server discovering it by running out of memory.
 *
 * The ranged read belongs on the port, and it rides the streaming-port row
 * rather than widening this one.
 */
export async function readBlobRange(
  store: OrganizationBlobStore | undefined,
  organizationId: string,
  stored: StoredVersion,
  resolved: { start: number; end: number },
): Promise<Uint8Array> {
  if (Number(stored.size_bytes) > MAX_BLOB_RANGE_BYTES) {
    throw new StandardError({ code: "RANGE_NOT_SATISFIABLE" });
  }
  const bytes = await readBlobBytes(store, organizationId, stored);
  return bytes.subarray(resolved.start, resolved.end + 1);
}

export function createArtifactReadHandlers(
  secret: string,
  blobStore?: OrganizationBlobStore,
) {
  return {
    async listArtifacts(
      context: ActionContext,
      input: {
        taskId?: string;
        repositoryId?: string;
        artifactType?: string;
        cursor?: string;
        limit?: number;
      },
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      if (input.taskId) {
        await assertTask(transaction, organizationId, input.taskId);
      }
      const limit = pageSize(input.limit);
      const binding = await artifactBinding(
        organizationId,
        principalId,
        input.taskId ?? null,
        input.artifactType ?? null,
        input.repositoryId ?? null,
      );
      const position = await decodeCursor(secret, input.cursor, binding);
      const result = await transaction.query<ArtifactCursorRow>(
        `select a.id,a.task_id,a.artifact_type,a.name,a.current_version_id,
                a.created_at,a.updated_at,a.version,a.pinned_at,a.pinned_by,
                to_char(
                  a.created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) as cursor_created_at
           from bakery.artifacts a
          where a.organization_id=$1
            and ($2::uuid is null or a.task_id=$2)
            and ($3::uuid is null or exists (
              select 1 from bakery.tasks t
               where t.organization_id=a.organization_id
                 and t.id=a.task_id
                 and t.repository_id=$3
            ))
            and ($4::text is null or a.artifact_type=$4)
            and ($5::timestamptz is null or (a.created_at,a.id)<($5,$6::uuid))
          order by a.created_at desc,a.id desc
          limit $7`,
        [
          organizationId,
          input.taskId ?? null,
          input.repositoryId ?? null,
          input.artifactType ?? null,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const page = result.rows.slice(0, limit);
      // A reviewer's list leaves out other steps' transcripts (O47); the
      // cursor follows the unfiltered page.
      const hidden = await hiddenArtifactIds(
        transaction,
        await reviewerIsolationOf(transaction, context, organizationId),
        organizationId,
        page.map((row) => row.id),
      );
      const items = page.filter((row) => !hidden.has(row.id));
      const last = page.at(-1);
      return {
        items: items.map(artifact),
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            createdAt: last.cursor_created_at,
            id: last.id,
          })
          : null,
      };
    },

    async getArtifact(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const result = await transaction.query<ArtifactRow>(
        `select a.id,a.task_id,a.artifact_type,a.name,a.current_version_id,
                a.created_at,a.updated_at,a.version,a.pinned_at,a.pinned_by
           from bakery.artifacts a
           join bakery.tasks t
             on t.organization_id=a.organization_id and t.id=a.task_id
          where a.organization_id=$1 and a.id=$2`,
        [organizationId, context.params.id],
      );
      if (!result.rows[0]) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      await refuseHiddenArtifact(context, organizationId, result.rows[0].id);
      return artifact(result.rows[0]);
    },

    async listArtifactVersions(
      context: ActionContext,
      input: { cursor?: string; limit?: number },
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const artifactId = context.params.id;
      const parent = await transaction.query<{ task_id: string }>(
        `select a.task_id
           from bakery.artifacts a
           join bakery.tasks t
             on t.organization_id=a.organization_id and t.id=a.task_id
          where a.organization_id=$1 and a.id=$2`,
        [organizationId, artifactId],
      );
      const taskId = parent.rows[0]?.task_id;
      if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      await refuseHiddenArtifact(context, organizationId, String(artifactId));
      const limit = pageSize(input.limit);
      const binding = versionBinding(organizationId, principalId, artifactId);
      const position = await decodeCursor(secret, input.cursor, binding);
      const result = await transaction.query<VersionCursorRow>(
        `select v.id,v.artifact_id,v.task_id,v.run_step_id,v.author_id,v.revision,
                v.subject_head_sha,v.subject_base_sha,v.metadata,v.media_type,
                v.size_bytes,v.sha256,v.created_at,v.retention_class,v.expires_at,v.purged_at,1 as version,
                v.publication_status,v.refused_kind_version_id,v.refused_rule_type,v.refused_reason,
                to_char(
                  v.created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) as cursor_created_at
           from bakery.artifact_versions v
           join bakery.artifacts a
             on a.organization_id=v.organization_id
            and a.id=v.artifact_id
            and a.task_id=v.task_id
           join bakery.tasks t
             on t.organization_id=v.organization_id and t.id=v.task_id
          where v.organization_id=$1
            and v.artifact_id=$2
            and v.task_id=$3
            -- A staged version waits for its probe and a refused one failed it
            -- (O29): neither is a version of the artifact a list shows.
            and v.publication_status='current'
            and (
              v.run_step_id is null or exists (
                select 1
                  from bakery.run_steps rs
                  join bakery.workflow_runs wr
                    on wr.organization_id=rs.organization_id and wr.id=rs.run_id
                 where rs.organization_id=v.organization_id
                   and rs.id=v.run_step_id
                   and wr.task_id=v.task_id
              )
            )
            and ($4::timestamptz is null or (v.created_at,v.id)<($4,$5::uuid))
          order by v.created_at desc,v.id desc
          limit $6`,
        [
          organizationId,
          artifactId,
          taskId,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const items = result.rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(version),
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            createdAt: last.cursor_created_at,
            id: last.id,
          })
          : null,
      };
    },

    /**
     * The version a content read would return, without its bytes: what an
     * MCP client gets instead of content, so no blob enters a model prompt.
     */
    async readArtifactVersionReference(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const { row, size } = await loadContentMetadata(
        transaction,
        organizationId,
        context.params.id,
      );
      await refuseHiddenVersion(context, organizationId, row.id);
      return {
        versionId: row.id,
        sha256: row.sha256,
        sizeBytes: size,
        mediaType: row.media_type,
      };
    },

    /**
     * What the probe learned about this version's bytes, or nulls.
     *
     * A flat answer rather than the probe's own union: the wire shape says one
     * thing per fact and `null` for "not measured", which is what the facts
     * line needs. Nothing here runs a probe -- an unasked blob reads as null
     * and the client decides whether to show a state or ask again.
     */
    async readArtifactProbe(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const { row } = await loadContentMetadata(
        transaction,
        organizationId,
        context.params.id,
      );
      // The runner keys a store-less version's answer on the version itself, so
      // stopping here left every such version reading as never probed.
      const stored = await readBlobProbe(transaction, {
        organizationId,
        ...(row.blob_id === null
          ? { artifactVersionId: row.id }
          : { blobId: row.blob_id }),
      });
      if (stored === null) {
        return {
          status: null,
          kind: null,
          mediaType: null,
          byteLength: null,
          width: null,
          height: null,
          durationMs: null,
          lineCount: null,
          utf8: null,
          code: null,
          limit: null,
          probedAt: null,
        };
      }
      const { result, probedAt } = stored;
      const described = result.status === "described" ? result : null;
      const refused = result.status === "refused" ? result : null;
      return {
        status: result.status,
        kind: described?.kind ?? null,
        mediaType: described?.mediaType ?? null,
        byteLength: described?.byteLength ?? null,
        width: described?.width ?? null,
        height: described?.height ?? null,
        durationMs: described?.durationMs ?? null,
        lineCount: described?.lineCount ?? null,
        utf8: described?.utf8 ?? null,
        code: refused?.code ?? null,
        limit: refused?.limit ?? null,
        probedAt: probedAt.toISOString(),
      };
    },

    async readArtifactContent(context: ActionContext) {
      const rangeHeader = context.request.headers.get("range");
      const ifRange = context.request.headers.get("if-range");
      const ifNoneMatch = context.request.headers.get("if-none-match");
      const { transaction, organizationId } = requireWorkTransaction(context);
      const { row, size } = await loadContentMetadata(
        transaction,
        organizationId,
        context.params.id,
      );
      await refuseHiddenVersion(context, organizationId, row.id);
      const headers = new Headers({
        "Content-Type": row.media_type,
        "Content-Length": String(size),
        "Content-Disposition": 'attachment; filename="artifact.bin"',
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "no-store",
        "ETag": `"${row.sha256}"`,
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
      });
      if (ifNoneMatchMatches(ifNoneMatch, row.sha256)) {
        return new Response(null, { status: 304, headers });
      }
      const range = ifRangeMatches(ifRange, row.sha256)
        ? parseRange(rangeHeader)
        : null;
      if (range) {
        const resolved = resolveRange(range, size);
        if (!resolved) {
          headers.set("Content-Length", "0");
          headers.set("Content-Range", `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }
        const content = await transaction.query<
          Pick<VersionRow, "size_bytes" | "sha256"> & {
            content_size_bytes: number | null;
            content_sha256: string | null;
            content: Buffer | null;
            blob_id: string | null;
          }
        >(
          `select v.size_bytes,v.sha256,v.blob_id,
                  octet_length(v.content) as content_size_bytes,
                  encode(sha256(v.content), 'hex') as content_sha256,
                  substring(v.content from $3::integer for $4::integer) as content
             from bakery.artifact_versions v
             join bakery.artifacts a
               on a.organization_id=v.organization_id
              and a.id=v.artifact_id
              and a.task_id=v.task_id
             join bakery.tasks t
               on t.organization_id=v.organization_id and t.id=v.task_id
            where v.organization_id=$1
              and v.id=$2
              and (
                v.run_step_id is null or exists (
                  select 1
                    from bakery.run_steps rs
                    join bakery.workflow_runs wr
                      on wr.organization_id=rs.organization_id and wr.id=rs.run_id
                   where rs.organization_id=v.organization_id
                   and rs.id=v.run_step_id
                     and wr.task_id=v.task_id
                )
              )`,
          [
            organizationId,
            context.params.id,
            resolved.start + 1,
            resolved.end - resolved.start + 1,
          ],
        );
        const stored = content.rows[0];
        if (!stored) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        if (
          Number(stored.size_bytes) !== size || stored.sha256 !== row.sha256
        ) {
          throw new StandardError({ code: "INTERNAL" });
        }
        // A version names its bytes in exactly one place. A blob-backed version
        // has no `content` at all, so the bytea branch below is not a fallback
        // for it - it is a different row shape, and reading it as "expired"
        // would report a healthy version as gone.
        const ranged = stored.blob_id === null
          ? readInlineRange(stored, resolved)
          : await readBlobRange(blobStore, organizationId, stored, resolved);
        headers.set("Content-Length", String(ranged.byteLength));
        headers.set(
          "Content-Range",
          `bytes ${resolved.start}-${resolved.end}/${size}`,
        );
        return new Response(ranged as unknown as BodyInit, {
          status: 206,
          headers,
        });
      }
      const content = await transaction.query<
        Pick<VersionRow, "size_bytes" | "sha256"> & {
          content: Buffer | null;
          blob_id: string | null;
        }
      >(
        `select v.size_bytes,v.sha256,v.content,v.blob_id
           from bakery.artifact_versions v
           join bakery.artifacts a
             on a.organization_id=v.organization_id
            and a.id=v.artifact_id
            and a.task_id=v.task_id
           join bakery.tasks t
             on t.organization_id=v.organization_id and t.id=v.task_id
          where v.organization_id=$1
            and v.id=$2
            and (
              v.run_step_id is null or exists (
                select 1
                  from bakery.run_steps rs
                  join bakery.workflow_runs wr
                    on wr.organization_id=rs.organization_id and wr.id=rs.run_id
                 where rs.organization_id=v.organization_id
                   and rs.id=v.run_step_id
                   and wr.task_id=v.task_id
              )
            )`,
        [organizationId, context.params.id],
      );
      const stored = content.rows[0];
      if (!stored) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (Number(stored.size_bytes) !== size || stored.sha256 !== row.sha256) {
        throw new StandardError({ code: "INTERNAL" });
      }
      const bytes = stored.blob_id === null
        ? await readInlineBytes(stored)
        : await readBlobBytes(blobStore, organizationId, stored);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers,
      });
    },
  };
}
