import type { StoragePolicy } from "./storage-tree.ts";

export const FOLDER_GRANT_LEVELS = ["view", "edit", "manage"] as const;
export type FolderGrantLevel = (typeof FOLDER_GRANT_LEVELS)[number];

const RANK: Record<FolderGrantLevel, number> = { view: 1, edit: 2, manage: 3 };

export type FolderNode = Readonly<{
  id: string;
  policy: StoragePolicy;
  systemKey: string | null;
  restricted: boolean;
}>;

export type FolderGrant = Readonly<{
  folderId: string;
  principalId: string;
  level: FolderGrantLevel;
}>;

export type GrantRefusal =
  | "not_a_working_area"
  | "artifact_area"
  | "connections_area";

const ARTIFACT_KEY = /^(task:|project:[^:]+:artifacts$)/;

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

export function mayView(
  access: ReturnType<typeof folderAccess>,
): boolean {
  return !access.restricted || access.level !== null;
}

export function mayEdit(access: ReturnType<typeof folderAccess>): boolean {
  return !access.restricted ||
    (access.level !== null && RANK[access.level] >= RANK.edit);
}

export function mayManage(
  access: ReturnType<typeof folderAccess>,
  mayWriteArea: boolean,
): boolean {
  if (!access.restricted) return mayWriteArea;
  return access.level !== null && RANK[access.level] >= RANK.manage;
}
