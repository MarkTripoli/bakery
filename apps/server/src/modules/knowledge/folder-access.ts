/**
 * Folder grants and restricted folders (chapter 25 section 17.3, O36, O41,
 * #449). Pure: no database, no clock. The store loads a folder's ancestors and
 * the grants on them and asks these rules, so each rule is tested once here
 * and enforced in one place.
 *
 * A grant names a person and a level (view, edit, manage) on a folder, and it
 * inherits downward. A restricted folder stops inheritance: what is granted
 * above it does not reach below it, so the folder and everything under it is
 * open only to people granted inside it. An unrestricted folder keeps today's
 * behavior and is not touched by any of this.
 *
 * Grants apply to working areas only. Record areas stay task-scoped with no
 * per-folder overrides (O36), personal folders are owner only (O41), and the
 * library, trash, system and connections areas have their own rules.
 */

import type { StoragePolicy } from "./storage-tree.ts";

export const FOLDER_GRANT_LEVELS = ["view", "edit", "manage"] as const;
export type FolderGrantLevel = (typeof FOLDER_GRANT_LEVELS)[number];

const RANK: Record<FolderGrantLevel, number> = { view: 1, edit: 2, manage: 3 };

/** A folder as the rules see it, with the chain given root first. */
export type FolderNode = Readonly<{
  id: string;
  policy: StoragePolicy;
  systemKey: string | null;
  restricted: boolean;
}>;

/** One live grant on one folder. */
export type FolderGrant = Readonly<{
  folderId: string;
  principalId: string;
  level: FolderGrantLevel;
}>;

/** Why grants and restriction are refused on a folder. */
export type GrantRefusal =
  | "not_a_working_area"
  | "artifact_area"
  | "connections_area";

const ARTIFACT_KEY = /^(task:|project:[^:]+:artifacts$)/;

/**
 * Whether grants and restriction may be set on the last folder of the chain.
 * Only working areas qualify, and not the artifacts area of a project or
 * anything under a work item's folder, which stay task-scoped (O36).
 */
export function grantRefusal(
  chain: readonly FolderNode[],
): GrantRefusal | undefined {
  const folder = chain.at(-1);
  if (!folder || folder.policy !== "working") return "not_a_working_area";
  if (chain.some((node) => node.systemKey === "connections")) {
    return "connections_area";
  }
  if (
    chain.some((node) => node.systemKey && ARTIFACT_KEY.test(node.systemKey))
  ) {
    return "artifact_area";
  }
  return undefined;
}

/**
 * What a principal holds on the last folder of the chain.
 *
 * `restricted` says whether any folder in the chain is restricted. When none
 * is, the folder is open and `level` is null: access is whatever the area
 * gives everyone. When one is, only grants on the nearest restricted folder
 * and below it count, and `level` is the highest of them, or null when the
 * principal holds none. An Admin holds manage on a restricted folder, because
 * somebody has to be able to repair one nobody can open.
 */
export function folderAccess(
  chain: readonly FolderNode[],
  grants: readonly FolderGrant[],
  principalId: string,
  isAdmin: boolean,
): Readonly<{ restricted: boolean; level: FolderGrantLevel | null }> {
  let cut = -1;
  for (const [index, node] of chain.entries()) {
    if (node.restricted) cut = index;
  }
  if (cut < 0) return { restricted: false, level: null };
  if (isAdmin) return { restricted: true, level: "manage" };
  const inside = new Set(chain.slice(cut).map((node) => node.id));
  let best: FolderGrantLevel | null = null;
  for (const grant of grants) {
    if (grant.principalId !== principalId || !inside.has(grant.folderId)) {
      continue;
    }
    if (best === null || RANK[grant.level] > RANK[best]) best = grant.level;
  }
  return { restricted: true, level: best };
}

/** Whether the principal may see the folder. A restricted one is hidden to the rest. */
export function mayView(
  access: ReturnType<typeof folderAccess>,
): boolean {
  return !access.restricted || access.level !== null;
}

/** Whether the principal may write into the folder beyond the area's own rule. */
export function mayEdit(access: ReturnType<typeof folderAccess>): boolean {
  return !access.restricted ||
    (access.level !== null && RANK[access.level] >= RANK.edit);
}

/**
 * Whether the principal may set grants and restriction on the folder. On an
 * open folder that takes Admin or a manage grant on an ancestor chain that
 * has none, so the first restriction is set by an Admin or by whoever the
 * area's own rule lets write; the caller passes that fact as `mayWriteArea`.
 */
export function mayManage(
  access: ReturnType<typeof folderAccess>,
  mayWriteArea: boolean,
): boolean {
  if (!access.restricted) return mayWriteArea;
  return access.level !== null && RANK[access.level] >= RANK.manage;
}
