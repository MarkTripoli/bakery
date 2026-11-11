import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  type ActionAccess as ActionAccessValue,
  type CatalogPermissionKey,
  isOrganizationRole,
  type OrganizationId,
  OrganizationRole,
  type OrganizationRole as OrganizationRoleValue,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { AccessScope, ResourceBinding } from "./bindings.ts";
import type { AuthenticatedSubject } from "./identity.ts";

export const AUTHORITY_POLICY_REVISION = 1;

/**
 * Authority for one organization-scoped request.
 *
 * Actors carry a live organization `role` or exact per-action `capabilities`.
 * Both values are resolved from Bakery-owned state for every principal type.
 */
export type CustomRoleAuthority = {
  id: string;
  key: string;
  permissions: readonly CatalogPermissionKey[];
};

export type OrganizationActor = {
  subject: AuthenticatedSubject;
  organizationId: OrganizationId;
  role?: OrganizationRoleValue;
  /**
   * Paid custom role the member holds. It grants its permissions on top of the
   * membership's system role (always guest while a custom role is held) and
   * never confers a system role, so it cannot satisfy a rank or last-admin check.
   */
  customRole?: CustomRoleAuthority;
  capabilities: readonly string[];
  /** Scope bundles of the access token that authenticated this request, if any. */
  tokenScopes?: readonly string[];
  /** Live resource role bindings; they add to, never replace, `role`. */
  bindings?: readonly ResourceBinding[];
  /**
   * Set only when the organization role denied a list action and bindings
   * allowed it: the list must return nothing outside this scope.
   */
  accessScope?: AccessScope;
};

export type InstallationActor = {
  subject: AuthenticatedSubject;
  installationAdministrator: true;
};

export type AuthorizedActionContext = ActionContext & {
  principal: AuthenticatedSubject;
  authority: AuthenticatedSubject | OrganizationActor | InstallationActor;
  transaction: PgTransactionClient;
};

/**
 * Role precedence. A role satisfies any minimum with an equal or lower rank.
 * Adding a role means adding one row here and one entry to the contract enum.
 */
const roleRank: Readonly<Record<OrganizationRoleValue, number>> = {
  [OrganizationRole.Guest]: 0,
  [OrganizationRole.Viewer]: 1,
  [OrganizationRole.Developer]: 2,
  [OrganizationRole.Admin]: 3,
};

/** Minimum membership role each catalog access policy requires. */
const organizationMinimumRoles = new Map<
  ActionAccessValue,
  OrganizationRoleValue
>([
  [ActionAccess.Admin, OrganizationRole.Admin],
  [ActionAccess.Developer, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperOrWorkerPinnedVersionAndCurrentLease,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndActionGrant, OrganizationRole.Developer],
  [ActionAccess.AuthorizedOwnerMember, OrganizationRole.Developer],
  [
    ActionAccess.AuthorizedOwnerMemberAndInstallGrant,
    OrganizationRole.Developer,
  ],
  [ActionAccess.CurrentMember, OrganizationRole.Developer],
  [ActionAccess.CurrentMemberLinkingSelf, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperForPersonalAdminForOrganization,
    OrganizationRole.Admin,
  ],
  [ActionAccess.DeveloperAndAdmissionAuthority, OrganizationRole.Developer],
  [ActionAccess.DeveloperAndDeployGrant, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperAndExactExternalActionGrant,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndResourceRead, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperAndSourceAndDestinationRead,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndSourceRead, OrganizationRole.Developer],
  [ActionAccess.ExactActionReadGrant, OrganizationRole.Developer],
  [ActionAccess.InitiatingPrincipalOrAdmin, OrganizationRole.Developer],
  [ActionAccess.LinkedPrincipalOrAdmin, OrganizationRole.Developer],
  [ActionAccess.OrganizationMember, OrganizationRole.Developer],
  [ActionAccess.OwnerForPersonalAdminForOrganization, OrganizationRole.Admin],
]);

export function organizationMinimumRole(
  access: ActionAccessValue,
): OrganizationRoleValue | undefined {
  return organizationMinimumRoles.get(access);
}

/** Narrows an untrusted persisted value to a declared organization role. */
export function requireOrganizationRole(value: unknown): OrganizationRoleValue {
  if (!isOrganizationRole(value)) {
    throw new Error("AUTHORITY_MEMBERSHIP_ROLE_INVALID");
  }
  return value;
}

/** Returns the actor's role or fails closed when the actor has none. */
export function requireActorRole(
  actor: OrganizationActor,
): OrganizationRoleValue {
  if (!actor.role) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return actor.role;
}

/** True when `role` meets or exceeds `minimum` in the role precedence. */
export function roleSatisfies(
  role: OrganizationRoleValue,
  minimum: OrganizationRoleValue,
): boolean {
  return roleRank[role] >= roleRank[minimum];
}

/** True when the actor holds one of the listed roles exactly. */
export function hasAnyRole(
  actor: OrganizationActor,
  ...roles: readonly OrganizationRoleValue[]
): boolean {
  return actor.role !== undefined && roles.includes(actor.role);
}
