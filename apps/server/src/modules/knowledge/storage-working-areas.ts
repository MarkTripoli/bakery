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
import { sha256Bytes } from "./bytes.ts";
import { appendMemorySourceChanged } from "./memory-source-state.ts";
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
  return row;
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
  const found = await tx.query<Record<string, string | number>>(
    "select working_versions_kept, trash_retention_days," +
      " scratch_retention_days, max_file_bytes::text," +
      " organization_quota_bytes::text, project_quota_bytes::text," +
      " personal_quota_bytes::text, version" +
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
  input: { blobId?: string; content?: string; mediaType: string },
): Promise<FileBytes> {
  if ((input.blobId === undefined) === (input.content === undefined)) {
    unprocessable("content", "exactly_one_of_content_or_blob");
  }
  if (input.blobId !== undefined) {
    const found = await tx.query<
      { id: string; sha256: string; size_bytes: string }
    >(
      "select id, sha256, size_bytes::text from bakery.blobs" +
        " where organization_id = $1 and id = $2",
      [organizationId, input.blobId],
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
  },
): Promise<void> {
  const revision = await tx.query<{ next: number }>(
    "select coalesce(max(revision), 0) + 1 as next" +
      " from bakery.storage_file_versions" +
      " where organization_id = $1 and entry_id = $2",
    [input.organizationId, input.entry.id],
  );
  const inserted = await tx.query<{ id: string }>(
    "insert into bakery.storage_file_versions" +
      " (organization_id, entry_id, revision, blob_id, content, sha256," +
      " size_bytes, media_type, author_id)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
    [
      input.organizationId,
      input.entry.id,
      revision.rows[0].next,
      input.bytes.blobId,
      input.bytes.content,
      input.bytes.sha256,
      input.bytes.sizeBytes,
      input.bytes.mediaType,
      input.principalId,
    ],
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
}

type ProjectedRow = Row & {
  path: string;
  sha256: string | null;
  size_bytes: string | null;
  media_type: string | null;
  revision: number | null;
};

/** An entry as the API returns it. */
async function project(
  tx: PgTransactionClient,
  organizationId: string,
  id: string,
) {
  const found = await tx.query<ProjectedRow>(
    UP_FROM + " select " + ENTRY_COLUMNS + "," +
      " (select '/' || string_agg(name, '/' order by depth desc) from up)" +
      " as path, v.sha256, v.size_bytes::text, v.media_type, v.revision" +
      " from bakery.storage_entries entry" +
      " left join bakery.storage_file_versions v" +
      " on v.organization_id = entry.organization_id" +
      " and v.id = entry.current_version_id" +
      " where entry.organization_id = $1 and entry.id = $2",
    [organizationId, id],
  );
  const row = found.rows[0];
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
  },
): Promise<void> {
  await appendAudit(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    operation: input.operation,
    resourceType: "storage_entry",
    resourceId: input.entryId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: input.details,
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
  await prepareTree(tx, organizationId, principalId);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.path,
  );
  const limits = await readStorageLimits(tx, organizationId);
  const bytes = await putBytes(tx, organizationId, input);
  if (bytes.sizeBytes > limits.maxFileBytes) {
    throw new StandardError({ code: "STORAGE_FILE_TOO_LARGE" });
  }
  let entry = await childAt(tx, organizationId, parent.id, nameKey);
  let created = false;
  if (entry) {
    if (entry.kind !== "file") conflict("folder_exists");
    if (entry.artifact_id !== null) refuse("record_area");
    requireExpectedVersion(context, entry);
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
      return await project(tx, organizationId, entry.id);
    }
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
  await appendVersion(tx, {
    organizationId,
    principalId,
    entry,
    bytes,
    limits,
  });
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFiles.put",
    entryId: entry.id,
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
  await prepareTree(tx, organizationId, principalId);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.path,
  );
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
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFolders.create",
    entryId: entry.id,
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
  await appendVersion(tx, {
    organizationId,
    principalId,
    entry,
    bytes,
    limits,
  });
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.copy",
    entryId: entry.id,
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
  requireExpectedVersion(context, entry);
  const { parent, name, nameKey } = await writableParent(
    tx,
    organizationId,
    principalId,
    input.destinationPath,
  );
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
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.move",
    entryId: entry.id,
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
  requireExpectedVersion(context, entry);
  await tx.query(
    "update bakery.storage_entries" +
      " set trash_parent_id = parent_id, trash_name = name, parent_id = $3," +
      " name_key = 'trash:' || id::text, trashed_at = now()," +
      " trashed_by_id = $4, version = version + 1, updated_at = now()" +
      " where organization_id = $1 and id = $2",
    [organizationId, entry.id, top.get("trash")!, principalId],
  );
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.trash",
    entryId: entry.id,
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
  requireExpectedVersion(context, entry);
  const parent = entry.trash_parent_id === null
    ? undefined
    : await lockEntry(tx, organizationId, entry.trash_parent_id);
  if (!parent || parent.purged_at !== null) conflict("restore_parent_gone");
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
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageEntries.restore",
    entryId: entry.id,
    details: { toParentId: parent.id },
  });
  return await project(tx, organizationId, entry.id);
}

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
    const found = await tx.query<{ id: string; cursor_trashed_at: string }>(
      "select id, to_char(trashed_at at time zone 'UTC'," +
        ' \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as cursor_trashed_at' +
        " from bakery.storage_entries" +
        " where organization_id = $1 and trashed_at is not null" +
        " and purged_at is null and (owner_id is null or owner_id = $2)" +
        " and ($3::timestamptz is null or (trashed_at, id) < ($3, $4::uuid))" +
        " order by trashed_at desc, id desc limit $5",
      [
        organizationId,
        principalId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const rows = found.rows.slice(0, limit);
    const items = [];
    for (const row of rows) {
      items.push(await project(tx, organizationId, row.id));
    }
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
    organizationUsedBytes: used,
    organizationQuotaState: quotaState(used, limits.organizationQuotaBytes),
    customized: limits.customized,
    version: limits.version,
  };
}

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
  input: StorageLimits,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const invalid = invalidLimit(input);
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
      " project_quota_bytes, personal_quota_bytes, updated_by_id)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8, $9)" +
      " on conflict (organization_id) do update set" +
      " working_versions_kept = excluded.working_versions_kept," +
      " trash_retention_days = excluded.trash_retention_days," +
      " scratch_retention_days = excluded.scratch_retention_days," +
      " max_file_bytes = excluded.max_file_bytes," +
      " organization_quota_bytes = excluded.organization_quota_bytes," +
      " project_quota_bytes = excluded.project_quota_bytes," +
      " personal_quota_bytes = excluded.personal_quota_bytes," +
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
 * with everything under it. A record-area file is the only early removal from
 * a record area: every version's bytes are cleared the way retention
 * collection clears them and the entry stays as a tombstone. The folders
 * Bakery made, and record-area folders, are refused.
 */
export async function purgeStorageEntry(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const entry = await lockEntry(tx, organizationId, context.params.id ?? "");
  if (!entry || entry.purged_at !== null) notFound();
  if (entry.system_key !== null) refuse("system_folder");
  if (entry.artifact_id !== null) {
    const versions = await tx.query<{ id: string }>(
      "update bakery.artifact_versions" +
        " set content = null, blob_id = null, purged_at = now()," +
        " purge_policy = 'admin-purge'" +
        " where organization_id = $1 and artifact_id = $2" +
        " and purged_at is null returning id",
      [organizationId, entry.artifact_id],
    );
    for (const version of versions.rows) {
      await appendMemorySourceChanged(tx, {
        organizationId,
        versionId: version.id,
        traceId: context.traceId,
      });
    }
    await tx.query(
      "update bakery.storage_entries" +
        " set purged_at = now(), version = version + 1, updated_at = now()" +
        " where organization_id = $1 and id = $2",
      [organizationId, entry.id],
    );
    await audit(tx, context, {
      organizationId,
      principalId,
      operation: "storageEntries.purge",
      entryId: entry.id,
      details: {
        artifactId: entry.artifact_id,
        versionsPurged: versions.rows.length,
        tombstone: true,
      },
    });
    return {
      id: entry.id,
      entriesRemoved: 0,
      bytesRemoved: 0,
      tombstone: true,
    };
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
      tombstone: false,
    },
  });
  return {
    id: entry.id,
    entriesRemoved: removed.entries,
    bytesRemoved: removed.bytes,
    tombstone: false,
  };
}
