/**
 * `@bakery/integration-sdk/provider` - the server tier (chapter 09 section 12.2).
 *
 * Imported by a provider package's `/server` entry, the two registries and the
 * rails. It must not reach the driver tier: no `pg`, no `inngest`, no `hono`, no
 * `node:` builtins, no `process.env` and no bare `fetch`, which rail B1 enforces.
 */
export {
  activatedProviders,
  activateProviders,
  defineServerProvider,
  isServerProvider,
  serverProviderDefects,
} from "./src/server-provider.ts";
export { IntegrationActivationError } from "./src/errors.ts";
export type { IntegrationDefect } from "./src/errors.ts";
export type {
  ActivatedProviders,
  CodeFor,
  ConnectFor,
  IngressFor,
  ProviderDefect,
  ServerImpl,
  ServerProvider,
  TicketsFor,
} from "./src/server-provider.ts";
export {
  IntegrationIdSchema,
  manifestDefects,
  ProviderFamilySchema,
  ProviderManifestSchema,
  ProviderSlugSchema,
  RESERVED_PROVIDER_SLUGS,
  ResourceKindSchema,
  servesFamily,
} from "./src/provider-manifest.ts";
export type {
  AppRegistration,
  ConnectKind,
  ProviderFamily,
  ProviderManifest,
  ResourceKind,
} from "./src/provider-manifest.ts";
export {
  credentialFieldAccepts,
  credentialFieldDefects,
  CredentialFieldSchema,
} from "./src/credential-fields.ts";
export type { CredentialField } from "./src/credential-fields.ts";
export { TICKET_ADMISSION_REFUSALS } from "./src/family-ports.ts";
export type {
  ChangeSnapshot,
  CheckSnapshot,
  CodePort,
  TicketAdmissionRefusal,
  TicketMutation,
  TicketPresentation,
  TicketSnapshot,
  TicketsPort,
} from "./src/family-ports.ts";
export type {
  ApiTokenProbe,
  ConnectStrategy,
  CredentialStrategy,
  IntakeIntent,
  OAuth2Profile,
  WebhookIngress,
} from "./src/strategies.ts";
export type {
  AuthorizationOutcome,
  DiscoveredResource,
  DriverContext,
  HealthProbe,
  Identity,
  InstallationLifecycle,
  InstallationOrigin,
  LifecycleEvent,
  ProviderRequestPort,
  ProviderSchema,
  ResourceDiscovery,
  SecretSlots,
  VerifiedAuthorization,
} from "./src/ports.ts";
