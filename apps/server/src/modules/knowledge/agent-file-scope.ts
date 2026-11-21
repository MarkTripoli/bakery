/**
 * The pure rules behind an agent's file writes (chapter 25 section 17.6, O39,
 * O44, O45, O50 to O52, issue #448). No database and no clock: the guard in
 * agent-file-guard.ts gathers the rows and asks these, so each layer is one
 * function a test can call on its own, with the other layers left out.
 *
 * Five layers stand between an agent and a write, and each refuses alone:
 *
 * 1. the contract: the operation's described input schema bounds the path
 *    (length) before any handler runs;
 * 2. the grant axes: scope (read or write) x area (the folder granted and
 *    everything under it) x expiry x revocation, checked on every write with
 *    the time of that write ({@link grantRefusal}, {@link agentAreaRefusal});
 * 3. path resolution: each lexical trick is a named refusal, never a silent
 *    normalization ({@link agentPathRefusal}), and the folders a path resolves
 *    through must carry exactly the names the path spelled
 *    ({@link pathSpellingRefusal});
 * 4. principal authority: the person the agent acts for must be able to write
 *    the target themselves; a grant adds scope, never authority
 *    ({@link principalAuthorityRefusal});
 * 5. storage scoping: every row the decision rests on belongs to the caller's
 *    organization, or the target does not exist ({@link storageScopeRefusal}).
 */

import {
  WORKFLOW_FILE_TREE_READ_AREAS,
  WORKFLOW_FILE_TREE_WRITE_AREAS,
  type WorkflowFileReadArea,
  type WorkflowFileWriteArea,
} from "@bakery/contracts/workflow-compiler";
import { type AreaEntry, isVisibleTo, writeRefusal } from "./storage-areas.ts";
import type { StoragePolicy } from "./storage-tree.ts";

/** What a file grant lets an agent do in the folder it names. */
export const AgentFileAccess = Object.freeze(
  { Read: "read", Write: "write" } as const,
);
export type AgentFileAccess =
  typeof AgentFileAccess[keyof typeof AgentFileAccess];

export const AGENT_FILE_ACCESSES: readonly AgentFileAccess[] = Object.freeze(
  Object.values(AgentFileAccess),
);

export function isAgentFileAccess(value: unknown): value is AgentFileAccess {
  return typeof value === "string" &&
    (AGENT_FILE_ACCESSES as readonly string[]).includes(value);
}

/** The session scope that offers the storage write operations as tools. */
export const FILES_WRITE_SCOPE = "files.write";

/** The session scope that offers the storage read operations as tools. */
export const FILES_READ_SCOPE = "files.read";

/** The longest a file grant may live; a grant is a loan, not a standing right. */
export const MAX_FILE_GRANT_DAYS = 30;

/** Layer 3: why a path an agent sent is refused, before it is resolved. */
export const AgentPathRefusal = Object.freeze(
  {
    NotAbsolute: "path_not_absolute",
    ControlCharacter: "path_control_character",
    Backslash: "path_backslash",
    Encoded: "path_encoded",
    LookalikeSeparator: "path_lookalike_separator",
    NotNormalized: "path_not_normalized",
    TrailingSlash: "path_trailing_slash",
    EmptySegment: "path_empty_segment",
    Traversal: "path_traversal",
    SymlinkLike: "path_symlink_like",
    /** The path resolved through a folder whose stored name it spelled differently. */
    SpellingMismatch: "path_spelling_mismatch",
  } as const,
);
export type AgentPathRefusal =
  typeof AgentPathRefusal[keyof typeof AgentPathRefusal];

/** Layers 2 and 4: why an agent's write is refused once the path resolved. */
export const AgentFileRefusal = Object.freeze(
  {
    GrantMissing: "agent_file_grant_missing",
    GrantReadOnly: "agent_file_grant_read_only",
    GrantExpired: "agent_file_grant_expired",
    GrantRevoked: "agent_file_grant_revoked",
    LibraryArea: "agent_file_library_area",
    PersonalArea: "agent_file_personal_area",
    TrashArea: "agent_file_trash_area",
    SystemArea: "agent_file_system_area",
    RecordArea: "agent_file_record_area",
    PrincipalCannotRead: "agent_file_principal_cannot_read",
    PrincipalCannotWrite: "agent_file_principal_cannot_write",
    /** Granting is a person's act (O51, O52): an agent never widens its own scope. */
    GrantRequiresPerson: "agent_file_grant_requires_person",
    /**
     * The area is outside the step's files section and no person granted the
     * workflow a folder there: an inputs-only step, a step that narrowed its reads,
     * or another project's tree.
     */
    AreaNotDeclared: "agent_file_area_not_declared",
    /**
     * /connections holds outside storage read through only for connections
     * the definition binds; no binding is recorded for a step yet, so a read
     * there needs a person's grant.
     */
    ConnectionNotBound: "agent_file_connection_not_bound",
    /**
     * A reviewer's session writes only its declared outputs, through its
     * step's result (O47): no storage write, whatever its files section or a
     * grant to the folder says.
     */
    ReviewerOutputsOnly: "agent_file_reviewer_outputs_only",
  } as const,
);
export type AgentFileRefusal =
  typeof AgentFileRefusal[keyof typeof AgentFileRefusal];

export const AGENT_FILE_REFUSALS: readonly AgentFileRefusal[] = Object.freeze(
  Object.values(AgentFileRefusal),
);

// Slashes that render like "/" but are not one. A path carrying one would look
// like it names a folder it does not.
const LOOKALIKE_SEPARATORS = ["\u2215", "\u2044", "\uff0f", "\u29f8", "\u2571"];

/**
 * Layer 3, lexical: the named refusal for a path, or undefined when it is
 * plain. The tree's own parser trims and normalizes names for a person's
 * convenience; an agent gets no such help, because a path that only resolves
 * after normalization is a path that may resolve somewhere it did not say.
 */
export function agentPathRefusal(raw: string): AgentPathRefusal | undefined {
  if (!raw.startsWith("/")) return AgentPathRefusal.NotAbsolute;
  for (const character of raw) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return AgentPathRefusal.ControlCharacter;
    }
  }
  if (raw.includes("\\")) return AgentPathRefusal.Backslash;
  // Any percent escape, so a double encoding (%252e) is caught as surely as a
  // single one (%2e): the tree never decodes, so an escape is never meant.
  if (/%[0-9a-f]{2}/i.test(raw)) return AgentPathRefusal.Encoded;
  if (LOOKALIKE_SEPARATORS.some((separator) => raw.includes(separator))) {
    return AgentPathRefusal.LookalikeSeparator;
  }
  // NFKC, not only NFC: a fullwidth or compatibility form of a folder name
  // (\uff55sers) is a different string that a reader takes for the same one.
  if (raw !== raw.normalize("NFKC")) return AgentPathRefusal.NotNormalized;
  if (raw.length > 1 && raw.endsWith("/")) {
    return AgentPathRefusal.TrailingSlash;
  }
  const segments = raw.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "") return AgentPathRefusal.EmptySegment;
    if (segment === "." || segment === "..") return AgentPathRefusal.Traversal;
    if (segment !== segment.trim()) return AgentPathRefusal.NotNormalized;
    if (
      segment.startsWith("~") || segment.includes("->") ||
      segment.toLowerCase().endsWith(".lnk")
    ) return AgentPathRefusal.SymlinkLike;
  }
  return undefined;
}

/**
 * Layer 3, resolved: the folders a path went through, root first, must carry
 * exactly the names the path spelled. Names compare case-insensitively for
 * people, so "/Shared" finds "/shared"; for an agent that is a refusal, never a
 * quiet match into a folder it did not name.
 */
export function pathSpellingRefusal(
  spelled: readonly string[],
  stored: readonly string[],
): AgentPathRefusal | undefined {
  if (spelled.length !== stored.length) {
    return AgentPathRefusal.SpellingMismatch;
  }
  for (let index = 0; index < spelled.length; index++) {
    if (spelled[index] !== stored[index]) {
      return AgentPathRefusal.SpellingMismatch;
    }
  }
  return undefined;
}

/** A file grant as the rules see it. */
export type AgentFileGrant = Readonly<{
  id: string;
  organizationId: string;
  /** The workflow whose agent sessions the grant covers. */
  workflowId: string;
  /** The folder granted; the grant covers it and everything under it. */
  folderId: string;
  access: AgentFileAccess;
  grantedById: string;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export type GrantDecision =
  | Readonly<{ grant: AgentFileGrant; refusal?: undefined }>
  | Readonly<{ grant?: undefined; refusal: AgentFileRefusal }>;

function satisfies(granted: AgentFileAccess, wanted: AgentFileAccess) {
  return granted === AgentFileAccess.Write || wanted === AgentFileAccess.Read;
}

/**
 * Layer 2: the live grant that covers a write, or why none does. A grant
 * covers when it is for this organization and workflow and names the target
 * folder or one of its ancestors. It is judged at `now`, the time of this
 * write and not of the session's admission, so a grant that expires or is
 * revoked mid-step stops the very next write.
 *
 * When nothing live covers, the refusal names the most telling reason: a
 * revocation (someone withdrew it) before an expiry, and both before "you hold
 * only read here", so a person can tell "withdrawn" from "never allowed".
 */
export function grantRefusal(
  grants: readonly AgentFileGrant[],
  scope: Readonly<{
    organizationId: string;
    workflowId: string;
    access: AgentFileAccess;
    /** The target folder's id and its ancestors' ids. */
    folderChain: readonly string[];
    now: Date;
  }>,
): GrantDecision {
  const covering = grants.filter((grant) =>
    grant.organizationId === scope.organizationId &&
    grant.workflowId === scope.workflowId &&
    scope.folderChain.includes(grant.folderId)
  );
  const live = (grant: AgentFileGrant) =>
    grant.revokedAt === null &&
    grant.expiresAt.getTime() > scope.now.getTime();
  const enough = covering.filter((grant) =>
    satisfies(grant.access, scope.access)
  );
  const usable = enough.find(live);
  if (usable) return { grant: usable };
  if (enough.some((grant) => grant.revokedAt !== null)) {
    return { refusal: AgentFileRefusal.GrantRevoked };
  }
  if (enough.length > 0) return { refusal: AgentFileRefusal.GrantExpired };
  if (covering.some(live)) return { refusal: AgentFileRefusal.GrantReadOnly };
  return { refusal: AgentFileRefusal.GrantMissing };
}

/**
 * Layer 2, the area axis: whether a grant may reach this folder at all. The
 * library is written by its own operations, never by path; /trash and /system
 * are unreachable; a record area takes only declared outputs; and a personal
 * folder, the starter's own included, stays closed unless its owner made the
 * grant (section 17.6).
 */
export function agentAreaRefusal(
  folder: AreaEntry,
  grantedById: string,
): AgentFileRefusal | undefined {
  if (folder.systemKey === "trash") return AgentFileRefusal.TrashArea;
  if (folder.systemKey === "connections") return AgentFileRefusal.SystemArea;
  switch (folder.policy) {
    case "library":
      return AgentFileRefusal.LibraryArea;
    case "system":
      return AgentFileRefusal.SystemArea;
    case "record":
      return AgentFileRefusal.RecordArea;
    case "personal":
    case "scratch":
      return folder.ownerId !== null && folder.ownerId === grantedById
        ? undefined
        : AgentFileRefusal.PersonalArea;
    case "working":
      return undefined;
  }
}

/**
 * Layer 4: the person the agent acts for must be able to see and write the
 * folder themselves. A grant made by someone else widens where the agent may
 * go, never what the person may do (section 17.6: never beyond the principal).
 */
export function principalAuthorityRefusal(
  folder: AreaEntry,
  principalId: string,
): AgentFileRefusal | undefined {
  if (!isVisibleTo(folder, principalId)) {
    return AgentFileRefusal.PrincipalCannotRead;
  }
  if (writeRefusal(folder, principalId) !== undefined) {
    return AgentFileRefusal.PrincipalCannotWrite;
  }
  return undefined;
}

/**
 * Layer 5: every row the decision rests on must be the caller's
 * organization's. A row from elsewhere means the target does not exist for
 * this caller; the answer is not found, never a refusal that confirms it.
 */
export function storageScopeRefusal(
  organizationId: string,
  rows: readonly Readonly<{ organizationId: string }>[],
): "not_found" | undefined {
  return rows.length > 0 &&
      rows.every((row) => row.organizationId === organizationId)
    ? undefined
    : "not_found";
}

/**
 * Who a storage write is attributed to, with the same keys for a person and an
 * agent (O50, R1 shape identity): only the values differ, so one reader serves
 * both and an agent's action cannot hide in a second shape nothing reads.
 */
export type StorageAuditActor = Readonly<{
  kind: "person" | "agent";
  principalId: string;
  accessTokenId: string | null;
  attemptId: string | null;
  agentSessionId: string | null;
  fileGrantId: string | null;
}>;

/**
 * What an allowed agent write carries into its audit row. The grant is null
 * when the write landed in one of the step's default write areas (O45), which
 * no grant was needed for.
 */
export type AgentWrite = Readonly<{
  attemptId: string;
  agentSessionId: string | null;
  fileGrantId: string | null;
}>;

/**
 * The storage operations a step write set records (section 17.6): every write
 * an agent's session can make to Bakery Files.
 */
export const StepWriteOp = Object.freeze(
  {
    Put: "put",
    Mkdir: "mkdir",
    Copy: "copy",
    Move: "move",
    Trash: "trash",
  } as const,
);
export type StepWriteOp = typeof StepWriteOp[keyof typeof StepWriteOp];

/** One row of bakery.step_write_set, as the write builds it. */
export type StepWriteSetRow = Readonly<{
  organizationId: string;
  attemptId: string;
  agentSessionId: string | null;
  entryId: string;
  op: StepWriteOp;
  previousVersionId: string | null;
  newVersionId: string | null;
  /** For a move: the folder and name the entry had before it; else null. */
  previousParentId: string | null;
  previousName: string | null;
  /** The entry's row version before the write; null when it made the entry. */
  entryVersionBefore: number | null;
}>;

/**
 * The write-set row an allowed agent write records, or null for a person's own
 * write, which no step's set holds. The previous and new versions are the
 * entry's current version before and after the write.
 */
export function stepWriteSetRow(
  agent: AgentWrite | null,
  write: Readonly<{
    organizationId: string;
    entryId: string;
    op: StepWriteOp;
    previousVersionId: string | null;
    newVersionId: string | null;
    previousParentId?: string | null;
    previousName?: string | null;
    entryVersionBefore?: number | null;
  }>,
): StepWriteSetRow | null {
  if (agent === null) return null;
  return {
    organizationId: write.organizationId,
    attemptId: agent.attemptId,
    agentSessionId: agent.agentSessionId,
    entryId: write.entryId,
    op: write.op,
    previousVersionId: write.previousVersionId,
    newVersionId: write.newVersionId,
    previousParentId: write.previousParentId ?? null,
    previousName: write.previousName ?? null,
    entryVersionBefore: write.entryVersionBefore ?? null,
  };
}

export function storageAuditActor(
  attribution: Readonly<{
    principalId: string;
    actorKind: "person" | "agent";
    accessTokenId: string | null;
  }>,
  agent: AgentWrite | null,
): StorageAuditActor {
  return {
    kind: attribution.actorKind,
    principalId: attribution.principalId,
    accessTokenId: attribution.accessTokenId,
    attemptId: agent?.attemptId ?? null,
    agentSessionId: agent?.agentSessionId ?? null,
    fileGrantId: agent?.fileGrantId ?? null,
  };
}

/**
 * Where in the tree an entry sits, as the files section names places
 * (section 17.6). "Own" means the work item and project of the run the
 * session belongs to; another project's tree is `OtherProject`.
 */
export const AgentTreeArea = Object.freeze(
  {
    Trash: "trash",
    System: "system",
    Personal: "personal",
    Library: "library",
    Connections: "connections",
    Shared: "shared",
    ProjectsRoot: "projects_root",
    Project: "project",
    WorkItem: "work_item",
    Attachments: "attachments",
    RunFolder: "run_folder",
    Assets: "assets",
    Workspaces: "workspaces",
    OtherProject: "other_project",
    Unknown: "unknown",
  } as const,
);
export type AgentTreeArea = typeof AgentTreeArea[keyof typeof AgentTreeArea];

/** One folder of a chain, root first, as the area rules read it. */
export type ChainEntry = Readonly<{
  systemKey: string | null;
  policy: StoragePolicy;
  ownerId: string | null;
}>;

/** The run a session belongs to, which decides what "own" means. */
export type AgentOwnPlaces = Readonly<{
  taskId: string | null;
  applicationId: string | null;
}>;

/**
 * The area an entry is in, from the folders above it (root first, the entry
 * itself last). Trash and /system win over everything, then a personal
 * folder anywhere in the chain, then the top-level area. Inside /projects the
 * most specific own place wins: attachments or the run folder before the
 * work item, assets and workspaces before the project.
 */
export function agentTreeAreaOf(
  chain: readonly ChainEntry[],
  own: AgentOwnPlaces,
): AgentTreeArea {
  const keys = chain.map((entry) => entry.systemKey);
  if (keys.includes("trash")) return AgentTreeArea.Trash;
  if (keys.includes("system")) return AgentTreeArea.System;
  if (
    chain.some((entry) =>
      entry.policy === "personal" || entry.policy === "scratch"
    )
  ) return AgentTreeArea.Personal;
  switch (keys[0]) {
    case "library":
      return AgentTreeArea.Library;
    case "connections":
      return AgentTreeArea.Connections;
    case "shared":
      return AgentTreeArea.Shared;
    case "projects":
      break;
    default:
      return AgentTreeArea.Unknown;
  }
  if (chain.length === 1) return AgentTreeArea.ProjectsRoot;
  if (own.taskId !== null) {
    const task = "task:" + own.taskId;
    if (keys.includes(task + ":attachments")) return AgentTreeArea.Attachments;
    if (keys.includes(task + ":runs")) return AgentTreeArea.RunFolder;
    if (keys.includes(task)) return AgentTreeArea.WorkItem;
  }
  if (own.applicationId !== null) {
    const project = "project:" + own.applicationId;
    if (keys.includes(project + ":assets")) return AgentTreeArea.Assets;
    if (keys.includes(project + ":workspaces")) {
      return AgentTreeArea.Workspaces;
    }
    if (keys.includes(project)) return AgentTreeArea.Project;
  }
  return AgentTreeArea.OtherProject;
}

/** The owner of the personal folder an entry is under, or null. */
export function personalOwnerOf(chain: readonly ChainEntry[]): string | null {
  for (const entry of chain) {
    if (
      (entry.policy === "personal" || entry.policy === "scratch") &&
      entry.ownerId !== null
    ) return entry.ownerId;
  }
  return null;
}

const OWN_PROJECT: readonly AgentTreeArea[] = Object.freeze([
  AgentTreeArea.ProjectsRoot,
  AgentTreeArea.Project,
  AgentTreeArea.WorkItem,
  AgentTreeArea.Attachments,
  AgentTreeArea.RunFolder,
  AgentTreeArea.Assets,
  AgentTreeArea.Workspaces,
]);

/** The tree areas each declared read area reaches (O44). */
export const READ_AREA_REACH: Readonly<
  Record<WorkflowFileReadArea, readonly AgentTreeArea[]>
> = Object.freeze({
  inputs: Object.freeze([]),
  outputs: Object.freeze([]),
  workspace: Object.freeze([]),
  work_item: Object.freeze([
    AgentTreeArea.WorkItem,
    AgentTreeArea.Attachments,
    AgentTreeArea.RunFolder,
  ]),
  project: OWN_PROJECT,
  shared: Object.freeze([AgentTreeArea.Shared]),
  library: Object.freeze([AgentTreeArea.Library]),
  connections: Object.freeze([AgentTreeArea.Connections]),
});

/** The tree areas each declared write area reaches (O45). */
export const WRITE_AREA_REACH: Readonly<
  Record<WorkflowFileWriteArea, readonly AgentTreeArea[]>
> = Object.freeze({
  outputs: Object.freeze([]),
  workspace: Object.freeze([]),
  run_folder: Object.freeze([AgentTreeArea.RunFolder]),
  attachments: Object.freeze([AgentTreeArea.Attachments]),
  assets: Object.freeze([AgentTreeArea.Assets]),
  workspaces: Object.freeze([AgentTreeArea.Workspaces]),
});

/** The session scope naming one declared tree area, as the claim mints it. */
export function fileAreaScope(
  access: AgentFileAccess,
  area: WorkflowFileReadArea | WorkflowFileWriteArea,
): string {
  return "files." + access + ":" + area;
}

/**
 * The session scopes a step's resolved files section mints at claim: the
 * read tools when it reads any tree area, the write tools when it writes
 * one, and one area scope per declared tree area so the guard judges every
 * call against the section the session was claimed under. An inputs-only step
 * (read: [inputs]) gets no read tool at all.
 */
export function stepFileScopes(
  files: Readonly<{
    read: readonly WorkflowFileReadArea[];
    write: readonly WorkflowFileWriteArea[];
  }>,
): readonly string[] {
  const scopes = new Set<string>();
  for (const area of files.read) {
    if (!WORKFLOW_FILE_TREE_READ_AREAS.includes(area)) continue;
    scopes.add(FILES_READ_SCOPE);
    scopes.add(fileAreaScope(AgentFileAccess.Read, area));
  }
  for (const area of files.write) {
    if (!WORKFLOW_FILE_TREE_WRITE_AREAS.includes(area)) continue;
    scopes.add(FILES_WRITE_SCOPE);
    scopes.add(fileAreaScope(AgentFileAccess.Write, area));
  }
  return [...scopes].sort();
}

/** The tree areas a session's scopes declare for one access. */
export function declaredTreeAreas(
  scopes: readonly string[] | undefined,
  access: AgentFileAccess,
): readonly AgentTreeArea[] {
  const prefix = "files." + access + ":";
  const reach: Readonly<Record<string, readonly AgentTreeArea[]>> =
    access === AgentFileAccess.Read ? READ_AREA_REACH : WRITE_AREA_REACH;
  const areas = new Set<AgentTreeArea>();
  for (const scope of scopes ?? []) {
    if (!scope.startsWith(prefix)) continue;
    for (const area of reach[scope.slice(prefix.length)] ?? []) {
      areas.add(area);
    }
  }
  return [...areas];
}

/**
 * Layer 2 for a read, the area axis: whether an agent may open this entry.
 * /trash and /system are unreachable; a personal folder, the starter's own
 * included, opens only with a live grant its owner made; /connections only
 * with a grant (no binding is recorded yet); anywhere else needs the step's
 * files section to reach the area, or a live grant covering the entry.
 */
export function agentReadAreaRefusal(
  input: Readonly<{
    area: AgentTreeArea;
    declared: readonly AgentTreeArea[];
    liveGrant: AgentFileGrant | undefined;
    personalOwnerId: string | null;
  }>,
): AgentFileRefusal | undefined {
  switch (input.area) {
    case AgentTreeArea.Trash:
      return AgentFileRefusal.TrashArea;
    case AgentTreeArea.System:
      return AgentFileRefusal.SystemArea;
    case AgentTreeArea.Personal:
      return input.liveGrant !== undefined &&
          input.personalOwnerId !== null &&
          input.liveGrant.grantedById === input.personalOwnerId
        ? undefined
        : AgentFileRefusal.PersonalArea;
    case AgentTreeArea.Connections:
      return input.liveGrant !== undefined
        ? undefined
        : AgentFileRefusal.ConnectionNotBound;
    default:
      return input.liveGrant !== undefined ||
          input.declared.includes(input.area)
        ? undefined
        : AgentFileRefusal.AreaNotDeclared;
  }
}

/**
 * The top-level folders an agent sees in the roots listing: never the
 * caller's personal folder, /trash or /system, and only the areas its files
 * section reaches. /connections stays out until a binding is recorded.
 */
export function agentRootKeys(
  keys: readonly string[],
  declared: readonly AgentTreeArea[],
): string[] {
  return keys.filter((key) => {
    switch (key) {
      case "projects":
        return declared.includes(AgentTreeArea.ProjectsRoot);
      case "shared":
        return declared.includes(AgentTreeArea.Shared);
      case "library":
        return declared.includes(AgentTreeArea.Library);
      default:
        return false;
    }
  });
}
