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
  casToFailed,
  findEffectById,
  findEffectByKey,
  insertPreparedEffect,
  type OutcomeChange,
  readEffectState,
} from "../effects/repository.ts";
import { computeRequestDigest } from "../effects/digest.ts";
import type { ExternalEffectRow } from "../effects/schema.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { sha256Bytes } from "./bytes.ts";
import { commitArtifactVersion } from "./persistence.ts";
import { connectionMountKey } from "./agent-file-scope.ts";
import { createLocalDiskStorageProvider } from "./local-disk-storage.ts";
import {
  readableEntry,
  readableVersionFile,
  type StorageReader,
} from "./storage-reads.ts";
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

export type StorageConnectionBinding = Readonly<{
  port: StoragePort;
  ctx: DriverContext;
  adapterVersion: string;
}>;

export type StorageConnectionFacts = Readonly<{
  id: string;
  organizationId: string;
  provider: string;
}>;

export type StorageProviderResolver = (
  connection: StorageConnectionFacts,
) => StorageConnectionBinding | undefined;

export const noStorageProviders: StorageProviderResolver = () => undefined;

export type StorageConnectionDeps = Readonly<{
  resolver: StorageProviderResolver;
  blobStore?: OrganizationBlobStore;
}>;

export const CONNECTION_FILE_ARTIFACT_TYPE = "connection_file";
export const STORAGE_EXPORT_OPERATION = "storage.file.export";
export const STORAGE_EXPORT_VERSION = 1;
const EXPORT_LEASE_SECONDS = 60;
const EXPORT_RETRY_SECONDS = 30;
export const MAX_EXPORT_ATTEMPTS = 5;
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

export function mountSystemKey(connectionId: string): string {
  return connectionMountKey(connectionId);
}

export function splitConnectionPath(
  path: string,
): { mountName: string; remotePath: string } | undefined {
  if (
    path.slice(0, CONNECTIONS_PREFIX.length).toLowerCase() !==
      CONNECTIONS_PREFIX
  ) return undefined;
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
    throw new StandardError({ code: "STORAGE_PROVIDER_UNAVAILABLE" });
  }
  return binding;
}

export type StorageMount = Readonly<{
  mountId: string;
  entryId: string;
  connectionId: string;
  name: string;
  path: string;
}>;

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

export type OpenedMount = Readonly<{
  mount: StorageMount;
  binding: StorageConnectionBinding;
  remotePath: string;
}>;

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

export async function assertConnectionsBindable(
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  tx: PgTransactionClient,
  reader: StorageReader,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    connectionIds: readonly string[];
  }>,
): Promise<void> {
  const unbindable = (connectionId: string): never => {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["files", "connections"],
          message: "storage_connection_not_bindable: " + connectionId,
          code: "storage_connection_not_bindable",
        }],
      },
    });
  };
  for (const connectionId of input.connectionIds) {
    if (!UUID.test(connectionId)) unbindable(connectionId);
    const mount = await tx.query<{ entry_id: string }>(
      "select entry_id from bakery.storage_connection_mounts" +
        " where organization_id = $1 and connection_id = $2",
      [input.organizationId, connectionId],
    );
    const entryId = mount.rows[0]?.entry_id;
    if (entryId === undefined) unbindable(connectionId);
    try {
      await readableEntry(
        context,
        tx,
        input.organizationId,
        input.principalId,
        reader,
        entryId,
      );
    } catch (error) {
      if (
        error instanceof StandardError &&
        (error.code === "RESOURCE_NOT_FOUND" || error.code === "AUTH_FORBIDDEN")
      ) unbindable(connectionId);
      throw error;
    }
    await liveConnection(tx, input.organizationId, connectionId);
  }
}

export type ConnectionListedItem =
  & StorageObject
  & Readonly<{
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

export type ConnectionIngest = Readonly<{
  artifactId: string;
  versionId: string;
  entryId: string;
  sha256: string;
  sizeBytes: number;
  remotePath: string;
  remoteRevision: string;
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
  const leaf = segments[segments.length - 1];
  for (
    const name of [leaf, `${leaf} (${artifactId.slice(0, 8)})`, artifactId]
  ) {
    const id = await insertFileEntry(db, {
      organizationId,
      parentId: parentId!,
      name,
      artifactId,
    });
    if (id) return id;
  }
  conflict("connection_path_conflict");
}

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

export const MAX_SYNC_FILES_PER_RUN = 500;

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

export type ConnectionSyncResult = Readonly<{
  unchanged: boolean;
  ingested: number;
  replayed: number;
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
  walk_folders: string[] | null;
  walk_cursor: string | null;
  walk_position: string | null;
  paused_at: Date | null;
  created_by: string;
};

type SyncWalk = {
  folders: string[];
  cursor: string | null;
  position: string | null;
};

const QUIET_SYNC: ConnectionSyncResult = {
  unchanged: true,
  ingested: 0,
  replayed: 0,
  skipped: 0,
};

export async function runConnectionSync(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  input: Readonly<
    { organizationId: string; syncId: string; maxFiles?: number }
  >,
): Promise<ConnectionSyncResult> {
  const { organizationId } = input;
  const maxFiles = input.maxFiles ?? MAX_SYNC_FILES_PER_RUN;
  const opened = await withPgTransaction(database, async (tx) => {
    const found = await tx.query<SyncRow>(
      `select sync.id, sync.mount_id, mount.entry_id, entry.name as mount_name,
              mount.connection_id, sync.remote_path, sync.task_id,
              sync.change_position, sync.walk_folders, sync.walk_cursor,
              sync.walk_position, sync.paused_at, sync.created_by
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
    if (row.paused_at !== null) return null;
    const connection = await liveConnection(
      tx,
      organizationId,
      row.connection_id,
    );
    return { row, binding: bindingFor(deps, organizationId, connection) };
  });
  if (opened === null) return QUIET_SYNC;
  const { row, binding } = opened;
  const mount: StorageMount = {
    mountId: row.mount_id,
    entryId: row.entry_id,
    connectionId: row.connection_id,
    name: row.mount_name,
    path: CONNECTIONS_PREFIX + row.mount_name,
  };

  let walk: SyncWalk | null = row.walk_folders === null ? null : {
    folders: [...row.walk_folders],
    cursor: row.walk_cursor,
    position: row.walk_position,
  };
  if (walk === null) {
    const feed = await readChangeFeed(binding, row);
    if (!feed.changed) {
      await saveSyncProgress(database, organizationId, row.id, {
        changePosition: feed.position,
        walk: null,
      });
      return QUIET_SYNC;
    }
    walk = {
      folders: [row.remote_path],
      cursor: null,
      position: feed.position,
    };
  }

  const result = { unchanged: false, ingested: 0, replayed: 0, skipped: 0 };
  let visited = 0;
  while (walk.folders.length > 0 && visited < maxFiles) {
    const page = StorageListPageSchema.safeParse(
      await binding.port.list({
        path: walk.folders[0],
        cursor: walk.cursor,
        limit: Math.min(MAX_STORAGE_PAGE_SIZE, maxFiles - visited),
        ctx: binding.ctx,
      }),
    );
    if (!page.success) providerAnswerInvalid(page.error);
    for (const item of page.data.items) {
      if (item.kind === "folder") {
        walk.folders.push(item.path);
        continue;
      }
      visited++;
      const outcome = await syncOneFile(database, deps, {
        organizationId,
        row,
        mount,
        binding,
        remotePath: item.path,
      });
      result[outcome]++;
    }
    walk.cursor = page.data.nextCursor;
    if (walk.cursor === null) walk.folders.shift();
  }
  const finished = walk.folders.length === 0;
  await saveSyncProgress(database, organizationId, row.id, {
    changePosition: finished ? walk.position : row.change_position,
    walk: finished ? null : walk,
  });
  return result;
}

async function readChangeFeed(
  binding: StorageConnectionBinding,
  row: SyncRow,
): Promise<{ position: string | null; changed: boolean }> {
  let position = row.change_position;
  let changed = row.change_position === null;
  const prefix = row.remote_path === "/" ? "/" : row.remote_path + "/";
  for (;;) {
    const page = StorageChangesPageSchema.safeParse(
      await binding.port.changes({
        since: position,
        limit: 200,
        ctx: binding.ctx,
      }),
    );
    if (!page.success) providerAnswerInvalid(page.error);
    if (
      page.data.events.some((event) =>
        event.kind !== "deleted" && event.path.startsWith(prefix)
      )
    ) changed = true;
    if (page.data.events.length === 0 || page.data.position === position) {
      return { position: page.data.position ?? position, changed };
    }
    position = page.data.position;
  }
}

async function syncOneFile(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  input: Readonly<{
    organizationId: string;
    row: SyncRow;
    mount: StorageMount;
    binding: StorageConnectionBinding;
    remotePath: string;
  }>,
): Promise<"ingested" | "replayed" | "skipped"> {
  try {
    const ingest = await withPgTransaction(
      database,
      (tx) =>
        ingestConnectionFile(tx, deps, {
          organizationId: input.organizationId,
          principalId: input.row.created_by,
          taskId: input.row.task_id,
          mount: input.mount,
          binding: input.binding,
          remotePath: input.remotePath,
        }),
    );
    return ingest.replayed ? "replayed" : "ingested";
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    return "skipped";
  }
}

async function saveSyncProgress(
  database: PgDatabase,
  organizationId: string,
  syncId: string,
  progress: Readonly<{ changePosition: string | null; walk: SyncWalk | null }>,
): Promise<void> {
  await database.query(
    `update bakery.storage_connection_syncs
        set change_position = $3, walk_folders = $4::jsonb, walk_cursor = $5,
            walk_position = $6, last_failure = null, last_run_at = now(),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      syncId,
      progress.changePosition,
      progress.walk === null ? null : JSON.stringify(progress.walk.folders),
      progress.walk?.cursor ?? null,
      progress.walk?.position ?? null,
    ],
  );
}

function syncFailureCode(error: unknown): string {
  if (!(error instanceof StandardError)) return "sync_failed";
  const reason = (error.params as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : error.code;
}

async function recordSyncFailure(
  database: PgDatabase,
  organizationId: string,
  syncId: string,
  failure: string,
): Promise<void> {
  await database.query(
    `update bakery.storage_connection_syncs
        set last_failure = $3, last_run_at = now(), updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, syncId, failure],
  );
}

export const MAX_SYNCS_PER_SWEEP = 50;

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
      failed++;
      await recordSyncFailure(
        database,
        sync.organization_id,
        sync.id,
        syncFailureCode(error),
      );
    }
  }
  return { ran, failed };
}

const STORAGE_CONNECTION_SYNC_FUNCTION_ID =
  "bakery-knowledge-storage-connection-sync";

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
  await readableVersionFile(context, tx, reader, {
    organizationId,
    principalId,
    versionId: input.artifactVersionId,
  });
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
  const inserted = await insertPreparedEffect(tx, {
    id: crypto.randomUUID(),
    organizationId,
    runStepId: null,
    automationDefinitionId: null,
    operation: STORAGE_EXPORT_OPERATION,
    actionVersion: STORAGE_EXPORT_VERSION,
    target,
    integrationConnectionId: opened.mount.connectionId,
    integrationResourceId: null,
    integrationInstallId: null,
    integrationGrantId: null,
    adapterManifestDigest: null,
    requestingPrincipalId: principalId,
    actorRef: principalId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
    safeArguments: args,
    externalAccountId: null,
    externalResourceId: null,
    adapterVersion: opened.binding.adapterVersion,
    authorizationRevision: null,
    budgetReservationId: null,
    approvalId: null,
    approvalStage: null,
    approvalPolicyDigest: null,
    argumentArtifactVersionId: input.artifactVersionId,
  });
  if (inserted) {
    return { effectId: inserted.id, status: inserted.status, replayed: false };
  }
  const winner = await findEffectByKey(tx, key);
  if (!winner) conflict("effect_key_vanished");
  return replay(winner);
}

export type StorageExportResult = Readonly<{
  outcome: "confirmed" | "failed" | "retry_scheduled" | "in_flight";
  effect: ExternalEffectRow;
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
    if (row.status !== "prepared" && row.status !== "submitted") {
      return { settled: row };
    }
    const ready = row.status === "submitted"
      ? await casOutcome(tx, organizationId, effectId, row.dispatchGeneration, {
        kind: "retry",
        delaySeconds: 0,
      })
      : row;
    if (!ready || ready.status !== "prepared") return { settled: ready ?? row };
    const binding = await exportBinding(tx, deps, organizationId, ready);
    if (binding === null) {
      return {
        settled: await failExport(tx, ready, "provider_not_sent"),
      };
    }
    if (ready.dispatchGeneration >= MAX_EXPORT_ATTEMPTS) {
      return {
        settled: await failExport(tx, ready, "retry_exhausted"),
      };
    }
    const claim = await casClaim(
      tx,
      organizationId,
      effectId,
      ready.dispatchGeneration,
      EXPORT_LEASE_SECONDS,
    );
    return claim ? { effect: claim, binding } : { settled: ready };
  });
  if ("settled" in claimed) return settledExport(claimed.settled, false);
  const { effect, binding } = claimed;
  const outcome = await dispatchExport(
    database,
    deps,
    organizationId,
    effect,
    binding,
  );
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

async function failExport(
  tx: PgTransactionClient,
  effect: ExternalEffectRow,
  failureCode: string,
): Promise<ExternalEffectRow> {
  const failed = await casToFailed(
    tx,
    effect.organizationId,
    effect.id,
    effect.dispatchGeneration,
    failureCode,
  );
  return failed ?? effect;
}

async function exportBinding(
  tx: PgTransactionClient,
  deps: StorageConnectionDeps,
  organizationId: string,
  effect: ExternalEffectRow,
): Promise<StorageConnectionBinding | null> {
  try {
    const connection = await liveConnection(
      tx,
      organizationId,
      effect.integrationConnectionId!,
    );
    return bindingFor(deps, organizationId, connection);
  } catch (error) {
    if (error instanceof StandardError) return null;
    throw error;
  }
}

async function dispatchExport(
  database: PgDatabase,
  deps: StorageConnectionDeps,
  organizationId: string,
  effect: ExternalEffectRow,
  binding: StorageConnectionBinding,
): Promise<OutcomeChange> {
  const args = effect.safeArguments as ExportArguments;
  let bytes: Uint8Array;
  try {
    bytes = await exportBytes(database, deps, organizationId, args);
  } catch (error) {
    return error instanceof StandardError
      ? { kind: "failed", failureCode: "provider_not_sent" }
      : { kind: "retry", delaySeconds: EXPORT_RETRY_SECONDS };
  }
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
    return written.kind === "written"
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
    return { kind: "retry", delaySeconds: EXPORT_RETRY_SECONDS };
  }
}

export type StorageProviderEntry = Readonly<{
  provider: string;
  bind(
    connection: StorageConnectionFacts,
  ): StorageConnectionBinding | undefined;
}>;

export function createStorageProviderRegistry(
  entries: readonly StorageProviderEntry[],
): StorageProviderResolver {
  const byProvider = new Map(entries.map((entry) => [entry.provider, entry]));
  if (byProvider.size !== entries.length) {
    throw new Error("STORAGE_PROVIDER_DUPLICATE");
  }
  return (connection) => byProvider.get(connection.provider)?.bind(connection);
}

export type DeployedStorageOptions = Readonly<{
  blobStore?: OrganizationBlobStore;
  storageLocalRoot?: string;
}>;

export function deployedStorageProviders(
  options: DeployedStorageOptions = {},
): readonly StorageProviderEntry[] {
  return options.storageLocalRoot === undefined
    ? []
    : [createLocalDiskStorageProvider(options.storageLocalRoot)];
}

export function defaultStorageConnections(
  options: DeployedStorageOptions = {},
): StorageConnectionDeps {
  return {
    resolver: createStorageProviderRegistry(deployedStorageProviders(options)),
    ...(options.blobStore === undefined
      ? {}
      : { blobStore: options.blobStore }),
  };
}

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

export async function statConnectionPathAction(
  context: ActionContext,
  reader: StorageReader,
  deps: StorageConnectionDeps,
  input: Readonly<{ path: string }>,
) {
  return itemOutput(await statConnectionPath(context, reader, deps, input));
}

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
  last_failure: string | null;
  created_at: Date;
  created_cursor: string;
  version: number;
  entry_id: string;
};

const SYNC_OUTPUT_SELECT = `select sync.id, sync.mount_id,
    entry.name as mount_name, sync.remote_path, sync.task_id,
    sync.change_position, sync.last_run_at, sync.paused_at, sync.last_failure,
    sync.created_at,
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
    lastFailure: row.last_failure,
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

export async function pauseConnectionSyncAction(
  context: ActionContext,
  reader: StorageReader,
) {
  return await setSyncPaused(context, reader, true);
}

export async function resumeConnectionSyncAction(
  context: ActionContext,
  reader: StorageReader,
) {
  return await setSyncPaused(context, reader, false);
}

async function setSyncPaused(
  context: ActionContext,
  reader: StorageReader,
  paused: boolean,
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
    paused
      ? `update bakery.storage_connection_syncs
          set paused_at = now(), updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and paused_at is null`
      : `update bakery.storage_connection_syncs
          set paused_at = null, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and paused_at is not null`,
    [organizationId, row.id],
  );
  const changed = await syncRowById(tx, organizationId, row.id);
  if (!changed) notFound();
  return syncOutput(changed);
}

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

export const MAX_EXPORTS_PER_SWEEP = 50;

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
    } catch {
      failed++;
    }
  }
  return { ran, failed };
}

const STORAGE_EXPORT_FUNCTION_ID =
  "bakery-knowledge-storage-connection-exports";

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
