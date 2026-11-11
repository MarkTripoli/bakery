/**
 * Catalog actions the audit matrix (`tests/integration/audit-auth-mutations_test.ts`)
 * covers with a success case (exactly one row) and a failure case (no row).
 * The audit-coverage rail fails when an implemented auth-resource mutation in
 * the catalog is missing here, so a new mutation cannot ship unaudited.
 */
export const AUDIT_MATRIX_ACTIONS = [
  "organizations.create",
  "organizations.update",
  "organizationMemberships.create",
  "organizationMemberships.update",
  "organizationMemberships.delete",
  "organizationInvitations.create",
  "organizationInvitations.cancel",
  "organizationInvitations.recipientAccept",
  "organizationInvitations.recipientReject",
  "browserSessions.revoke",
  "browserSessions.revokeOthers",
  "connectedClients.revoke",
  "userPreferences.update",
  "installationSettings.update",
  "auditRetention.update",
  "scimConnection.create",
  "scimConnection.rotate",
  "scimConnection.revoke",
  "installationAdministrators.create",
  "installationAdministrators.revoke",
  "integrationAppRegistrations.begin",
  "integrationAppRegistrations.put",
  "skillStorageSettings.put",
  "skillStorageSettings.verify",
  "principals.create",
  "principals.update",
  "permissionGrants.create",
  "permissionGrants.delete",
  "accessTokens.create",
  "accessTokens.revoke",
  "accessBindings.create",
  "accessBindings.delete",
  "applicationRepositoryRoles.set",
  "organizationRoles.create",
  "organizationRoles.update",
  "organizationRoles.assign",
  "organizationRoles.unassign",
  "organizationRoles.delete",
] as const;

export type AuditMatrixAction = (typeof AUDIT_MATRIX_ACTIONS)[number];

/** Better Auth routes recorded by the credential audit plugin and account hook. */
export const AUDIT_MATRIX_CREDENTIAL_OPERATIONS = [
  "auth.password.change",
  "auth.passkey.add",
  "auth.passkey.delete",
  "auth.passkey.rename",
  "auth.twoFactor.enable",
  "auth.twoFactor.disable",
  "auth.twoFactor.regenerateBackupCodes",
] as const;

/**
 * Auth mutations served by Better Auth plugin endpoints rather than catalog
 * actions, so the catalog-driven coverage rail cannot see them. Each needs a
 * success case (exactly one row) and a failure case (no row) in the matrix and
 * is scanned for secrets. The SSO module declares the same set; its own test
 * fails when the two lists drift.
 */
export const AUDIT_MATRIX_PLUGIN_OPERATIONS = [
  "auth.sso.provider.create",
  "auth.sso.provider.update",
  "auth.sso.provider.delete",
  "auth.sso.domain.verify",
  "auth.sso.enforcement.update",
] as const;
