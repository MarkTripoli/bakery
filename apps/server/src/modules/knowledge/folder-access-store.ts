/**
 * Loads what folder-access.ts needs and asks it (#449). The rules are pure and
 * tested there; this file only reads a folder's ancestors and the grants on
 * them, so every place that decides who may see or write an entry asks one
 * function.
 */

import type { PgTransactionClient } from "../../platform/database.ts";
import {
  folderAccess,
  type FolderGrant,
  type FolderGrantLevel,
  type FolderNode,
  mayEdit,
  mayView,
} from "./folder-access.ts";

export type EntryAccess = ReturnType<typeof folderAccess>;

/** The folders from the root down to the entry, with their restriction flag. */
export async function ancestorChain(
  tx: PgTransactionClient,
  organizationId: string,
  entryId: string,
): Promise<FolderNode[]> {
  const found = await tx.query<{
    id: string;
    policy: FolderNode["policy"];
    system_key: string | null;
    restricted: boolean;
    depth: number;
  }>(
    `with recursive up as (
       select id, parent_id, policy, system_key, restricted, 0 as depth
         from bakery.storage_entries
        where organization_id = $1 and id = $2
       union all
       select e.id, e.parent_id, e.policy, e.system_key, e.restricted,
              up.depth + 1
         from bakery.storage_entries e
         join up on e.organization_id = $1 and e.id = up.parent_id
        where up.depth < 64)
     select id, policy, system_key, restricted, depth from up
      order by depth desc`,
    [organizationId, entryId],
  );
  return found.rows.map((row) => ({
    id: row.id,
    policy: row.policy,
    systemKey: row.system_key,
    restricted: row.restricted,
  }));
}

/** Whether the principal is an active Admin of the organization. */
export async function isOrganizationAdmin(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  const found = await tx.query(
    `select 1 from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2
        and status = 'active' and role = 'admin'`,
    [organizationId, principalId],
  );
  return found.rows.length > 0;
}

/** The live grants a principal holds on any of the folders. */
export async function liveGrants(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  folderIds: readonly string[],
): Promise<FolderGrant[]> {
  if (folderIds.length === 0) return [];
  const found = await tx.query<{
    folder_id: string;
    principal_id: string;
    level: FolderGrantLevel;
  }>(
    `select folder_id, principal_id, level
       from bakery.storage_folder_grants
      where organization_id = $1 and principal_id = $2
        and folder_id = any($3::uuid[]) and revoked_at is null`,
    [organizationId, principalId, [...folderIds]],
  );
  return found.rows.map((row) => ({
    folderId: row.folder_id,
    principalId: row.principal_id,
    level: row.level,
  }));
}

/**
 * What the principal holds at an entry. An entry nobody restricted is open and
 * costs one ancestor read; grants and the Admin check are read only when some
 * folder on the way down is restricted.
 */
export async function accessAt(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  entryId: string,
  isAdmin?: boolean,
): Promise<EntryAccess> {
  const chain = await ancestorChain(tx, organizationId, entryId);
  if (!chain.some((node) => node.restricted)) {
    return { restricted: false, level: null };
  }
  const grants = await liveGrants(
    tx,
    organizationId,
    principalId,
    chain.map((node) => node.id),
  );
  const admin = isAdmin ??
    await isOrganizationAdmin(tx, organizationId, principalId);
  return folderAccess(chain, grants, principalId, admin);
}

export async function mayViewAt(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  entryId: string,
  isAdmin?: boolean,
): Promise<boolean> {
  return mayView(
    await accessAt(tx, organizationId, principalId, entryId, isAdmin),
  );
}

export async function mayEditAt(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  entryId: string,
  isAdmin?: boolean,
): Promise<boolean> {
  return mayEdit(
    await accessAt(tx, organizationId, principalId, entryId, isAdmin),
  );
}

/**
 * Of some child folders, the ids a principal may not see. A child that is not
 * restricted inherits its parent's access, which the caller already holds, so
 * only restricted children are looked at; each one's cut-off is its own, so
 * only grants on the child (and below, which a listing never asks about) count.
 */
export async function hiddenRestrictedChildren(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  children: readonly { id: string; restricted: boolean }[],
  isAdmin: boolean,
): Promise<Set<string>> {
  const restricted = children.filter((child) => child.restricted);
  if (restricted.length === 0 || isAdmin) return new Set();
  const grants = await liveGrants(
    tx,
    organizationId,
    principalId,
    restricted.map((child) => child.id),
  );
  const held = new Set(grants.map((grant) => grant.folderId));
  return new Set(
    restricted.filter((child) => !held.has(child.id)).map((child) => child.id),
  );
}
