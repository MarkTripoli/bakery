import { z } from "zod";
import {
  ActionAuthorizationError,
  type ActionContext,
} from "@bakery/contracts/action-registry";
import {
  contractSchemas,
  isPrincipalType,
  isUuid,
} from "@bakery/contracts/contracts";
import {
  parseStrongIfMatch,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import type { PgDatabase } from "../../../../../platform/database.ts";
import { AuthImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { requestLocale } from "../../../../../platform/locale.ts";
import {
  loadIdentityPresentation,
  readProfile,
  readUserPreferences,
  updateProfile,
  updateUserPreferences,
} from "../../../adapters/settings-postgres.ts";
import {
  type AuthAuditRecord,
  recordAuthAudit,
} from "../../../application/audit.ts";
import { normalizeLocaleTag } from "../../../application/preferences.ts";
import type { PostgresOrganizationStore } from "../../../adapters/organization-postgres.ts";
import {
  listConnectedClientGrants,
  revokeConnectedClientGrant,
} from "../../../adapters/oauth-grants.ts";
import { countUnusedBackupCodes } from "../../../adapters/postgres.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../../../application/authority.ts";
import {
  type AuthenticatedSubject,
  getIdentity,
} from "../../../application/identity.ts";

export function requirePrincipal(value: unknown): AuthenticatedSubject {
  const principal = value as Partial<AuthenticatedSubject> | undefined;
  if (
    !principal || !isUuid(principal.principalId) ||
    !isPrincipalType(principal.principalType) ||
    typeof principal.displayName !== "string" || !principal.displayName
  ) {
    throw new ActionAuthorizationError(
      "identity.get requires a resolved principal",
    );
  }
  return principal as AuthenticatedSubject;
}

/**
 * `/v1/me`: the browser-session principal plus account facts the session
 * middleware carries (email) or that need one bounded read (unused backup
 * codes, only when the person has enrolled an authenticator).
 */
export async function identityGet(
  context: ActionContext,
  _input: z.output<typeof contractSchemas.Empty>,
  options: { database: PgDatabase; secret: string },
) {
  const principal = requirePrincipal(context.principal);
  if (
    typeof principal.email !== "string" ||
    typeof principal.providerUserId !== "string"
  ) {
    throw new ActionAuthorizationError(
      "identity.get requires a browser session principal",
    );
  }
  const backupCodesRemaining = principal.twoFactorEnabled
    ? await countUnusedBackupCodes(
      options.database,
      principal.providerUserId,
      options.secret,
    )
    : null;
  const organizationHeader = context.request.headers.get(
    "bakery-organization-id",
  )?.trim() ?? null;
  const presentation = await loadIdentityPresentation(
    options.database,
    principal.principalId,
    organizationHeader !== null && isUuid(organizationHeader)
      ? organizationHeader.toLowerCase()
      : null,
  );
  const locale = requestLocale(
    context.request,
    principal,
    presentation.defaultLocale,
  );
  return getIdentity(
    { ...principal, email: principal.email },
    locale,
    backupCodesRemaining,
    presentation.timeZone,
  );
}

/** Guard for self-service actions: a human principal with a provider user. */
export function requireHumanSelf(
  context: ActionContext,
): AuthenticatedSubject & { providerUserId: string } {
  const principal = requirePrincipal(context.principal);
  if (
    principal.principalType !== "human" ||
    typeof principal.providerUserId !== "string"
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return principal as AuthenticatedSubject & { providerUserId: string };
}

export function profileGet(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  const principal = requireHumanSelf(authorized);
  return readProfile(
    authorized.transaction,
    principal.principalId,
    principal.providerUserId,
  );
}

export function profileUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.UserProfileUpdate>,
) {
  const authorized = requireAuthorizedContext(context);
  const principal = requireHumanSelf(authorized);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return updateProfile(
    authorized.transaction,
    principal.principalId,
    principal.providerUserId,
    input,
    expectedVersion,
  );
}

/** Guard for member-scoped presentation state: a human with live membership. */
export function requireHumanMember(context: ActionContext): void {
  const principal = requirePrincipal(context.principal);
  if (principal.principalType !== "human") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

export function userPreferencesGet(
  context: ActionContext,
  availableLocales: readonly string[],
) {
  const authorized = requireAuthorizedContext(context);
  const actor = requireOrganizationActor(authorized);
  return readUserPreferences(
    authorized.transaction,
    actor.organizationId,
    actor.subject.principalId,
    {
      availableLocales,
      acceptLanguage: context.request.headers.get("accept-language"),
    },
  );
}

export function userPreferencesUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.UserPreferencesUpdate>,
  availableLocales: readonly string[],
) {
  const authorized = requireAuthorizedContext(context);
  const actor = requireOrganizationActor(authorized);
  return updateUserPreferences(
    authorized.transaction,
    actor.organizationId,
    actor.subject.principalId,
    input,
    {
      availableLocales,
      acceptLanguage: context.request.headers.get("accept-language"),
      requestId: context.requestId,
      traceId: context.traceId,
    },
  );
}

function requireAuthorizedContext(
  context: ActionContext,
): AuthorizedActionContext {
  const authorized = context as Partial<AuthorizedActionContext>;
  requirePrincipal(authorized.principal);
  if (
    !authorized.authority || !authorized.transaction ||
    typeof authorized.transaction.query !== "function"
  ) {
    throw new ActionAuthorizationError(
      "organization action requires an authorized transaction",
    );
  }
  return authorized as AuthorizedActionContext;
}

function requireOrganizationActor(
  context: AuthorizedActionContext,
): OrganizationActor {
  const actor = context.authority as Partial<OrganizationActor>;
  if (
    typeof actor.organizationId !== "string" || !actor.subject ||
    !Array.isArray(actor.capabilities)
  ) {
    throw new ActionAuthorizationError(
      "organization action requires a resolved organization actor",
    );
  }
  requirePrincipal(actor.subject);
  return actor as OrganizationActor;
}

/**
 * Appends the mutation's audit row in the action's own transaction. Known
 * deviation: sign-in credential changes made inside Better Auth (password,
 * passkey, two-factor) are audited best-effort after Better Auth commits (see
 * `credential-audit.ts`), so a write failure there leaves no row.
 */
function audit(
  context: AuthorizedActionContext,
  record: Omit<AuthAuditRecord, "principalId"> & {
    principalId?: string | null;
  },
) {
  return recordAuthAudit(context.transaction, context, {
    ...record,
    principalId: record.principalId ?? context.principal.principalId,
  });
}

export function organizationsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.CursorQuery>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.listOrganizations(
    authorized.transaction,
    authorized.principal,
    input,
  );
}

export function organizationsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationCreate>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.createOrganization(
    authorized.transaction,
    authorized.principal,
    input,
  ).then(async (created) => {
    await audit(authorized, {
      organizationId: created.id,
      operation: Action.OrganizationsCreate,
      resourceType: "organization",
      resourceId: created.id,
      details: { slug: created.slug },
    });
    return created;
  });
}

export function organizationGet(
  context: ActionContext,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.getOrganization(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
  );
}

export async function organizationUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationUpdate>,
  store: PostgresOrganizationStore,
  availableLocales: readonly string[],
) {
  const authorized = requireAuthorizedContext(context);
  const defaultLocale = input.defaultLocale === undefined ||
      input.defaultLocale === null
    ? input.defaultLocale
    : normalizeLocaleTag(input.defaultLocale, availableLocales);
  if (defaultLocale === undefined && input.defaultLocale !== undefined) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  // The version precondition is mandatory: a PATCH with no strong If-Match is
  // refused, so nobody overwrites an organization they have not read. The
  // transport leaves this action's command metadata unset, so the header is
  // read here.
  const expectedVersion = parseStrongIfMatch(
    context.request.headers.get("if-match"),
  );
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const updated = await store.updateOrganization(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    defaultLocale === undefined ? input : { ...input, defaultLocale },
    expectedVersion,
  );
  await audit(authorized, {
    organizationId: updated.id,
    operation: Action.OrganizationsUpdate,
    resourceType: "organization",
    resourceId: updated.id,
    details: { fields: Object.keys(input).sort() },
  });
  return updated;
}

export function organizationEffectiveAccess(
  context: ActionContext,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.effectiveAccess(
    requireOrganizationActor(authorized),
    authorized.params.id,
  );
}

export function organizationMembershipsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.CursorQuery>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.listMemberships(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    input,
  );
}

export async function organizationMembershipsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationMembershipCreate>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const created = await store.createMembership(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    input,
  );
  await audit(authorized, {
    organizationId: created.organizationId,
    operation: Action.OrganizationMembershipsCreate,
    resourceType: "organization_membership",
    resourceId: created.id,
    details: { targetPrincipalId: input.principalId, role: input.role ?? null },
  });
  return created;
}

export async function organizationMembershipsUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationMembershipUpdate>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const updated = await store.updateMembership(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    authorized.params.membershipId,
    input,
  );
  await audit(authorized, {
    organizationId: updated.organizationId,
    operation: Action.OrganizationMembershipsUpdate,
    resourceType: "organization_membership",
    resourceId: updated.id,
    details: {
      fields: Object.keys(input).sort(),
      role: updated.role,
      status: updated.status,
    },
  });
  return updated;
}

export async function organizationMembershipsDelete(
  context: ActionContext,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const removal = await store.deleteMembership(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    authorized.params.membershipId,
  );
  await audit(authorized, {
    organizationId: authorized.params.id,
    operation: Action.OrganizationMembershipsDelete,
    resourceType: "organization_membership",
    resourceId: authorized.params.membershipId,
    details: {
      permissionGrantsRemoved: removal.permissionGrantsRemoved,
      bindingsRemoved: removal.bindingsRemoved,
    },
  });
  return null;
}

export function organizationInvitationsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.CursorQuery>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.listInvitations(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    input,
  );
}

export function organizationInvitationRecipientGet(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationInvitationRecipientGet>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  return store.getRecipientInvitation(
    authorized.transaction,
    authorized.principal,
    input,
  );
}

/** Anonymous invitation-link preview; see `PostgresOrganizationStore.previewInvitation`. */
export function organizationInvitationPreview(
  _context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationInvitationPreviewGet>,
  database: PgDatabase,
  store: PostgresOrganizationStore,
) {
  return store.previewInvitation(database, input);
}

export async function organizationInvitationRecipientAccept(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationInvitationRecipientAction>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const accepted = await store.acceptRecipientInvitation(
    authorized.transaction,
    authorized.principal,
    input,
  );
  await audit(authorized, {
    organizationId: accepted.invitation.organizationId,
    operation: Action.OrganizationInvitationRecipientAccept,
    resourceType: "organization_invitation",
    resourceId: accepted.invitation.id,
  });
  return accepted;
}

export async function organizationInvitationRecipientReject(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationInvitationRecipientAction>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const rejected = await store.rejectRecipientInvitation(
    authorized.transaction,
    authorized.principal,
    input,
  );
  await audit(authorized, {
    organizationId: rejected.invitation.organizationId,
    operation: Action.OrganizationInvitationRecipientReject,
    resourceType: "organization_invitation",
    resourceId: rejected.invitation.id,
  });
  return rejected;
}

export async function organizationInvitationsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.OrganizationInvitationCreate>,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const created = await store.createInvitation(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    input,
  );
  await audit(authorized, {
    organizationId: created.organizationId,
    operation: Action.OrganizationInvitationsCreate,
    resourceType: "organization_invitation",
    resourceId: created.id,
    details: { role: input.role },
  });
  return created;
}

export async function organizationInvitationsCancel(
  context: ActionContext,
  store: PostgresOrganizationStore,
) {
  const authorized = requireAuthorizedContext(context);
  const cancelled = await store.cancelInvitation(
    authorized.transaction,
    requireOrganizationActor(authorized),
    authorized.params.id,
    authorized.params.invitationId,
    requireCommandMetadata(context).expectedVersion,
  );
  await audit(authorized, {
    organizationId: authorized.params.id,
    operation: Action.OrganizationInvitationsCancel,
    resourceType: "organization_invitation",
    resourceId: authorized.params.invitationId,
  });
  return cancelled;
}

/** Whether any enabled human principal exists, i.e. first-admin bootstrap is done. */
export async function installationStatus(
  _context: ActionContext,
  _input: z.output<typeof contractSchemas.Empty>,
  database: PgDatabase,
): Promise<z.output<typeof contractSchemas.InstallationStatus>> {
  const result = await database.query<{ bootstrapped: boolean }>(
    `select exists (
      select 1
      from bakery.installation_settings
      where id = true and bootstrap_principal_id is not null
    ) as bootstrapped`,
  );
  return { bootstrapped: result.rows[0]?.bootstrapped === true };
}

/** Better Auth's provider user id for the authorized principal, read live. */
async function resolveProviderUserId(
  authorized: AuthorizedActionContext,
): Promise<string> {
  if (authorized.principal.providerUserId) {
    return authorized.principal.providerUserId;
  }
  const result = await authorized.transaction.query<
    { providerUserId: string }
  >(
    `select provider_user_id as "providerUserId"
      from bakery.principals
      where id = $1`,
    [authorized.principal.principalId],
  );
  if (result.rows.length !== 1) {
    throw new ActionAuthorizationError(
      "browser session action requires a resolved provider user",
    );
  }
  return result.rows[0].providerUserId;
}

export async function browserSessionsList(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  const providerUserId = await resolveProviderUserId(authorized);
  const result = await authorized.transaction.query<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }>(
    `select id, "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent"
      from public.session
      where "userId" = $1 and "expiresAt" > now()
      order by "updatedAt" desc`,
    [providerUserId],
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      current: row.id === context.sessionId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
    })),
  };
}

export async function browserSessionsRevoke(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  if (!context.sessionId) {
    throw new ActionAuthorizationError(
      "browser session action requires a resolved session",
    );
  }
  const providerUserId = await resolveProviderUserId(authorized);
  const id = authorized.params.id;
  const result = await authorized.transaction.query(
    `delete from public.session
      where id = $1 and "userId" = $2 and "expiresAt" > now()`,
    [id, providerUserId],
  );
  if (result.rowCount !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  await audit(authorized, {
    organizationId: null,
    operation: Action.BrowserSessionsRevoke,
    resourceType: "browser_session",
    resourceId: id,
    details: { current: id === context.sessionId },
  });
  return { revoked: true, current: id === context.sessionId };
}

export async function browserSessionsRevokeOthers(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  if (!context.sessionId) {
    throw new ActionAuthorizationError(
      "browser session action requires a resolved session",
    );
  }
  const providerUserId = await resolveProviderUserId(authorized);
  const result = await authorized.transaction.query(
    `delete from public.session
      where "userId" = $1 and id <> $2 and "expiresAt" > now()
      returning id`,
    [providerUserId, context.sessionId],
  );
  await audit(authorized, {
    organizationId: null,
    operation: Action.BrowserSessionsRevokeOthers,
    resourceType: "browser_session",
    resourceId: authorized.principal.principalId,
    details: { revokedCount: result.rowCount ?? 0 },
  });
  return { revokedCount: result.rowCount ?? 0 };
}

export async function connectedClientsList(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  const providerUserId = await resolveProviderUserId(authorized);
  return {
    items: await listConnectedClientGrants(
      authorized.transaction,
      providerUserId,
    ),
  };
}

export async function connectedClientsRevoke(context: ActionContext) {
  const authorized = requireAuthorizedContext(context);
  const providerUserId = await resolveProviderUserId(authorized);
  const revoked = await revokeConnectedClientGrant(authorized.transaction, {
    providerUserId,
    principalId: authorized.principal.principalId,
    grantId: authorized.params.id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return { revoked: true, ...revoked };
}
