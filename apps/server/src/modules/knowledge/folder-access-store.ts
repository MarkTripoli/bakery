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

export function deniedEntriesCte(
  organization: string,
  principal: string,
  name = "denied",
): string {
  const granted = (entry: string) =>
    `exists (select 1 from bakery.storage_folder_grants g
              where g.organization_id = ${entry}.organization_id
                and g.folder_id = ${entry}.id
                and g.principal_id = ${principal}::uuid
                and g.revoked_at is null)`;
  return `${name}(id, granted) as (
    select seed.id, ${granted("seed")}
      from bakery.storage_entries seed
     where seed.organization_id = ${organization}::uuid
       and seed.restricted
    union all
    select child.id,
           case when child.restricted then ${granted("child")}
                else up.granted or ${granted("child")} end
      from bakery.storage_entries child
      join ${name} up on child.parent_id = up.id
     where child.organization_id = ${organization}::uuid
  )`;
}
