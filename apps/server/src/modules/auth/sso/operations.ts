/**
 * Audit operations the SSO module records. Each is one row in
 * `bakery.audit_events` per successful mutation and none for a refused or
 * failed one. `details` carry identifiers and enum values only: never OIDC
 * client secrets, SAML private keys, assertions or domain-verification tokens.
 */
export const SSO_AUDIT_OPERATIONS = Object.freeze({
  providerCreate: "auth.sso.provider.create",
  providerUpdate: "auth.sso.provider.update",
  providerDelete: "auth.sso.provider.delete",
  domainVerify: "auth.sso.domain.verify",
  enforcementUpdate: "auth.sso.enforcement.update",
});

export const SSO_AUDIT_RESOURCE_TYPE = "sso_provider";
export const SSO_ENFORCEMENT_RESOURCE_TYPE = "organization_sso_settings";

/** Better Auth SSO routes that mutate provider state, mapped to the operation they record. */
export const SSO_PROVIDER_MUTATION_PATHS = Object.freeze(
  {
    "/sso/register": SSO_AUDIT_OPERATIONS.providerCreate,
    "/sso/update-provider": SSO_AUDIT_OPERATIONS.providerUpdate,
    "/sso/delete-provider": SSO_AUDIT_OPERATIONS.providerDelete,
    "/sso/verify-domain": SSO_AUDIT_OPERATIONS.domainVerify,
  } as const,
);

export type SsoProviderMutationPath = keyof typeof SSO_PROVIDER_MUTATION_PATHS;
