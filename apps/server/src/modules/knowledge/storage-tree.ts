import type { PgTransactionClient } from "@bakery/persistence";

/**
 * The storage tree (chapter 25 section 17, slice F2, #444).
 *
 * One virtual, hierarchical tree per organization over artifacts. A path is a
 * name, not an identity (O34): an entry has a stable id and points at an
 * artifact, and runs pin versions (`ArtifactRef` has no path), so renaming or
 * moving an entry breaks nothing that was pinned.
 *
 * This slice builds the entries, the default layout and the projection of
 * existing artifacts under their work items. It writes entries only: no
 * artifact or version row is touched, so no data moves.
 */

/** What a query needs; both the server's transaction and the backfill fit it. */
export type StorageQuery = {
  query<Row>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
};

/** Lets the server's transaction be used as a `StorageQuery`. */
export function storageQueryOf(transaction: PgTransactionClient): StorageQuery {
  return {
    query: async <Row>(sql: string, params: unknown[] = []) => {
      const result = await transaction.query(sql, params);
      return { rows: result.rows as unknown as Row[] };
    },
  };
}

export const STORAGE_ENTRY_KINDS = Object.freeze(["folder", "file"] as const);
export type StorageEntryKind = typeof STORAGE_ENTRY_KINDS[number];

/**
 * The folder policy children inherit (section 17.1). `record` areas hold
 * artifacts and run outputs; `working` areas hold people's files; `scratch`
 * expires; `library` mirrors the catalog; `personal` is owner only; `system` is
 * Admin only.
 */
export const STORAGE_POLICIES = Object.freeze(
  ["record", "working", "scratch", "library", "personal", "system"] as const,
);
export type StoragePolicy = typeof STORAGE_POLICIES[number];

const MAX_NAME_LENGTH = 255;

/** Thrown for a name or path the tree refuses. Never echoes the input. */
export class StorageNameError extends Error {
  constructor(readonly reason: string) {
    super(`STORAGE_NAME_REFUSED:${reason}`);
    this.name = "StorageNameError";
  }
}

/**
 * Normalizes an entry name and returns it with its comparison key. Names are
 * unique per folder, compared case-insensitively after normalization; empty,
 * `.`, `..`, a path separator, NUL and control characters are refused.
 */
export function normalizeEntryName(
  raw: string,
): { name: string; nameKey: string } {
  const name = raw.normalize("NFC").trim();
  if (name === "") throw new StorageNameError("empty");
  if (name === "." || name === "..") throw new StorageNameError("dot");
  if (name.length > MAX_NAME_LENGTH) throw new StorageNameError("too_long");
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || character === "/") {
      throw new StorageNameError("forbidden_character");
    }
  }
  return { name, nameKey: name.toLowerCase() };
}

/** Splits an absolute path into normalized segments; `/` is no segments. */
export function parseStoragePath(
  path: string,
): { name: string; nameKey: string }[] {
  if (!path.startsWith("/")) throw new StorageNameError("not_absolute");
  const segments = path.split("/").slice(1);
  if (segments.length === 1 && segments[0] === "") return [];
  return segments.map(normalizeEntryName);
}

/** A readable, stable folder name for a work item: title slug plus short id. */
export function workItemFolderName(title: string, taskId: string): string {
  const slug = title.normalize("NFKD").replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60).replace(/-+$/g, "");
  return `${slug === "" ? "work-item" : slug}-${taskId.slice(0, 8)}`;
}

export type StorageEntry = Readonly<{
  id: string;
  parentId: string | null;
  name: string;
  kind: StorageEntryKind;
  policy: StoragePolicy;
  artifactId: string | null;
}>;

type EntryRow = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  policy: string;
  artifact_id: string | null;
};

const ENTRY_COLUMNS = "id, parent_id, name, kind, policy, artifact_id";

function toEntry(row: EntryRow): StorageEntry {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind as StorageEntryKind,
    policy: row.policy as StoragePolicy,
    artifactId: row.artifact_id,
  };
}

/**
 * Finds or makes a folder Bakery owns, keyed by `systemKey` so repeating the
 * call returns the same folder.
 *
 * The key, not the name, is the folder's identity: a project's key is its
 * application id, which never changes, and its name is only a display label (the
 * slug). A name another entry already holds in this parent (an application
 * renamed and its old slug reused, or two work items whose titles slug alike)
 * must not fail the write this rides on, so the name falls back to one made
 * unique by the key, and the last resort is the key itself.
 */
async function ensureFolder(
  db: StorageQuery,
  input: {
    organizationId: string;
    parentId: string | null;
    name: string;
    policy: StoragePolicy;
    systemKey: string;
  },
): Promise<string> {
  const keyed = async () => {
    const found = await db.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and system_key = $2`,
      [input.organizationId, input.systemKey],
    );
    return found.rows[0]?.id;
  };
  const existing = await keyed();
  if (existing) return existing;
  const suffix = input.systemKey.replace(/[^0-9a-zA-Z]+/g, "-").slice(-12);
  for (
    const candidate of [
      input.name,
      `${input.name} (${suffix})`,
      input.systemKey,
    ]
  ) {
    let normalized;
    try {
      normalized = normalizeEntryName(candidate);
    } catch (error) {
      if (error instanceof StorageNameError) continue;
      throw error;
    }
    await db.query(
      `insert into bakery.storage_entries
         (organization_id, parent_id, name, name_key, kind, policy, system_key)
       values ($1, $2, $3, $4, 'folder', $5, $6)
       on conflict do nothing`,
      [
        input.organizationId,
        input.parentId,
        normalized.name,
        normalized.nameKey,
        input.policy,
        input.systemKey,
      ],
    );
    const made = await keyed();
    if (made) return made;
  }
  throw new Error("STORAGE_FOLDER_NAME_UNAVAILABLE");
}

/** The default top-level areas Bakery makes, with the policy each carries. */
export const DEFAULT_TOP_LEVEL_FOLDERS: readonly {
  name: string;
  policy: StoragePolicy;
}[] = Object.freeze([
  { name: "projects", policy: "record" },
  { name: "shared", policy: "working" },
  { name: "library", policy: "library" },
  { name: "users", policy: "personal" },
  { name: "connections", policy: "working" },
  { name: "trash", policy: "system" },
  { name: "system", policy: "system" },
]);

/** Makes the organization's top-level folders. Idempotent. */
export async function ensureOrganizationTree(
  db: StorageQuery,
  organizationId: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const folder of DEFAULT_TOP_LEVEL_FOLDERS) {
    ids.set(
      folder.name,
      await ensureFolder(db, {
        organizationId,
        parentId: null,
        name: folder.name,
        policy: folder.policy,
        systemKey: folder.name,
      }),
    );
  }
  return ids;
}

/** `/projects/<project>` with its `artifacts`, `workspaces` and `assets`. */
export async function ensureProjectTree(
  db: StorageQuery,
  input: { organizationId: string; applicationId: string; slug: string },
): Promise<{ projectId: string; artifactsId: string }> {
  const top = await ensureOrganizationTree(db, input.organizationId);
  const projectId = await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: top.get("projects")!,
    name: input.slug,
    policy: "record",
    systemKey: `project:${input.applicationId}`,
  });
  const artifactsId = await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: projectId,
    name: "artifacts",
    policy: "record",
    systemKey: `project:${input.applicationId}:artifacts`,
  });
  for (const area of ["workspaces", "assets"] as const) {
    await ensureFolder(db, {
      organizationId: input.organizationId,
      parentId: projectId,
      name: area,
      policy: "working",
      systemKey: `project:${input.applicationId}:${area}`,
    });
  }
  return { projectId, artifactsId };
}

/**
 * The work item's folder under its project's `artifacts`, with `attachments`
 * and `runs`. Made by Bakery, named once (title slug plus short id) and kept:
 * a later title edit does not rename it.
 */
export async function ensureWorkItemFolder(
  db: StorageQuery,
  input: { organizationId: string; taskId: string },
): Promise<string> {
  const task = await db.query<
    { title: string; application_id: string; slug: string }
  >(
    `select task.title, task.application_id, application.slug
       from bakery.tasks task
       join bakery.applications application
         on application.organization_id = task.organization_id
        and application.id = task.application_id
      where task.organization_id = $1 and task.id = $2`,
    [input.organizationId, input.taskId],
  );
  const row = task.rows[0];
  if (!row) throw new Error("STORAGE_WORK_ITEM_NOT_FOUND");
  const project = await ensureProjectTree(db, {
    organizationId: input.organizationId,
    applicationId: row.application_id,
    slug: row.slug,
  });
  const folderId = await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: project.artifactsId,
    name: workItemFolderName(row.title, input.taskId),
    policy: "record",
    systemKey: `task:${input.taskId}`,
  });
  await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: folderId,
    name: "attachments",
    policy: "working",
    systemKey: `task:${input.taskId}:attachments`,
  });
  await ensureFolder(db, {
    organizationId: input.organizationId,
    parentId: folderId,
    name: "runs",
    policy: "record",
    systemKey: `task:${input.taskId}:runs`,
  });
  return folderId;
}

/**
 * A folder of this name under `parentId`, made if it is missing. Returns
 * undefined when the name is taken by a file, so the caller can fall back.
 */
async function ensureChildFolder(
  db: StorageQuery,
  input: { organizationId: string; parentId: string; segment: string },
): Promise<string | undefined> {
  const { name, nameKey } = normalizeEntryName(input.segment);
  await db.query(
    `insert into bakery.storage_entries
       (organization_id, parent_id, name, name_key, kind, policy)
     values ($1, $2, $3, $4, 'folder', 'record')
     on conflict do nothing`,
    [input.organizationId, input.parentId, name, nameKey],
  );
  const found = await db.query<{ id: string; kind: string }>(
    `select id, kind from bakery.storage_entries
      where organization_id = $1 and parent_id = $2 and name_key = $3`,
    [input.organizationId, input.parentId, nameKey],
  );
  const row = found.rows[0];
  return row && row.kind === "folder" ? row.id : undefined;
}

/** An artifact name made into one safe entry name when it cannot be a path. */
function flatName(name: string, artifactId: string): string {
  let flat = "";
  for (const character of name.normalize("NFC")) {
    const code = character.codePointAt(0)!;
    flat += code <= 0x1f || code === 0x7f || character === "/"
      ? "_"
      : character;
  }
  flat = flat.trim().slice(0, MAX_NAME_LENGTH);
  return flat === "" || flat === "." || flat === ".."
    ? `unnamed-${artifactId.slice(0, 8)}`
    : flat;
}

/** Tries to insert one file entry; returns its id, or undefined if the name is taken. */
async function insertFileEntry(
  db: StorageQuery,
  input: {
    organizationId: string;
    parentId: string;
    name: string;
    artifactId: string;
  },
): Promise<string | undefined> {
  let normalized;
  try {
    normalized = normalizeEntryName(input.name);
  } catch (error) {
    if (error instanceof StorageNameError) return undefined;
    throw error;
  }
  const inserted = await db.query<{ id: string }>(
    `insert into bakery.storage_entries
       (organization_id, parent_id, name, name_key, kind, policy, artifact_id)
     values ($1, $2, $3, $4, 'file', 'record', $5)
     on conflict do nothing
     returning id`,
    [
      input.organizationId,
      input.parentId,
      normalized.name,
      normalized.nameKey,
      input.artifactId,
    ],
  );
  return inserted.rows[0]?.id;
}

/**
 * Projects one existing artifact as a file entry under its work item's folder,
 * without moving data. Idempotent: an artifact that already has an entry keeps
 * it.
 *
 * It never fails the write it rides on. An artifact name is a document name and
 * may be a path (`output-transcript/<session>/manifest`): when every segment is
 * a valid name, the leading segments become folders and the last the file;
 * otherwise the name is made safe and kept flat. Two artifacts whose names
 * collide get `name (type)`, then `name (type id)`, and the last resort is the
 * artifact's own id, so none is dropped and none can fail.
 */
export async function projectArtifactEntry(
  db: StorageQuery,
  input: { organizationId: string; artifactId: string },
): Promise<string | undefined> {
  const existing = await db.query<{ id: string }>(
    `select id from bakery.storage_entries
      where organization_id = $1 and artifact_id = $2`,
    [input.organizationId, input.artifactId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const artifact = await db.query<
    { task_id: string; artifact_type: string; name: string }
  >(
    `select task_id, artifact_type, name from bakery.artifacts
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.artifactId],
  );
  const row = artifact.rows[0];
  if (!row) return undefined;
  const workItemId = await ensureWorkItemFolder(db, {
    organizationId: input.organizationId,
    taskId: row.task_id,
  });

  // A path-like name: folders for the leading segments, the file for the last.
  let parentId = workItemId;
  let leaf = flatName(row.name, input.artifactId);
  const segments = row.name.split("/");
  if (segments.length > 1) {
    try {
      let current: string | undefined = workItemId;
      for (const segment of segments.slice(0, -1)) {
        current = await ensureChildFolder(db, {
          organizationId: input.organizationId,
          parentId: current,
          segment,
        });
        if (current === undefined) break;
      }
      const last = segments[segments.length - 1];
      if (current !== undefined) {
        normalizeEntryName(last);
        parentId = current;
        leaf = last;
      }
    } catch (error) {
      if (!(error instanceof StorageNameError)) throw error;
      parentId = workItemId;
      leaf = flatName(row.name, input.artifactId);
    }
  }

  const candidates = [
    leaf,
    `${leaf} (${row.artifact_type})`,
    `${leaf} (${row.artifact_type} ${input.artifactId.slice(0, 8)})`,
    input.artifactId,
  ];
  for (const candidate of candidates) {
    const id = await insertFileEntry(db, {
      organizationId: input.organizationId,
      parentId,
      name: candidate,
      artifactId: input.artifactId,
    });
    if (id) return id;
    // Lost to a concurrent projection of this same artifact?
    const raced = await db.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and artifact_id = $2`,
      [input.organizationId, input.artifactId],
    );
    if (raced.rows[0]) return raced.rows[0].id;
  }
  throw new Error("STORAGE_ARTIFACT_NAME_UNAVAILABLE");
}

/**
 * Resolves an absolute path to its entry within one organization, or undefined.
 * Names compare case-insensitively after normalization; `.`, `..`, an empty
 * segment and a control character refuse the whole path.
 */
export async function resolveStoragePath(
  db: StorageQuery,
  input: { organizationId: string; path: string },
): Promise<StorageEntry | undefined> {
  const segments = parseStoragePath(input.path);
  let parentId: string | null = null;
  let entry: StorageEntry | undefined;
  for (const segment of segments) {
    const found: { rows: EntryRow[] } = await db.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from bakery.storage_entries
        where organization_id = $1 and parent_id is not distinct from $2
          and name_key = $3`,
      [input.organizationId, parentId, segment.nameKey],
    );
    const row: EntryRow | undefined = found.rows[0];
    if (!row) return undefined;
    entry = toEntry(row);
    parentId = entry.id;
  }
  return entry;
}

/** What a run pins when a path is used as an input: a version, never a path. */
export type StoragePin = Readonly<{
  entryId: string;
  /** The path as written, kept as a label; the pin is the ids and digest. */
  label: string;
  artifactId: string;
  versionId: string;
  sha256: string;
}>;

/**
 * Resolves a path to the file's current version for pinning at admission. The
 * result names the entry (so a rename never breaks it) and the exact version and
 * digest; the path survives only as a label. Undefined for a folder, a missing
 * path, or an artifact with no current version.
 */
export async function pinStoragePath(
  db: StorageQuery,
  input: { organizationId: string; path: string },
): Promise<StoragePin | undefined> {
  const entry = await resolveStoragePath(db, input);
  if (!entry || entry.kind !== "file" || entry.artifactId === null) {
    return undefined;
  }
  const version = await db.query<{ version_id: string; sha256: string }>(
    `select version.id as version_id, version.sha256
       from bakery.artifacts artifact
       join bakery.artifact_versions version
         on version.organization_id = artifact.organization_id
        and version.id = artifact.current_version_id
      where artifact.organization_id = $1 and artifact.id = $2`,
    [input.organizationId, entry.artifactId],
  );
  const row = version.rows[0];
  if (!row) return undefined;
  return {
    entryId: entry.id,
    label: input.path,
    artifactId: entry.artifactId,
    versionId: row.version_id,
    sha256: row.sha256,
  };
}
