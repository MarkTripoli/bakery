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
  StorageFor,
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
  TicketTriggerSchema,
} from "./src/provider-manifest.ts";
export type {
  AppRegistration,
  ConnectKind,
  ProviderFamily,
  ProviderManifest,
  ResourceKind,
  TicketTrigger,
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
export {
  isStoragePath,
  MAX_STORAGE_CHANGES_PAGE,
  MAX_STORAGE_PAGE_SIZE,
  MAX_STORAGE_PATH_LENGTH,
  MAX_STORAGE_READ_BYTES,
  StorageChangeEventSchema,
  StorageChangesInputSchema,
  StorageChangesPageSchema,
  StorageListInputSchema,
  StorageListPageSchema,
  StorageObjectSchema,
  storageParentPath,
  StoragePathSchema,
  StorageReadInputSchema,
  StorageReadRangeSchema,
  StorageWriteInputSchema,
  StorageWriteResultSchema,
} from "./src/storage-port.ts";
export type {
  StorageChangeEvent,
  StorageChangesInput,
  StorageChangesPage,
  StorageListInput,
  StorageListPage,
  StorageObject,
  StoragePort,
  StorageReadInput,
  StorageReadRange,
  StorageReadResult,
  StorageWriteInput,
  StorageWriteResult,
} from "./src/storage-port.ts";
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
