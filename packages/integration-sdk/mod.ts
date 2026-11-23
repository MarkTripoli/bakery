export {
  assertSchemaDescriptions,
  findSchemaDescriptionDefects,
  SchemaDescriptionError,
} from "./src/descriptions.ts";
export type { SchemaDescriptionDefect } from "./src/descriptions.ts";
export {
  graphqlBody,
  graphqlBodyCarriesDocument,
  isGraphqlRead,
  isStrictObject,
  MAX_RESPONSE_BYTES,
  parsePathTemplate,
  requestTemplateSchema,
} from "./src/request.ts";
export type { PathTemplate, RequestTemplate } from "./src/request.ts";
export {
  INTEGRATION_EVENT_TYPES,
  integrationManifestSchema,
  OptionalFeatureSchema,
} from "./src/manifest.ts";
export type { IntegrationManifest, OptionalFeature } from "./src/manifest.ts";
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  defineAction,
  isDefinedAction,
} from "./src/action.ts";
export type {
  ActionDefinition,
  ActionEffect,
  DefinedAction,
  ExactRef,
  PermissionLevel,
  ReconcileResult,
} from "./src/action.ts";
export {
  defineIntegration,
  isDefinedIntegration,
  SUPPORTED_SDK_VERSIONS,
  validateIntegration,
} from "./src/activation.ts";
export type {
  DefinedIntegration,
  IntegrationDefinitionInput,
  IntegrationHandlers,
  ValidationResult,
} from "./src/activation.ts";
export { deepFreeze } from "./src/context.ts";
export type { IntakeIntent, WebhookIngress } from "./src/strategies.ts";
export type {
  ActionContext,
  BakeryOperation,
  ReconciliationContext,
  RequestRef,
  ResourceProjection,
} from "./src/context.ts";
export {
  IntegrationActivationError,
  IntegrationContractError,
} from "./src/errors.ts";
export type { IntegrationDefect } from "./src/errors.ts";
export { COMPUTE_PROVIDERS, USAGE_RECORD_KINDS } from "./src/compute-port.ts";
export type {
  ComputeCostReport,
  ComputeEnvironment,
  ComputeOutputs,
  ComputePort,
  ComputeProvider,
  ComputeProvisionRequest,
  ComputeRunRequest,
  ComputeWorkspacePin,
  UsageRecordKind,
} from "./src/compute-port.ts";
