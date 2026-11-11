import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  parseStrongIfMatch,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import { AuthImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import {
  createAccessBinding,
  deleteAccessBinding,
  listAccessBindings,
} from "../../../adapters/bindings-postgres.ts";
import {
  createAccessToken,
  createPermissionGrant,
  createServiceAccount,
  listAccessTokens,
  listPermissionGrants,
  listPrincipals,
  revokeAccessToken,
  revokePermissionGrant,
  updateServiceAccount,
} from "../../../adapters/access-postgres.ts";
import {
  deleteOrganizationRole,
  listOrganizationRoles,
  unassignOrganizationRole,
} from "../../../adapters/organization-roles-postgres.ts";
import { customRoles } from "../../../roles/mod.ts";
import { recordAuthAudit } from "../../../application/audit.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../../../application/authority.ts";

function authorized(context: ActionContext): AuthorizedActionContext {
  const value = context as Partial<AuthorizedActionContext>;
  if (!value.transaction || !value.principal || !value.authority) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return value as AuthorizedActionContext;
}

/**
 * Access-management mutations need a browser session. A bearer token could
 * otherwise mint a longer-lived copy of itself, so revoking a leaked token
 * would not end the leak.
 */
function requireSession(context: AuthorizedActionContext): void {
  if (context.accessToken !== undefined) {
    throw new StandardError({ code: "SESSION_REQUIRED" });
  }
}

function organizationActor(
  context: AuthorizedActionContext,
): OrganizationActor {
  const actor = context.authority as Partial<OrganizationActor>;
  if (
    !actor.organizationId || !actor.subject ||
    !Array.isArray(actor.capabilities)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return actor as OrganizationActor;
}

function audit(
  context: AuthorizedActionContext,
  actor: OrganizationActor,
  record: {
    operation: string;
    resourceType: string;
    resourceId: string;
    details?: Readonly<Record<string, unknown>>;
  },
) {
  return recordAuthAudit(context.transaction, context, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    ...record,
    details: {
      ...record.details,
      ...(context.accessToken ? { viaAccessToken: true } : {}),
    },
  });
}

function requiredVersion(context: ActionContext): number {
  const version = parseStrongIfMatch(context.request.headers.get("if-match"));
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return version;
}

function commandVersion(context: ActionContext): number {
  const version = requireCommandMetadata(context).expectedVersion;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return version;
}

type CursorInput = z.output<typeof contractSchemas.CursorQuery>;

export function principalsList(
  context: ActionContext,
  input: CursorInput,
  secret: string,
) {
  const value = authorized(context);
  return listPrincipals(
    value.transaction,
    organizationActor(value),
    input,
    secret,
  );
}

export async function principalsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.PrincipalCreate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const created = await createServiceAccount(value.transaction, actor, input);
  await audit(value, actor, {
    operation: Action.PrincipalsCreate,
    resourceType: "principal",
    resourceId: created.id,
    details: { principalType: "service", role: input.role },
  });
  return created;
}

export async function principalsUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.PrincipalUpdate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const updated = await updateServiceAccount(
    value.transaction,
    actor,
    value.params.id,
    input,
    requiredVersion(context),
  );
  await audit(value, actor, {
    operation: Action.PrincipalsUpdate,
    resourceType: "principal",
    resourceId: updated.id,
    details: {
      fields: Object.keys(input).sort(),
      disabled: updated.disabledAt !== null,
    },
  });
  return updated;
}

export function permissionGrantsList(
  context: ActionContext,
  input: CursorInput,
  secret: string,
) {
  const value = authorized(context);
  return listPermissionGrants(
    value.transaction,
    organizationActor(value),
    input,
    secret,
  );
}

export async function permissionGrantsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.PermissionGrantCreate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const created = await createPermissionGrant(value.transaction, actor, input);
  await audit(value, actor, {
    operation: Action.PermissionGrantsCreate,
    resourceType: "permission_grant",
    resourceId: created.id,
    details: {
      principalId: created.principalId,
      capability: created.capability,
      expires: created.expiresAt !== null,
    },
  });
  return created;
}

export async function permissionGrantsDelete(context: ActionContext) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const { grant } = await revokePermissionGrant(
    value.transaction,
    actor,
    value.params.id,
    commandVersion(context),
  );
  await audit(value, actor, {
    operation: Action.PermissionGrantsDelete,
    resourceType: "permission_grant",
    resourceId: grant.id,
    details: { principalId: grant.principalId, capability: grant.capability },
  });
  return null;
}

export function accessTokensList(
  context: ActionContext,
  input: CursorInput,
  secret: string,
) {
  const value = authorized(context);
  return listAccessTokens(
    value.transaction,
    organizationActor(value),
    input,
    secret,
  );
}

export async function accessTokensCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AccessTokenCreate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const created = await createAccessToken(value.transaction, actor, input);
  // The secret is returned to the caller only; the audit row never sees it.
  await audit(value, actor, {
    operation: Action.AccessTokensCreate,
    resourceType: "access_token",
    resourceId: created.id,
    details: {
      principalId: created.principalId,
      scopes: created.scopes,
      expiresAt: created.expiresAt,
    },
  });
  return created;
}

export async function accessTokensRevoke(context: ActionContext) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const { token, changed } = await revokeAccessToken(
    value.transaction,
    actor,
    value.params.id,
    commandVersion(context),
  );
  if (changed) {
    await audit(value, actor, {
      operation: Action.AccessTokensRevoke,
      resourceType: "access_token",
      resourceId: token.id,
      details: { principalId: token.principalId },
    });
  }
  return null;
}

export function accessBindingsList(
  context: ActionContext,
  input: CursorInput,
  secret: string,
) {
  const value = authorized(context);
  return listAccessBindings(
    value.transaction,
    organizationActor(value),
    input,
    secret,
  );
}

export async function accessBindingsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AccessBindingCreate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const created = await createAccessBinding(value.transaction, actor, input);
  await audit(value, actor, {
    operation: Action.AccessBindingsCreate,
    resourceType: "access_binding",
    resourceId: created.id,
    details: {
      principalId: created.principalId,
      roleKey: created.roleKey,
      scopeType: created.scopeType,
      scopeId: created.scopeId,
    },
  });
  return created;
}

export async function accessBindingsDelete(context: ActionContext) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const removed = await deleteAccessBinding(
    value.transaction,
    actor,
    value.params.id,
    commandVersion(context),
  );
  await audit(value, actor, {
    operation: Action.AccessBindingsDelete,
    resourceType: "access_binding",
    resourceId: removed.id,
    details: {
      principalId: removed.principalId,
      roleKey: removed.roleKey,
      scopeType: removed.scopeType,
      scopeId: removed.scopeId,
    },
  });
  return null;
}

export function organizationRolesList(
  context: ActionContext,
  input: CursorInput,
  secret: string,
) {
  const value = authorized(context);
  return listOrganizationRoles(
    value.transaction,
    organizationActor(value),
    input,
    secret,
  );
}

export async function organizationRolesCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationRoleCreate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const created = await customRoles.createRole(
    value.transaction,
    actor,
    input,
  );
  await audit(value, actor, {
    operation: Action.OrganizationRolesCreate,
    resourceType: "organization_role",
    resourceId: created.id,
    details: { key: created.key, permissions: created.permissions },
  });
  return created;
}

export async function organizationRolesUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationRoleUpdate>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const updated = await customRoles.updateRole(
    value.transaction,
    actor,
    value.params.id,
    input,
    requiredVersion(context),
  );
  await audit(value, actor, {
    operation: Action.OrganizationRolesUpdate,
    resourceType: "organization_role",
    resourceId: updated.id,
    details: {
      key: updated.key,
      fields: Object.keys(input).sort(),
      permissions: updated.permissions,
    },
  });
  return updated;
}

export async function organizationRolesDelete(context: ActionContext) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  requiredVersion(context);
  const role = await deleteOrganizationRole(
    value.transaction,
    actor,
    value.params.id,
  );
  await audit(value, actor, {
    operation: Action.OrganizationRolesDelete,
    resourceType: "organization_role",
    resourceId: role.id,
    details: { key: role.key },
  });
  return null;
}

export async function organizationRolesAssign(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationRoleAssign>,
) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const role = await customRoles.assignRole(
    value.transaction,
    actor,
    value.params.id,
    input,
  );
  await audit(value, actor, {
    operation: Action.OrganizationRolesAssign,
    resourceType: "organization_role",
    resourceId: role.id,
    details: { key: role.key, principalId: input.principalId },
  });
  return role;
}

export async function organizationRolesUnassign(context: ActionContext) {
  const value = authorized(context);
  requireSession(value);
  const actor = organizationActor(value);
  const role = await unassignOrganizationRole(
    value.transaction,
    actor,
    value.params.id,
    value.params.principalId,
  );
  await audit(value, actor, {
    operation: Action.OrganizationRolesUnassign,
    resourceType: "organization_role",
    resourceId: role.id,
    details: { key: role.key, principalId: value.params.principalId },
  });
  return null;
}
