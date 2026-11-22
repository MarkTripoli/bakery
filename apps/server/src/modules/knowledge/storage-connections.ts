import type { Inngest } from "inngest";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  type DriverContext,
  isStoragePath,
  MAX_STORAGE_PAGE_SIZE,
  MAX_STORAGE_READ_BYTES,
  StorageChangesPageSchema,
  StorageListPageSchema,
  type StorageObject,
  StorageObjectSchema,
  type StoragePort,
  StorageReadRangeSchema,
  StorageWriteResultSchema,
} from "@bakery/integration-sdk/provider";
import { Buffer } from "node:buffer";
import type { PgTransactionClient } from "@bakery/persistence";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import {
  casClaim,
  casOutcome,
  findEffectById,
  findEffectByKey,
  insertPreparedHostEffect,
  readEffectState,
} from "../effects/repository.ts";
import { computeRequestDigest } from "../effects/digest.ts";
import type { ExternalEffectRow } from "../effects/schema.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { sha256Bytes } from "./bytes.ts";
import { commitArtifactVersion } from "./persistence.ts";
import { readableEntry, type StorageReader } from "./storage-reads.ts";
import {
  ensureChildFolder,
  ensureFolder,
  ensureOrganizationTree,
  insertFileEntry,
  normalizeEntryName,
  StorageNameError,
  type StoragePin,
  storageQueryOf,
} from "./storage-tree.ts";

/**
 * Outside storage in the tree (chapter 25 section 17.4, O38, slice F9, #452).
 *
 * A connection whose provider serves the storage family is mounted as a folder
 * under `/connections`. Everything below that folder is read through the
 * provider's port on demand: listing, stat and range reads copy nothing. A file
 * is copied only when it is used, and then it becomes an artifact version
 * (keyed by mount, remote path and remote revision, so a repeated use returns
 * the same version) projected at the same path, which is what a run pins.
 * One-way sync is a workflow over the same ingest; writing out is a keyed
 * external effect in `bakery.external_effects`, never an inline call. There is
 * no two-way sync.
 *
 * Access, three layers, every one of them an existing rule:
 * - the connection's permission: the routes declare
 *   `integrationConnection:read` for reading through a mount and
 *   `integrationConnection:invoke` for syncing and exporting, the same
 *   permissions the integrations module checks for reading and invoking a
 *   connection; mounting needs `integrationConnection:manage`;
 * - the tree's read rule on the mount folder: organization scope, and for an
 *   agent a live folder grant on /connections (O44);
 * - a live connection: enabled and not archived.
 * Per-connection `integration_grants` rows are not consulted: they grant an
 * exact provider action on one resource, and a storage connection has
 * neither. Same as the tree otherwise.
 */

/** The port and driver context the host binds for one storage connection. */
export type StorageConnectionBinding = Readonly<{
  port: StoragePort;
  ctx: DriverContext;
  /** Provider and version that serve the port, written on an export effect. */
  adapterVersion: string;
}>;

/** The connection facts a resolver needs to pick the provider's port. */
export type StorageConnectionFacts = Readonly<{
  id: string;
  organizationId: string;
  provider: string;
}>;

/**
 * Binds a connection to its storage port, or answers undefined when its
 * provider serves no storage family. No hosted storage provider is deployed
 * yet, so production resolves nothing; tests bind an in-process provider.
 */
export type StorageProviderResolver = (
  connection: StorageConnectionFacts,
) => StorageConnectionBinding | undefined;

/** The resolver for an installation with no storage providers deployed. */
export const noStorageProviders: StorageProviderResolver = () => undefined;

/** What the storage connection functions need besides a transaction. */
export type StorageConnectionDeps = Readonly<{
  resolver: StorageProviderResolver;
  /** Where ingested bytes go; absent, they are stored inline. */
  blobStore?: OrganizationBlobStore;
}>;

/** The artifact type an ingested file is recorded under. */
export const CONNECTION_FILE_ARTIFACT_TYPE = "connection_file";
/** The operation a write to outside storage is recorded under. */
export const STORAGE_EXPORT_OPERATION = "storage.file.export";
/** The version of the export operation's argument shape. */
export const STORAGE_EXPORT_VERSION = 1;
/** Seconds one export dispatch holds its lease. */
const EXPORT_LEASE_SECONDS = 60;
/** Seconds before a thrown export write is tried again under the same key. */
const EXPORT_RETRY_SECONDS = 30;
const CONNECTIONS_PREFIX = "/connections/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function refused(reason: string, path = "path"): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [path], message: reason, code: reason }] },
  });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function providerAnswerInvalid(cause: unknown): never {
  throw new StandardError({ code: "INTERNAL", cause });
}

/** The system key of a connection's mount folder under /connections. */
export function mountSystemKey(connectionId: string): string {
  return "connection:" + connectionId;
}

/**
 * Splits a tree path under /connections into the mount folder's name and the
 * remote path inside it; undefined for anything else. The remote path keeps
 * the caller's exact segments, because a provider's names are its own.
 */
export function splitConnectionPath(
  path: string,
): { mountName: string; remotePath: string } | undefined {
  if (!path.startsWith(CONNECTIONS_PREFIX)) return undefined;
  const rest = path.slice(CONNECTIONS_PREFIX.length);
  const slash = rest.indexOf("/");
  const mountName = slash === -1 ? rest : rest.slice(0, slash);
  const remotePath = slash === -1 ? "/" : rest.slice(slash);
  if (mountName === "" || !isStoragePath(remotePath)) return undefined;
  return { mountName, remotePath };
}

type ConnectionRow = {
  id: string;
  provider: string;
  label: string;
  status: string;
  archived_at: Date | null;
};

async function liveConnection(
  tx: PgTransactionClient,
  organizationId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  if (!UUID.test(connectionId)) notFound();
  const found = await tx.query<ConnectionRow>(
    `select id, provider, label, status, archived_at
       from bakery.integration_connections
      where organization_id = $1 and id = $2`,
    [organizationId, connectionId],
  );
  const row = found.rows[0];
  if (!row) notFound();
  if (row.archived_at !== null || row.status !== "enabled") {
    conflict("connection_unavailable");
  }
  return row;
}

function bindingFor(
  deps: StorageConnectionDeps,
  organizationId: string,
  connection: ConnectionRow,
): StorageConnectionBinding {
  const binding = deps.resolver({
    id: connection.id,
    organizationId,
    provider: connection.provider,
  });
  if (!binding) {
    // Typed, so a caller can tell "nothing serves this connection's files
    // here" from a missing path or a refused read.
    throw new StandardError({ code: "STORAGE_PROVIDER_UNAVAILABLE" });
  }
  return binding;
}

/** A mounted connection, as the mount table and its folder record it. */
export type StorageMount = Readonly<{
  mountId: string;
  entryId: string;
  connectionId: string;
  name: string;
  path: string;
}>;

/**
 * Mounts a storage connection under /connections, or returns its mount.
 * Idempotent per connection. The folder takes the connection's label (made
 * unique by the tree when another mount holds it) and is a record area: files
 * appear in it only by ingest, and nothing writes into it by path.
 */
export async function mountStorageConnection(
  tx: PgTransactionClient,
  deps: StorageConnectionDeps,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    connectionId: string;
  }>,
): Promise<StorageMount> {
  const connection = await liveConnection(
    tx,
    input.organizationId,
    input.connectionId,
  );
  bindingFor(deps, input.organizationId, connection);
  const db = storageQueryOf(tx);
  await ensureOrganizationTree(db, input.organizationId);
  const top = await tx.query<{ id: string }>(
    `select id from bakery.storage_entries
      where organization_id = $1 and system_key = 'connections'`,
    [input.organizationId],
  );
  const entryId = await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: top.rows[0].id,
    name: connection.label,
    policy: "record",
    systemKey: mountSystemKey(connection.id),
  });
  await tx.query(
    `insert into bakery.storage_connection_mounts
       (organization_id, connection_id, entry_id, created_by)
     values ($1, $2, $3, $4)
     on conflict (organization_id, connection_id) do nothing`,
    [input.organizationId, connection.id, entryId, input.principalId],
  );
  const mount = await tx.query<{ id: string; entry_id: string; name: string }>(
    `select mount.id, mount.entry_id, entry.name
       from bakery.storage_connection_mounts mount
       join bakery.storage_entries entry
         on entry.organization_id = mount.organization_id
        and entry.id = mount.entry_id
      where mount.organization_id = $1 and mount.connection_id = $2`,
    [input.organizationId, connection.id],
  );
  const row = mount.rows[0];
  return {
    mountId: row.id,
    entryId: row.entry_id,
    connectionId: connection.id,
    name: row.name,
    path: CONNECTIONS_PREFIX + row.name,
  };
}

/** A path under a mount the caller may read, with its live binding. */
export type OpenedMount = Readonly<{
  mount: StorageMount;
  binding: StorageConnectionBinding;
  remotePath: string;
}>;

/**
 * Resolves a tree path under /connections to its mount, checking that the
 * caller may read the mount folder (organization, area and agent grants, the
 * same rule every tree read uses) and that the connection is live. Another
 * organization's mount, or one the caller may not read, is 404.
 */
export async function openConnectionPath(
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  tx: PgTransactionClient,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<
    { organizationId: string; principalId: string; path: string }
  >,
): Promise<OpenedMount> {
  const split = splitConnectionPath(input.path);
  if (!split) notFound();
  let nameKey: string;
  try {
    nameKey = normalizeEntryName(split.mountName).nameKey;
  } catch (error) {
    if (error instanceof StorageNameError) notFound();
    throw error;
  }
  const found = await tx.query<
    { id: string; entry_id: string; connection_id: string; name: string }
  >(
    `select mount.id, mount.entry_id, mount.connection_id, entry.name
       from bakery.storage_connection_mounts mount
       join bakery.storage_entries entry
         on entry.organization_id = mount.organization_id
        and entry.id = mount.entry_id
       join bakery.storage_entries top
         on top.organization_id = entry.organization_id
        and top.id = entry.parent_id and top.system_key = 'connections'
      where mount.organization_id = $1 and entry.name_key = $2`,
    [input.organizationId, nameKey],
  );
  const row = found.rows[0];
  if (!row) notFound();
  await readableEntry(
    context,
    tx,
    input.organizationId,
    input.principalId,
    reader,
    row.entry_id,
  );
  const connection = await liveConnection(
    tx,
    input.organizationId,
    row.connection_id,
  );
  return {
    mount: {
      mountId: row.id,
      entryId: row.entry_id,
      connectionId: row.connection_id,
      name: row.name,
      path: CONNECTIONS_PREFIX + row.name,
    },
    binding: bindingFor(deps, input.organizationId, connection),
    remotePath: split.remotePath,
  };
}

/** One child of a mounted folder, as the tree shows it. */
export type ConnectionListedItem =
  & StorageObject
  & Readonly<{
    /** The item's path in the tree, under its mount. */
    treePath: string;
  }>;

function treePathOf(mount: StorageMount, remotePath: string): string {
  return remotePath === "/" ? mount.path : mount.path + remotePath;
}

function parsedObject(value: unknown): StorageObject | null {
  if (value === null) return null;
  const parsed = StorageObjectSchema.safeParse(value);
  if (!parsed.success) providerAnswerInvalid(parsed.error);
  return parsed.data;
}

/**
 * One page of a mounted folder, read through the port: nothing is copied.
 * Keyset paged by the provider's cursor.
 */
export async function listConnectionFolder(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string; cursor?: string; limit?: number }>,
): Promise<{ items: ConnectionListedItem[]; nextCursor: string | null }> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const limit = input.limit ?? 25;
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STORAGE_PAGE_SIZE
  ) {
    refused("out_of_range", "limit");
  }
  const opened = await openConnectionPath(context, tx, reader, deps, {
    organizationId,
    principalId,
    path: input.path,
  });
  const page = StorageListPageSchema.safeParse(
    await opened.binding.port.list({
      path: opened.remotePath,
      cursor: input.cursor ?? null,
      limit,
      ctx: opened.binding.ctx,
    }),
  );
  if (!page.success) providerAnswerInvalid(page.error);
  return {
    items: page.data.items.map((item) => ({
      ...item,
      treePath: treePathOf(opened.mount, item.path),
    })),
    nextCursor: page.data.nextCursor,
  };
}

/** A mounted file or folder's facts, read through the port; 404 when absent. */
export async function statConnectionPath(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string }>,
): Promise<ConnectionListedItem> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const opened = await openConnectionPath(context, tx, reader, deps, {
    organizationId,
    principalId,
    path: input.path,
  });
  const object = parsedObject(
    await opened.binding.port.stat({
      path: opened.remotePath,
      ctx: opened.binding.ctx,
    }),
  );
  if (!object) notFound();
  return { ...object, treePath: treePathOf(opened.mount, object.path) };
}

/** A byte range of a mounted file, read through the port and not kept. */
export async function readConnectionRange(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string; offset: number; length: number }>,
): Promise<{ object: StorageObject; bytes: Uint8Array }> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const range = StorageReadRangeSchema.safeParse({
    offset: input.offset,
    length: input.length,
  });
  if (!range.success) refused("out_of_range", "range");
  const opened = await openConnectionPath(context, tx, reader, deps, {
    organizationId,
    principalId,
    path: input.path,
  });
  const read = await opened.binding.port.read({
    path: opened.remotePath,
    range: range.data,
    revision: null,
    ctx: opened.binding.ctx,
  });
  if (read.kind !== "bytes") notFound();
  const object = parsedObject(read.object);
  if (!object) notFound();
  if (read.bytes.byteLength > range.data.length) {
    providerAnswerInvalid(new Error("range read returned too many bytes"));
  }
  return { object, bytes: read.bytes };
}

/** What one ingest produced: the artifact version a remote revision became. */
export type ConnectionIngest = Readonly<{
  artifactId: string;
  versionId: string;
  entryId: string;
  sha256: string;
  sizeBytes: number;
  remotePath: string;
  remoteRevision: string;
  /** True when an earlier use already ingested this revision. */
  replayed: boolean;
}>;

type IngestRow = {
  artifact_id: string;
  artifact_version_id: string;
  sha256: string;
  size_bytes: string;
  remote_revision: string;
};

async function ingestRow(
  tx: PgTransactionClient,
  organizationId: string,
  mountId: string,
  remotePath: string,
  remoteRevision: string,
): Promise<IngestRow | undefined> {
  const found = await tx.query<IngestRow>(
    `select artifact_id, artifact_version_id, sha256,
            size_bytes::text as size_bytes, remote_revision
       from bakery.storage_connection_ingests
      where organization_id = $1 and mount_id = $2 and remote_path = $3
        and remote_revision = $4`,
    [organizationId, mountId, remotePath, remoteRevision],
  );
  return found.rows[0];
}

/**
 * The file entry an ingested artifact has under its mount, at the remote
 * path; made (with the folders above it) on the first ingest of the path.
 */
async function mountFileEntry(
  tx: PgTransactionClient,
  organizationId: string,
  mount: StorageMount,
  remotePath: string,
  artifactId: string,
): Promise<string> {
  const db = storageQueryOf(tx);
  const existing = await tx.query<{ id: string }>(
    `select id from bakery.storage_entries
      where organization_id = $1 and artifact_id = $2`,
    [organizationId, artifactId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const segments = remotePath.slice(1).split("/");
  let parentId: string | undefined = mount.entryId;
  try {
    for (const segment of segments.slice(0, -1)) {
      parentId = await ensureChildFolder(db, {
        organizationId,
        parentId: parentId!,
        segment,
      });
      if (parentId === undefined) conflict("connection_path_conflict");
    }
  } catch (error) {
    if (error instanceof StorageNameError) refused("connection_path_invalid");
    throw error;
  }
  const id = await insertFileEntry(db, {
    organizationId,
    parentId: parentId!,
    name: segments[segments.length - 1],
    artifactId,
  });
  if (!id) conflict("connection_path_conflict");
  return id;
}

/**
 * Ingests one remote file revision into an artifact version, or returns the
 * version an earlier use made of the same mount, path and revision. The first
 * ingest of a path makes its artifact on `taskId` (artifacts are task-scoped,
 * O36) and projects it at the same path under the mount; a later revision is a
 * new version of the same artifact, and identical bytes reuse the current one.
 * Large files are refused for now: a remote file larger than one range read is
 * deferred to resumable ingest.
 */
export async function ingestConnectionFile(
  tx: PgTransactionClient,
  deps: StorageConnectionDeps,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    taskId: string;
    mount: StorageMount;
    binding: StorageConnectionBinding;
    remotePath: string;
  }>,
): Promise<ConnectionIngest> {
  const { organizationId, mount, binding, remotePath } = input;
  const object = parsedObject(
    await binding.port.stat({ path: remotePath, ctx: binding.ctx }),
  );
  if (!object) notFound();
  if (object.kind !== "file") refused("connection_path_not_a_file");
  if (object.revision === null) refused("connection_file_has_no_revision");
  const revision = object.revision;
  const done = (row: IngestRow, entryId: string, replayed: boolean) => ({
    artifactId: row.artifact_id,
    versionId: row.artifact_version_id,
    entryId,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    remotePath,
    remoteRevision: row.remote_revision,
    replayed,
  });
  const earlier = await ingestRow(
    tx,
    organizationId,
    mount.mountId,
    remotePath,
    revision,
  );
  if (earlier) {
    const entryId = await mountFileEntry(
      tx,
      organizationId,
      mount,
      remotePath,
      earlier.artifact_id,
    );
    return done(earlier, entryId, true);
  }
  if ((object.sizeBytes ?? 0) > MAX_STORAGE_READ_BYTES) {
    refused("connection_file_too_large");
  }
  const read = await binding.port.read({
    path: remotePath,
    range: null,
    revision,
    ctx: binding.ctx,
  });
  if (read.kind === "missing") notFound();
  if (read.kind === "stale") conflict("connection_file_changed");
  const content = read.bytes;
  const sha256 = await sha256Bytes(content);

  // The artifact a path already has, else a new one on the using work item.
  const prior = await tx.query<{ artifact_id: string }>(
    `select artifact_id from bakery.storage_connection_ingests
      where organization_id = $1 and mount_id = $2 and remote_path = $3
      order by created_at desc, id desc limit 1`,
    [organizationId, mount.mountId, remotePath],
  );
  let artifactId = prior.rows[0]?.artifact_id;
  if (artifactId === undefined) {
    const made = await tx.query<{ id: string }>(
      `insert into bakery.artifacts
         (organization_id, task_id, artifact_type, name)
       values ($1, $2, $3, $4)
       on conflict (organization_id, task_id, artifact_type, name)
       do update set updated_at = now()
       returning id`,
      [
        organizationId,
        input.taskId,
        CONNECTION_FILE_ARTIFACT_TYPE,
        "connections/" + mount.name + remotePath,
      ],
    );
    artifactId = made.rows[0].id;
  }
  const entryId = await mountFileEntry(
    tx,
    organizationId,
    mount,
    remotePath,
    artifactId,
  );
  const parent = await tx.query<{
    id: string;
    task_id: string;
    revision: number;
    version: number;
    current_version_id: string | null;
    current_sha256: string | null;
  }>(
    `select artifact.id, artifact.task_id, artifact.revision, artifact.version,
            artifact.current_version_id, current.sha256 as current_sha256
       from bakery.artifacts artifact
       left join bakery.artifact_versions current
         on current.organization_id = artifact.organization_id
        and current.id = artifact.current_version_id
      where artifact.organization_id = $1 and artifact.id = $2
      for update of artifact`,
    [organizationId, artifactId],
  );
  const artifact = parent.rows[0];
  let versionId: string;
  if (
    artifact.current_version_id !== null && artifact.current_sha256 === sha256
  ) {
    // The provider moved the revision but the bytes are the same version.
    versionId = artifact.current_version_id;
  } else {
    const scope = await tx.query<{
      application_id: string;
      repository_id: string | null;
      conversation_id: string | null;
    }>(
      `select application_id, repository_id, conversation_id
         from bakery.tasks where organization_id = $1 and id = $2`,
      [organizationId, artifact.task_id],
    );
    const task = scope.rows[0];
    if (!task) notFound();
    const committed = await commitArtifactVersion(tx, {
      scope: {
        organizationId,
        taskId: artifact.task_id,
        applicationId: task.application_id,
        repositoryId: task.repository_id,
        conversationId: task.conversation_id,
      },
      parent: {
        id: artifact.id,
        revision: artifact.revision,
        version: artifact.version,
        currentVersionId: artifact.current_version_id,
      },
      version: {
        // The artifact row is locked above, so its current version is the
        // parent; the store takes it in If-Match form.
        parentVersionId: artifact.current_version_id === null
          ? null
          : '"' + artifact.current_version_id + '"',
        runStepId: null,
        authorId: input.principalId,
        subjectHeadSha: null,
        subjectBaseSha: null,
        stepKey: null,
        metadata: {
          connectionId: mount.connectionId,
          remotePath,
          remoteRevision: revision,
        },
        content,
        sha256,
        mediaType: object.mediaType ?? "application/octet-stream",
      },
      promotion: { kind: "human" },
      publicationSource: "import",
      ...(deps.blobStore === undefined ? {} : { blobStore: deps.blobStore }),
    });
    versionId = String(committed.id);
  }
  const inserted = await tx.query<IngestRow>(
    `insert into bakery.storage_connection_ingests (
       organization_id, mount_id, remote_path, remote_revision, artifact_id,
       artifact_version_id, sha256, size_bytes, created_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id, mount_id, remote_path, remote_revision)
     do nothing
     returning artifact_id, artifact_version_id, sha256,
               size_bytes::text as size_bytes, remote_revision`,
    [
      organizationId,
      mount.mountId,
      remotePath,
      revision,
      artifactId,
      versionId,
      sha256,
      content.byteLength,
      input.principalId,
    ],
  );
  if (inserted.rows[0]) return done(inserted.rows[0], entryId, false);
  const raced = await ingestRow(
    tx,
    organizationId,
    mount.mountId,
    remotePath,
    revision,
  );
  if (!raced) conflict("connection_ingest_vanished");
  return done(raced, entryId, true);
}

/**
 * Ingest on use: a run that names a path under /connections as an input
 * pins the artifact version the file's current remote revision became. The
 * caller's right to read the mount is checked first, as for any tree read.
 */
export async function ingestConnectionInput(
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  tx: PgTransactionClient,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    taskId: string;
    path: string;
  }>,
): Promise<StoragePin> {
  const opened = await openConnectionPath(context, tx, reader, deps, input);
  const ingest = await ingestConnectionFile(tx, deps, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    taskId: input.taskId,
    mount: opened.mount,
    binding: opened.binding,
    remotePath: opened.remotePath,
  });
  return {
    entryId: ingest.entryId,
    label: input.path,
    artifactId: ingest.artifactId,
    versionId: ingest.versionId,
    sha256: ingest.sha256,
  };
}

// --- One-way sync --------------------------------------------------------

/** Remote files one sync run visits at most; the next run continues. */
export const MAX_SYNC_FILES_PER_RUN = 500;

/**
 * Records a one-way sync of a mounted folder into a work item. The caller
 * must be able to read the mount; the sync workflow then runs it.
 */
export async function createConnectionSync(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string; taskId: string }>,
): Promise<{ syncId: string }> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const opened = await openConnectionPath(context, tx, reader, deps, {
    organizationId,
    principalId,
    path: input.path,
  });
  if (!UUID.test(input.taskId)) notFound();
  const task = await tx.query(
    "select 1 from bakery.tasks where organization_id = $1 and id = $2",
    [organizationId, input.taskId],
  );
  if (task.rows.length === 0) notFound();
  const folder = parsedObject(
    await opened.binding.port.stat({
      path: opened.remotePath,
      ctx: opened.binding.ctx,
    }),
  );
  if (!folder) notFound();
  if (folder.kind !== "folder") refused("connection_path_not_a_folder");
  const made = await tx.query<{ id: string }>(
    `insert into bakery.storage_connection_syncs
       (organization_id, mount_id, remote_path, task_id, created_by)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      organizationId,
      opened.mount.mountId,
      opened.remotePath,
      input.taskId,
      principalId,
    ],
  );
  return { syncId: made.rows[0].id };
}

/** What one sync run did. */
export type ConnectionSyncResult = Readonly<{
  /** True when the change feed showed nothing new since the last run. */
  unchanged: boolean;
  ingested: number;
  replayed: number;
  /** Remote files that could not be ingested, such as one too large. */
  skipped: number;
}>;

type SyncRow = {
  id: string;
  mount_id: string;
  entry_id: string;
  mount_name: string;
  connection_id: string;
  remote_path: string;
  task_id: string;
  change_position: string | null;
  created_by: string;
};

/**
 * Runs one sync: ingests every file under its remote folder into its work
 * item, one transaction per file, so a failure keeps what came before. The
 * change feed decides whether anything is to do: a sync that has run before
 * and sees no event since its position records the run and stops. One way
 * only: a remote deletion leaves the ingested versions in place, and nothing
 * Bakery holds is ever written back.
 */
export async function runConnectionSync(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  input: Readonly<{ organizationId: string; syncId: string }>,
): Promise<ConnectionSyncResult> {
  const { organizationId } = input;
  const opened = await withPgTransaction(database, async (tx) => {
    const found = await tx.query<SyncRow>(
      `select sync.id, sync.mount_id, mount.entry_id, entry.name as mount_name,
              mount.connection_id, sync.remote_path, sync.task_id,
              sync.change_position, sync.created_by
         from bakery.storage_connection_syncs sync
         join bakery.storage_connection_mounts mount
           on mount.organization_id = sync.organization_id
          and mount.id = sync.mount_id
         join bakery.storage_entries entry
           on entry.organization_id = mount.organization_id
          and entry.id = mount.entry_id
        where sync.organization_id = $1 and sync.id = $2`,
      [organizationId, input.syncId],
    );
    const row = found.rows[0];
    if (!row) notFound();
    const connection = await liveConnection(
      tx,
      organizationId,
      row.connection_id,
    );
    return { row, binding: bindingFor(deps, organizationId, connection) };
  });
  const { row, binding } = opened;
  const mount: StorageMount = {
    mountId: row.mount_id,
    entryId: row.entry_id,
    connectionId: row.connection_id,
    name: row.mount_name,
    path: CONNECTIONS_PREFIX + row.mount_name,
  };

  // Drain the change feed first: its end is the position this run reaches.
  let position = row.change_position;
  let changed = row.change_position === null;
  for (;;) {
    const page = StorageChangesPageSchema.safeParse(
      await binding.port.changes({
        since: position,
        limit: 200,
        ctx: binding.ctx,
      }),
    );
    if (!page.success) providerAnswerInvalid(page.error);
    const prefix = row.remote_path === "/" ? "/" : row.remote_path + "/";
    if (
      page.data.events.some((event) =>
        event.kind !== "deleted" && event.path.startsWith(prefix)
      )
    ) changed = true;
    if (page.data.events.length === 0 || page.data.position === position) {
      position = page.data.position ?? position;
      break;
    }
    position = page.data.position;
  }

  const result = { unchanged: !changed, ingested: 0, replayed: 0, skipped: 0 };
  if (changed) {
    const folders = [row.remote_path];
    let visited = 0;
    while (folders.length > 0 && visited < MAX_SYNC_FILES_PER_RUN) {
      const folder = folders.shift()!;
      let cursor: string | null = null;
      do {
        const page = StorageListPageSchema.safeParse(
          await binding.port.list({
            path: folder,
            cursor,
            limit: MAX_STORAGE_PAGE_SIZE,
            ctx: binding.ctx,
          }),
        );
        if (!page.success) providerAnswerInvalid(page.error);
        for (const item of page.data.items) {
          if (item.kind === "folder") {
            folders.push(item.path);
            continue;
          }
          if (visited >= MAX_SYNC_FILES_PER_RUN) break;
          visited++;
          try {
            const ingest = await withPgTransaction(
              database,
              (tx) =>
                ingestConnectionFile(tx, deps, {
                  organizationId,
                  principalId: row.created_by,
                  taskId: row.task_id,
                  mount,
                  binding,
                  remotePath: item.path,
                }),
            );
            if (ingest.replayed) result.replayed++;
            else result.ingested++;
          } catch (error) {
            if (!(error instanceof StandardError)) throw error;
            result.skipped++;
          }
        }
        cursor = page.data.nextCursor;
      } while (cursor !== null && visited < MAX_SYNC_FILES_PER_RUN);
    }
  }
  await database.query(
    `update bakery.storage_connection_syncs
        set change_position = $3, last_run_at = now(), updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, input.syncId, position],
  );
  return result;
}

/** Syncs one workflow run takes at most, least recently run first. */
export const MAX_SYNCS_PER_SWEEP = 50;

/**
 * Runs the syncs least recently run first. A sync whose connection is gone,
 * or whose provider is not deployed, is counted and skipped; one failure
 * never stops the rest.
 */
export async function runDueConnectionSyncs(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  limit = MAX_SYNCS_PER_SWEEP,
): Promise<{ ran: number; failed: number }> {
  const due = await database.query<{ id: string; organization_id: string }>(
    `select id, organization_id from bakery.storage_connection_syncs
      where paused_at is null
      order by last_run_at asc nulls first, id asc limit $1`,
    [limit],
  );
  let ran = 0;
  let failed = 0;
  for (const sync of due.rows) {
    try {
      await runConnectionSync(database, deps, {
        organizationId: sync.organization_id,
        syncId: sync.id,
      });
      ran++;
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      failed++;
    }
  }
  return { ran, failed };
}

const STORAGE_CONNECTION_SYNC_FUNCTION_ID =
  "bakery-knowledge-storage-connection-sync";

/**
 * The built-in one-way sync workflow: every hour, at minute 53, runs the
 * syncs least recently run first. Not minute 41 (the retention reaper) or 23
 * (the upload reaper), so storage sweeps do not start together.
 */
export function createStorageConnectionSyncWorkflow(
  options: Readonly<{
    database: PgDatabase;
    client: Inngest;
    storage: StorageConnectionDeps;
  }>,
) {
  return options.client.createFunction(
    {
      id: STORAGE_CONNECTION_SYNC_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "53 * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "run-due-connection-syncs",
        () => runDueConnectionSyncs(options.database, options.storage),
      ),
  );
}

// --- Export as a keyed effect --------------------------------------------
//
// The write goes through the external effect ledger (bakery.external_effects:
// idempotency key, request digest, prepared -> submitted claim, fenced
// outcome) but not through the integration-action executor. That executor
// runs a gate-registered provider action built from request templates and a
// selected integration resource; a storage port is a typed family call with
// neither, so the ledger is the shared part and this is its dispatcher.

/** The arguments an export effect records; replayed to the write. */
type ExportArguments = Readonly<{
  mountId: string;
  remotePath: string;
  artifactVersionId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  ifMatch: string | null;
}>;

function exportTarget(connectionId: string, remotePath: string): string {
  return "storage-connection:" + connectionId + ":" + remotePath;
}

/**
 * Records the intent to write an artifact version out to a mounted path, as
 * a keyed external effect: the same key with the same request returns the
 * same effect, a different request under the key is refused. Nothing is
 * written here; `runStorageExport` dispatches it.
 */
export async function prepareStorageExport(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{
    path: string;
    artifactVersionId: string;
    idempotencyKey: string;
    ifMatch?: string | null;
  }>,
): Promise<
  { effectId: string; status: ExternalEffectRow["status"]; replayed: boolean }
> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    refused("idempotency_key_invalid", "idempotencyKey");
  }
  const opened = await openConnectionPath(context, tx, reader, deps, {
    organizationId,
    principalId,
    path: input.path,
  });
  if (opened.remotePath === "/") refused("connection_path_not_a_file");
  if (!UUID.test(input.artifactVersionId)) notFound();
  const version = await tx.query<
    { sha256: string; size_bytes: number; media_type: string }
  >(
    `select sha256, size_bytes, media_type from bakery.artifact_versions
      where organization_id = $1 and id = $2 and purged_at is null`,
    [organizationId, input.artifactVersionId],
  );
  const source = version.rows[0];
  if (!source) notFound();
  const args: ExportArguments = {
    mountId: opened.mount.mountId,
    remotePath: opened.remotePath,
    artifactVersionId: input.artifactVersionId,
    sha256: source.sha256,
    sizeBytes: Number(source.size_bytes),
    mediaType: source.media_type,
    ifMatch: input.ifMatch ?? null,
  };
  const target = exportTarget(opened.mount.connectionId, opened.remotePath);
  const digest = await computeRequestDigest({
    operation: STORAGE_EXPORT_OPERATION,
    actionVersion: STORAGE_EXPORT_VERSION,
    target,
    connectionId: opened.mount.connectionId,
    resourceId: opened.mount.mountId,
    externalAccountId: null,
    externalResourceId: null,
    arguments: args,
    actorRef: principalId,
    runStepId: null,
    automationDefinitionId: null,
    budgetReservationId: null,
    approval: null,
  });
  const key = {
    organizationId,
    operation: STORAGE_EXPORT_OPERATION,
    target,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = (row: ExternalEffectRow) => {
    if (row.requestDigest !== digest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return { effectId: row.id, status: row.status, replayed: true };
  };
  const existing = await findEffectByKey(tx, key);
  if (existing) return replay(existing);
  const inserted = await insertPreparedHostEffect(tx, {
    id: crypto.randomUUID(),
    organizationId,
    operation: STORAGE_EXPORT_OPERATION,
    actionVersion: STORAGE_EXPORT_VERSION,
    target,
    integrationConnectionId: opened.mount.connectionId,
    requestingPrincipalId: principalId,
    actorRef: principalId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
    safeArguments: args,
    argumentArtifactVersionId: input.artifactVersionId,
    adapterVersion: opened.binding.adapterVersion,
  });
  if (inserted) {
    return { effectId: inserted.id, status: inserted.status, replayed: false };
  }
  const winner = await findEffectByKey(tx, key);
  if (!winner) conflict("effect_key_vanished");
  return replay(winner);
}

/** How one export run ended. */
export type StorageExportResult = Readonly<{
  outcome: "confirmed" | "failed" | "retry_scheduled" | "in_flight";
  effect: ExternalEffectRow;
  /** True only when this call sent the write. */
  dispatched: boolean;
}>;

function settledExport(
  effect: ExternalEffectRow,
  dispatched: boolean,
): StorageExportResult {
  switch (effect.status) {
    case "confirmed":
      return { outcome: "confirmed", effect, dispatched };
    case "failed":
      return { outcome: "failed", effect, dispatched };
    case "prepared":
      return { outcome: "retry_scheduled", effect, dispatched };
    default:
      return { outcome: "in_flight", effect, dispatched };
  }
}

async function exportBytes(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  organizationId: string,
  args: ExportArguments,
): Promise<Uint8Array> {
  const found = await database.query<
    { content: Uint8Array | null; blob_id: string | null; size_bytes: number }
  >(
    `select content, blob_id, size_bytes from bakery.artifact_versions
      where organization_id = $1 and id = $2`,
    [organizationId, args.artifactVersionId],
  );
  const row = found.rows[0];
  if (!row) notFound();
  if (row.content !== null) return new Uint8Array(row.content);
  if (!deps.blobStore) conflict("export_bytes_unavailable");
  return await deps.blobStore.read(
    organizationId,
    args.sha256,
    Number(row.size_bytes),
  );
}

/**
 * Drives one export effect toward a proven outcome. The write runs only after
 * the claim committed `prepared -> submitted` with a new generation; it is
 * keyed by the effect id, so a provider lands it once however often it is
 * sent. A written file confirms the effect with the remote revision as its
 * remote id; a refused `If-Match` fails it; a thrown write goes back to
 * prepared to be sent again under the same key. A submitted effect whose
 * lease lapsed is sent again at its generation for the same reason.
 */
export async function runStorageExport(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  input: Readonly<{ organizationId: string; effectId: string }>,
): Promise<StorageExportResult> {
  const { organizationId, effectId } = input;
  const claimed = await withPgTransaction(database, async (tx): Promise<
    | { settled: ExternalEffectRow }
    | { effect: ExternalEffectRow; binding: StorageConnectionBinding }
  > => {
    const state = await readEffectState(tx, organizationId, effectId);
    if (!state || state.row.operation !== STORAGE_EXPORT_OPERATION) notFound();
    const { row } = state;
    if (row.status === "confirmed" || row.status === "failed") {
      return { settled: row };
    }
    if (row.status === "submitted" && state.leaseLive) return { settled: row };
    if (row.status === "prepared" && !state.due) return { settled: row };
    const connection = await liveConnection(
      tx,
      organizationId,
      row.integrationConnectionId!,
    );
    const binding = bindingFor(deps, organizationId, connection);
    if (row.status === "prepared") {
      const claim = await casClaim(
        tx,
        organizationId,
        effectId,
        row.dispatchGeneration,
        EXPORT_LEASE_SECONDS,
      );
      if (!claim) return { settled: row };
      return { effect: claim, binding };
    }
    return { effect: row, binding };
  });
  if ("settled" in claimed) return settledExport(claimed.settled, false);
  const { effect, binding } = claimed;
  const args = effect.safeArguments as ExportArguments;
  const bytes = await exportBytes(database, deps, organizationId, args);
  let outcome:
    | { kind: "confirmed"; remoteId: string | null; safeResult: unknown }
    | { kind: "failed"; failureCode: string }
    | { kind: "retry"; delaySeconds: number };
  try {
    const written = StorageWriteResultSchema.parse(
      await binding.port.write({
        path: args.remotePath,
        mediaType: args.mediaType,
        ifMatch: args.ifMatch,
        idempotencyKey: effect.id,
        bytes,
        ctx: binding.ctx,
      }),
    );
    outcome = written.kind === "written"
      ? {
        kind: "confirmed",
        remoteId: written.object.revision,
        safeResult: {
          path: written.object.path,
          revision: written.object.revision,
        },
      }
      : { kind: "failed", failureCode: "provider_rejected" };
  } catch {
    outcome = { kind: "retry", delaySeconds: EXPORT_RETRY_SECONDS };
  }
  const recorded = await withPgTransaction(
    database,
    (tx) =>
      casOutcome(
        tx,
        organizationId,
        effectId,
        effect.dispatchGeneration,
        outcome,
      ),
  );
  if (recorded) return settledExport(recorded, true);
  const current = await withPgTransaction(
    database,
    (tx) => findEffectById(tx, organizationId, effectId),
  );
  if (!current) notFound();
  return settledExport(current, true);
}

// --- Provider registry -----------------------------------------------------

/** A storage provider the host can bind a connection to, by provider slug. */
export type StorageProviderEntry = Readonly<{
  /** The integration_connections.provider value this entry serves. */
  provider: string;
  bind(connection: StorageConnectionFacts): StorageConnectionBinding;
}>;

/**
 * The resolver over the storage providers an installation deploys: a
 * connection binds to the entry its provider names, and to nothing else.
 */
export function createStorageProviderRegistry(
  entries: readonly StorageProviderEntry[],
): StorageProviderResolver {
  const byProvider = new Map(entries.map((entry) => [entry.provider, entry]));
  if (byProvider.size !== entries.length) {
    throw new Error("STORAGE_PROVIDER_DUPLICATE");
  }
  return (connection) => byProvider.get(connection.provider)?.bind(connection);
}

/**
 * The storage providers this installation deploys. Empty until a hosted
 * storage provider ships, so every storage connection answers
 * STORAGE_PROVIDER_UNAVAILABLE rather than failing silently.
 */
export const deployedStorageProviders: readonly StorageProviderEntry[] = Object
  .freeze([]);

/** The storage connection dependencies the server runs with. */
export function defaultStorageConnections(
  blobStore?: OrganizationBlobStore,
): StorageConnectionDeps {
  return {
    resolver: createStorageProviderRegistry(deployedStorageProviders),
    ...(blobStore === undefined ? {} : { blobStore }),
  };
}

// --- Route handlers --------------------------------------------------------

/** Mounts the connection the route names under /connections. */
export async function mountConnectionAction(
  context: ActionContext,
  deps: StorageConnectionDeps,
): Promise<StorageMount> {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  return await mountStorageConnection(tx, deps, {
    organizationId,
    principalId,
    connectionId: context.params.id ?? "",
  });
}

function itemOutput(item: ConnectionListedItem) {
  return {
    path: item.treePath,
    remotePath: item.path,
    name: item.name,
    kind: item.kind,
    sizeBytes: item.sizeBytes,
    mediaType: item.mediaType,
    revision: item.revision,
    modifiedAt: item.modifiedAt,
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

type PathCursorScope = Readonly<{
  organizationId: string;
  principalId: string;
  path: string;
}>;

/**
 * Wraps the provider's own cursor so the page token is signed and bound to
 * this operation, caller, organization and folder, like every other list
 * cursor; the provider's cursor is opaque text the shared row cursor cannot
 * carry.
 */
async function signPathCursor(
  secret: string,
  scope: PathCursorScope,
  providerCursor: string,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({
      a: "storageConnectionPaths.list",
      o: scope.organizationId,
      p: scope.principalId,
      f: scope.path,
      c: providerCursor,
    })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await cursorKey(secret),
      new TextEncoder().encode(payload),
    ),
  );
  const token = payload + "." + base64Url(signature);
  if (token.length > 512) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return token;
}

async function openPathCursor(
  secret: string,
  scope: PathCursorScope,
  token: string | undefined,
): Promise<string | null> {
  if (token === undefined) return null;
  const invalid = (): never => {
    throw new StandardError({ code: "INVALID_CURSOR" });
  };
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0] + parts[1])) {
    invalid();
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await cursorKey(secret),
    new Uint8Array(Buffer.from(parts[1], "base64url")),
    new TextEncoder().encode(parts[0]),
  );
  if (!valid) invalid();
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return invalid();
  }
  if (
    record.a !== "storageConnectionPaths.list" ||
    record.o !== scope.organizationId || record.p !== scope.principalId ||
    record.f !== scope.path || typeof record.c !== "string"
  ) invalid();
  return record.c as string;
}

/** storageConnectionPaths.list: one page of a mounted folder. */
export function createConnectionPathLister(
  secret: string,
  deps: StorageConnectionDeps,
) {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: Readonly<{ path: string; cursor?: string; limit?: number }>,
  ) => {
    const { organizationId, principalId } = requireWorkTransaction(context);
    const scope = { organizationId, principalId, path: input.path };
    const cursor = await openPathCursor(secret, scope, input.cursor);
    const page = await listConnectionFolder(context, reader, deps, {
      path: input.path,
      ...(cursor === null ? {} : { cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return {
      items: page.items.map(itemOutput),
      nextCursor: page.nextCursor === null
        ? null
        : await signPathCursor(secret, scope, page.nextCursor),
    };
  };
}

/** storageConnectionPaths.stat: one mounted path as the provider reports it. */
export async function statConnectionPathAction(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string }>,
) {
  return itemOutput(await statConnectionPath(context, reader, deps, input));
}

/** storageConnectionPaths.read: a byte range, base64 encoded, not kept. */
export async function readConnectionPathAction(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string; offset: number; length: number }>,
) {
  const range = await readConnectionRange(context, reader, deps, input);
  return {
    path: input.path,
    revision: range.object.revision,
    mediaType: range.object.mediaType,
    sizeBytes: range.object.sizeBytes,
    offset: input.offset,
    contentBase64: Buffer.from(range.bytes).toString("base64"),
  };
}

type SyncOutputRow = {
  id: string;
  mount_id: string;
  mount_name: string;
  remote_path: string;
  task_id: string;
  change_position: string | null;
  last_run_at: Date | null;
  paused_at: Date | null;
  created_at: Date;
  created_cursor: string;
  version: number;
  entry_id: string;
};

const SYNC_OUTPUT_SELECT = `select sync.id, sync.mount_id,
    entry.name as mount_name, sync.remote_path, sync.task_id,
    sync.change_position, sync.last_run_at, sync.paused_at, sync.created_at,
    to_char(sync.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor,
    sync.version, mount.entry_id
  from bakery.storage_connection_syncs sync
  join bakery.storage_connection_mounts mount
    on mount.organization_id = sync.organization_id
   and mount.id = sync.mount_id
  join bakery.storage_entries entry
    on entry.organization_id = mount.organization_id
   and entry.id = mount.entry_id`;

function syncOutput(row: SyncOutputRow) {
  const mountPath = CONNECTIONS_PREFIX + row.mount_name;
  return {
    id: row.id,
    mountId: row.mount_id,
    path: row.remote_path === "/" ? mountPath : mountPath + row.remote_path,
    taskId: row.task_id,
    changePosition: row.change_position,
    lastRunAt: row.last_run_at === null
      ? null
      : new Date(row.last_run_at).toISOString(),
    pausedAt: row.paused_at === null
      ? null
      : new Date(row.paused_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

async function syncRowById(
  tx: PgTransactionClient,
  organizationId: string,
  syncId: string,
): Promise<SyncOutputRow | undefined> {
  if (!UUID.test(syncId)) return undefined;
  const found = await tx.query<SyncOutputRow>(
    SYNC_OUTPUT_SELECT + " where sync.organization_id = $1 and sync.id = $2",
    [organizationId, syncId],
  );
  return found.rows[0];
}

/** storageConnectionSyncs.create: records a sync and returns it. */
export async function createConnectionSyncAction(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string; taskId: string }>,
) {
  const { transaction: tx, organizationId } = requireWorkTransaction(context);
  const { syncId } = await createConnectionSync(context, reader, deps, input);
  const row = await syncRowById(tx, organizationId, syncId);
  if (!row) notFound();
  return syncOutput(row);
}

/** storageConnectionSyncs.list: the organization's syncs, oldest first. */
export function createConnectionSyncLister(secret: string) {
  return async (
    context: ActionContext,
    input: Readonly<{ cursor?: string; limit?: number }>,
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      refused("out_of_range", "limit");
    }
    const binding: CursorBinding = {
      action: "storageConnectionSyncs.list",
      principalId,
      organizationId,
      ordering: "createdAt:asc,id:asc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<SyncOutputRow>(
      SYNC_OUTPUT_SELECT +
        " where sync.organization_id = $1" +
        " and ($2::timestamptz is null or (sync.created_at, sync.id) >" +
        " ($2::timestamptz, $3::uuid))" +
        " order by sync.created_at, sync.id limit $4",
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const page = found.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(syncOutput),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.created_cursor,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * storageConnectionSyncs.pause: stops the workflow from running a sync.
 * Pausing twice keeps the first moment. The caller must be able to read the
 * sync's mount, the same rule its reads follow; no provider is needed.
 */
export async function pauseConnectionSyncAction(
  context: ActionContext,
  reader: StorageReader,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const row = await syncRowById(tx, organizationId, context.params.id ?? "");
  if (!row) notFound();
  await readableEntry(
    context,
    tx,
    organizationId,
    principalId,
    reader,
    row.entry_id,
  );
  await tx.query(
    `update bakery.storage_connection_syncs
        set paused_at = coalesce(paused_at, now()),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and paused_at is null`,
    [organizationId, row.id],
  );
  const paused = await syncRowById(tx, organizationId, row.id);
  if (!paused) notFound();
  return syncOutput(paused);
}

/**
 * storageConnectionExports.create: records the export effect under the
 * request's Idempotency-Key. The storage export workflow sends it.
 */
export async function createConnectionExportAction(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{
    path: string;
    artifactVersionId: string;
    ifMatch?: string;
  }>,
) {
  const key = context.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (key === "") refused("idempotency_key_required", "Idempotency-Key");
  return await prepareStorageExport(context, reader, deps, {
    path: input.path,
    artifactVersionId: input.artifactVersionId,
    idempotencyKey: key,
    ifMatch: input.ifMatch ?? null,
  });
}

/** Export effects one workflow run sends at most. */
export const MAX_EXPORTS_PER_SWEEP = 50;

/**
 * Sends the export effects that are due: prepared ones whose retry delay has
 * passed, and submitted ones whose dispatch lease lapsed.
 */
export async function runDueStorageExports(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  limit = MAX_EXPORTS_PER_SWEEP,
): Promise<{ ran: number; failed: number }> {
  const due = await database.query<{ id: string; organization_id: string }>(
    `select id, organization_id from bakery.external_effects
      where operation = $1
        and ((status = 'prepared'
              and (next_retry_at is null or next_retry_at <= now()))
          or (status = 'submitted' and lease_expires_at < now()))
      order by created_at, id limit $2`,
    [STORAGE_EXPORT_OPERATION, limit],
  );
  let ran = 0;
  let failed = 0;
  for (const effect of due.rows) {
    try {
      await runStorageExport(database, deps, {
        organizationId: effect.organization_id,
        effectId: effect.id,
      });
      ran++;
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      failed++;
    }
  }
  return { ran, failed };
}

const STORAGE_EXPORT_FUNCTION_ID =
  "bakery-knowledge-storage-connection-exports";

/** Every minute, sends the export effects that are due. */
export function createStorageExportWorkflow(
  options: Readonly<{
    database: PgDatabase;
    client: Inngest;
    storage: StorageConnectionDeps;
  }>,
) {
  return options.client.createFunction(
    {
      id: STORAGE_EXPORT_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "run-due-storage-exports",
        () => runDueStorageExports(options.database, options.storage),
      ),
  );
}
