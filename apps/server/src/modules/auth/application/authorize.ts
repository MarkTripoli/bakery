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
  /** A live direct grant on the one document the request is about. */
  artifactGrant?: OrganizationActor["artifactGrant"];
}>;

/**
 * What a direct document grant permits, by level. The grant is for one document;
 * callers set it only for a request about that document. `read_comment` reads it
 * and comments; `edit` also works its draft and publishes it. Nothing here
 * reaches the task, agents, other documents or resharing.
 */
const READ_COMMENT_PERMISSIONS: ReadonlySet<CatalogPermissionKey> = new Set([
  "artifact:read",
  "artifactVersion:read",
  "artifactComment:read",
  "artifactComment:write",
]);
const EDIT_PERMISSIONS: ReadonlySet<CatalogPermissionKey> = new Set([
  ...READ_COMMENT_PERMISSIONS,
  "draft:read",
  "draft:write",
  "draftCheckpoint:read",
  "draftSlice:read",
  "artifactVersion:write",
]);

function documentGrantPermits(
  grant: OrganizationActor["artifactGrant"],
  permission: CatalogPermissionKey,
): boolean {
  if (grant === undefined) return false;
  return (grant.level === "edit" ? EDIT_PERMISSIONS : READ_COMMENT_PERMISSIONS)
    .has(permission);
}

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
  // Developer is the role floor for both; the action's handler then decides
  // per skill (the owner for a personal skill, an Admin for an organization
  // one), which no single role check can express.
  ActionAccess.DeveloperForPersonalAdminForOrganization,
  ActionAccess.OwnerForPersonalAdminForOrganization,
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
  const grantAllows = (resource.action !== undefined &&
    principal.capabilities.includes(resource.action)) ||
    documentGrantPermits(principal.artifactGrant, permission);
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

/**
 * A current human member with a system role, or a guest holding a custom role.
 * This is the floor for the own-inbox rules: a bare guest or a service account
 * is not a member here.
 */
export function isOrganizationMember(actor: PermissionPrincipal): boolean {
  return actor.subject.principalType === PrincipalType.Human &&
    actor.role !== undefined &&
    (actor.role !== OrganizationRole.Guest || actor.customRole !== undefined);
}

/**
 * The SQL form of isOrganizationMember's role half, for a membership row
 * aliased `membership`: a system role, and not a bare guest. Callers add the
 * human-principal and active-status conditions themselves. Kept here so a
 * role rule outside auth is never spelled twice.
 */
export function organizationMemberRoleSql(membership: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(membership)) {
    throw new Error("membership alias must be a plain SQL identifier");
  }
  return `(${membership}.role is not null
    and (${membership}.role <> '${OrganizationRole.Guest}'
      or ${membership}.custom_role_id is not null))`;
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

/**
 * Guard for "Initiating principal or Admin" on the service-account and token
 * actions (issue 233, owner-directed split). The role and permission check has
 * already run; what is left is scope. A member acts on the records they own and
 * an Admin acts on the whole organization, so the gate here is only that the
 * caller is one of the two roles the policy names. The handlers narrow the
 * reads and refuse a foreign write, which is where ownership is enforced.
 */
/**
 * Guard for an action whose policy says "Admin for organization scope".
 *
 * The catalog grants the action to Developer by default, because a person may
 * act on their own records with it; whether this particular call reaches the
 * whole organization is decided by the input, so the action asks here. Keeping
 * the role knowledge in this file is what the no-raw-role-checks rail exists to
 * enforce: an organization module names the authority it needs, never the role.
 */
export function authorizeOrganizationAdministrator(
  actor: OrganizationActor,
): void {
  if (actor.role !== OrganizationRole.Admin) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

/**
 * The same requirement, for a role read live from the database inside a
 * transaction rather than taken from the session.
 *
 * A session's role can be stale: somebody demoted a minute ago still carries
 * Admin in their cookie. A write that widens what the whole organization can
 * use re-reads the membership row and asks here, so the role knowledge stays in
 * this file and the caller only names the authority it needs.
 */
export function isOrganizationAdministratorRole(role: string): boolean {
  return role === OrganizationRole.Admin;
}

export function authorizeInitiatingPrincipal(actor: OrganizationActor): void {
  if (
    actor.role !== OrganizationRole.Admin &&
    actor.role !== OrganizationRole.Developer
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}
