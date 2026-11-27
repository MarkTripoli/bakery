/**
 * The files read API over the storage tree (#445, server half): the folders a
 * caller sees at the top, a folder's entries, a file's versions, the runs that
 * used it, and its bytes by range or as a download.
 *
 * Reads only: nothing here writes except making the caller's own tree exist
 * (ensureOrganizationTree and ensurePersonalFolder are idempotent), so the
 * top-level listing always has the caller's own folder. Visibility is the same
 * rule the working areas apply: another member's personal or scratch entry does
 * not exist for the caller, an id from another organization is 404, and /system
 * is for organization Admins only.
 */

import { mayViewAt } from "./folder-access-store.ts";
import { Buffer } from "node:buffer";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import { storedMediaSafety } from "./media.ts";
import { assertStoredBytes } from "./stored-bytes.ts";
import { type ProbeSubject, readBlobProbe } from "./blob-probes.ts";
import {
  ifNoneMatchMatches,
  ifRangeMatches,
  parseRange,
  readBlobBytes,
  readBlobRange,
  resolveRange,
} from "./reads.ts";
import { isVisibleTo } from "./storage-areas.ts";
import {
  agentDeclaredReadAreas,
  agentFileReadFor,
  agentReadGrantedFolders,
} from "./agent-file-guard.ts";
import {
  agentRootKeys,
  boundConnectionsOf,
  connectionMountKey,
} from "./agent-file-scope.ts";
import {
  hiddenEntryIds,
  hiddenFromReviewer,
  hiddenVersionIds,
  reviewerIsolationOf,
} from "./reviewer-isolation.ts";
import { type StoragePolicy, storageQueryOf } from "./storage-tree.ts";
import { ensureOrganizationTree } from "./storage-tree.ts";
import { ensurePersonalFolder } from "./storage-working-areas.ts";
import {
  chooseRead,
  inputPinFor,
  listingDigest,
  recordStepRead,
  stepReaderOf,
  stepReadSetRow,
} from "./step-read-set.ts";

const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_SQL = '\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'';

/** What the read handlers need to know about the caller beyond the context. */
export type StorageReader = Readonly<{
  /** True when the caller is an organization Admin, who alone sees /system. */
  isAdmin: boolean;
}>;

type PageInput = Readonly<{ cursor?: string; limit?: number }>;

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function pageSize(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["limit"],
          message: "out_of_range",
          code: "out_of_range",
        }],
      },
    });
  }
  return limit;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * The order a folder lists in: folders first, then files, each by name
 * compared the way names are unique (the name key), the id breaking no ties in
 * practice but keeping the order total.
 */
export function folderOrderRank(kind: "folder" | "file"): number {
  return kind === "folder" ? 0 : 1;
}

/**
 * The top-level folders a caller sees, in the order the page shows them:
 * /users itself never, the caller's own personal folder in its place,
 * /connections only when something is connected under it, /system for
 * organization Admins only.
 */
export function visibleRootKeys(input: {
  principalId: string;
  isAdmin: boolean;
  hasConnections: boolean;
}): string[] {
  const keys = ["projects", "shared", "user:" + input.principalId, "library"];
  if (input.hasConnections) keys.push("connections");
  keys.push("trash");
  if (input.isAdmin) keys.push("system");
  return keys;
}

/** A content-disposition header value that names the file and forces a download. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${
    encodeURIComponent(name)
  }`;
}

type EntryRow = {
  id: string;
  parent_id: string | null;
  name: string;
  name_key: string;
  kind: "folder" | "file";
  policy: StoragePolicy;
  artifact_id: string | null;
  system_key: string | null;
  owner_id: string | null;
  current_version_id: string | null;
  purged_at: Date | null;
  updated_at: Date;
  trash_parent_id: string | null;
};

const ENTRY_COLUMNS =
  "e.id, e.parent_id, e.name, e.name_key, e.kind, e.policy, e.artifact_id," +
  " e.system_key, e.owner_id, e.current_version_id, e.purged_at, e.updated_at, e.trash_parent_id";

const UP_FROM = "with recursive up as (" +
  " select id, parent_id, name, system_key, 0 as depth" +
  " from bakery.storage_entries where organization_id = $1 and id = $2" +
  " union all" +
  " select e.id, e.parent_id, e.name, e.system_key, up.depth + 1" +
  " from bakery.storage_entries e" +
  " join up on e.organization_id = $1 and e.id = up.parent_id" +
  " where up.depth < 64)";

/**
 * A live entry the caller may read, with its path; 404 for anything else. A
 * record-area file an Admin purged stays readable as a tombstone: its versions
 * say their contents were removed.
 */
export async function readableEntry(
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  reader: StorageReader,
  id: string | undefined,
): Promise<EntryRow & { path: string }> {
  if (!id || !UUID.test(id)) notFound();
  const found = await tx.query<EntryRow>(
    "select " + ENTRY_COLUMNS + " from bakery.storage_entries e" +
      " where e.organization_id = $1 and e.id = $2",
    [organizationId, id],
  );
  const row = found.rows[0];
  if (!row) notFound();
  if (
    !isVisibleTo(
      { policy: row.policy, ownerId: row.owner_id, systemKey: row.system_key },
      principalId,
    )
  ) notFound();
  if (row.purged_at !== null && row.artifact_id === null) notFound();
  if (
    !(await mayViewAt(tx, organizationId, principalId, row.id, reader.isAdmin))
  ) notFound();
  if (
    row.trash_parent_id !== null &&
    !(await mayViewAt(
      tx,
      organizationId,
      principalId,
      row.trash_parent_id,
      reader.isAdmin,
    ))
  ) notFound();
  const above = await tx.query<{ path: string; in_system: boolean }>(
    UP_FROM +
      " select '/' || string_agg(name, '/' order by depth desc) as path," +
      " coalesce(bool_or(system_key = 'system'), false) as in_system from up",
    [organizationId, row.id],
  );
  if (above.rows[0].in_system && !reader.isAdmin) notFound();
  // An agent's read is judged again against its step's files section and the
  // workflow's grants (section 17.6, O44); a person's passes untouched.
  await agentFileReadFor(tx, context, {
    organizationId,
    principalId,
    target: {
      id: row.id,
      policy: row.policy,
      owner_id: row.owner_id,
      system_key: row.system_key,
    },
  });
  // A reviewer's read never reaches a writer step's side-write (O47). It is
  // judged after the grant guard and apart from it: a grant opens folders,
  // never versions this filter hides.
  const isolation = await reviewerIsolationOf(tx, context, organizationId);
  if ((await hiddenEntryIds(tx, isolation, organizationId, [row.id])).size) {
    hiddenFromReviewer();
  }
  return { ...row, path: above.rows[0].path };
}

type ListedRow = EntryRow & {
  display_name: string | null;
  kind_name: string | null;
  size_bytes: string | null;
  media_type: string | null;
  content_removed: boolean;
  pinned: boolean;
  version: string;
};

/**
 * The projection both listings share: the current version's size and media
 * type (a working version, or the artifact's current version), the artifact
 * kind, and the name Bakery gave a work item's folder.
 */
const LISTED_SELECT = "select " + ENTRY_COLUMNS + "," +
  " task.title as display_name, a.artifact_type as kind_name," +
  " coalesce(wv.size_bytes, av.size_bytes)::text as size_bytes," +
  " coalesce(wv.media_type, av.media_type) as media_type," +
  " (e.purged_at is not null or av.purged_at is not null) as content_removed," +
  " (a.pinned_at is not null) as pinned, e.version::text as version" +
  " from bakery.storage_entries e" +
  " left join bakery.storage_file_versions wv" +
  " on wv.organization_id = e.organization_id and wv.id = e.current_version_id" +
  " left join bakery.artifacts a" +
  " on a.organization_id = e.organization_id and a.id = e.artifact_id" +
  " left join bakery.artifact_versions av" +
  " on av.organization_id = a.organization_id and av.id = a.current_version_id" +
  " left join bakery.tasks task" +
  " on task.organization_id = e.organization_id" +
  " and e.system_key = 'task:' || task.id::text";

function listed(row: ListedRow, path: string) {
  return {
    id: row.id,
    parentId: row.parent_id,
    path,
    name: row.name,
    displayName: row.display_name,
    kind: row.kind,
    policy: row.policy,
    kindName: row.kind_name,
    mediaType: row.media_type,
    sizeBytes: row.kind === "folder" || row.size_bytes === null
      ? null
      : Number(row.size_bytes),
    artifactId: row.artifact_id,
    pinned: row.kind === "file" && row.pinned,
    contentRemoved: row.kind === "file" && row.content_removed,
    version: Number(row.version),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The file a version belongs to, from the version id alone: a working-area
 * version (bakery.storage_file_versions) or a work item document's artifact
 * version. The file must be readable by the caller under the same rule as the
 * other reads; anything else, another organization's id included, is 404.
 */
export async function readStorageFileByVersion(
  context: ActionContext,
  reader: StorageReader,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const versionId = context.params.id ?? "";
  const { file, revision, current } = await readableVersionFile(
    context,
    tx,
    reader,
    { organizationId, principalId, versionId },
  );
  const listedRow = await tx.query<ListedRow>(
    LISTED_SELECT + " where e.organization_id = $1 and e.id = $2",
    [organizationId, file.id],
  );
  return {
    file: listed(listedRow.rows[0], file.path),
    versionId,
    revision,
    isCurrent: current,
  };
}

export async function readableVersionFile(
  context: ActionContext,
  tx: PgTransactionClient,
  reader: StorageReader,
  input: Readonly<
    { organizationId: string; principalId: string; versionId: string }
  >,
) {
  const { organizationId, principalId, versionId } = input;
  if (!UUID.test(versionId)) notFound();
  const found = await tx.query<
    { entry_id: string; revision: number; current: boolean }
  >(
    "select wv.entry_id, wv.revision," +
      " (e.current_version_id = wv.id) as current" +
      " from bakery.storage_file_versions wv" +
      " join bakery.storage_entries e" +
      " on e.organization_id = wv.organization_id and e.id = wv.entry_id" +
      " where wv.organization_id = $1 and wv.id = $2" +
      " union all" +
      " select e.id as entry_id, av.revision," +
      " (a.current_version_id = av.id) as current" +
      " from bakery.artifact_versions av" +
      " join bakery.artifacts a" +
      " on a.organization_id = av.organization_id and a.id = av.artifact_id" +
      " join bakery.storage_entries e" +
      " on e.organization_id = a.organization_id and e.artifact_id = a.id" +
      " where av.organization_id = $1 and av.id = $2" +
      " limit 1",
    [organizationId, versionId],
  );
  const hit = found.rows[0];
  if (!hit) notFound();
  const file = await readableEntry(
    context,
    tx,
    organizationId,
    principalId,
    reader,
    hit.entry_id,
  );
  if (file.kind !== "file") notFound();
  const isolation = await reviewerIsolationOf(tx, context, organizationId);
  if (
    (await hiddenVersionIds(tx, isolation, organizationId, [versionId])).size
  ) {
    hiddenFromReviewer();
  }
  return {
    file,
    revision: Number(hit.revision),
    current: hit.current === true,
  };
}

export async function listStorageRoots(
  context: ActionContext,
  reader: StorageReader,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  await ensureOrganizationTree(storageQueryOf(tx), organizationId);
  await ensurePersonalFolder(tx, organizationId, principalId);
  const connections = await tx.query<{ present: boolean }>(
    "select exists (select 1 from bakery.storage_entries child" +
      " join bakery.storage_entries top" +
      " on top.organization_id = child.organization_id" +
      " and top.id = child.parent_id" +
      " where child.organization_id = $1 and top.system_key = 'connections'" +
      " and child.purged_at is null) as present",
    [organizationId],
  );
  const everyKey = visibleRootKeys({
    principalId,
    isAdmin: reader.isAdmin,
    hasConnections: connections.rows[0].present,
  });
  // An agent sees only the top-level areas its step's files section reaches,
  // never its principal's personal folder, /trash or /system.
  const declared = agentDeclaredReadAreas(context);
  const keys = declared === null ? everyKey : agentRootKeys(
    everyKey,
    declared,
    boundConnectionsOf(context.sessionScopes),
  );
  const found = await tx.query<ListedRow>(
    LISTED_SELECT +
      " where e.organization_id = $1 and e.system_key = any($2::text[])",
    [organizationId, keys],
  );
  const byKey = new Map(found.rows.map((row) => [row.system_key, row]));
  const items = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    const visible = await mayViewAt(
      tx,
      organizationId,
      principalId,
      row.id,
      reader.isAdmin,
    );
    if (!visible) continue;
    const path = key === "user:" + principalId
      ? "/users/" + row.name
      : "/" + row.name;
    items.push(listed(row, path));
  }
  return { items, nextCursor: null };
}

/** The entries of a folder the caller may see: folders first, by name. */
export function createFolderLister(secret: string) {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: PageInput,
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageSize(input.limit);
    const folder = await readableEntry(
      context,
      tx,
      organizationId,
      principalId,
      reader,
      context.params.id,
    );
    if (folder.kind !== "folder") notFound();
    const binding: CursorBinding = {
      action: "storageFolderEntries.list",
      principalId,
      organizationId,
      ordering: "kind:asc,nameKey:asc,id:asc",
      filters: JSON.stringify({ folderId: folder.id }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    // The cursor names the last row seen; its rank and name key are read back
    // so the next page starts strictly after it. A row that has left the
    // folder since makes the cursor stale.
    let after: { rank: number; nameKey: string; id: string } | null = null;
    if (position) {
      const anchor = await tx.query<
        { kind: "folder" | "file"; name_key: string }
      >(
        "select kind, name_key from bakery.storage_entries" +
          " where organization_id = $1 and id = $2 and parent_id = $3",
        [organizationId, position.id, folder.id],
      );
      if (!anchor.rows[0]) throw new StandardError({ code: "INVALID_CURSOR" });
      after = {
        rank: folderOrderRank(anchor.rows[0].kind),
        nameKey: anchor.rows[0].name_key,
        id: position.id,
      };
    }
    const found = await tx.query<ListedRow>(
      LISTED_SELECT +
        " where e.organization_id = $1 and e.parent_id = $2" +
        " and (e.purged_at is null or e.artifact_id is not null)" +
        " and (e.policy not in ('personal', 'scratch')" +
        " or e.owner_id is null or e.owner_id = $3)" +
        " and (not e.restricted or $8::boolean or exists (" +
        " select 1 from bakery.storage_folder_grants g" +
        " where g.organization_id = e.organization_id" +
        " and g.folder_id = e.id and g.principal_id = $3" +
        " and g.revoked_at is null))" +
        " and ($4::int is null or" +
        " (case when e.kind = 'folder' then 0 else 1 end, e.name_key, e.id)" +
        " > ($4::int, $5::text, $6::uuid))" +
        " order by case when e.kind = 'folder' then 0 else 1 end," +
        " e.name_key, e.id limit $7",
      [
        organizationId,
        folder.id,
        principalId,
        after?.rank ?? null,
        after?.nameKey ?? null,
        after?.id ?? null,
        limit + 1,
        reader.isAdmin,
      ],
    );
    const page = found.rows.slice(0, limit);
    // A reviewer's listing leaves out the files it may not read (O47). The
    // cursor still follows the unfiltered page, so the next page is the same.
    const hidden = await hiddenEntryIds(
      tx,
      await reviewerIsolationOf(tx, context, organizationId),
      organizationId,
      page.map((row) => row.id),
    );
    const connectionsListing = context.agentSession !== undefined &&
      folder.system_key === "connections";
    const granted = connectionsListing
      ? await agentReadGrantedFolders(tx, context, {
        organizationId,
        folderId: folder.id,
        childIds: page.map((row) => row.id),
      })
      : null;
    const bound = granted === null || granted.folder ? null : new Set(
      boundConnectionsOf(context.sessionScopes).map(connectionMountKey),
    );
    const rows = page.filter((row) =>
      !hidden.has(row.id) &&
      (bound === null ||
        (row.system_key !== null && bound.has(row.system_key)) ||
        granted?.children.has(row.id) === true)
    );
    // An agent's listing joins its step's read set (O46). A listing shows the
    // folder as it is now, so it is never pinned.
    const stepReader = await stepReaderOf(tx, context, organizationId);
    const readRow = stepReadSetRow(stepReader, {
      organizationId,
      entryId: folder.id,
      served: { kind: "listing" },
      sha256: await listingDigest(rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        versionId: row.current_version_id,
      }))),
      pinned: false,
    });
    if (readRow !== null) await recordStepRead(tx, readRow);
    const prefix = folder.path === "/" ? "" : folder.path;
    const last = page.at(-1);
    return {
      items: rows.map((row) => listed(row, prefix + "/" + row.name)),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: folderOrderRank(last.kind),
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}

type VersionRow = {
  id: string;
  revision: number;
  created_at: Date;
  size_bytes: string;
  media_type: string;
  sha256: string;
  removed_at: Date | null;
  content_removed: boolean;
  author_id: string;
  author_name: string | null;
  run_step_id: string | null;
  step_key: string | null;
  run_id: string | null;
  task_id: string | null;
  task_title: string | null;
  /** The agent session the version recorded at its write (#448 S8a). */
  session_id: string | null;
  /** The job attempt the version recorded at its write. */
  attempt_id: string | null;
  /** The agent the recorded session ran. */
  agent_name: string | null;
  /** The person the producing run acts for, as recorded at the write. */
  acting_for_id: string | null;
  acting_for_name: string | null;
  /** True when an agent's session call wrote the version (a put or copy). */
  agent_write: boolean;
};

/**
 * Who made a version. Every field comes from what the version recorded when it
 * was written (#448 S8a), never from the step's sessions now: a step's later
 * session does not become the maker of a version an earlier one wrote. A
 * version an agent wrote from its session with a person's access names the
 * agent, its session, attempt, step and run and that person: it never reads as
 * the person's own. A version a run step published names the step, its run,
 * its work item and the session and attempt that published it. Any other
 * version names the person (or service) that wrote it.
 */
export function versionMaker(row: VersionRow) {
  const produced = {
    makerPrincipalId: row.author_id,
    makerName: row.author_name,
    stepId: row.run_step_id,
    stepName: row.step_key,
    runId: row.run_id,
    workItemId: row.task_id,
    workItemTitle: row.task_title,
    sessionId: row.session_id,
    attemptId: row.attempt_id,
    agentName: row.agent_name,
    actingForPrincipalId: row.acting_for_id,
    actingForName: row.acting_for_name,
  };
  if (row.agent_write) return { makerKind: "agent" as const, ...produced };
  if (row.run_step_id !== null) {
    return { makerKind: "step" as const, ...produced };
  }
  return {
    makerKind: "person" as const,
    makerPrincipalId: row.author_id,
    makerName: row.author_name,
    stepId: null,
    stepName: null,
    runId: null,
    workItemId: null,
    workItemTitle: null,
    sessionId: null,
    attemptId: null,
    agentName: null,
    actingForPrincipalId: null,
    actingForName: null,
  };
}

/** A file's versions, newest first, with who made each and whether it is gone. */
export function createFileVersionLister(secret: string) {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: PageInput,
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageSize(input.limit);
    const file = await readableEntry(
      context,
      tx,
      organizationId,
      principalId,
      reader,
      context.params.id,
    );
    if (file.kind !== "file") notFound();
    const binding: CursorBinding = {
      action: "storageFileVersions.list",
      principalId,
      organizationId,
      ordering: "revision:desc,id:desc",
      filters: JSON.stringify({ entryId: file.id }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const before = position?.position ?? null;
    let current: string | null = file.current_version_id;
    let found: { rows: VersionRow[] };
    if (file.artifact_id !== null) {
      const artifact = await tx.query<{ current_version_id: string | null }>(
        "select current_version_id from bakery.artifacts" +
          " where organization_id = $1 and id = $2",
        [organizationId, file.artifact_id],
      );
      current = artifact.rows[0]?.current_version_id ?? null;
      found = await tx.query<VersionRow>(
        "select v.id, v.revision, v.created_at, v.size_bytes::text," +
          " v.media_type, v.sha256, v.purged_at as removed_at," +
          " (v.purged_at is not null) as content_removed, v.author_id," +
          " who.display_name as author_name, v.run_step_id, rs.step_key," +
          " coalesce(v.run_id, rs.run_id) as run_id, wr.task_id," +
          " task.title as task_title," +
          // The session and attempt the version recorded when it was published,
          // not the step's sessions now.
          " v.agent_session_id as session_id, v.attempt_id," +
          " def.name as agent_name," +
          " v.acting_for_principal_id as acting_for_id," +
          " actor.display_name as acting_for_name," +
          " false as agent_write" +
          " from bakery.artifact_versions v" +
          " left join bakery.principals who on who.id = v.author_id" +
          " left join bakery.principals actor" +
          " on actor.id = v.acting_for_principal_id" +
          " left join bakery.run_steps rs" +
          " on rs.organization_id = v.organization_id and rs.id = v.run_step_id" +
          " left join bakery.workflow_runs wr" +
          " on wr.organization_id = rs.organization_id and wr.id = rs.run_id" +
          " left join bakery.tasks task" +
          " on task.organization_id = wr.organization_id and task.id = wr.task_id" +
          " left join bakery.agent_sessions s" +
          " on s.organization_id = v.organization_id" +
          " and s.id = v.agent_session_id" +
          " left join bakery.agent_versions av" +
          " on av.organization_id = s.organization_id" +
          " and av.id = s.agent_version_id" +
          " left join bakery.agent_definitions def" +
          " on def.organization_id = av.organization_id" +
          " and def.id = av.agent_id" +
          " where v.organization_id = $1 and v.artifact_id = $2" +
          // Staged and refused versions (O29) are not part of a file's history.
          " and v.publication_status = 'current'" +
          " and ($3::int is null or v.revision < $3)" +
          " order by v.revision desc limit $4",
        [organizationId, file.artifact_id, before, limit + 1],
      );
    } else {
      found = await tx.query<VersionRow>(
        "select v.id, v.revision, v.created_at, v.size_bytes::text," +
          " v.media_type, v.sha256, null::timestamptz as removed_at," +
          " false as content_removed, v.author_id," +
          " who.display_name as author_name, v.run_step_id, rs.step_key," +
          " v.run_id, wr.task_id, task.title as task_title," +
          // What the version recorded at its write (#448 S8a). A version an
          // agent wrote before that recorded only its step write set row,
          // which names the session and attempt from the same write.
          " coalesce(v.agent_session_id, agent.agent_session_id) as session_id," +
          " coalesce(v.attempt_id, agent.attempt_id) as attempt_id," +
          " def.name as agent_name," +
          " v.acting_for_principal_id as acting_for_id," +
          " actor.display_name as acting_for_name," +
          " (v.attempt_id is not null or agent.id is not null) as agent_write" +
          " from bakery.storage_file_versions v" +
          " left join bakery.principals who on who.id = v.author_id" +
          " left join bakery.principals actor" +
          " on actor.id = v.acting_for_principal_id" +
          " left join bakery.run_steps rs" +
          " on rs.organization_id = v.organization_id and rs.id = v.run_step_id" +
          " left join bakery.workflow_runs wr" +
          " on wr.organization_id = v.organization_id and wr.id = v.run_id" +
          " left join bakery.tasks task" +
          " on task.organization_id = wr.organization_id and task.id = wr.task_id" +
          // A version written before 0300: the agent write that made it.
          " left join lateral (select w.id, w.agent_session_id, w.attempt_id" +
          " from bakery.step_write_set w" +
          " where v.attempt_id is null" +
          " and w.organization_id = v.organization_id" +
          " and w.new_version_id = v.id and w.op in ('put', 'copy')" +
          " order by w.created_at, w.id limit 1) agent on true" +
          " left join bakery.agent_sessions s" +
          " on s.organization_id = v.organization_id" +
          " and s.id = coalesce(v.agent_session_id, agent.agent_session_id)" +
          " left join bakery.agent_versions av" +
          " on av.organization_id = s.organization_id" +
          " and av.id = s.agent_version_id" +
          " left join bakery.agent_definitions def" +
          " on def.organization_id = av.organization_id" +
          " and def.id = av.agent_id" +
          " where v.organization_id = $1 and v.entry_id = $2" +
          " and ($3::int is null or v.revision < $3)" +
          " order by v.revision desc limit $4",
        [organizationId, file.id, before, limit + 1],
      );
    }
    const page = found.rows.slice(0, limit);
    // A reviewer's list leaves out the versions it may not read (O47).
    const hidden = await hiddenVersionIds(
      tx,
      await reviewerIsolationOf(tx, context, organizationId),
      organizationId,
      page.map((row) => row.id),
    );
    const rows = page.filter((row) => !hidden.has(row.id));
    const last = page.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        revision: Number(row.revision),
        isCurrent: row.id === current,
        createdAt: iso(row.created_at),
        sizeBytes: Number(row.size_bytes),
        mediaType: row.media_type,
        sha256: row.sha256,
        contentRemoved: row.content_removed || file.purged_at !== null,
        removedAt: row.removed_at !== null
          ? iso(row.removed_at)
          : file.purged_at !== null
          ? iso(file.purged_at)
          : null,
        ...versionMaker(row),
      })),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: Number(last.revision),
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * The runs that used a file, newest first. A use is a run's admission pin of
 * one of the file's versions (bakery.run_input_pins), so only a record-area
 * file, which is an artifact, can have uses; a working-area file is never
 * pinned and lists none. A use whose run or work item the caller cannot read
 * in this organization is left out, not counted.
 */
export function createFileUseLister(secret: string) {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: PageInput,
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageSize(input.limit);
    const file = await readableEntry(
      context,
      tx,
      organizationId,
      principalId,
      reader,
      context.params.id,
    );
    if (file.kind !== "file") notFound();
    const binding: CursorBinding = {
      action: "storageFileUses.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: JSON.stringify({ entryId: file.id }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    if (file.artifact_id === null) return { items: [], nextCursor: null };
    const found = await tx.query<{
      id: string;
      used_at: Date;
      cursor_used_at: string;
      run_id: string;
      task_id: string;
      task_title: string;
      version_id: string;
      revision: number;
      input_name: string | null;
    }>(
      "select p.id, p.created_at as used_at," +
        " to_char(p.created_at at time zone 'UTC', " + TIMESTAMP_SQL + ")" +
        " as cursor_used_at, p.run_id, wr.task_id, task.title as task_title," +
        " p.artifact_version_id as version_id, v.revision," +
        " (select ip.input_name from bakery.run_input_paths ip" +
        " where ip.organization_id = p.organization_id and ip.run_id = p.run_id" +
        " and ip.artifact_version_id = p.artifact_version_id" +
        " order by ip.input_name limit 1) as input_name" +
        " from bakery.run_input_pins p" +
        " join bakery.artifact_versions v" +
        " on v.organization_id = p.organization_id" +
        " and v.id = p.artifact_version_id" +
        " join bakery.workflow_runs wr" +
        " on wr.organization_id = p.organization_id and wr.id = p.run_id" +
        " join bakery.tasks task" +
        " on task.organization_id = wr.organization_id and task.id = wr.task_id" +
        " where p.organization_id = $1 and p.artifact_id = $2" +
        " and ($3::timestamptz is null or (p.created_at, p.id) < ($3, $4::uuid))" +
        " order by p.created_at desc, p.id desc limit $5",
      [
        organizationId,
        file.artifact_id,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const rows = found.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        workItemId: row.task_id,
        workItemTitle: row.task_title,
        runId: row.run_id,
        inputName: row.input_name,
        versionId: row.version_id,
        revision: Number(row.revision),
        usedAt: iso(row.used_at),
      })),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_used_at,
          id: last.id,
        })
        : null,
    };
  };
}

type BytesRow = {
  id: string;
  revision: number;
  blob_id: string | null;
  content: Uint8Array | null;
  sha256: string;
  size_bytes: string;
  media_type: string;
  removed: boolean;
};

/**
 * Parses the optional revision query value. Anything but a positive integer
 * without leading zeros is 400 MALFORMED_REQUEST, the same answer the query
 * schema gives, so every bad revision has one status.
 */
export function parseRevision(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new StandardError({
      code: "MALFORMED_REQUEST",
      params: {
        issues: [{ path: ["revision"], message: "invalid", code: "invalid" }],
      },
    });
  }
  return Number(value);
}

/**
 * What the probe measured about a storage file's version (the current one unless
 * a revision is named).
 *
 * The same read the artifact-version probe makes, reached the way the content
 * read reaches these bytes: through `readableEntry`, so a file in another
 * organization and a file in somebody else's personal folder are both simply not
 * found, exactly as they are for the bytes themselves. The answer is keyed on the
 * blob, so every version sharing those bytes shares the answer, and a file whose
 * content is stored inline (no blob) has never been probed.
 */
export function createFileProbeReader() {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: Readonly<{ revision: number | null }>,
  ): Promise<StorageFileProbeAnswer> => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    // `readableEntry` takes the context for the agent guard main added (#770): a
    // person's read is unaffected, an agent's is judged by its step's files
    // section. This reader was written before that parameter existed and the
    // merge left it out, so every probe answered "not found".
    const file = await readableEntry(
      context,
      tx,
      organizationId,
      principalId,
      reader,
      context.params.id,
    );
    if (file.kind !== "file") notFound();
    if (file.purged_at !== null) notFound();
    // The subject is whichever of the three the version resolves to: a blob when
    // the bytes live in one, an artifact version, or an inline entry and revision.
    // Reading only the blob left every inline file and every store-less artifact
    // version with no answer at all, however the runner had recorded it.
    const found = file.artifact_id !== null
      ? await tx.query<{
        id: string;
        blob_id: string | null;
        entry_id: null;
        revision: null;
      }>(
        "select v.id, v.blob_id, null::text as entry_id," +
          " null::int as revision from bakery.artifact_versions v" +
          " join bakery.artifacts a" +
          " on a.organization_id = v.organization_id and a.id = v.artifact_id" +
          " where v.organization_id = $1 and v.artifact_id = $2" +
          " and (($3::int is null and v.id = a.current_version_id)" +
          // A revision names a published version; a staged or refused one is not.
          " or (v.revision = $3 and v.publication_status = 'current'))",
        [organizationId, file.artifact_id, input.revision],
      )
      : await tx.query<{
        id: string;
        blob_id: string | null;
        entry_id: string;
        revision: number;
      }>(
        "select id, blob_id, entry_id, revision from bakery.storage_file_versions" +
          " where organization_id = $1 and entry_id = $2" +
          " and (($3::int is null and id = $4) or revision = $3)",
        [organizationId, file.id, input.revision, file.current_version_id],
      );
    const row = found.rows[0];
    if (!row) notFound();
    const subject: ProbeSubject = row.blob_id !== null
      ? { blobId: row.blob_id }
      : row.entry_id === null
      ? { artifactVersionId: row.id }
      : { entryId: row.entry_id, revision: Number(row.revision) };
    const stored = await readBlobProbe(tx, { organizationId, ...subject });
    if (stored === null) return neverProbed();
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
  };
}

/** The flat answer the transport can express: one field per fact, null if unmeasured. */
export type StorageFileProbeAnswer = Readonly<{
  status: "described" | "refused" | null;
  kind: string | null;
  mediaType: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  lineCount: number | null;
  utf8: boolean | null;
  code: string | null;
  limit: number | null;
  probedAt: string | null;
}>;

function neverProbed(): StorageFileProbeAnswer {
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

/**
 * The bytes of a file's version (the current one unless a revision is named):
 * whole, or one byte range for a media player, always as a download that names
 * the file. Removed contents are 410 ARTIFACT_CONTENT_EXPIRED.
 */
export function createFileContentReader(blobStore?: OrganizationBlobStore) {
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: Readonly<{ revision: number | null }>,
  ): Promise<Response> => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const file = await readableEntry(
      context,
      tx,
      organizationId,
      principalId,
      reader,
      context.params.id,
    );
    if (file.kind !== "file") notFound();
    if (file.purged_at !== null) {
      throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
    }
    // O46: an agent's read of a declared input serves the version the run
    // pinned at admission; a named revision is the latest on request.
    const stepReader = await stepReaderOf(tx, context, organizationId);
    const choice = chooseRead({
      reader: stepReader,
      pin: stepReader !== null && file.artifact_id !== null
        ? await inputPinFor(
          tx,
          organizationId,
          stepReader.runId,
          file.artifact_id,
        )
        : null,
      revision: input.revision,
    });
    const pinnedId = choice.kind === "pinned" ? choice.artifactVersionId : null;
    const found = file.artifact_id !== null
      ? await tx.query<BytesRow>(
        "select v.id, v.revision, v.blob_id, v.content, v.sha256," +
          " v.size_bytes::text, v.media_type, (v.purged_at is not null) as removed" +
          " from bakery.artifact_versions v" +
          " join bakery.artifacts a" +
          " on a.organization_id = v.organization_id and a.id = v.artifact_id" +
          " where v.organization_id = $1 and v.artifact_id = $2" +
          " and (case when $4::uuid is not null then v.id = $4::uuid" +
          " when $3::int is null then v.id = a.current_version_id" +
          // A revision names a published version; a staged or refused one is not.
          " else v.revision = $3 and v.publication_status = 'current' end)",
        [organizationId, file.artifact_id, input.revision, pinnedId],
      )
      : await tx.query<BytesRow>(
        "select id, revision, blob_id, content, sha256, size_bytes::text," +
          " media_type, false as removed from bakery.storage_file_versions" +
          " where organization_id = $1 and entry_id = $2" +
          " and (($3::int is null and id = $4) or revision = $3)",
        [organizationId, file.id, input.revision, file.current_version_id],
      );
    const row = found.rows[0];
    if (!row) notFound();
    // A named revision is judged on its own: an earlier side-write stays
    // hidden from a reviewer even when the current version is not (O47).
    const isolation = await reviewerIsolationOf(tx, context, organizationId);
    if (
      (await hiddenVersionIds(tx, isolation, organizationId, [row.id])).size
    ) {
      hiddenFromReviewer();
    }
    if (row.removed || (row.blob_id === null && row.content === null)) {
      throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
    }
    // The read joins the step's read set in this transaction, before any
    // answer (a 304 or a range is still a read of this version).
    const readRow = stepReadSetRow(stepReader, {
      organizationId,
      entryId: file.id,
      served: file.artifact_id !== null
        ? { kind: "artifact", versionId: row.id }
        : { kind: "storage", versionId: row.id },
      sha256: row.sha256,
      pinned: choice.kind === "pinned",
    });
    if (readRow !== null) await recordStepRead(tx, readRow);
    const size = Number(row.size_bytes);
    const safety = storedMediaSafety(row.media_type);
    const headers = new Headers({
      "Content-Type": safety === null
        ? "application/octet-stream"
        : row.media_type,
      "Content-Length": String(size),
      "Content-Disposition": attachmentDisposition(file.name),
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "no-store",
      "ETag": `"${row.sha256}"`,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    });
    if (
      ifNoneMatchMatches(
        context.request.headers.get("if-none-match"),
        row.sha256,
      )
    ) {
      return new Response(null, { status: 304, headers });
    }
    const range = ifRangeMatches(
        context.request.headers.get("if-range"),
        row.sha256,
      )
      ? parseRange(context.request.headers.get("range"))
      : null;
    const stored = { size_bytes: size, sha256: row.sha256 };
    if (range) {
      const resolved = resolveRange(range, size);
      if (!resolved) {
        headers.set("Content-Length", "0");
        headers.set("Content-Range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      let ranged: Uint8Array;
      if (row.blob_id === null) {
        await assertStoredBytes(stored, row.content!, {
          mismatch: "content-mismatch",
        });
        ranged = row.content!.subarray(resolved.start, resolved.end + 1);
      } else {
        ranged = await readBlobRange(
          blobStore,
          organizationId,
          stored,
          resolved,
        );
      }
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
    let bytes: Uint8Array;
    if (row.blob_id === null) {
      await assertStoredBytes(stored, row.content!, {
        mismatch: "content-mismatch",
      });
      bytes = row.content!;
    } else {
      bytes = await readBlobBytes(blobStore, organizationId, stored);
    }
    return new Response(bytes as unknown as BodyInit, { status: 200, headers });
  };
}

/**
 * The most bytes one session read returns. An agent's call answers JSON, so
 * the bytes travel as base64; a larger file is read in ranges, and asking for
 * all of it is refused by name rather than cut short.
 */
export const SESSION_CONTENT_MAX_BYTES = 8 * 1024 * 1024;

function contentBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * A file's bytes for an agent's session call (storageFiles.content offered
 * under files.read): the same reader, guard and range rules a person's
 * download uses, answered as base64. The range comes from the call's own
 * arguments, never from whatever headers the worker's request carried.
 */
export function createSessionFileContentReader(
  blobStore?: OrganizationBlobStore,
) {
  const read = createFileContentReader(blobStore);
  return async (
    context: ActionContext,
    reader: StorageReader,
    input: Readonly<{ range?: string; revision?: number }>,
  ): Promise<string> => {
    const headers = new Headers();
    if (input.range !== undefined) headers.set("range", input.range);
    const response = await read(
      { ...context, request: new Request(context.request.url, { headers }) },
      reader,
      { revision: input.revision ?? null },
    );
    const tooLarge = () =>
      new StandardError({
        code: "UNPROCESSABLE",
        params: {
          issues: [{
            path: ["range"],
            code: "session_content_too_large",
            message: "session_content_too_large",
          }],
        },
      });
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > SESSION_CONTENT_MAX_BYTES) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > SESSION_CONTENT_MAX_BYTES) throw tooLarge();
    return contentBase64(bytes);
  };
}
