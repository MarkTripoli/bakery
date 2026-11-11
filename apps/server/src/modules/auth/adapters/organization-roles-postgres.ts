import {
  type CatalogPermissionKey,
  contractSchemas,
  OrganizationRole,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { decodeCursor } from "../../../platform/cursor.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { OrganizationActor } from "../application/authority.ts";
import { effectivePermissions } from "../application/authorize.ts";
import {
  isCatalogPermissionKey,
  rolePermissions,
} from "../application/permissions.ts";
import {
  binding,
  type Cursor,
  freshActor,
  iso,
  pageOf,
  TIMESTAMP_SQL,
} from "./access-postgres.ts";

/** Most custom roles one organization may define. */
export const MAX_CUSTOM_ROLES = 100;

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const SYSTEM_ROLE_KEYS: readonly string[] = Object.values(OrganizationRole);

export type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  memberCount: number;
  memberIds: string[];
  createdAt: Date;
  updatedAt: Date;
  version: number;
  cursorCreatedAt: string;
};

export const ROLE_COLUMNS = `role_record.id, role_record.key, role_record.name,
  role_record.description, role_record.permissions,
  (select count(*)::int from bakery.organization_memberships as holder
    where holder.organization_id = role_record.organization_id
      and holder.custom_role_id = role_record.id) as "memberCount",
  array(select holder.principal_id from bakery.organization_memberships as holder
    where holder.organization_id = role_record.organization_id
      and holder.custom_role_id = role_record.id
    order by holder.principal_id) as "memberIds",
  role_record.created_at as "createdAt", role_record.updated_at as "updatedAt",
  role_record.version,
  to_char(role_record.created_at at time zone 'UTC', ${TIMESTAMP_SQL}) as "cursorCreatedAt"`;

export function roleOut(row: RoleRow) {
  return contractSchemas.OrganizationRole.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: row.permissions,
    memberCount: row.memberCount,
    memberIds: row.memberIds,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  });
}

/** Validates a role handle; system role names are reserved. */
export function requireRoleKey(key: string): string {
  if (!KEY_PATTERN.test(key) || SYSTEM_ROLE_KEYS.includes(key)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return key;
}

/** Deduplicated, sorted permission keys; unknown keys are refused. */
export function normalizeRolePermissions(
  permissions: readonly string[],
): CatalogPermissionKey[] {
  const unique = [...new Set(permissions)];
  if (unique.length === 0 || !unique.every(isCatalogPermissionKey)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return unique.sort() as CatalogPermissionKey[];
}

/** A caller may only touch permissions it holds itself. */
export function assertWithinCaller(
  actor: OrganizationActor,
  permissions: readonly string[],
): void {
  const held = new Set<string>(effectivePermissions(actor));
  if (!permissions.every((permission) => held.has(permission))) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

export async function listOrganizationRoles(
  client: PgTransactionClient,
  actor: OrganizationActor,
  query: Cursor,
  secret: string,
) {
  const b = binding("organizationRoles.list", actor);
  const position = await decodeCursor(secret, query.cursor, b);
  const limit = query.limit ?? 25;
  const result = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS}
    from bakery.organization_roles as role_record
    where role_record.organization_id = $1
      and ($2::timestamptz is null
        or (role_record.created_at, role_record.id) > ($2::timestamptz, $3::uuid))
    order by role_record.created_at, role_record.id
    limit $4`,
    [
      actor.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  return await pageOf(secret, b, result.rows, limit, roleOut);
}

/** Locks one role of this organization; a foreign or missing id is not found. */
export async function lockRole(
  client: PgTransactionClient,
  organizationId: string,
  roleId: string,
): Promise<RoleRow> {
  const result = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS}
    from bakery.organization_roles as role_record
    where role_record.organization_id = $1 and role_record.id = $2
    for update`,
    [organizationId, roleId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return result.rows[0];
}

export async function readRole(
  client: PgTransactionClient,
  organizationId: string,
  roleId: string,
): Promise<RoleRow> {
  const result = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS}
    from bakery.organization_roles as role_record
    where role_record.organization_id = $1 and role_record.id = $2`,
    [organizationId, roleId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return result.rows[0];
}

type MemberRow = {
  membershipId: string;
  role: string | null;
  customRoleId: string | null;
  customPermissions: string[] | null;
};

/** Locks one active member of the organization; anyone else is not found. */
export async function lockActiveMember(
  client: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<MemberRow> {
  const result = await client.query<MemberRow>(
    `select membership.id as "membershipId", membership.role,
      membership.custom_role_id as "customRoleId",
      custom.permissions as "customPermissions"
    from bakery.organization_memberships as membership
    left join bakery.organization_roles as custom
      on custom.organization_id = membership.organization_id
      and custom.id = membership.custom_role_id
    where membership.organization_id = $1
      and membership.principal_id = $2
      and membership.status = 'active'
    for update of membership`,
    [organizationId, principalId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return result.rows[0];
}

/** Permissions the member holds through its role, system or custom. */
export function memberRolePermissions(member: MemberRow): string[] {
  const system = member.role === null
    ? []
    : (rolePermissions as Record<string, readonly string[]>)[member.role] ?? [];
  return [...system, ...(member.customPermissions ?? [])];
}

export async function deleteOrganizationRole(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  roleId: string,
) {
  const actor = await freshActor(client, actorInput);
  const role = await lockRole(client, actor.organizationId, roleId);
  assertWithinCaller(actor, role.permissions);
  if (role.memberCount > 0) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  await client.query(
    `delete from bakery.organization_roles
    where organization_id = $1 and id = $2`,
    [actor.organizationId, roleId],
  );
  return role;
}

export async function unassignOrganizationRole(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  roleId: string,
  principalId: string,
) {
  const actor = await freshActor(client, actorInput);
  await readRole(client, actor.organizationId, roleId);
  const member = await lockActiveMember(
    client,
    actor.organizationId,
    principalId,
  );
  if (member.customRoleId !== roleId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  assertWithinCaller(actor, memberRolePermissions(member));
  await client.query(
    `update bakery.organization_memberships
    set custom_role_id = null, updated_at = current_timestamp,
      version = version + 1
    where id = $1`,
    [member.membershipId],
  );
  return await readRole(client, actor.organizationId, roleId);
}
