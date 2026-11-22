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
  OrganizationRole,
  type PrincipalId,
  principalId as toPrincipalId,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { isPostgresDeadlock } from "../../../platform/postgres-errors.ts";
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
  hasLivePowerGrant,
  hasLiveRunGrant,
  RUN_GRANT_ACTIONS,
  RUN_POWER_ACTIONS,
  type RunGrantKind,
  type RunPower,
} from "../application/run-grants.ts";
import {
  authorizeOrganizationAction,
  isOrganizationMember,
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

/**
 * The organization header, or, for an action that declares
 * `organizationIdQuery`, that query parameter when the header is absent. Both
 * go through the same parsing. When both are present they must agree; a
 * disagreement is reported as not found, like a header and path mismatch.
 */
function requiredOrganizationId(
  action: ActionDefinition,
  context: ActionContext,
): OrganizationId {
  const header = context.request.headers.get(ORGANIZATION_HEADER);
  const queryName = action.policy.organizationIdQuery;
  const query = queryName === undefined
    ? null
    : new URL(context.request.url).searchParams.get(queryName);
  const organizationId = requireOrganizationIdValue(header ?? query);
  if (
    header !== null && query !== null &&
    requireOrganizationIdValue(query) !== organizationId
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
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

/**
 * Live canonical membership of any principal, or no membership. The row is
 * read `for share`, like a conversation grant: a concurrent demotion or
 * removal is ordered wholly before or after this request, so a write that
 * passed its role check never commits after the role was taken away.
 */
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
      and membership.organization_id = $2
    for share of membership`,
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
export function authorizeWithBindings(
  action: ActionDefinition,
  actor: OrganizationActor,
  resolveTarget: (
    kind: NonNullable<(typeof BINDABLE_ACTIONS)[keyof typeof BINDABLE_ACTIONS]>,
  ) => Promise<BindingTarget | undefined>,
  holdsRunGrant: (kind: RunGrantKind) => Promise<boolean> = () =>
    Promise.resolve(false),
  holdsRunPower: (power: RunPower) => Promise<boolean> = () =>
    Promise.resolve(false),
): Promise<OrganizationActor> {
  return (async () => {
    try {
      return await authorizeThroughBindings(action, actor, resolveTarget);
    } catch (denied) {
      // Last: the right to see this one run, given by a request. Only a
      // permission miss is widened, like the other fallbacks: a scope miss, a
      // binding fault or any later denial is the real answer and passes on. Only
      // the actions in RUN_GRANT_ACTIONS ask; any other action keeps the answer
      // the role and the bindings gave.
      const kind = RUN_GRANT_ACTIONS[action.name as CatalogActionName];
      const power = RUN_POWER_ACTIONS[action.name as CatalogActionName];
      const human = actor.subject.principalType === PrincipalType.Human;
      const widened = isPermissionMiss(denied) && human && (
        (kind !== undefined && await holdsRunGrant(kind)) ||
        (power !== undefined && await holdsRunPower(power))
      );
      if (widened) {
        const permission = permissionForAction(
          action.name as CatalogActionName,
        );
        if (
          actor.tokenScopes !== undefined &&
          !scopeAllows(permission, actor.tokenScopes)
        ) {
          throw new StandardError({
            code: "INSUFFICIENT_SCOPE",
            params: { requiredScopes: minimalScopes(permission) },
          });
        }
        return actor;
      }
      throw denied;
    }
  })();
}

function authorizeThroughBindings(
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

/**
 * Conversation actions a direct mention grant can open, and only on the
 * conversation named by the route id: read the conversation and its
 * transcript, see who takes part, find people to mention, and reply. Agent
 * execution, turn control, task and repository actions are never here.
 */
const CONVERSATION_GRANT_ACTIONS: ReadonlySet<string> = new Set([
  "conversations.get",
  "messages.list",
  "messages.create",
  "conversationParticipants.list",
  "conversations.mentionCandidates",
  "conversationAccess.sharers",
]);

/**
 * When the organization role refused a conversation action, a live direct
 * grant on exactly that conversation may still allow it. The grant row is read
 * `for share`, so a concurrent revoke is ordered before or after this request
 * rather than interleaved with it. A grant never helps a non-human, a member
 * without a system role, or a guest with no custom role, and a token still has
 * to carry the scope the action needs.
 */
async function authorizeWithConversationGrant(
  transaction: PgTransactionClient,
  action: ActionDefinition,
  actor: OrganizationActor,
  conversationId: string | undefined,
  denied: unknown,
): Promise<OrganizationActor> {
  if (
    !CONVERSATION_GRANT_ACTIONS.has(action.name) ||
    conversationId === undefined || !isUuid(conversationId) ||
    actor.subject.principalType !== PrincipalType.Human ||
    actor.role === undefined ||
    (actor.role === OrganizationRole.Guest && actor.customRole === undefined)
  ) throw denied;
  // Only a permission miss falls back to a grant; any other error is the answer.
  if (!isPermissionMiss(denied)) throw denied;
  const grant = await transaction.query(
    `select 1 from bakery.conversation_access_grants
     where organization_id = $1 and conversation_id = $2
       and principal_id = $3 and revoked_at is null
     for share`,
    [actor.organizationId, conversationId, actor.subject.principalId],
  );
  if (grant.rows.length !== 1) throw denied;
  const permission = permissionForAction(action.name as CatalogActionName);
  if (
    actor.tokenScopes !== undefined &&
    !scopeAllows(permission, actor.tokenScopes)
  ) {
    throw new StandardError({
      code: "INSUFFICIENT_SCOPE",
      params: { requiredScopes: minimalScopes(permission) },
    });
  }
  return { ...actor, conversationGrant: { conversationId } };
}

/**
 * Document actions a direct document grant can open, and only on the one
 * document the route names (directly, or through its version or comment).
 * `read_comment` opens reading the document, its versions and its comments
 * and writing a comment; only `edit` also opens publishing a version. Task,
 * repository, agent and resharing actions are never here, and neither is
 * artifacts.list: a grantee reaches the document from where they were told.
 */
const ARTIFACT_GRANT_ACTIONS: ReadonlyMap<
  string,
  {
    target: "artifact" | "version" | "comment" | "draft" | "draftReference";
    level: "read_comment" | "edit";
  }
> = new Map([
  ["artifacts.get", { target: "artifact", level: "read_comment" }],
  ["artifactVersions.list", { target: "artifact", level: "read_comment" }],
  [
    "artifactComments.listAcrossVersions",
    { target: "artifact", level: "read_comment" },
  ],
  ["artifactAccess.list", { target: "artifact", level: "read_comment" }],
  ["artifactAccess.sharers", { target: "artifact", level: "read_comment" }],
  ["artifactVersions.content", { target: "version", level: "read_comment" }],
  ["artifactVersions.probe", { target: "version", level: "read_comment" }],
  ["artifactVersions.extract", { target: "version", level: "read_comment" }],
  ["artifactComments.list", { target: "version", level: "read_comment" }],
  ["artifactComments.create", { target: "version", level: "read_comment" }],
  [
    "artifactComments.mentionCandidates",
    { target: "version", level: "read_comment" },
  ],
  ["artifactComments.update", { target: "comment", level: "read_comment" }],
  // The editor: its draft, checkpoints, suggestions, comments and publication,
  // at level edit only.
  ["drafts.open", { target: "artifact", level: "edit" }],
  ["drafts.get", { target: "draft", level: "edit" }],
  ["drafts.edit", { target: "draft", level: "edit" }],
  ["drafts.rollover", { target: "draft", level: "edit" }],
  ["draftCheckpoints.get", { target: "draft", level: "edit" }],
  ["draftSlices.get", { target: "draft", level: "edit" }],
  ["draftPublications.create", { target: "draft", level: "edit" }],
  ["draftPublications.get", { target: "draft", level: "edit" }],
  ["draftSuggestions.create", { target: "draft", level: "edit" }],
  ["draftSuggestions.list", { target: "draft", level: "edit" }],
  ["draftSuggestions.accept", { target: "draft", level: "edit" }],
  ["draftSuggestions.reject", { target: "draft", level: "edit" }],
  ["draftComments.create", { target: "draft", level: "edit" }],
  ["draftComments.list", { target: "draft", level: "edit" }],
  ["draftComments.update", { target: "draft", level: "edit" }],
  ["draftReferences.create", { target: "draft", level: "edit" }],
  ["draftReferences.get", { target: "draftReference", level: "edit" }],
]);

/**
 * When the organization role refused a document action, a live direct grant on
 * exactly that document may still allow it. The grant row is read `for share`
 * so a concurrent revoke is ordered before or after this request. A grant never
 * helps a non-human or a member with no system role, and a token still has to
 * carry the scope the action needs.
 */
async function authorizeWithArtifactGrant(
  transaction: PgTransactionClient,
  action: ActionDefinition,
  actor: OrganizationActor,
  routeId: string | undefined,
  denied: unknown,
): Promise<OrganizationActor> {
  const rule = ARTIFACT_GRANT_ACTIONS.get(action.name);
  if (
    rule === undefined || routeId === undefined || !isUuid(routeId) ||
    actor.subject.principalType !== PrincipalType.Human ||
    actor.role === undefined ||
    (actor.role === OrganizationRole.Guest && actor.customRole === undefined)
  ) throw denied;
  if (!isPermissionMiss(denied)) throw denied;
  const found = await transaction.query<{ artifactId: string; level: string }>(
    rule.target === "artifact"
      ? `select grant_row.artifact_id as "artifactId", grant_row.level
           from bakery.artifact_access_grants as grant_row
          where grant_row.organization_id = $1 and grant_row.artifact_id = $2
            and grant_row.principal_id = $3 and grant_row.revoked_at is null
            for share of grant_row`
      : rule.target === "draft"
      ? `select grant_row.artifact_id as "artifactId", grant_row.level
           from bakery.artifact_drafts as draft
           join bakery.artifact_access_grants as grant_row
             on grant_row.organization_id = draft.organization_id
            and grant_row.artifact_id = draft.artifact_id
          where draft.organization_id = $1 and draft.id = $2
            and grant_row.principal_id = $3 and grant_row.revoked_at is null
            for share of grant_row`
      : rule.target === "draftReference"
      ? `select grant_row.artifact_id as "artifactId", grant_row.level
           from bakery.artifact_draft_references as reference
           join bakery.artifact_drafts as draft
             on draft.organization_id = reference.organization_id
            and draft.id = reference.draft_id
           join bakery.artifact_access_grants as grant_row
             on grant_row.organization_id = draft.organization_id
            and grant_row.artifact_id = draft.artifact_id
          where reference.organization_id = $1 and reference.id = $2
            and grant_row.principal_id = $3 and grant_row.revoked_at is null
            for share of grant_row`
      : rule.target === "version"
      ? `select grant_row.artifact_id as "artifactId", grant_row.level
           from bakery.artifact_versions as version
           join bakery.artifact_access_grants as grant_row
             on grant_row.organization_id = version.organization_id
            and grant_row.artifact_id = version.artifact_id
          where version.organization_id = $1 and version.id = $2
            and grant_row.principal_id = $3 and grant_row.revoked_at is null
            for share of grant_row`
      : `select grant_row.artifact_id as "artifactId", grant_row.level
           from bakery.artifact_comments as comment
           join bakery.artifact_versions as version
             on version.organization_id = comment.organization_id
            and version.id = comment.artifact_version_id
           join bakery.artifact_access_grants as grant_row
             on grant_row.organization_id = version.organization_id
            and grant_row.artifact_id = version.artifact_id
          where comment.organization_id = $1 and comment.id = $2
            and grant_row.principal_id = $3 and grant_row.revoked_at is null
            for share of grant_row`,
    [actor.organizationId, routeId, actor.subject.principalId],
  );
  const grant = found.rows[0];
  if (grant === undefined) throw denied;
  // A grant that reads and comments is refused the verbs only `edit` opens.
  if (rule.level === "edit" && grant.level !== "edit") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const permission = permissionForAction(action.name as CatalogActionName);
  if (
    actor.tokenScopes !== undefined &&
    !scopeAllows(permission, actor.tokenScopes)
  ) {
    throw new StandardError({
      code: "INSUFFICIENT_SCOPE",
      params: { requiredScopes: minimalScopes(permission) },
    });
  }
  return {
    ...actor,
    artifactGrant: {
      artifactId: grant.artifactId,
      level: grant.level as "read_comment" | "edit",
    },
  };
}

/**
 * Read-state changes on the caller's OWN inbox. Every one of these handlers
 * scopes to recipient = the authenticated principal and never accepts a
 * recipient from the request, so a member whose role lacks
 * notification:write (a Viewer) may still mark their own items read or
 * unread. This is a principal-equals-recipient rule, not a role grant: it
 * reaches no other action and no other person's notifications.
 */
const OWN_INBOX_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "notifications.setRead",
  "notifications.markAllRead",
  "notifications.undoMarkAllRead",
]);

/**
 * The asked person's own view of the requests addressed to them (issue #456).
 * A person asked may hold nothing but the right to see one run, including a bare
 * Guest, so a role-based permission would refuse exactly the people the view is
 * for. The handler scopes to recipient = the authenticated principal and never
 * accepts a recipient from the request, so this is a principal-equals-recipient
 * rule, not a role grant: it reaches no other action and nobody else's requests.
 */
const OWN_REQUEST_READ_ACTIONS: ReadonlySet<string> = new Set([
  "runRequests.mine",
]);

export function authorizeOwnRequestRead(
  action: ActionDefinition,
  actor: OrganizationActor,
  denied: unknown,
): OrganizationActor {
  if (
    !isPermissionMiss(denied) ||
    !OWN_REQUEST_READ_ACTIONS.has(action.name) ||
    actor.subject.principalType !== PrincipalType.Human ||
    actor.role === undefined
  ) throw denied;
  const permission = permissionForAction(action.name as CatalogActionName);
  if (
    actor.tokenScopes !== undefined &&
    !scopeAllows(permission, actor.tokenScopes)
  ) {
    throw new StandardError({
      code: "INSUFFICIENT_SCOPE",
      params: { requiredScopes: minimalScopes(permission) },
    });
  }
  return actor;
}

function isPermissionMiss(error: unknown): boolean {
  return error instanceof StandardError &&
    (error.code === "AUTH_FORBIDDEN" || error.code === "RESOURCE_NOT_FOUND");
}

export function authorizeOwnInboxWrite(
  action: ActionDefinition,
  actor: OrganizationActor,
  denied: unknown,
): OrganizationActor {
  // Only a permission miss falls back to the own-inbox rule. A scope miss, a
  // binding fault or any other error is the real answer and is passed on.
  if (
    !isPermissionMiss(denied) ||
    !OWN_INBOX_WRITE_ACTIONS.has(action.name) ||
    !isOrganizationMember(actor)
  ) throw denied;
  const permission = permissionForAction(action.name as CatalogActionName);
  if (
    actor.tokenScopes !== undefined &&
    !scopeAllows(permission, actor.tokenScopes)
  ) {
    throw new StandardError({
      code: "INSUFFICIENT_SCOPE",
      params: { requiredScopes: minimalScopes(permission) },
    });
  }
  return actor;
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
    // A session-only action needs a browser session, so the rule asks for the
    // session rather than refusing things known to lack one: without a session
    // id there is no session to bind to, whether the caller arrived with a
    // bearer token, through MCP dispatch, or with a principal and nothing else.
    // Stated this way a new seeding path cannot be born unguarded (issue 287).
    if (
      action.policy.sessionOnly === true &&
      context.sessionId === undefined
    ) {
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

    try {
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
              AuthImplementedAction.InstallationAdministratorsRevoke ||
            action.name === AuthImplementedAction.PasswordResetLinksCreate;
          const organizationCreation =
            action.name === AuthImplementedAction.OrganizationsCreate;
          if (installationMutation || organizationCreation) {
            await readInstallationSettings(
              transaction,
              installationMutation ? "update" : "share",
            );
            const target = action.name ===
                  AuthImplementedAction.InstallationAdministratorsCreate ||
                action.name === AuthImplementedAction.PasswordResetLinksCreate
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
              (kind) =>
                hasLiveRunGrant(
                  transaction,
                  organizationId,
                  claimedSubject.principalId,
                  kind,
                  context.params.id,
                ),
              (power) =>
                hasLivePowerGrant(
                  transaction,
                  organizationId,
                  claimedSubject.principalId,
                  power,
                  context.params.id,
                ),
            )
              .catch(async (denied) => {
                // The two fallbacks cover disjoint actions and each rethrows the
                // original denial untouched, so only a permission miss is widened.
                if (CONVERSATION_GRANT_ACTIONS.has(action.name)) {
                  return await authorizeWithConversationGrant(
                    transaction,
                    action,
                    actor,
                    context.params.id,
                    denied,
                  );
                }
                if (ARTIFACT_GRANT_ACTIONS.has(action.name)) {
                  return await authorizeWithArtifactGrant(
                    transaction,
                    action,
                    actor,
                    context.params.id,
                    denied,
                  );
                }
                return authorizeOwnInboxWrite(action, actor, denied);
              })
              .catch((denied) =>
                authorizeOwnRequestRead(action, actor, denied)
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
    } catch (error) {
      // Two members changing each other's roles at once can deadlock on the
      // membership rows this request holds `for share`. Postgres aborts one
      // side; nothing of it committed, so it is a plain, retryable conflict
      // rather than a server fault.
      if (isPostgresDeadlock(error)) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "concurrent_authority_change" },
        });
      }
      throw error;
    }
  }
}
