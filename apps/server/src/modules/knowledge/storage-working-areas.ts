/**
 * Working areas over the storage tree (chapter 25 sections 17.1, 17.4 and
 * 17.5, slice F5, #447): put (and upload, which is a put naming a completed
 * blob), mkdir, cp, mv, rm to trash, restore, the trash listing, the
 * organization's storage limits and quotas, and the Admin purge.
 *
 * It builds on #444's entries: one tree, one entry model. A record-area file
 * stays a pointer to its artifact; a file written into a working, personal or
 * scratch area has its versions in bakery.storage_file_versions, each naming a
 * blob or carrying small inline bytes. The folder policy rules are the pure
 * functions in storage-areas.ts; this module only applies them.
 *
 * Every handler runs inside the action's work transaction, scoped to the
 * caller's organization. An id from another organization, or a personal entry
 * of another member, is RESOURCE_NOT_FOUND, never a refusal that confirms it.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  type AgentWrite,
  type StepWriteOp,
  StepWriteOp as WriteOp,
  stepWriteSetRow,
  storageAuditActor,
} from "./agent-file-scope.ts";
import { agentFileWriteFor, refuseAgentPath } from "./agent-file-guard.ts";
import { sha256Bytes } from "./bytes.ts";
import { enqueueProbeSubject } from "./probe-runner.ts";
import {
  attemptVersionProvenance,
  type VersionProvenance,
} from "./version-provenance.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  admitsWrite,
  type AreaEntry,
  type AreaRefusal,
  changeRefusal,
  childPolicy,
  DEFAULT_STORAGE_LIMITS,
  invalidLimit,
  isVisibleTo,
  quotaState,
  revisionsToPrune,
  scopeKeyFromAncestors,
  stepWriteLimitRefusal,
  type StorageLimits,
  writeRefusal,
} from "./storage-areas.ts";
import {
  ensureOrganizationTree,
  normalizeEntryName,
  parseStoragePath,
  StorageNameError,
  type StoragePolicy,
  storageQueryOf,
} from "./storage-tree.ts";
import { mayEditAt, mayViewAt } from "./folder-access-store.ts";
import {
  type EntryNow,
  planStepUndo,
  type RecordedWrite,
  UndoAction,
} from "./step-write-undo.ts";

/** Largest file a put may carry inline as base64; larger files upload a blob. */
export const MAX_INLINE_FILE_BYTES = 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const TRASH_ORDERING = "trashedAt:desc,id:desc";

type Row = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: "folder" | "file";
  policy: StoragePolicy;
  artifact_id: string | null;
  system_key: string | null;
  version: number;
  owner_id: string | null;
  scope_key: string | null;
  current_version_id: string | null;
  trashed_at: Date | null;
  trash_parent_id: string | null;
  trash_name: string | null;
  purged_at: Date | null;
  updated_at: Date;
  restricted: boolean;
};

const COLUMN_NAMES = [
  "id",
  "parent_id",
  "name",
  "kind",
  "policy",
  "artifact_id",
  "system_key",
  "version",
  "owner_id",
  "scope_key",
  "current_version_id",
  "trashed_at",
  "trash_parent_id",
  "trash_name",
  "purged_at",
  "updated_at",
  "restricted",
];
const COLUMNS = COLUMN_NAMES.join(", ");
const ENTRY_COLUMNS = COLUMN_NAMES.map((name) => "entry." + name).join(", ");

function area(row: Row): AreaEntry {
  return {
    policy: row.policy,
    ownerId: row.owner_id,
    systemKey: row.system_key,
  };
}

function refuse(reason: AreaRefusal): never {
  throw new StandardError({ code: "STORAGE_AREA_REFUSED", params: { reason } });
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function unprocessable(field: string, reason: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [field], message: reason, code: reason }] },
  });
}

function parsePath(path: string) {
  try {
    return parseStoragePath(path);
  } catch (error) {
    if (error instanceof StorageNameError) {
      unprocessable("path", error.reason);
    }
    throw error;
  }
}

function expectedVersion(context: ActionContext): number | undefined {
  try {
    return requireCommandMetadata(context).expectedVersion;
  } catch {
    return undefined;
  }
}

function requireExpectedVersion(context: ActionContext, row: Row): void {
  const expected = expectedVersion(context);
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (expected !== Number(row.version)) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lockEntry(
  tx: PgTransactionClient,
  organizationId: string,
  id: string,
): Promise<Row | undefined> {
  if (!UUID.test(id)) return undefined;
  const found = await tx.query<Row>(
    "select " + COLUMNS + " from bakery.storage_entries" +
      " where organization_id = $1 and id = $2 for update",
    [organizationId, id],
  );
  return found.rows[0];
}

/** A visible, live entry by id, locked; 404 for anything else. */
async function visibleEntry(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  id: string,
): Promise<Row> {
  const row = await lockEntry(tx, organizationId, id);
  if (!row || row.purged_at !== null || !isVisibleTo(area(row), principalId)) {
    notFound();
  }
  if (!(await mayViewAt(tx, organizationId, principalId, row.id))) notFound();
  if (
    row.trash_parent_id !== null &&
    !(await mayViewAt(tx, organizationId, principalId, row.trash_parent_id))
  ) notFound();
  return row;
}

async function requireEdit(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  folderId: string,
): Promise<void> {
  if (!(await mayEditAt(tx, organizationId, principalId, folderId))) {
    refuse("folder_view_only");
  }
}

/** Resolves absolute path segments one by one to a live, visible entry. */
async function resolvePath(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  segments: { nameKey: string }[],
): Promise<Row | undefined> {
  let parentId: string | null = null;
  let row: Row | undefined;
  for (const segment of segments) {
    const found: { rows: Row[] } = await tx.query<Row>(
      "select " + COLUMNS + " from bakery.storage_entries" +
        " where organization_id = $1 and parent_id is not distinct from $2" +
        " and name_key = $3",
      [organizationId, parentId, segment.nameKey],
    );
    row = found.rows[0];
    if (!row || row.purged_at !== null) return undefined;
    if (!isVisibleTo(area(row), principalId)) return undefined;
    parentId = row.id;
  }
  if (row && !(await mayViewAt(tx, organizationId, principalId, row.id))) {
    return undefined;
  }
  return row;
}

/**
 * The caller's personal folder, /users/<principal id> with uploads and
 * scratch, made on first use. Owner only; scratch expires (section 17.1).
 */
export async function ensurePersonalFolder(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const top = await ensureOrganizationTree(storageQueryOf(tx), organizationId);
  const scope = "user:" + principalId;
  const make = async (
    parentId: string,
    name: string,
    policy: StoragePolicy,
    systemKey: string,
  ) => {
    await tx.query(
      "insert into bakery.storage_entries" +
        " (organization_id, parent_id, name, name_key, kind, policy," +
        " system_key, owner_id, scope_key)" +
        " values ($1, $2, $3, $3, 'folder', $4, $5, $6, $7)" +
        " on conflict do nothing",
      [organizationId, parentId, name, policy, systemKey, principalId, scope],
    );
    const found = await tx.query<{ id: string }>(
      "select id from bakery.storage_entries" +
        " where organization_id = $1 and system_key = $2",
      [organizationId, systemKey],
    );
    if (!found.rows[0]) throw new Error("STORAGE_PERSONAL_FOLDER_UNAVAILABLE");
    return found.rows[0].id;
  };
  const root = await make(top.get("users")!, principalId, "personal", scope);
  await make(root, "uploads", "personal", scope + ":uploads");
  await make(root, "scratch", "scratch", scope + ":scratch");
  return root;
}

/** Makes the tree and the caller's personal folder exist before a write. */
async function prepareTree(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<Map<string, string>> {
  const top = await ensureOrganizationTree(storageQueryOf(tx), organizationId);
  await ensurePersonalFolder(tx, organizationId, principalId);
  return top;
}

const UP_FROM = "with recursive up as (" +
  " select id, parent_id, name, system_key, trashed_at, 0 as depth" +
  " from bakery.storage_entries where organization_id = $1 and id = $2" +
  " union all" +
  " select e.id, e.parent_id, e.name, e.system_key, e.trashed_at, up.depth + 1" +
  " from bakery.storage_entries e" +
  " join up on e.organization_id = $1 and e.id = up.parent_id" +
  " where up.depth < 64)";

const DOWN_FROM = "with recursive down as (" +
  " select id, 0 as depth from bakery.storage_entries" +
  " where organization_id = $1 and id = $2" +
  " union all" +
  " select e.id, down.depth + 1 from bakery.storage_entries e" +
  " join down on e.organization_id = $1 and e.parent_id = down.id" +
  " where down.depth < 64)";

/**
 * The quota scope a child of this folder counts against: the folder's own, or
 * the nearest project or personal folder above it.
 */
async function scopeOf(
  tx: PgTransactionClient,
  organizationId: string,
  folder: Row,
): Promise<string | null> {
  if (folder.scope_key !== null) return folder.scope_key;
  const ancestors = await tx.query<{ system_key: string | null }>(
    UP_FROM + " select system_key from up order by depth",
    [organizationId, folder.id],
  );
  return scopeKeyFromAncestors(ancestors.rows.map((row) => row.system_key));
}

/** The organization's storage limits: its settings row, or the defaults. */
export async function readStorageLimits(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
): Promise<StorageLimits & { version: number; customized: boolean }> {
  const found = await tx.query<Record<string, string | number | null>>(
    "select working_versions_kept, trash_retention_days," +
      " scratch_retention_days, max_file_bytes::text," +
      " organization_quota_bytes::text, project_quota_bytes::text," +
      " personal_quota_bytes::text, step_write_bytes::text," +
      " step_write_files, version" +
      " from bakery.storage_settings where organization_id = $1",
    [organizationId],
  );
  const row = found.rows[0];
  if (!row) {
    return { ...DEFAULT_STORAGE_LIMITS, version: 0, customized: false };
  }
  return {
    workingVersionsKept: Number(row.working_versions_kept),
    trashRetentionDays: Number(row.trash_retention_days),
    scratchRetentionDays: Number(row.scratch_retention_days),
    maxFileBytes: Number(row.max_file_bytes),
    organizationQuotaBytes: Number(row.organization_quota_bytes),
    projectQuotaBytes: Number(row.project_quota_bytes),
    personalQuotaBytes: Number(row.personal_quota_bytes),
    // Null is the default (migration 0286), so a saved row follows it.
    stepWriteBytes: row.step_write_bytes === null
      ? DEFAULT_STORAGE_LIMITS.stepWriteBytes
      : Number(row.step_write_bytes),
    stepWriteFiles: row.step_write_files === null
      ? DEFAULT_STORAGE_LIMITS.stepWriteFiles
      : Number(row.step_write_files),
    version: Number(row.version),
    customized: true,
  };
}

/**
 * Bytes stored by working-area file versions, for the organization or one
 * scope. Trashed files count until the sweep or a purge removes them.
 */
async function usedBytes(
  tx: PgTransactionClient,
  organizationId: string,
  scopeKey: string | null,
): Promise<number> {
  const found = await tx.query<{ used: string }>(
    "select coalesce(sum(v.size_bytes), 0)::text as used" +
      " from bakery.storage_file_versions v" +
      " join bakery.storage_entries e" +
      " on e.organization_id = v.organization_id and e.id = v.entry_id" +
      " where v.organization_id = $1" +
      " and ($2::text is null or e.scope_key = $2)",
    [organizationId, scopeKey],
  );
  return Number(found.rows[0].used);
}

function quotaRefusal(scopeKey: string | null): never {
  throw new StandardError({
    code: "STORAGE_QUOTA_EXCEEDED",
    params: {
      reason: scopeKey === null
        ? "organization"
        : scopeKey.startsWith("project:")
        ? "project"
        : "personal",
    },
  });
}

/**
 * Refuses a write of addedBytes that would pass a quota's pause line: the
 * organization's, and the project's or personal folder's it lands in.
 */
async function assertQuota(
  tx: PgTransactionClient,
  organizationId: string,
  scopeKey: string | null,
  addedBytes: number,
  limits: StorageLimits,
  options: { organization: boolean } = { organization: true },
): Promise<void> {
  if (addedBytes <= 0) return;
  // One writer at a time per organization decides against the same total, so
  // two concurrent writes cannot both squeeze under the line.
  await tx.query(
    "select pg_advisory_xact_lock(hashtext('storage-quota:' || $1))",
    [organizationId],
  );
  if (options.organization) {
    const used = await usedBytes(tx, organizationId, null);
    if (!admitsWrite(used, addedBytes, limits.organizationQuotaBytes)) {
      quotaRefusal(null);
    }
  }
  if (scopeKey === null) return;
  const limit = scopeKey.startsWith("project:")
    ? limits.projectQuotaBytes
    : limits.personalQuotaBytes;
  const used = await usedBytes(tx, organizationId, scopeKey);
  if (!admitsWrite(used, addedBytes, limit)) quotaRefusal(scopeKey);
}

/**
 * Refuses an agent write that would take its run step attempt past the step
 * write limits (O49): the distinct entries and the bytes the attempt already
 * wrote, from its write set, plus this write. A person's own write (agent
 * null) is never limited. Identical-bytes puts record no write-set row, so
 * they neither count nor reach here.
 *
 * Race-safe: it takes the same per-organization storage lock assertQuota
 * takes, before counting, and holds it to commit. The write-set row of this
 * write is inserted later in the same transaction, so a concurrent write of
 * the same attempt waits on the lock until this one commits and then counts
 * its row (each statement under READ COMMITTED sees rows committed before it
 * began). A transaction-level advisory lock is re-entrant, so taking it again
 * after assertQuota costs nothing.
 */
async function assertStepWriteLimit(
  tx: PgTransactionClient,
  organizationId: string,
  agent: AgentWrite | null,
  entryId: string,
  addedBytes: number,
  limits: StorageLimits,
): Promise<void> {
  if (agent === null) return;
  await tx.query(
    "select pg_advisory_xact_lock(hashtext('storage-quota:' || $1))",
    [organizationId],
  );
  // Bytes count once per version a put or copy made; a move or trash names
  // the version it already had and adds none.
  const found = await tx.query<
    { files: string; bytes: string; written: boolean }
  >(
    "select count(distinct w.entry_id)::text as files," +
      // bytes_written is kept on the row, so a version retention later
      // deletes still counts against the step.
      " coalesce(sum(w.bytes_written), 0)::text as bytes," +
      " coalesce(bool_or(w.entry_id = $3), false) as written" +
      " from bakery.step_write_set w" +
      " where w.organization_id = $1 and w.attempt_id = $2",
    [organizationId, agent.attemptId, entryId],
  );
  const row = found.rows[0];
  const reason = stepWriteLimitRefusal(
    { files: Number(row.files), bytes: Number(row.bytes) },
    { newEntry: !row.written, addedBytes },
    limits,
  );
  if (reason === undefined) return;
  throw new StandardError({
    code: "STEP_WRITE_LIMIT_EXCEEDED",
    params: {
      reason,
      limit: reason === "files" ? limits.stepWriteFiles : limits.stepWriteBytes,
    },
  });
}

type FileBytes = {
  blobId: string | null;
  content: Uint8Array | null;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

function decodeBase64(content: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(content);
  } catch {
    unprocessable("content", "invalid_base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function putBytes(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: { blobId?: string; content?: string; mediaType: string },
): Promise<FileBytes> {
  if ((input.blobId === undefined) === (input.content === undefined)) {
    unprocessable("content", "exactly_one_of_content_or_blob");
  }
  if (input.blobId !== undefined) {
    // Only the caller's own completed upload. Blobs are deduplicated across
    // the organization, so a bare blob id could name bytes the caller cannot
    // read; anything else is 404, never a sign that the blob exists.
    if (!UUID.test(input.blobId)) notFound();
    const found = await tx.query<
      { id: string; sha256: string; size_bytes: string }
    >(
      "select blob.id, blob.sha256, blob.size_bytes::text" +
        " from bakery.blobs blob" +
        " where blob.organization_id = $1 and blob.id = $2" +
        " and exists (select 1 from bakery.blob_upload_sessions upload" +
        " where upload.organization_id = $1" +
        " and upload.completed_blob_id = blob.id" +
        " and upload.state = 'completed' and upload.created_by_id = $3)",
      [organizationId, input.blobId, principalId],
    );
    const blob = found.rows[0];
    if (!blob) notFound();
    return {
      blobId: blob.id,
      content: null,
      sha256: blob.sha256,
      sizeBytes: Number(blob.size_bytes),
      mediaType: input.mediaType,
    };
  }
  const content = decodeBase64(input.content!);
  if (content.byteLength > MAX_INLINE_FILE_BYTES) {
    unprocessable("content", "inline_too_large");
  }
  return {
    blobId: null,
    content,
    sha256: await sha256Bytes(content),
    sizeBytes: content.byteLength,
    mediaType: input.mediaType,
  };
}

/** Writes a new version of a working-area file and prunes what policy drops. */
async function appendVersion(
  tx: PgTransactionClient,
  input: {
    organizationId: string;
    principalId: string;
    entry: Row;
    bytes: FileBytes;
    limits: StorageLimits;
    /** The agent step that produced the version; null for a person's. */
    provenance: VersionProvenance | null;
  },
): Promise<string> {
  const revision = await tx.query<{ next: number }>(
    "select coalesce(max(revision), 0) + 1 as next" +
      " from bakery.storage_file_versions" +
      " where organization_id = $1 and entry_id = $2",
    [input.organizationId, input.entry.id],
  );
  const revisionNumber = revision.rows[0].next;
  const inserted = await tx.query<{ id: string }>(
    "insert into bakery.storage_file_versions" +
      " (organization_id, entry_id, revision, blob_id, content, sha256," +
      " size_bytes, media_type, author_id, run_id, run_step_id, attempt_id," +
      " agent_session_id, acting_for_principal_id)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)" +
      " returning id",
    [
      input.organizationId,
      input.entry.id,
      revisionNumber,
      input.bytes.blobId,
      input.bytes.content,
      input.bytes.sha256,
      input.bytes.sizeBytes,
      input.bytes.mediaType,
      input.principalId,
      input.provenance?.runId ?? null,
      input.provenance?.runStepId ?? null,
      input.provenance?.attemptId ?? null,
      input.provenance?.agentSessionId ?? null,
      input.provenance?.actingForPrincipalId ?? null,
    ],
  );
  // A blob-backed version is asked about once however many versions share the
  // bytes; an inline version is its own subject, because nothing else has them.
  await enqueueProbeSubject(
    tx,
    input.bytes.blobId === null
      ? {
        organizationId: input.organizationId,
        entryId: input.entry.id,
        revision: revisionNumber,
      }
      : { organizationId: input.organizationId, blobId: input.bytes.blobId },
  );
  await tx.query(
    "update bakery.storage_entries" +
      " set current_version_id = $3, version = version + 1, updated_at = now()" +
      " where organization_id = $1 and id = $2",
    [input.organizationId, input.entry.id, inserted.rows[0].id],
  );
  const revisions = await tx.query<{ revision: number }>(
    "select revision from bakery.storage_file_versions" +
      " where organization_id = $1 and entry_id = $2",
    [input.organizationId, input.entry.id],
  );
  const prune = revisionsToPrune(
    input.entry.policy,
    revisions.rows.map((row) => Number(row.revision)),
    input.limits.workingVersionsKept,
  );
  if (prune.length > 0) {
    await tx.query(
      "delete from bakery.storage_file_versions" +
        " where organization_id = $1 and entry_id = $2" +
        " and revision = any($3::int[])",
      [input.organizationId, input.entry.id, prune],
    );
  }
  return inserted.rows[0].id;
}

type ProjectedRow = Row & {
  path: string;
  sha256: string | null;
  size_bytes: string | null;
  media_type: string | null;
  revision: number | null;
  trashed_by_id: string | null;
  trashed_by_name: string | null;
  deletion_requested_at: Date | null;
};

/** Path of a folder, for where a trashed entry came from. */
async function folderPath(
  tx: PgTransactionClient,
  organizationId: string,
  id: string,
): Promise<string> {
  const found = await tx.query<{ path: string }>(
    UP_FROM +
      " select '/' || string_agg(name, '/' order by depth desc) as path from up",
    [organizationId, id],
  );
  return found.rows[0].path;
}

/** An entry as the API returns it. */
async function project(
  tx: PgTransactionClient,
  organizationId: string,
  id: string,
) {
  const found = await tx.query<ProjectedRow>(
    UP_FROM + " select " + ENTRY_COLUMNS + "," +
      " (select '/' || string_agg(name, '/' order by depth desc) from up)" +
      " as path, v.sha256, v.size_bytes::text, v.media_type, v.revision," +
      " entry.trashed_by_id, who.display_name as trashed_by_name," +
      " request.requested_at as deletion_requested_at" +
      " from bakery.storage_entries entry" +
      " left join bakery.storage_purge_requests request" +
      " on request.organization_id = entry.organization_id" +
      " and request.entry_id = entry.id and request.completed_at is null" +
      " left join bakery.storage_file_versions v" +
      " on v.organization_id = entry.organization_id" +
      " and v.id = entry.current_version_id" +
      " left join bakery.principals who on who.id = entry.trashed_by_id" +
      " where entry.organization_id = $1 and entry.id = $2",
    [organizationId, id],
  );
  const row = found.rows[0];
  return entryView(
    row,
    row.trash_parent_id === null
      ? null
      : await folderPath(tx, organizationId, row.trash_parent_id),
  );
}

/** The StorageEntry shape, from a projected row and its original folder path. */
function entryView(row: ProjectedRow, originalFolderPath: string | null) {
  return {
    id: row.id,
    parentId: row.parent_id,
    path: row.path,
    name: row.name,
    kind: row.kind,
    policy: row.policy,
    artifactId: row.artifact_id,
    currentVersionId: row.current_version_id,
    revision: row.revision === null ? null : Number(row.revision),
    sha256: row.sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    mediaType: row.media_type,
    trashedAt: row.trashed_at?.toISOString() ?? null,
    restoreParentId: row.trash_parent_id,
    originalName: row.trash_name,
    originalFolderPath,
    trashedById: row.trashed_by_id,
    trashedByName: row.trashed_by_name,
    deletionRequestedAt: row.deletion_requested_at?.toISOString() ?? null,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function audit(
  tx: PgTransactionClient,
  context: ActionContext,
  input: {
    organizationId: string;
    principalId: string;
    operation: string;
    entryId: string;
    details: Record<string, unknown>;
    /** The allowed agent write, or null for a person's own request. */
    agent?: AgentWrite | null;
    /**
     * What the write did to the entry, for the step write set: the operation
     * and the entry's current version before and after it.
     */
    write?: Readonly<{
      op: StepWriteOp;
      previousVersionId: string | null;
      newVersionId: string | null;
      previousParentId?: string | null;
      previousName?: string | null;
      entryVersionBefore?: number | null;
    }>;
  },
): Promise<void> {
  // The same actor keys for a person and an agent (O50, R1): the principal,
  // the token, the attempt, the agent session and the grant, null where they
  // do not apply, so one reader reads both.
  const actor = storageAuditActor(
    attributeAction(context, input.principalId),
    input.agent ?? null,
  );
  await appendAudit(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    agentSessionId: actor.agentSessionId,
    operation: input.operation,
    resourceType: "storage_entry",
    resourceId: input.entryId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { ...input.details, actor },
  });
  // The step write set: one row per agent write, in the write's transaction.
  if (input.write !== undefined) {
    const row = stepWriteSetRow(input.agent ?? null, {
      organizationId: input.organizationId,
      entryId: input.entryId,
      ...input.write,
    });
    if (row !== null) await recordStepWrite(tx, row);
  }
}

/**
 * Inserts one write-set row. A previous version the write's own pruning just
 * deleted is recorded as null, as its foreign key would leave it.
 */
async function recordStepWrite(
  tx: PgTransactionClient,
  row: NonNullable<ReturnType<typeof stepWriteSetRow>>,
): Promise<void> {
  await tx.query(
    "insert into bakery.step_write_set" +
      " (organization_id, attempt_id, agent_session_id, entry_id, op," +
      " previous_version_id, new_version_id, bytes_written," +
      " previous_parent_id, previous_name, entry_version_before," +
      " entry_version_after)" +
      " select $1, $2, $3, $4, $5," +
      " (select id from bakery.storage_file_versions" +
      " where organization_id = $1 and id = $6), $7," +
      // The stored size, so the step's byte limit keeps counting a version
      // that retention later deletes.
      " case when $5 in ('put', 'copy') then coalesce((select size_bytes" +
      " from bakery.storage_file_versions" +
      " where organization_id = $1 and id = $7), 0) else 0 end," +
      // The entry's row version now, after the write, so the undo can tell
      // whether anyone changed it since.
      " $8, $9, $10, (select version from bakery.storage_entries" +
      " where organization_id = $1 and id = $4)",
    [
      row.organizationId,
      row.attemptId,
      row.agentSessionId,
      row.entryId,
      row.op,
      row.previousVersionId,
      row.newVersionId,
      row.previousParentId,
      row.previousName,
      row.entryVersionBefore,
    ],
  );
}

/**
 * An agent's mv or rm writes the folder the entry leaves, so it needs a write
 * grant there too: a read grant never deletes (section 17.6). Null for a
 * person's own request.
 */
async function agentLeaves(
  tx: PgTransactionClient,
  context: ActionContext,
  organizationId: string,
  principalId: string,
  entry: Row,
): Promise<AgentWrite | null> {
  if (context.agentSession === undefined) return null;
  const parent = entry.parent_id === null
    ? undefined
    : await lockEntry(tx, organizationId, entry.parent_id);
  if (!parent) notFound();
  return await agentFileWriteFor(tx, context, {
    organizationId,
    principalId,
    target: parent,
  });
}

/** The parent folder of a new entry at a path, checked writable, and its name. */
async function writableParent(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  path: string,
): Promise<{ parent: Row; name: string; nameKey: string }> {
  const segments = parsePath(path);
  if (segments.length < 2) refuse("system_area");
  const parent = await resolvePath(
    tx,
    organizationId,
    principalId,
    segments.slice(0, -1),
  );
  if (!parent || parent.kind !== "folder") notFound();
  const refusal = writeRefusal(area(parent), principalId);
  if (refusal) refuse(refusal);
  await requireEdit(tx, organizationId, principalId, parent.id);
  const leaf = segments[segments.length - 1];
  return { parent, name: leaf.name, nameKey: leaf.nameKey };
}

async function childAt(
  tx: PgTransactionClient,
  organizationId: string,
  parentId: string,
  nameKey: string,
): Promise<Row | undefined> {
  const found = await tx.query<Row>(
    "select " + COLUMNS + " from bakery.storage_entries" +
      " where organization_id = $1 and parent_id = $2 and name_key = $3" +
      " for update",
    [organizationId, parentId, nameKey],
  );
  return found.rows[0];
}

async function insertEntry(
  tx: PgTransactionClient,
  input: {
    organizationId: string;
    parent: Row;
    name: string;
    nameKey: string;
    kind: "file" | "folder";
  },
): Promise<Row> {
  const scopeKey = await scopeOf(tx, input.organizationId, input.parent);
  const inserted = await tx.query<Row>(
    "insert into bakery.storage_entries" +
      " (organization_id, parent_id, name, name_key, kind, policy, owner_id," +
      " scope_key)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8)" +
      " on conflict do nothing returning " + COLUMNS,
    [
      input.organizationId,
      input.parent.id,
      input.name,
      input.nameKey,
      input.kind,
      childPolicy(area(input.parent)),
      input.parent.owner_id,
      scopeKey,
    ],
  );
  if (!inserted.rows[0]) conflict("name_taken");
  return inserted.rows[0];
}

export type PutInput = Readonly<{
  path: string;
  mediaType: string;
  content?: string;
  blobId?: string;
}>;

/**
 * put: writes a file at a path in a working area, making it or adding a
 * version. An existing file needs If-Match on its version; identical bytes
 * change nothing, so a retried put is idempotent. Upload is a put naming the
 * blob a completed upload stored.
 */
export async function putStorageFile(context: ActionContext, input: PutInput) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  refuseAgentPath(context, input.path);
  await prepareTree(tx, organizationId, principalId);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.path,
  );
  const agent = await agentFileWriteFor(tx, context, {
    organizationId,
    principalId,
    target: parent,
    rawPath: input.path,
  });
  const limits = await readStorageLimits(tx, organizationId);
  const bytes = await putBytes(tx, organizationId, principalId, input);
  if (bytes.sizeBytes > limits.maxFileBytes) {
    throw new StandardError({ code: "STORAGE_FILE_TOO_LARGE" });
  }
  let entry = await childAt(tx, organizationId, parent.id, nameKey);
  let created = false;
  if (entry) {
    if (entry.kind !== "file") conflict("folder_exists");
    if (entry.artifact_id !== null) refuse("record_area");
    const current = await tx.query<{ sha256: string; media_type: string }>(
      "select sha256, media_type from bakery.storage_file_versions" +
        " where organization_id = $1 and id = $2",
      [organizationId, entry.current_version_id],
    );
    const same = current.rows[0];
    if (
      same && same.sha256 === bytes.sha256 &&
      same.media_type === bytes.mediaType
    ) {
      // Identical bytes change nothing, so they need no If-Match; a stale one
      // is still refused.
      const expected = expectedVersion(context);
      if (expected !== undefined && expected !== Number(entry.version)) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      return await project(tx, organizationId, entry.id);
    }
    requireExpectedVersion(context, entry);
  } else {
    if (expectedVersion(context) !== undefined) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    entry = await insertEntry(tx, {
      organizationId,
      parent,
      name,
      nameKey,
      kind: "file",
    });
    created = true;
  }
  await assertQuota(
    tx,
    organizationId,
    entry.scope_key,
    bytes.sizeBytes,
    limits,
  );
  await assertStepWriteLimit(
    tx,
    organizationId,
    agent,
    entry.id,
    bytes.sizeBytes,
    limits,
  );
  const previousVersionId = entry.current_version_id;
  const newVersionId = await appendVersion(tx, {
    organizationId,
    principalId,
    entry,
    bytes,
    limits,
    // An agent's write records the step that made it, from this call's
    // attempt and session; a person's own write records none.
    provenance: agent === null ? null : await attemptVersionProvenance(
      tx,
      organizationId,
      agent.attemptId,
      {
        agentSessionId: agent.agentSessionId,
        actingForPrincipalId: principalId,
      },
    ),
  });
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFiles.put",
    entryId: entry.id,
    agent,
    write: {
      op: WriteOp.Put,
      previousVersionId,
      newVersionId,
      entryVersionBefore: created ? null : Number(entry.version),
    },
    details: {
      created,
      sha256: bytes.sha256,
      sizeBytes: bytes.sizeBytes,
      blobId: bytes.blobId,
    },
  });
  return await project(tx, organizationId, entry.id);
}

/** mkdir: makes a folder in a working area; an existing folder is returned. */
export async function createStorageFolder(
  context: ActionContext,
  input: Readonly<{ path: string }>,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  refuseAgentPath(context, input.path);
  await prepareTree(tx, organizationId, principalId);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.path,
  );
  const agent = await agentFileWriteFor(tx, context, {
    organizationId,
    principalId,
    target: parent,
    rawPath: input.path,
  });
  const existing = await childAt(tx, organizationId, parent.id, nameKey);
  if (existing) {
    if (existing.kind !== "folder") conflict("name_taken");
    return await project(tx, organizationId, existing.id);
  }
  const entry = await insertEntry(tx, {
    organizationId,
    parent,
    name,
    nameKey,
    kind: "folder",
  });
  await assertStepWriteLimit(
    tx,
    organizationId,
    agent,
    entry.id,
    0,
    await readStorageLimits(tx, organizationId),
  );
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFolders.create",
    entryId: entry.id,
    agent,
    write: {
      op: WriteOp.Mkdir,
      previousVersionId: null,
      newVersionId: null,
    },
    details: { parentId: parent.id },
  });
  return await project(tx, organizationId, entry.id);
}

type BytesRow = {
  blob_id: string | null;
  content: Uint8Array | null;
  sha256: string;
  size_bytes: string;
  media_type: string;
};

/** The bytes of a file's current version: a working version or an artifact's. */
async function currentBytes(
  tx: PgTransactionClient,
  organizationId: string,
  entry: Row,
): Promise<FileBytes> {
  const found = entry.artifact_id !== null
    ? await tx.query<BytesRow>(
      "select v.blob_id, v.content, v.sha256, v.size_bytes::text," +
        " v.media_type from bakery.artifacts a" +
        " join bakery.artifact_versions v" +
        " on v.organization_id = a.organization_id" +
        " and v.id = a.current_version_id" +
        " where a.organization_id = $1 and a.id = $2 and v.purged_at is null",
      [organizationId, entry.artifact_id],
    )
    : await tx.query<BytesRow>(
      "select blob_id, content, sha256, size_bytes::text, media_type" +
        " from bakery.storage_file_versions" +
        " where organization_id = $1 and id = $2",
      [organizationId, entry.current_version_id],
    );
  const row = found.rows[0];
  if (!row || (row.blob_id === null && row.content === null)) {
    conflict("no_current_version");
  }
  return {
    blobId: row.blob_id,
    content: row.content,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type,
  };
}

/**
 * cp: copies a file to a path in a working area as a new entry with one
 * version naming the same blob (by reference; small inline bytes are copied).
 * The source may be any file the caller can see, record areas included.
 */
export async function copyStorageEntry(
  context: ActionContext,
  input: Readonly<{ destinationPath: string }>,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  refuseAgentPath(context, input.destinationPath);
  await prepareTree(tx, organizationId, principalId);
  const source = await visibleEntry(
    tx,
    organizationId,
    principalId,
    context.params.id ?? "",
  );
  if (source.trashed_at !== null) conflict("entry_trashed");
  if (source.kind !== "file") unprocessable("id", "folder_copy_unsupported");
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.destinationPath,
  );
  const agent = await agentFileWriteFor(tx, context, {
    organizationId,
    principalId,
    target: parent,
    rawPath: input.destinationPath,
  });
  const limits = await readStorageLimits(tx, organizationId);
  const bytes = await currentBytes(tx, organizationId, source);
  if (await childAt(tx, organizationId, parent.id, nameKey)) {
    conflict("name_taken");
  }
  const entry = await insertEntry(tx, {
    organizationId,
    parent,
    name,
    nameKey,
    kind: "file",
  });
  await assertQuota(
    tx,
    organizationId,
    entry.scope_key,
    bytes.sizeBytes,
    limits,
  );
  await assertStepWriteLimit(
    tx,
    organizationId,
    agent,
    entry.id,
    bytes.sizeBytes,
    limits,
  );
  const newVersionId = await appendVersion(tx, {
    organizationId,
    principalId,
    entry,
    bytes,
    limits,
    // An agent's write records the step that made it, from this call's
    // attempt and session; a person's own write records none.
    provenance: agent === null ? null : await attemptVersionProvenance(
      tx,
      organizationId,
      agent.attemptId,
      {
        agentSessionId: agent.agentSessionId,
        actingForPrincipalId: principalId,
      },
    ),
  });
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.copy",
    entryId: entry.id,
    agent,
    write: { op: WriteOp.Copy, previousVersionId: null, newVersionId },
    details: { sourceId: source.id, sha256: bytes.sha256 },
  });
  return await project(tx, organizationId, entry.id);
}

/** The ids of an entry and everything under it, deepest first. */
async function subtree(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  id: string,
): Promise<{ id: string; depth: number }[]> {
  const found = await tx.query<{ id: string; depth: number }>(
    DOWN_FROM + " select id, depth from down order by depth desc",
    [organizationId, id],
  );
  return found.rows;
}

async function subtreeBytes(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  ids: string[],
): Promise<number> {
  const found = await tx.query<{ bytes: string }>(
    "select coalesce(sum(size_bytes), 0)::text as bytes" +
      " from bakery.storage_file_versions" +
      " where organization_id = $1 and entry_id = any($2::uuid[])",
    [organizationId, ids],
  );
  return Number(found.rows[0].bytes);
}

/**
 * Puts an entry under a folder with a name, carrying the owner, policy and
 * quota scope its new place gives its subtree. Shared by mv and by the undo of
 * a step's move; the caller has locked both and checked the write is allowed.
 */
async function relocateEntry(
  tx: PgTransactionClient,
  organizationId: string,
  entry: Row,
  target: Readonly<{ parent: Row; name: string; nameKey: string }>,
): Promise<void> {
  const { parent, name, nameKey } = target;
  const ids = (await subtree(tx, organizationId, entry.id)).map((row) =>
    row.id
  );
  if (ids.includes(parent.id)) {
    unprocessable("destinationPath", "into_own_subtree");
  }
  const existing = await childAt(tx, organizationId, parent.id, nameKey);
  if (existing && existing.id !== entry.id) conflict("name_taken");
  const scopeKey = await scopeOf(tx, organizationId, parent);
  const policy = childPolicy(area(parent));
  if (
    scopeKey !== entry.scope_key || policy !== entry.policy ||
    parent.owner_id !== entry.owner_id
  ) {
    if (scopeKey !== entry.scope_key) {
      // The organization total does not change; the destination's does.
      const limits = await readStorageLimits(tx, organizationId);
      await assertQuota(
        tx,
        organizationId,
        scopeKey,
        await subtreeBytes(tx, organizationId, ids),
        limits,
        { organization: false },
      );
    }
    await tx.query(
      "update bakery.storage_entries" +
        " set scope_key = $3, owner_id = $4, policy = $5" +
        " where organization_id = $1 and id = any($2::uuid[])",
      [organizationId, ids, scopeKey, parent.owner_id, policy],
    );
  }
  await tx.query(
    "update bakery.storage_entries" +
      " set parent_id = $3, name = $4, name_key = $5," +
      " version = version + 1, updated_at = now()" +
      " where organization_id = $1 and id = $2",
    [organizationId, entry.id, parent.id, name, nameKey],
  );
}

/**
 * mv: renames or moves an entry within working areas. Changes only the entry,
 * and, moving between quota scopes or into or out of a personal folder, the
 * owner, policy and scope its subtree carries; no version or pin moves.
 */
export async function moveStorageEntry(
  context: ActionContext,
  input: Readonly<{ destinationPath: string }>,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  refuseAgentPath(context, input.destinationPath);
  await prepareTree(tx, organizationId, principalId);
  const entry = await visibleEntry(
    tx,
    organizationId,
    principalId,
    context.params.id ?? "",
  );
  if (entry.trashed_at !== null) conflict("entry_trashed");
  const refusal = changeRefusal(area(entry));
  if (refusal) refuse(refusal);
  await requireEdit(tx, organizationId, principalId, entry.id);
  requireExpectedVersion(context, entry);
  // A move is a write in both folders: the one it leaves and the one it enters.
  await agentLeaves(tx, context, organizationId, principalId, entry);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.destinationPath,
  );
  const agent = await agentFileWriteFor(tx, context, {
    organizationId,
    principalId,
    target: parent,
    rawPath: input.destinationPath,
  });
  await relocateEntry(tx, organizationId, entry, { parent, name, nameKey });
  await assertStepWriteLimit(
    tx,
    organizationId,
    agent,
    entry.id,
    0,
    await readStorageLimits(tx, organizationId),
  );
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.move",
    entryId: entry.id,
    agent,
    // A move changes no version: before and after are the same one.
    write: {
      op: WriteOp.Move,
      previousVersionId: entry.current_version_id,
      newVersionId: entry.current_version_id,
      previousParentId: entry.parent_id,
      previousName: entry.name,
      entryVersionBefore: Number(entry.version),
    },
    details: { fromParentId: entry.parent_id, toParentId: parent.id },
  });
  return await project(tx, organizationId, entry.id);
}

/**
 * rm: moves an entry, with everything under it, to /trash, where it stays
 * restorable for the trash retention. Refused in record areas (section 17.4).
 */
export async function trashStorageEntry(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const top = await prepareTree(tx, organizationId, principalId);
  const entry = await visibleEntry(
    tx,
    organizationId,
    principalId,
    context.params.id ?? "",
  );
  if (entry.trashed_at !== null) conflict("entry_trashed");
  const refusal = changeRefusal(area(entry));
  if (refusal) refuse(refusal);
  await requireEdit(tx, organizationId, principalId, entry.id);
  requireExpectedVersion(context, entry);
  const agent = await agentLeaves(
    tx,
    context,
    organizationId,
    principalId,
    entry,
  );
  await moveToTrash(
    tx,
    organizationId,
    entry.id,
    top.get("trash")!,
    principalId,
  );
  await assertStepWriteLimit(
    tx,
    organizationId,
    agent,
    entry.id,
    0,
    await readStorageLimits(tx, organizationId),
  );
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.trash",
    entryId: entry.id,
    agent,
    write: {
      op: WriteOp.Trash,
      previousVersionId: entry.current_version_id,
      newVersionId: entry.current_version_id,
      entryVersionBefore: Number(entry.version),
    },
    details: { fromParentId: entry.parent_id },
  });
  return await project(tx, organizationId, entry.id);
}

/** Restores a trashed entry to the folder it came from, under its old name. */
export async function restoreStorageEntry(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  await prepareTree(tx, organizationId, principalId);
  const entry = await visibleEntry(
    tx,
    organizationId,
    principalId,
    context.params.id ?? "",
  );
  if (entry.trashed_at === null) conflict("entry_not_trashed");
  if (entry.trash_parent_id !== null) {
    await requireEdit(tx, organizationId, principalId, entry.trash_parent_id);
  }
  requireExpectedVersion(context, entry);
  const parent = await restoreFromTrash(tx, organizationId, entry);
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.restore",
    entryId: entry.id,
    details: { toParentId: parent.id },
  });
  return await project(tx, organizationId, entry.id);
}

/** Moves an entry to /trash, remembering the folder and name it had. */
async function moveToTrash(
  tx: PgTransactionClient,
  organizationId: string,
  entryId: string,
  trashFolderId: string,
  principalId: string,
): Promise<void> {
  await tx.query(
    "update bakery.storage_entries" +
      " set trash_parent_id = parent_id, trash_name = name, parent_id = $3," +
      " name_key = 'trash:' || id::text, trashed_at = now()," +
      " trashed_by_id = $4, version = version + 1, updated_at = now()" +
      " where organization_id = $1 and id = $2",
    [organizationId, entryId, trashFolderId, principalId],
  );
}

/**
 * Puts a trashed entry back in the folder it came from, under its old name;
 * refused when that folder is gone or trashed, or the name is taken. Shared by
 * restore and by the undo of a step's rm. Returns the folder.
 */
async function restoreFromTrash(
  tx: PgTransactionClient,
  organizationId: string,
  entry: Row,
): Promise<Row> {
  const parent = entry.trash_parent_id === null
    ? undefined
    : await lockEntry(tx, organizationId, entry.trash_parent_id);
  // Only record-area files are ever marked purged, and a trashed entry's
  // parent is a working-area folder, so a missing parent is the only case.
  if (!parent) conflict("restore_parent_gone");
  const trashedAbove = await tx.query<{ trashed: boolean }>(
    UP_FROM + " select bool_or(trashed_at is not null) as trashed from up",
    [organizationId, parent.id],
  );
  if (trashedAbove.rows[0]?.trashed) conflict("restore_parent_gone");
  const { name, nameKey } = normalizeEntryName(entry.trash_name ?? entry.name);
  if (await childAt(tx, organizationId, parent.id, nameKey)) {
    conflict("name_taken");
  }
  await tx.query(
    "update bakery.storage_entries" +
      " set parent_id = $3, name = $4, name_key = $5, trashed_at = null," +
      " trashed_by_id = null, trash_parent_id = null, trash_name = null," +
      " version = version + 1, updated_at = now()" +
      " where organization_id = $1 and id = $2",
    [organizationId, entry.id, parent.id, name, nameKey],
  );
  return parent;
}

/**
 * One trash page with every StorageEntry column, in one query: the page, then
 * one recursive walk up from each entry and from each original folder, so the
 * paths need no query per row. Parameters: organization, caller, cursor
 * position (trashed_at, id), and limit.
 */
const TRASH_PAGE = "with recursive page as (" +
  " select " + ENTRY_COLUMNS + ", entry.trashed_by_id," +
  " to_char(entry.trashed_at at time zone 'UTC'," +
  ' \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as cursor_trashed_at' +
  " from bakery.storage_entries entry" +
  " where entry.organization_id = $1 and entry.trashed_at is not null" +
  " and (entry.owner_id is null or entry.owner_id = $2)" +
  " and ($3::timestamptz is null or" +
  " (entry.trashed_at, entry.id) < ($3, $4::uuid))" +
  " order by entry.trashed_at desc, entry.id desc limit $5)," +
  " starts as (select id as start_id from page" +
  " union select trash_parent_id from page where trash_parent_id is not null)," +
  " walk as (" +
  " select starts.start_id, s.parent_id, s.name, 0 as depth" +
  " from starts join bakery.storage_entries s" +
  " on s.organization_id = $1 and s.id = starts.start_id" +
  " union all" +
  " select walk.start_id, e.parent_id, e.name, walk.depth + 1" +
  " from walk join bakery.storage_entries e" +
  " on e.organization_id = $1 and e.id = walk.parent_id" +
  " where walk.depth < 64)," +
  " paths as (select start_id," +
  " '/' || string_agg(name, '/' order by depth desc) as path" +
  " from walk group by start_id)" +
  " select page.*, own.path, origin.path as original_folder_path," +
  " v.sha256, v.size_bytes::text, v.media_type, v.revision," +
  " who.display_name as trashed_by_name," +
  " request.requested_at as deletion_requested_at" +
  " from page" +
  " join paths own on own.start_id = page.id" +
  " left join paths origin on origin.start_id = page.trash_parent_id" +
  " left join bakery.storage_file_versions v" +
  " on v.organization_id = $1 and v.id = page.current_version_id" +
  " left join bakery.principals who on who.id = page.trashed_by_id" +
  " left join bakery.storage_purge_requests request" +
  " on request.organization_id = $1 and request.entry_id = page.id" +
  " and request.completed_at is null" +
  " order by page.trashed_at desc, page.id desc";

/** What is in the trash and visible to the caller, newest first. */
export function createTrashLister(secret: string) {
  return async (
    context: ActionContext,
    input: Readonly<{ cursor?: string; limit?: number }>,
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      unprocessable("limit", "out_of_range");
    }
    const binding: CursorBinding = {
      action: "storageTrash.list",
      principalId,
      organizationId,
      ordering: TRASH_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<
      ProjectedRow & {
        cursor_trashed_at: string;
        original_folder_path: string | null;
      }
    >(TRASH_PAGE, [
      organizationId,
      principalId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ]);
    const rows = found.rows.slice(0, limit);
    const listed = [];
    for (const row of rows) {
      if (
        row.trash_parent_id === null ||
        await mayViewAt(tx, organizationId, principalId, row.trash_parent_id)
      ) listed.push(row);
    }
    const items = listed.map((row) => entryView(row, row.original_folder_path));
    const last = rows.at(-1);
    return {
      items,
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_trashed_at,
          id: last.id,
        })
        : null,
    };
  };
}

async function settingsView(tx: PgTransactionClient, organizationId: string) {
  const limits = await readStorageLimits(tx, organizationId);
  const used = await usedBytes(tx, organizationId, null);
  return {
    workingVersionsKept: limits.workingVersionsKept,
    trashRetentionDays: limits.trashRetentionDays,
    scratchRetentionDays: limits.scratchRetentionDays,
    maxFileBytes: limits.maxFileBytes,
    organizationQuotaBytes: limits.organizationQuotaBytes,
    projectQuotaBytes: limits.projectQuotaBytes,
    personalQuotaBytes: limits.personalQuotaBytes,
    stepWriteBytes: limits.stepWriteBytes,
    stepWriteFiles: limits.stepWriteFiles,
    organizationUsedBytes: used,
    organizationQuotaState: quotaState(used, limits.organizationQuotaBytes),
    customized: limits.customized,
    version: limits.version,
  };
}

/**
 * What an Admin saves. The step write limits may be left out: absent stores
 * null, which follows Bakery's default (O49).
 */
export type StorageSettingsInput =
  & Omit<StorageLimits, "stepWriteBytes" | "stepWriteFiles">
  & Partial<Pick<StorageLimits, "stepWriteBytes" | "stepWriteFiles">>;

/** The organization's storage limits with its usage against its quota. */
export async function getStorageSettings(context: ActionContext) {
  const { transaction: tx, organizationId } = requireWorkTransaction(context);
  return await settingsView(tx, organizationId);
}

/**
 * Admin: replaces the organization's storage limits. The first write needs no
 * If-Match (there is no version yet); every later one needs the current one.
 */
export async function putStorageSettings(
  context: ActionContext,
  input: StorageSettingsInput,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const invalid = invalidLimit({
    ...input,
    stepWriteBytes: input.stepWriteBytes ??
      DEFAULT_STORAGE_LIMITS.stepWriteBytes,
    stepWriteFiles: input.stepWriteFiles ??
      DEFAULT_STORAGE_LIMITS.stepWriteFiles,
  });
  if (invalid) unprocessable(invalid, "out_of_range");
  await tx.query(
    "select pg_advisory_xact_lock(hashtext('storage-settings:' || $1))",
    [organizationId],
  );
  const current = await readStorageLimits(tx, organizationId);
  const expected = expectedVersion(context);
  if (current.customized) {
    if (expected === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expected !== current.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expected !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await tx.query(
    "insert into bakery.storage_settings" +
      " (organization_id, working_versions_kept, trash_retention_days," +
      " scratch_retention_days, max_file_bytes, organization_quota_bytes," +
      " project_quota_bytes, personal_quota_bytes, updated_by_id," +
      " step_write_bytes, step_write_files)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)" +
      " on conflict (organization_id) do update set" +
      " working_versions_kept = excluded.working_versions_kept," +
      " trash_retention_days = excluded.trash_retention_days," +
      " scratch_retention_days = excluded.scratch_retention_days," +
      " max_file_bytes = excluded.max_file_bytes," +
      " organization_quota_bytes = excluded.organization_quota_bytes," +
      " project_quota_bytes = excluded.project_quota_bytes," +
      " personal_quota_bytes = excluded.personal_quota_bytes," +
      " step_write_bytes = excluded.step_write_bytes," +
      " step_write_files = excluded.step_write_files," +
      " updated_by_id = excluded.updated_by_id," +
      " version = bakery.storage_settings.version + 1, updated_at = now()",
    [
      organizationId,
      input.workingVersionsKept,
      input.trashRetentionDays,
      input.scratchRetentionDays,
      input.maxFileBytes,
      input.organizationQuotaBytes,
      input.projectQuotaBytes,
      input.personalQuotaBytes,
      principalId,
      input.stepWriteBytes ?? null,
      input.stepWriteFiles ?? null,
    ],
  );
  await appendAudit(tx, {
    organizationId,
    principalId,
    operation: "storageSettings.put",
    resourceType: "storage_settings",
    resourceId: organizationId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { ...input },
  });
  return await settingsView(tx, organizationId);
}

/** Deletes an entry and everything under it, with their working versions. */
export async function deleteSubtree(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  id: string,
): Promise<{ entries: number; bytes: number }> {
  const rows = await subtree(tx, organizationId, id);
  const ids = rows.map((row) => row.id);
  const bytes = await subtreeBytes(tx, organizationId, ids);
  // The parent key restricts deletes, so the deepest level goes first.
  const byDepth = new Map<number, string[]>();
  for (const row of rows) {
    byDepth.set(row.depth, [...(byDepth.get(row.depth) ?? []), row.id]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
    await tx.query(
      "delete from bakery.storage_entries" +
        " where organization_id = $1 and id = any($2::uuid[])",
      [organizationId, byDepth.get(depth)],
    );
  }
  return { entries: ids.length, bytes };
}

/**
 * Admin purge: the permanent removal section 17.5 keeps for leaked secrets and
 * legal demands, audited. A working-area entry, live or trashed, is deleted
 * with everything under it, at once (status "removed").
 *
 * A record-area file is an artifact, whose version bytes only the database
 * owner may clear; the runtime role may not (pinned by the artifact-pins
 * security test). So its purge is queued (status "queued"): this records one
 * request per entry in bakery.storage_purge_requests, touches no artifact
 * version, and the owner-privileged job in storage-record-purge.ts clears the
 * bytes and leaves the entry as a tombstone. Purging it again before the job
 * runs finds the same request. A record-area folder and the folders Bakery
 * made are refused.
 */
export async function purgeStorageEntry(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const entry = await lockEntry(tx, organizationId, context.params.id ?? "");
  if (!entry || entry.purged_at !== null) notFound();
  if (entry.system_key !== null) refuse("system_folder");
  if (entry.artifact_id !== null) {
    return await queueRecordPurge(tx, context, {
      organizationId,
      principalId,
      entry: { ...entry, artifact_id: entry.artifact_id },
    });
  }
  if (entry.policy === "record") refuse("record_area");
  const removed = await deleteSubtree(tx, organizationId, entry.id);
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.purge",
    entryId: entry.id,
    details: {
      kind: entry.kind,
      policy: entry.policy,
      entriesRemoved: removed.entries,
      bytesRemoved: removed.bytes,
    },
  });
  return {
    id: entry.id,
    status: "removed" as const,
    alreadyRequested: false,
    entriesRemoved: removed.entries,
    bytesRemoved: removed.bytes,
  };
}

/** Records (or finds) the purge request for a record-area file. */
async function queueRecordPurge(
  tx: PgTransactionClient,
  context: ActionContext,
  input: {
    organizationId: string;
    principalId: string;
    entry: Row & { artifact_id: string };
  },
) {
  const { organizationId, principalId, entry } = input;
  const inserted = await tx.query(
    "insert into bakery.storage_purge_requests" +
      " (organization_id, entry_id, artifact_id, requested_by_id)" +
      " values ($1, $2, $3, $4)" +
      " on conflict (organization_id, entry_id) do nothing",
    [organizationId, entry.id, entry.artifact_id, principalId],
  );
  const alreadyRequested = (inserted.rowCount ?? 0) === 0;
  const request = await tx.query<{ id: string }>(
    "select id from bakery.storage_purge_requests" +
      " where organization_id = $1 and entry_id = $2",
    [organizationId, entry.id],
  );
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.purge",
    entryId: entry.id,
    details: {
      kind: entry.kind,
      policy: entry.policy,
      requested: true,
      alreadyRequested,
      purgeRequestId: request.rows[0].id,
      artifactId: entry.artifact_id,
    },
  });
  return {
    id: entry.id,
    status: "queued" as const,
    alreadyRequested,
    entriesRemoved: 0,
    bytesRemoved: 0,
  };
}

type WriteSetRow = {
  id: string;
  attempt_id: string;
  entry_id: string;
  op: StepWriteOp;
  previous_version_id: string | null;
  new_version_id: string | null;
  previous_parent_id: string | null;
  previous_name: string | null;
  entry_version_before: string | null;
  entry_version_after: string;
};

/** At most this many refused entries are named in one refusal. */
const MAX_NAMED_CONFLICTS = 20;

/**
 * Reverts the writes the given attempts' agent made that are not yet undone,
 * newest first, in the caller's transaction (section 17.6, O48, #448 S5).
 * All or nothing: when any entry refuses, STATE_CONFLICT
 * `step_writes_conflict` names each one and nothing changes. Every reverted
 * write is marked with who undid it and when, so it is never undone twice; a
 * second undo finds nothing and reverts nothing. Each reverted entry gets an
 * audit row. The caller has checked that a person with run control asks.
 */
export async function revertStepWrites(
  context: ActionContext,
  attemptIds: readonly string[],
): Promise<{ reverted: number; entries: number }> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  if (attemptIds.length === 0) return { reverted: 0, entries: 0 };
  const top = await prepareTree(tx, organizationId, principalId);
  const found = await tx.query<WriteSetRow>(
    "select id, attempt_id, entry_id, op, previous_version_id," +
      " new_version_id, previous_parent_id, previous_name," +
      " entry_version_before::text, entry_version_after::text" +
      " from bakery.step_write_set" +
      " where organization_id = $1 and attempt_id = any($2::uuid[])" +
      " and reverted_at is null" +
      " order by created_at, id for update",
    [organizationId, attemptIds],
  );
  if (found.rows.length === 0) return { reverted: 0, entries: 0 };
  const writes: RecordedWrite[] = found.rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    op: row.op,
    previousVersionId: row.previous_version_id,
    newVersionId: row.new_version_id,
    previousParentId: row.previous_parent_id,
    previousName: row.previous_name,
    entryVersionBefore: row.entry_version_before === null
      ? null
      : Number(row.entry_version_before),
    entryVersionAfter: Number(row.entry_version_after),
  }));

  // Lock every entry in id order, so two undos never deadlock.
  const ids = [...new Set(writes.map((write) => write.entryId))].sort();
  const rows = new Map<string, Row>();
  const entries = new Map<string, EntryNow>();
  for (const id of ids) {
    const row = await lockEntry(tx, organizationId, id);
    if (row) rows.set(id, row);
    const children = row?.kind === "folder"
      ? (await tx.query<{ id: string }>(
        "select id from bakery.storage_entries" +
          " where organization_id = $1 and parent_id = $2" +
          " and trashed_at is null",
        [organizationId, id],
      )).rows.map((child) => child.id)
      : [];
    entries.set(id, {
      id,
      path: row ? await folderPath(tx, organizationId, id) : id,
      kind: row?.kind ?? "file",
      version: Number(row?.version ?? -1),
      gone: !row || row.purged_at !== null,
      parentId: row?.parent_id ?? null,
      trashed: row?.trashed_at != null,
      trashParentId: row?.trash_parent_id ?? null,
      liveChildIds: children,
    });
  }

  const plan = planStepUndo(writes, entries);
  if (!plan.ok) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: "step_writes_conflict",
        issues: plan.conflicts.slice(0, MAX_NAMED_CONFLICTS).map((
          conflict,
        ) => ({
          path: [conflict.path],
          message: conflict.reason,
          code: conflict.reason,
        })),
      },
    });
  }

  const attemptOf = new Map(found.rows.map((row) => [row.id, row.attempt_id]));
  for (const step of plan.steps) {
    // Re-read: an earlier reversal in this undo may have changed the entry.
    const entry = await lockEntry(tx, organizationId, step.entryId);
    if (!entry) notFound();
    let details: Record<string, unknown> = {};
    switch (step.action) {
      case UndoAction.Trash:
        if (entry.trashed_at === null) {
          await moveToTrash(
            tx,
            organizationId,
            entry.id,
            top.get("trash")!,
            principalId,
          );
        }
        details = { fromParentId: entry.parent_id };
        break;
      case UndoAction.SetVersion:
        await tx.query(
          "update bakery.storage_entries" +
            " set current_version_id = $3, version = version + 1," +
            " updated_at = now()" +
            " where organization_id = $1 and id = $2",
          [organizationId, entry.id, step.versionId],
        );
        details = {
          fromVersionId: entry.current_version_id,
          toVersionId: step.versionId,
        };
        break;
      case UndoAction.MoveBack: {
        const parent = await lockEntry(tx, organizationId, step.parentId!);
        if (!parent || parent.trashed_at !== null) {
          conflict("restore_parent_gone");
        }
        const { name, nameKey } = normalizeEntryName(step.name!);
        await relocateEntry(tx, organizationId, entry, {
          parent,
          name,
          nameKey,
        });
        details = { fromParentId: entry.parent_id, toParentId: parent.id };
        break;
      }
      case UndoAction.Restore: {
        const parent = await restoreFromTrash(tx, organizationId, entry);
        details = { toParentId: parent.id };
        break;
      }
    }
    await audit(tx, context, {
      organizationId,
      principalId,
      operation: "storageEntries.revertStepWrite",
      entryId: entry.id,
      details: {
        ...details,
        action: step.action,
        writeId: step.writeId,
        attemptId: attemptOf.get(step.writeId),
      },
    });
  }

  await tx.query(
    "update bakery.step_write_set" +
      " set reverted_at = now(), reverted_by_principal_id = $3" +
      " where organization_id = $1 and id = any($2::uuid[])" +
      " and reverted_at is null",
    [organizationId, writes.map((write) => write.id), principalId],
  );
  return { reverted: writes.length, entries: ids.length };
}
