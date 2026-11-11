import {
  type ActionAuthorityRunner,
  type ActionContext,
  type ActionDefinition,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  type CatalogActionName,
  isMembershipStatus,
  isPrincipalType,
  isUuid,
  MembershipStatus,
  type MembershipStatus as MembershipStatusValue,
  OrganizationContextPolicy,
  type OrganizationId,
  organizationId as toOrganizationId,
  type OrganizationRole,
  type PrincipalId,
  principalId as toPrincipalId,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  lockInstallationPrincipals,
  readInstallationSettings,
} from "./installation-settings-postgres.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import { type AuthenticatedSubject } from "../application/identity.ts";
import {
  AUTHORITY_POLICY_REVISION,
  type AuthorizedActionContext,
  type CustomRoleAuthority,
  type InstallationActor,
  type OrganizationActor,
  requireOrganizationRole,
} from "../application/authority.ts";
import {
  accessScopeFor,
  BINDABLE_ACTIONS,
  bindingAllows,
  bindingCovers,
  type BindingTarget,
} from "../application/bindings.ts";
import {
  authorizeOrganizationAction,
  permissionForAction,
} from "../application/authorize.ts";
import { minimalScopes, scopeAllows } from "../application/scopes.ts";
import {
  loadResourceBindings,
  resolveBindingTarget,
} from "./binding-resolution-postgres.ts";
import { isCatalogPermissionKey } from "../application/permissions.ts";

const ORGANIZATION_HEADER = "Bakery-Organization-Id";

type PrincipalRow = {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  providerUserId?: string;
};

function requireSubject(value: unknown): AuthenticatedSubject {
  const subject = value as Partial<PrincipalRow> | undefined;
  if (
    !subject || !isUuid(subject.principalId) ||
    !isPrincipalType(subject.principalType) ||
    typeof subject.displayName !== "string" || !subject.displayName
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return {
    principalId: toPrincipalId(subject.principalId),
    principalType: subject.principalType,
    displayName: subject.displayName,
    ...(typeof subject.providerUserId === "string"
      ? { providerUserId: subject.providerUserId }
      : {}),
  };
}

async function reloadSubject(
  client: PgTransactionClient,
  principalId: PrincipalId,
): Promise<AuthenticatedSubject> {
  const result = await client.query<PrincipalRow>(
    `select id as "principalId", principal_type as "principalType",
      display_name as "displayName", provider_user_id as "providerUserId"
    from bakery.principals
    where id = $1
      and disabled_at is null`,
    [principalId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return requireSubject(result.rows[0]);
}

/** Reads and validates an organization identifier. Never trusts the path. */
export function requireOrganizationIdValue(
  raw: string | null | undefined,
): OrganizationId {
  const value = raw?.trim();
  if (value === undefined) throw new StandardError({ code: "SCOPE_REQUIRED" });
  if (!isUuid(value)) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return toOrganizationId(value);
}

/**
 * When the action declares which route parameter names its organization, the
 * header and that parameter must agree. A mismatch is reported as not found so
 * callers cannot probe for organizations they do not belong to.
 */
function assertOrganizationPathMatches(
  action: ActionDefinition,
  context: ActionContext,
  organizationId: OrganizationId,
): void {
  const param = action.policy.organizationIdParam;
  if (param === undefined) return;
  const fromPath = context.params[param]?.trim().toLowerCase();
  if (fromPath !== organizationId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

function requiredOrganizationId(
  action: ActionDefinition,
  context: ActionContext,
): OrganizationId {
  const organizationId = requireOrganizationIdValue(
    context.request.headers.get(ORGANIZATION_HEADER),
  );
  assertOrganizationPathMatches(action, context, organizationId);
  return organizationId;
}

type MembershipAuthority = {
  role?: OrganizationRole;
  customRole?: CustomRoleAuthority;
  status: MembershipStatusValue;
};

export type MembershipRow = {
  role: string | null;
  status: string;
  customRoleId: string | null;
  customRoleKey: string | null;
  customRolePermissions: string[] | null;
};

/**
 * Maps a raw membership row to its authority. A row without a custom role —
 * whether the columns are SQL NULL or absent entirely (e.g. a stale
 * two-column mock returns `undefined`) — carries no `customRole`; only a
 * present id and key build one. An undefined key still fails the presence
 * check, so an incomplete row can never grant membership-level rights on
 * a guest.
 */
export function membershipFromRow(row: MembershipRow): MembershipAuthority {
  if (!isMembershipStatus(row.status)) {
    throw new Error("AUTHORITY_MEMBERSHIP_STATUS_INVALID");
  }
  const customRoleId = row.customRoleId;
  const customRoleKey = row.customRoleKey;
  return {
    role: row.role === null ? undefined : requireOrganizationRole(row.role),
    ...(customRoleId == null || customRoleKey == null ? {} : {
      customRole: {
        id: customRoleId,
        key: customRoleKey,
        // Unknown keys never grant: a key dropped from the catalog is ignored.
        permissions: (row.customRolePermissions ?? []).filter(
          isCatalogPermissionKey,
        ),
      },
    }),
    status: row.status,
  };
}

/** Live canonical membership of any principal, or no membership. */
async function loadMembership(
  client: PgTransactionClient,
  principalId: PrincipalId,
  organizationId: OrganizationId,
): Promise<MembershipAuthority | null> {
  const membership = await client.query<MembershipRow>(
    `select membership.role, membership.status,
      custom.id as "customRoleId", custom.key as "customRoleKey",
      custom.permissions as "customRolePermissions"
    from bakery.organization_memberships as membership
    left join bakery.organization_roles as custom
      on custom.organization_id = membership.organization_id
      and custom.id = membership.custom_role_id
    where membership.principal_id = $1
      and membership.organization_id = $2`,
    [principalId, organizationId],
  );
  const row = membership.rows[0];
  if (!row) return null;
  return membershipFromRow(row);
}

/** Current, unrevoked, unexpired exact capabilities of any principal. */
async function loadCapabilities(
  client: PgTransactionClient,
  principalId: PrincipalId,
  organizationId: OrganizationId,
): Promise<string[]> {
  const grants = await client.query<{ capability: string }>(
    `select capability
    from bakery.permission_grants
    where organization_id = $1
    and principal_id = $2
      and policy_revision = $3
      and revoked_at is null
      and (expires_at is null or expires_at > current_timestamp)
    order by capability`,
    [organizationId, principalId, AUTHORITY_POLICY_REVISION],
  );
  return grants.rows.map(({ capability }) => capability);
}

/**
 * A membership the SCIM projection created whose provisioned person is now
 * deactivated or deleted at the identity provider loses access at once, even
 * when the projection has not caught up. The sole active administrator is
 * exempt, matching the projection, which never removes the last one.
 */
async function isDeprovisionedByScim(
  client: PgTransactionClient,
  principalId: string,
  organizationId: string,
): Promise<boolean> {
  const managed = await client.query(
    `select 1 from bakery.scim_memberships
    where organization_id = $1 and principal_id = $2`,
    [organizationId, principalId],
  );
  if (managed.rows.length === 0) return false;
  const result = await client.query(
    `select 1
    from bakery.scim_memberships as link
    join bakery.principals as principal on principal.id = link.principal_id
    join bakery.organization_memberships as membership
      on membership.organization_id = link.organization_id
      and membership.principal_id = link.principal_id
    where link.organization_id = $1
      and link.principal_id = $2
      and not exists (
        select 1 from public."scimUser" as provisioned
        where provisioned."provisioningDomainId" = $1::text
          and provisioned."userId" = principal.provider_user_id
          and provisioned.active
      )
      and not (
        membership.role = 'admin' and membership.status = 'active'
        and (
          select count(*)
          from bakery.organization_memberships as admin
          join bakery.principals as admin_principal
            on admin_principal.id = admin.principal_id
          where admin.organization_id = $1 and admin.role = 'admin'
            and admin.status = 'active'
            and admin_principal.principal_type = 'human'
            and admin_principal.disabled_at is null
        ) = 1
      )`,
    [organizationId, principalId],
  );
  return result.rows.length > 0;
}

async function resolveOrganizationActorForSubject(
  client: PgTransactionClient,
  subject: AuthenticatedSubject,
  organizationId: OrganizationId,
): Promise<OrganizationActor> {
  const membership = await loadMembership(
    client,
    subject.principalId,
    organizationId,
  );
  if (membership?.status === MembershipStatus.Inactive) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (
    membership !== undefined && membership !== null &&
    await isDeprovisionedByScim(client, subject.principalId, organizationId)
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const capabilities = await loadCapabilities(
    client,
    subject.principalId,
    organizationId,
  );
  if (
    subject.principalType === PrincipalType.Human &&
    membership?.role === undefined
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const bindings = await loadResourceBindings(
    client,
    subject.principalId,
    organizationId,
  );
  if (
    membership?.role === undefined && capabilities.length === 0 &&
    bindings.length === 0
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return {
    subject,
    organizationId,
    ...(membership?.role === undefined ? {} : { role: membership.role }),
    ...(membership?.customRole === undefined
      ? {}
      : { customRole: membership.customRole }),
    capabilities,
    ...(bindings.length === 0 ? {} : { bindings }),
  };
}

/**
 * Organization-wide authority first; when it refuses a bindable action, the
 * principal's resource bindings may still allow it. A binding that reaches the
 * resource but not the verb answers 403 (the resource is readable); a resource
 * no binding reaches answers exactly as before, so a foreign or hidden
 * resource stays indistinguishable from a missing one.
 */
function authorizeWithBindings(
  action: ActionDefinition,
  actor: OrganizationActor,
  resolveTarget: (
    kind: NonNullable<(typeof BINDABLE_ACTIONS)[keyof typeof BINDABLE_ACTIONS]>,
  ) => Promise<BindingTarget | undefined>,
): Promise<OrganizationActor> {
  return (async () => {
    try {
      authorizeOrganizationAction(action, actor);
      return actor;
    } catch (denied) {
      const kind = BINDABLE_ACTIONS[action.name as CatalogActionName];
      const bindings = actor.bindings ?? [];
      if (kind === undefined || bindings.length === 0) throw denied;
      const permission = permissionForAction(action.name as CatalogActionName);
      const scopeDenied = () => {
        if (
          actor.tokenScopes !== undefined &&
          !scopeAllows(permission, actor.tokenScopes)
        ) {
          return new StandardError({
            code: "INSUFFICIENT_SCOPE",
            params: { requiredScopes: minimalScopes(permission) },
          });
        }
        return undefined;
      };
      if (kind === "list") {
        const accessScope = accessScopeFor(bindings, permission);
        if (accessScope === undefined) throw denied;
        const insufficient = scopeDenied();
        if (insufficient) throw insufficient;
        return { ...actor, accessScope };
      }
      const target = await resolveTarget(kind);
      if (target === undefined) throw denied;
      const covering = bindings.filter((binding) =>
        bindingCovers(binding, target)
      );
      if (covering.length === 0) throw denied;
      if (!covering.some((binding) => bindingAllows(binding, permission))) {
        // Readable through the binding, but this verb is not.
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const insufficient = scopeDenied();
      if (insufficient) throw insufficient;
      return actor;
    }
  })();
}

export async function resolveOrganizationActor(
  transaction: PgTransactionClient,
  principalId: PrincipalId,
  organizationId: OrganizationId,
): Promise<OrganizationActor> {
  const subject = await reloadSubject(transaction, principalId);
  return await resolveOrganizationActorForSubject(
    transaction,
    subject,
    organizationId,
  );
}

async function resolveInstallationActor(
  client: PgTransactionClient,
  subject: AuthenticatedSubject,
): Promise<InstallationActor> {
  if (subject.principalType !== PrincipalType.Human) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const grant = await client.query(
    `select 1
    from bakery.installation_administrators
    where principal_id = $1
      and revoked_at is null`,
    [subject.principalId],
  );
  if (grant.rows.length !== 1) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return { subject, installationAdministrator: true };
}

/** The token must still be unrevoked, unexpired and its principal enabled at action time. */
async function assertAccessTokenLive(
  client: PgTransactionClient,
  tokenId: string,
  principalId: PrincipalId,
): Promise<void> {
  const live = await client.query(
    `select 1
    from bakery.access_tokens as token
    join bakery.principals as principal on principal.id = token.principal_id
    where token.id = $1
      and token.principal_id = $2
      and token.revoked_at is null
      and token.expires_at > current_timestamp
      and principal.disabled_at is null`,
    [tokenId, principalId],
  );
  if (live.rows.length !== 1) {
    throw new StandardError({ code: "AUTH_INVALID" });
  }
}

export class PostgresAuthorityRunner implements ActionAuthorityRunner {
  constructor(private readonly database: PgDatabase) {}

  async run(
    action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: (authorizedContext: ActionContext) => Promise<unknown>,
  ): Promise<unknown> {
    const claimedSubject = requireSubject(context.principal);
    const policy = action.policy.organizationContext;

    if (
      policy === OrganizationContextPolicy.DerivedBoundAuthAttempt ||
      policy === OrganizationContextPolicy.None || !policy
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }

    const organizationId = policy ===
        OrganizationContextPolicy.RequiredAuthenticatedContext
      ? requiredOrganizationId(action, context)
      : undefined;

    const token = context.accessToken;
    if (token !== undefined && action.policy.sessionOnly === true) {
      throw new StandardError({ code: "SESSION_REQUIRED" });
    }
    if (token !== undefined) {
      // A token acts in exactly one organization. Every other organization
      // answers exactly as one the principal does not belong to.
      if (organizationId === undefined) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      if (token.organizationId !== organizationId) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
    }

    return await withPgTransaction(
      this.database,
      async (transaction) => {
        if (token !== undefined) {
          await assertAccessTokenLive(
            transaction,
            token.id,
            claimedSubject.principalId,
          );
        }
        const installationMutation =
          action.name === AuthImplementedAction.InstallationSettingsUpdate ||
          action.name ===
            AuthImplementedAction.InstallationAdministratorsCreate ||
          action.name ===
            AuthImplementedAction.InstallationAdministratorsRevoke;
        const organizationCreation =
          action.name === AuthImplementedAction.OrganizationsCreate;
        if (installationMutation || organizationCreation) {
          await readInstallationSettings(
            transaction,
            installationMutation ? "update" : "share",
          );
          const target = action.name ===
              AuthImplementedAction.InstallationAdministratorsCreate
            ? (input as { principalId: string }).principalId
            : action.name ===
                AuthImplementedAction.InstallationAdministratorsRevoke
            ? context.params.id
            : undefined;
          await lockInstallationPrincipals(
            transaction,
            target === undefined
              ? [claimedSubject.principalId]
              : [claimedSubject.principalId, target],
          );
        }
        let subject: AuthenticatedSubject;
        let authority: AuthorizedActionContext["authority"];

        if (organizationId) {
          const resolved = await resolveOrganizationActor(
            transaction,
            claimedSubject.principalId,
            organizationId,
          );
          const actor = token === undefined
            ? resolved
            : { ...resolved, tokenScopes: token.scopes };
          const permitted = await authorizeWithBindings(
            action,
            actor,
            (kind) =>
              resolveBindingTarget(transaction, organizationId, kind, {
                id: context.params.id,
                input,
              }),
          );
          subject = permitted.subject;
          authority = permitted;
        } else {
          subject = await reloadSubject(
            transaction,
            claimedSubject.principalId,
          );
          authority = subject;

          if (
            policy === OrganizationContextPolicy
              .InstallationAdministratorScope
          ) {
            authority = await resolveInstallationActor(transaction, subject);
          } else if (
            policy !== OrganizationContextPolicy.AuthenticatedPrincipalScope
          ) {
            throw new StandardError({ code: "AUTH_FORBIDDEN" });
          }
        }

        const authorized: AuthorizedActionContext = {
          ...context,
          principal: subject,
          authority,
          transaction,
        };
        return await next(authorized);
      },
      context.signal,
      action.transactionIsolation ?? TransactionIsolation.ReadCommitted,
    );
  }
}
