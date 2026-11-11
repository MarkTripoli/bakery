import { StandardError } from "@bakery/contracts/http";
import { freshActor } from "../adapters/access-postgres.ts";
import { assertAnotherAdminRemains } from "../adapters/last-admin-postgres.ts";
import {
  assertWithinCaller,
  lockActiveMember,
  lockRole,
  MAX_CUSTOM_ROLES,
  memberRolePermissions,
  normalizeRolePermissions,
  readRole,
  requireRoleKey,
  roleOut,
  type RoleRow,
} from "../adapters/organization-roles-postgres.ts";
import {
  type contractSchemas,
  OrganizationRole,
} from "@bakery/contracts/contracts";
import type { z } from "zod";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { OrganizationActor } from "../application/authority.ts";

type OrganizationRoleOut = z.output<typeof contractSchemas.OrganizationRole>;

/** Custom role writes: create, update and assign. */
export type CustomRoles = Readonly<{
  createRole(
    transaction: PgTransactionClient,
    actor: OrganizationActor,
    input: z.output<typeof contractSchemas.OrganizationRoleCreate>,
  ): Promise<OrganizationRoleOut>;
  updateRole(
    transaction: PgTransactionClient,
    actor: OrganizationActor,
    roleId: string,
    input: z.output<typeof contractSchemas.OrganizationRoleUpdate>,
    expectedVersion: number,
  ): Promise<OrganizationRoleOut>;
  assignRole(
    transaction: PgTransactionClient,
    actor: OrganizationActor,
    roleId: string,
    input: z.output<typeof contractSchemas.OrganizationRoleAssign>,
  ): Promise<OrganizationRoleOut>;
}>;

/**
 * Create, edit and assign custom roles. Every call runs in the action's own
 * transaction after the tenant lookup, and the caller records the audit row in
 * that same transaction.
 */
export const customRoles: CustomRoles = {
  async createRole(transaction, actorInput, input) {
    const actor = await freshActor(transaction, actorInput);
    const key = requireRoleKey(input.key);
    const permissions = normalizeRolePermissions(input.permissions);
    assertWithinCaller(actor, permissions);
    const existing = await transaction.query<{ key: string }>(
      `select key from bakery.organization_roles where organization_id = $1`,
      [actor.organizationId],
    );
    if (
      existing.rows.length >= MAX_CUSTOM_ROLES ||
      existing.rows.some((row) => row.key === key)
    ) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.organization_roles (
        organization_id, key, name, description, permissions,
        created_by_principal_id
      ) values ($1, $2, $3, $4, $5, $6)
      returning id`,
      [
        actor.organizationId,
        key,
        input.name.trim(),
        input.description?.trim() ?? "",
        permissions,
        actor.subject.principalId,
      ],
    );
    return roleOut(
      await readRole(transaction, actor.organizationId, inserted.rows[0].id),
    );
  },

  async updateRole(transaction, actorInput, roleId, input, expectedVersion) {
    const actor = await freshActor(transaction, actorInput);
    const current: RoleRow = await lockRole(
      transaction,
      actor.organizationId,
      roleId,
    );
    if (current.version !== expectedVersion) {
      throw new StandardError({ code: "VERSION_CONFLICT" });
    }
    const permissions = input.permissions === undefined
      ? current.permissions
      : normalizeRolePermissions(input.permissions);
    // The editor must hold both the old and the new set: a weaker editor can
    // neither raise a role past itself nor quietly strip a stronger one.
    assertWithinCaller(actor, current.permissions);
    assertWithinCaller(actor, permissions);
    await transaction.query(
      `update bakery.organization_roles
      set name = $3, description = $4, permissions = $5,
        updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2`,
      [
        actor.organizationId,
        roleId,
        input.name?.trim() ?? current.name,
        input.description?.trim() ?? current.description,
        permissions,
      ],
    );
    return roleOut(await readRole(transaction, actor.organizationId, roleId));
  },

  async assignRole(transaction, actorInput, roleId, input) {
    const actor = await freshActor(transaction, actorInput);
    const role = await readRole(transaction, actor.organizationId, roleId);
    // The assigner must hold everything it hands out.
    assertWithinCaller(actor, role.permissions);
    const member = await lockActiveMember(
      transaction,
      actor.organizationId,
      input.principalId,
    );
    // Nor may it strip a member who outranks it.
    assertWithinCaller(actor, memberRolePermissions(member));
    if (member.role === OrganizationRole.Admin) {
      await assertAnotherAdminRemains(
        transaction,
        actor.organizationId,
        member.membershipId,
      );
    }
    await transaction.query(
      `update bakery.organization_memberships
      set role = 'guest', custom_role_id = $2,
        updated_at = current_timestamp, version = version + 1
      where id = $1`,
      [member.membershipId, roleId],
    );
    return roleOut(await readRole(transaction, actor.organizationId, roleId));
  },
};
