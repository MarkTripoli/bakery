import {
  ActionAuthorizationError,
  type ActionDefinition,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  type CatalogActionName,
  catalogActions,
  type CatalogPermissionKey,
  OrganizationRole,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { OrganizationActor } from "./authority.ts";
import { roleHasPermission, rolePermissions } from "./permissions.ts";
import { minimalScopes, scopeAllows } from "./scopes.ts";

type PermissionPrincipal = Readonly<{
  subject: Readonly<{ principalType: PrincipalType }>;
  role?: OrganizationActor["role"];
  customRole?: OrganizationActor["customRole"];
  capabilities: readonly string[];
  /** Present only for an access-token request: the token's scope bundles. */
  tokenScopes?: readonly string[];
}>;

export type AuthorizationResource = Readonly<{
  action?: CatalogActionName;
}>;

const catalogByName = new Map(
  catalogActions.map((action) => [action.action, action] as const),
);

const baseOrganizationPolicies: ReadonlySet<string> = new Set([
  ActionAccess.Admin,
  ActionAccess.Developer,
  ActionAccess.OrganizationMember,
]);

function deniedCode(permission: CatalogPermissionKey) {
  const verb = permission.slice(permission.indexOf(":") + 1);
  return verb.startsWith("read") ? "RESOURCE_NOT_FOUND" : "AUTH_FORBIDDEN";
}

export function permissionForAction(
  action: CatalogActionName,
): CatalogPermissionKey {
  const permission = catalogByName.get(action)?.permission;
  if (permission === null || permission === undefined) {
    throw new ActionAuthorizationError(
      `action ${action} has no principal permission`,
    );
  }
  return permission;
}

export function authorize(
  principal: PermissionPrincipal,
  permission: CatalogPermissionKey,
  resource: AuthorizationResource = {},
): void {
  const roleAllows = principal.role !== undefined &&
    roleHasPermission(principal.role, permission);
  const customAllows = principal.customRole?.permissions.includes(permission) ??
    false;
  const grantAllows = resource.action !== undefined &&
    principal.capabilities.includes(resource.action);
  const humanWithoutRole =
    principal.subject.principalType === PrincipalType.Human &&
    principal.role === undefined;

  if ((roleAllows || customAllows || grantAllows) && !humanWithoutRole) {
    // The principal may do this; a token may still be scoped below it. Distinct
    // from a permission miss so the caller learns which bundle to mint.
    if (
      principal.tokenScopes !== undefined &&
      !scopeAllows(permission, principal.tokenScopes)
    ) {
      throw new StandardError({
        code: "INSUFFICIENT_SCOPE",
        params: { requiredScopes: minimalScopes(permission) },
      });
    }
    return;
  }
  // A guest must not learn the organization exists: every denial is a 404. A
  // custom-role holder is a member (the role is the grant), so it gets the
  // ordinary 404-for-read and 403-for-write split instead.
  throw new StandardError({
    code: principal.role === OrganizationRole.Guest &&
        principal.customRole === undefined
      ? "RESOURCE_NOT_FOUND"
      : deniedCode(permission),
  });
}

export function authorizeOrganizationAction(
  action: ActionDefinition,
  actor: OrganizationActor,
): void {
  if (
    !baseOrganizationPolicies.has(action.policy.access) &&
    action.policy.authorize === undefined
  ) {
    throw new ActionAuthorizationError(
      `action ${action.name} requires an action-specific authorization guard`,
    );
  }
  authorize(actor, permissionForAction(action.name), { action: action.name });
}

/** Permission keys the catalog assigns to an exact action, or undefined for an unknown or keyless one. */
export function catalogPermissionForAction(
  action: string,
): CatalogPermissionKey | undefined {
  return catalogByName.get(action as CatalogActionName)?.permission ??
    undefined;
}

/** Permission keys of a role, or undefined for an unknown role name. */
export function rolePermissionsOf(
  role: string,
): readonly CatalogPermissionKey[] | undefined {
  return (rolePermissions as Record<string, readonly CatalogPermissionKey[]>)[
    role
  ];
}

/**
 * Everything the actor may do right now: live role permissions plus exact
 * grants, further narrowed by a token's scopes when the request used one.
 */
export function effectivePermissions(
  actor: OrganizationActor,
): CatalogPermissionKey[] {
  const all = allPermissions(actor);
  const scopes = actor.tokenScopes;
  return scopes === undefined ? all : all.filter((p) => scopeAllows(p, scopes));
}

/** Full organization-scoped permission set for a display surface such as
 * `effectiveAccess`; unlike `effectivePermissions`, it is never narrowed by a
 * token's scopes and is never truncated. */
export function organizationPermissions(
  actor: OrganizationActor,
): CatalogPermissionKey[] {
  return allPermissions(actor);
}

function allPermissions(actor: OrganizationActor): CatalogPermissionKey[] {
  if (
    actor.subject.principalType === PrincipalType.Human &&
    actor.role === undefined
  ) return [];
  const fromRole = actor.role === undefined ? [] : rolePermissions[actor.role];
  const fromCustom = actor.customRole?.permissions ?? [];
  const fromGrants = actor.capabilities.flatMap((action) => {
    const catalog = catalogByName.get(action as CatalogActionName);
    return catalog?.permission === null || catalog?.permission === undefined
      ? []
      : [catalog.permission];
  });
  return [...new Set([...fromRole, ...fromCustom, ...fromGrants])].sort();
}
