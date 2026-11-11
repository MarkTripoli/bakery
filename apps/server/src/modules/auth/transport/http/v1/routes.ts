import { Hono } from "hono";
import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  AuthImplementedAction,
  authImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter } from "@bakery/contracts/http";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import type { PgDatabase } from "../../../../../platform/database.ts";
import { createPostgresInstallationSettingsReader } from "../../../adapters/installation-settings-postgres.ts";
import type { InstallationSettingsReader } from "../../../application/installation-settings.ts";
import {
  accessBindingsCreate,
  accessBindingsDelete,
  accessBindingsList,
  accessTokensCreate,
  accessTokensList,
  accessTokensRevoke,
  organizationRolesAssign,
  organizationRolesCreate,
  organizationRolesDelete,
  organizationRolesList,
  organizationRolesUnassign,
  organizationRolesUpdate,
  permissionGrantsCreate,
  permissionGrantsDelete,
  permissionGrantsList,
  principalsCreate,
  principalsList,
  principalsUpdate,
} from "./access-handlers.ts";
import {
  auditEventsExport,
  auditEventsList,
  auditRetentionGet,
  auditRetentionUpdate,
  authorizeOrganizationCreation,
  installationAdministratorsCreate,
  installationAdministratorsList,
  installationAdministratorsRevoke,
  installationAuditEventsList,
  installationCapabilities,
  installationSettingsGet,
  installationSettingsUpdate,
} from "./installation-handlers.ts";
import {
  scimConnectionCreate,
  scimConnectionGet,
  scimConnectionRevoke,
  scimConnectionRotate,
} from "./scim-handlers.ts";
import { PostgresAuthorityRunner } from "../../../adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../../../../platform/command-replay.ts";
import { PostgresOrganizationStore } from "../../../adapters/organization-postgres.ts";
import type { IdentityStore } from "../../../application/identity.ts";
import type { SessionStore } from "../../../adapters/postgres.ts";
import {
  type AuthVariables,
  type BrowserSessionAuth,
  createActionContext,
  createBrowserSessionMiddleware,
} from "../../../middleware.ts";
import {
  browserSessionsList,
  browserSessionsRevoke,
  browserSessionsRevokeOthers,
  connectedClientsList,
  connectedClientsRevoke,
  identityGet,
  installationStatus,
  organizationEffectiveAccess,
  organizationGet,
  organizationInvitationPreview,
  organizationInvitationRecipientAccept,
  organizationInvitationRecipientGet,
  organizationInvitationRecipientReject,
  organizationInvitationsCancel,
  organizationInvitationsCreate,
  organizationInvitationsList,
  organizationMembershipsCreate,
  organizationMembershipsDelete,
  organizationMembershipsList,
  organizationMembershipsUpdate,
  organizationsCreate,
  organizationsList,
  organizationUpdate,
  profileGet,
  profileUpdate,
  requireHumanMember,
  requireHumanSelf,
  requirePrincipal,
  userPreferencesGet,
  userPreferencesUpdate,
} from "./handlers.ts";

export type AuthActionRegistryOptions = {
  database: PgDatabase;
  secret: string;
  installationSettings?: InstallationSettingsReader;
  /** BCP 47 locales the server offers for selection; English only by default. */
  availableLocales?: readonly string[];
  /** Public origin; the SCIM base URL shown to administrators derives from it. */
  publicBaseUrl?: string;
};

/**
 * The auth module's operation registry. Built once by the application and
 * shared by the HTTP routes and the MCP resource, so both transports run the
 * same operations through the same authority runner.
 */
export function createAuthActionRegistry(
  options: AuthActionRegistryOptions,
): ActionRegistry {
  const availableLocales = options.availableLocales ?? ["en"];
  const installationSettings = options.installationSettings ??
    createPostgresInstallationSettingsReader(options.database);
  const store = new PostgresOrganizationStore(options.secret);
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(options.database),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  registry.register({
    name: AuthImplementedAction.OrganizationInvitationRecipientGet,
    method: HttpMethod.Get,
    path: "/api/auth/organization/get-invitation",
    input: contractSchemas.OrganizationInvitationRecipientGet,
    output: contractSchemas.OrganizationInvitationRecipient,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: (context, input) =>
      organizationInvitationRecipientGet(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationRecipientAccept,
    method: HttpMethod.Post,
    path: "/api/auth/organization/accept-invitation",
    input: contractSchemas.OrganizationInvitationRecipientAction,
    output: contractSchemas.OrganizationInvitationRecipientResult,
    successStatus: 200,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "invitationId",
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: (context, input) =>
      organizationInvitationRecipientAccept(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationRecipientReject,
    method: HttpMethod.Post,
    path: "/api/auth/organization/reject-invitation",
    input: contractSchemas.OrganizationInvitationRecipientAction,
    output: contractSchemas.OrganizationInvitationRecipientResult,
    successStatus: 200,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "invitationId",
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: (context, input) =>
      organizationInvitationRecipientReject(context, input, store),
  }).register({
    name: AuthImplementedAction.IdentityGet,
    method: HttpMethod.Get,
    path: "/v1/me",
    input: contractSchemas.Empty,
    output: contractSchemas.PrincipalIdentity,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      authorize: (context) => {
        requirePrincipal(context.principal);
      },
    },
    handler: (context, input) =>
      identityGet(context, input, {
        database: options.database,
        secret: options.secret,
      }),
  }).register({
    name: AuthImplementedAction.ProfileGet,
    method: HttpMethod.Get,
    path: "/v1/me/profile",
    input: contractSchemas.Empty,
    output: contractSchemas.UserProfile,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
      authorize: (context) => {
        requireHumanSelf(context);
      },
    },
    handler: profileGet,
  }).register({
    name: AuthImplementedAction.ProfileUpdate,
    method: HttpMethod.Patch,
    path: "/v1/me/profile",
    input: contractSchemas.UserProfileUpdate,
    output: contractSchemas.UserProfile,
    explicitIdempotency: "key-and-if-match",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
      authorize: (context) => {
        requireHumanSelf(context);
      },
    },
    handler: profileUpdate,
  }).register({
    name: AuthImplementedAction.UserPreferencesGet,
    method: HttpMethod.Get,
    path: "/v1/user-preferences",
    input: contractSchemas.Empty,
    output: contractSchemas.UserPreferences,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.CurrentMember,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      authorize: requireHumanMember,
    },
    handler: (context) => userPreferencesGet(context, availableLocales),
  }).register({
    name: AuthImplementedAction.UserPreferencesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/user-preferences",
    input: contractSchemas.UserPreferencesUpdate,
    output: contractSchemas.UserPreferences,
    explicitIdempotency: "key",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.CurrentMember,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      authorize: requireHumanMember,
    },
    handler: (context, input) =>
      userPreferencesUpdate(context, input, availableLocales),
  }).register({
    name: AuthImplementedAction.InstallationCapabilities,
    method: HttpMethod.Get,
    path: "/v1/installation/capabilities",
    input: contractSchemas.Empty,
    output: contractSchemas.InstallationCapabilities,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Public,
    },
    handler: () => installationCapabilities(installationSettings),
  }).register({
    name: AuthImplementedAction.InstallationSettingsGet,
    method: HttpMethod.Get,
    path: "/v1/installation/settings",
    input: contractSchemas.Empty,
    output: contractSchemas.InstallationSettings,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: installationSettingsGet,
  }).register({
    name: AuthImplementedAction.InstallationSettingsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/installation/settings",
    input: contractSchemas.InstallationSettingsUpdate,
    output: contractSchemas.InstallationSettings,
    explicitIdempotency: "key-and-if-match",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: installationSettingsUpdate,
  }).register({
    name: AuthImplementedAction.InstallationAdministratorsList,
    method: HttpMethod.Get,
    path: "/v1/installation/administrators",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<InstallationAdministrator>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: (context, input) =>
      installationAdministratorsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.InstallationAuditEventsList,
    method: HttpMethod.Get,
    path: "/v1/installation/audit-events",
    input: contractSchemas.AuditQuery,
    output: contractSchemas["Page<AuditEvent>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: (context, input) =>
      installationAuditEventsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.AuditEventsList,
    method: HttpMethod.Get,
    path: "/v1/audit-events",
    input: contractSchemas.AuditQuery,
    output: contractSchemas["Page<AuditEvent>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      auditEventsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.AuditEventsExport,
    method: HttpMethod.Get,
    path: "/v1/audit-events/export",
    input: contractSchemas.AuditExportQuery,
    output: contractSchemas.AuditExport,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => auditEventsExport(context, input),
  }).register({
    name: AuthImplementedAction.AuditRetentionGet,
    method: HttpMethod.Get,
    path: "/v1/audit-retention",
    input: contractSchemas.Empty,
    output: contractSchemas.AuditRetention,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => auditRetentionGet(context),
  }).register({
    name: AuthImplementedAction.AuditRetentionUpdate,
    method: HttpMethod.Patch,
    path: "/v1/audit-retention",
    input: contractSchemas.AuditRetentionUpdate,
    output: contractSchemas.AuditRetention,
    explicitIdempotency: "key",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => auditRetentionUpdate(context, input),
  }).register({
    name: AuthImplementedAction.ScimConnectionGet,
    method: HttpMethod.Get,
    path: "/v1/scim-connection",
    input: contractSchemas.Empty,
    output: contractSchemas.ScimConnection,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => scimConnectionGet(context, options.publicBaseUrl),
  }).register({
    name: AuthImplementedAction.ScimConnectionCreate,
    method: HttpMethod.Post,
    path: "/v1/scim-connection",
    input: contractSchemas.ScimConnectionCreate,
    output: contractSchemas.ScimConnectionCreated,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      sessionOnly: true,
    },
    handler: (context, input) =>
      scimConnectionCreate(
        context,
        input,
        options.publicBaseUrl,
      ),
  }).register({
    name: AuthImplementedAction.ScimConnectionRotate,
    method: HttpMethod.Post,
    path: "/v1/scim-connection/rotate",
    input: contractSchemas.ScimConnectionRotate,
    output: contractSchemas.ScimConnectionCreated,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      sessionOnly: true,
    },
    handler: (context, input) =>
      scimConnectionRotate(
        context,
        input,
        options.publicBaseUrl,
      ),
  }).register({
    name: AuthImplementedAction.ScimConnectionRevoke,
    method: HttpMethod.Post,
    path: "/v1/scim-connection/revoke",
    input: contractSchemas.Empty,
    output: contractSchemas.ScimConnection,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      sessionOnly: true,
    },
    handler: (context) => scimConnectionRevoke(context, options.publicBaseUrl),
  }).register({
    name: AuthImplementedAction.PrincipalsList,
    method: HttpMethod.Get,
    path: "/v1/principals",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Principal>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => principalsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.PrincipalsCreate,
    method: HttpMethod.Post,
    path: "/v1/principals",
    input: contractSchemas.PrincipalCreate,
    output: contractSchemas.Principal,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => principalsCreate(context, input),
  }).register({
    name: AuthImplementedAction.PrincipalsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/principals/:id",
    input: contractSchemas.PrincipalUpdate,
    output: contractSchemas.Principal,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => principalsUpdate(context, input),
  }).register({
    name: AuthImplementedAction.PermissionGrantsList,
    method: HttpMethod.Get,
    path: "/v1/permission-grants",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PermissionGrant>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      permissionGrantsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.PermissionGrantsCreate,
    method: HttpMethod.Post,
    path: "/v1/permission-grants",
    input: contractSchemas.PermissionGrantCreate,
    output: contractSchemas.PermissionGrant,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => permissionGrantsCreate(context, input),
  }).register({
    name: AuthImplementedAction.PermissionGrantsDelete,
    method: HttpMethod.Delete,
    explicitIdempotency: "key-and-if-match",
    path: "/v1/permission-grants/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => permissionGrantsDelete(context),
  }).register({
    name: AuthImplementedAction.OrganizationRolesList,
    method: HttpMethod.Get,
    path: "/v1/organization-roles",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationRole>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      organizationRolesList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.OrganizationRolesCreate,
    method: HttpMethod.Post,
    path: "/v1/organization-roles",
    input: contractSchemas.OrganizationRoleCreate,
    output: contractSchemas.OrganizationRole,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => organizationRolesCreate(context, input),
  }).register({
    name: AuthImplementedAction.OrganizationRolesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/organization-roles/:id",
    input: contractSchemas.OrganizationRoleUpdate,
    output: contractSchemas.OrganizationRole,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => organizationRolesUpdate(context, input),
  }).register({
    name: AuthImplementedAction.OrganizationRolesDelete,
    method: HttpMethod.Delete,
    path: "/v1/organization-roles/:id",
    explicitIdempotency: "key-and-if-match",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => organizationRolesDelete(context),
  }).register({
    name: AuthImplementedAction.OrganizationRolesAssign,
    method: HttpMethod.Post,
    path: "/v1/organization-roles/:id/members",
    input: contractSchemas.OrganizationRoleAssign,
    output: contractSchemas.OrganizationRole,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => organizationRolesAssign(context, input),
  }).register({
    name: AuthImplementedAction.OrganizationRolesUnassign,
    method: HttpMethod.Delete,
    path: "/v1/organization-roles/:id/members/:principalId",
    input: contractSchemas.OrganizationRoleMemberPath,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => organizationRolesUnassign(context),
  }).register({
    name: AuthImplementedAction.AccessTokensList,
    method: HttpMethod.Get,
    path: "/v1/access-tokens",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AccessToken>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      accessTokensList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.AccessTokensCreate,
    method: HttpMethod.Post,
    path: "/v1/access-tokens",
    input: contractSchemas.AccessTokenCreate,
    output: contractSchemas.AccessTokenCreated,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => accessTokensCreate(context, input),
  }).register({
    name: AuthImplementedAction.AccessTokensRevoke,
    method: HttpMethod.Delete,
    explicitIdempotency: "key-and-if-match",
    path: "/v1/access-tokens/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => accessTokensRevoke(context),
  }).register({
    name: AuthImplementedAction.AccessBindingsList,
    method: HttpMethod.Get,
    path: "/v1/access-bindings",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AccessBinding>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      accessBindingsList(context, input, options.secret),
  }).register({
    name: AuthImplementedAction.AccessBindingsCreate,
    method: HttpMethod.Post,
    path: "/v1/access-bindings",
    input: contractSchemas.AccessBindingCreate,
    output: contractSchemas.AccessBinding,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => accessBindingsCreate(context, input),
  }).register({
    name: AuthImplementedAction.AccessBindingsDelete,
    method: HttpMethod.Delete,
    explicitIdempotency: "key-and-if-match",
    path: "/v1/access-bindings/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => accessBindingsDelete(context),
  }).register({
    name: AuthImplementedAction.InstallationAdministratorsCreate,
    method: HttpMethod.Post,
    path: "/v1/installation/administrators",
    input: contractSchemas.InstallationAdministratorCreate,
    output: contractSchemas.InstallationAdministrator,
    explicitIdempotency: "key",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: installationAdministratorsCreate,
  }).register({
    name: AuthImplementedAction.InstallationAdministratorsRevoke,
    method: HttpMethod.Delete,
    path: "/v1/installation/administrators/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.InstallationAdministrator,
    explicitIdempotency: "key-and-if-match",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.InstallationAdministrator,
      organizationContext:
        OrganizationContextPolicy.InstallationAdministratorScope,
    },
    handler: installationAdministratorsRevoke,
  }).register({
    name: AuthImplementedAction.InstallationStatus,
    method: HttpMethod.Get,
    path: "/v1/installation/status",
    input: contractSchemas.Empty,
    output: contractSchemas.InstallationStatus,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Public,
    },
    handler: (context, input) =>
      installationStatus(context, input, options.database),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationPreview,
    method: HttpMethod.Get,
    path: "/v1/invitations/:invitationId",
    input: contractSchemas.OrganizationInvitationPreviewGet,
    output: contractSchemas.OrganizationInvitationPreview,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Public,
    },
    handler: (context, input) =>
      organizationInvitationPreview(context, input, options.database, store),
  }).register({
    name: AuthImplementedAction.BrowserSessionsList,
    method: HttpMethod.Get,
    path: "/v1/me/sessions",
    input: contractSchemas.Empty,
    output: contractSchemas.BrowserSessionList,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: browserSessionsList,
  }).register({
    name: AuthImplementedAction.BrowserSessionsRevoke,
    method: HttpMethod.Delete,
    path: "/v1/me/sessions/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.BrowserSessionRevocation,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: browserSessionsRevoke,
  }).register({
    name: AuthImplementedAction.BrowserSessionsRevokeOthers,
    method: HttpMethod.Post,
    path: "/v1/me/sessions/revoke-others",
    input: contractSchemas.Empty,
    output: contractSchemas.BrowserSessionRevocationCount,
    successStatus: 200,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: browserSessionsRevokeOthers,
  }).register({
    name: AuthImplementedAction.ConnectedClientsList,
    method: HttpMethod.Get,
    path: "/v1/me/connected-clients",
    input: contractSchemas.Empty,
    output: contractSchemas.ConnectedClientList,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
      authorize: (context) => {
        requireHumanSelf(context);
      },
    },
    handler: connectedClientsList,
  }).register({
    name: AuthImplementedAction.ConnectedClientsRevoke,
    method: HttpMethod.Delete,
    path: "/v1/me/connected-clients/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.ConnectedClientRevocation,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Authenticated,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
      authorize: (context) => {
        requireHumanSelf(context);
      },
    },
    handler: connectedClientsRevoke,
  }).register({
    name: AuthImplementedAction.OrganizationsList,
    method: HttpMethod.Get,
    path: "/v1/organizations",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationAccess>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.AuthenticatedPrincipal,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: (context, input) => organizationsList(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationsCreate,
    method: HttpMethod.Post,
    path: "/v1/organizations",
    input: contractSchemas.OrganizationCreate,
    output: contractSchemas.Organization,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.AuthenticatedPrincipalAllowedToCreateOrganizations,
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
      authorize: authorizeOrganizationCreation,
    },
    handler: (context, input) => organizationsCreate(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationsGet,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Organization,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.OrganizationMember,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context) => organizationGet(context, store),
  }).register({
    name: AuthImplementedAction.OrganizationsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/organizations/:id",
    input: contractSchemas.OrganizationUpdate,
    output: contractSchemas.Organization,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationUpdate(context, input, store, availableLocales),
  }).register({
    name: AuthImplementedAction.OrganizationsEffectiveAccess,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/effective-access",
    input: contractSchemas.Empty,
    output: contractSchemas.EffectiveAccess,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.OrganizationMember,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context) => organizationEffectiveAccess(context, store),
  }).register({
    name: AuthImplementedAction.OrganizationMembershipsList,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/memberships",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationMembership>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.OrganizationMember,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationMembershipsList(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationMembershipsCreate,
    method: HttpMethod.Post,
    path: "/v1/organizations/:id/memberships",
    input: contractSchemas.OrganizationMembershipCreate,
    output: contractSchemas.OrganizationMembership,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationMembershipsCreate(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationMembershipsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/organizations/:id/memberships/:membershipId",
    input: contractSchemas.OrganizationMembershipUpdate,
    output: contractSchemas.OrganizationMembership,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationMembershipsUpdate(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationMembershipsDelete,
    method: HttpMethod.Delete,
    path: "/v1/organizations/:id/memberships/:membershipId",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context) => organizationMembershipsDelete(context, store),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationsList,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/invitations",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationInvitation>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationInvitationsList(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationsCreate,
    method: HttpMethod.Post,
    path: "/v1/organizations/:id/invitations",
    input: contractSchemas.OrganizationInvitationCreate,
    output: contractSchemas.OrganizationInvitation,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context, input) =>
      organizationInvitationsCreate(context, input, store),
  }).register({
    name: AuthImplementedAction.OrganizationInvitationsCancel,
    method: HttpMethod.Delete,
    path: "/v1/organizations/:id/invitations/:invitationId",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    naturalIdempotency: true,
    policy: {
      sessionOnly: true,
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: (context) => organizationInvitationsCancel(context, store),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, authImplementedActions);
  return registry;
}

export function createAuthV1Routes(
  options: AuthActionRegistryOptions & {
    auth: BrowserSessionAuth;
    store: IdentityStore & SessionStore;
    publicBaseUrl: string;
    trustedOrigins?: readonly string[];
    /** Registry shared with other transports; built from the options when absent. */
    registry?: ActionRegistry;
  },
) {
  const registry = options.registry ?? createAuthActionRegistry(options);

  const app = new Hono<{ Variables: AuthVariables }>();
  const browserSession = createBrowserSessionMiddleware({
    ...options,
    trustedOrigins: options.trustedOrigins ?? [options.publicBaseUrl],
    acceptAccessTokens: true,
  });
  app.use("/v1/me", browserSession);
  app.use("/v1/me/sessions", browserSession);
  app.use("/v1/me/sessions/*", browserSession);
  app.use("/v1/me/connected-clients", browserSession);
  app.use("/v1/me/connected-clients/*", browserSession);
  app.use("/v1/me/profile", browserSession);
  app.use("/v1/installation/settings", browserSession);
  app.use("/v1/installation/audit-events", browserSession);
  app.use("/v1/audit-events", browserSession);
  app.use("/v1/audit-events/export", browserSession);
  app.use("/v1/audit-retention", browserSession);
  app.use("/v1/scim-connection", browserSession);
  app.use("/v1/scim-connection/*", browserSession);
  app.use("/v1/installation/administrators", browserSession);
  app.use("/v1/installation/administrators/*", browserSession);
  app.use("/v1/user-preferences", browserSession);
  app.use("/v1/organizations", browserSession);
  app.use("/v1/organizations/*", browserSession);
  app.use("/v1/principals", browserSession);
  app.use("/v1/principals/*", browserSession);
  app.use("/v1/permission-grants", browserSession);
  app.use("/v1/permission-grants/*", browserSession);
  app.use("/v1/access-tokens", browserSession);
  app.use("/v1/access-tokens/*", browserSession);
  app.use("/v1/organization-roles", browserSession);
  app.use("/v1/organization-roles/*", browserSession);
  app.use("/v1/access-bindings", browserSession);
  app.use("/v1/access-bindings/*", browserSession);
  app.use("/api/auth/organization/get-invitation", browserSession);
  app.use("/api/auth/organization/accept-invitation", browserSession);
  app.use("/api/auth/organization/reject-invitation", browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
