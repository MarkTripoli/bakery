import {
  CoordinatorTurnJobInputSchema,
  CoordinatorTurnJobOutputSchema,
} from "./coordinator-turn.ts";
import { z } from "zod";
import catalog from "../../../docs/technical-design/api-catalog.json" with {
  type: "json",
};
import transport from "../generated/transport-schemas.ts";
import {
  CatalogAccess,
  type CatalogAccessPolicy,
  type CatalogActionName,
  type CatalogPermissionKey,
  type ContractInputName,
  type ContractOutputName,
} from "./catalog-literals.ts";
import { implementedActions as implementedActionNames } from "./implemented-actions.ts";
import { descriptionDefectKind } from "./description-quality.ts";
import { CHECK_OBSERVATION_MAX_ITEMS } from "./check-evidence.ts";
import { REVIEW_LOOP_LIMITS } from "./review-evidence.ts";
import {
  type EffectiveRepositoryRuleEntry,
  EffectiveRepositoryRuleEntrySchema,
  freeText as repositoryRuleFreeText,
  type OrganizationRepositoryRuleEntry,
  OrganizationRepositoryRuleEntrySchema,
  REPOSITORY_RULE_KEYS,
  RepositoryRuleOverrideEntrySchema,
  type RepositoryRuleOverrides,
  type SupersededRepositoryRuleOverride,
  SupersededRepositoryRuleOverrideSchema,
} from "./repository-rules.ts";
import { ContractQualityError } from "./exceptions.ts";
import { assertWorkflowWorkerContract } from "./workflow-action-registry.ts";
import {
  RepositoryExecutionContextSchema,
  RepositoryInspectionJobInputSchema,
  RepositoryInspectionReportSchema,
  RepositoryProfileObservationPayloadSchema,
} from "./repository-inspection.ts";

import {
  type OutputBatch,
  OutputBatchSchema,
  type OutputPart,
  OutputPartSchema,
} from "./output.ts";
import {
  type SecretIdentityToolResult,
  SecretIdentityToolResultSchema,
} from "./secret-identity.ts";

type Schema = z.ZodType;
type JsonObject = Record<string, unknown>;
type Field = JsonObject & { name?: unknown; type?: unknown };
type Definition = JsonObject & { fields?: unknown };
type Node = JsonObject & { _def?: JsonObject; description?: unknown };
export type TransportSource = Readonly<Record<string, unknown>>;

export const ActionAccess = CatalogAccess;
export type ActionAccess = CatalogAccessPolicy;
export type {
  CatalogAccessPolicy,
  CatalogActionName,
  CatalogPermissionKey,
  ContractInputName,
  ContractOutputName,
} from "./catalog-literals.ts";
export {
  CatalogAccess,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_METADATA_BYTES,
  MAX_ARTIFACT_METADATA_DEPTH,
} from "./catalog-literals.ts";

/**
 * Branded identifiers. A value only becomes a `PrincipalId` or
 * `OrganizationId` through its constructor, which validates the UUID, so the
 * two cannot be swapped in a call and unvalidated strings cannot leak in.
 */
declare const idBrand: unique symbol;
export type PrincipalId = string & { readonly [idBrand]: "PrincipalId" };
export type OrganizationId = string & {
  readonly [idBrand]: "OrganizationId";
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
function brandedUuid<T extends string>(value: unknown, kind: string): T {
  if (!isUuid(value)) throw new TypeError(`${kind} must be a UUID`);
  return value.toLowerCase() as T;
}
export function principalId(value: unknown): PrincipalId {
  return brandedUuid<PrincipalId>(value, "PrincipalId");
}
export function organizationId(value: unknown): OrganizationId {
  return brandedUuid<OrganizationId>(value, "OrganizationId");
}
const catalogAccessValues = new Set<string>(catalog.accessPolicies);
export function isActionAccess(value: unknown): value is ActionAccess {
  return typeof value === "string" && catalogAccessValues.has(value);
}

export const PrincipalType = Object.freeze(
  {
    Human: "human",
    Service: "service",
    Worker: "worker",
  } as const,
);
export type PrincipalType = (typeof PrincipalType)[keyof typeof PrincipalType];
export function isPrincipalType(value: unknown): value is PrincipalType {
  return typeof value === "string" &&
    (Object.values(PrincipalType) as readonly string[]).includes(value);
}

export const OrganizationRole = Object.freeze(
  {
    Admin: "admin",
    Developer: "developer",
    Viewer: "viewer",
    Guest: "guest",
  } as const,
);
export type OrganizationRole =
  (typeof OrganizationRole)[keyof typeof OrganizationRole];
export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" &&
    (Object.values(OrganizationRole) as readonly string[]).includes(value);
}

export const MembershipStatus = Object.freeze(
  {
    Active: "active",
    Inactive: "inactive",
  } as const,
);
export type MembershipStatus =
  (typeof MembershipStatus)[keyof typeof MembershipStatus];
export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" &&
    (Object.values(MembershipStatus) as readonly string[]).includes(value);
}

export const OrganizationContextPolicy = Object.freeze(
  {
    None: "none",
    AuthenticatedPrincipalScope: "authenticated_principal_scope",
    RequiredAuthenticatedContext: "required_authenticated_context",
    InstallationAdministratorScope: "installation_administrator_scope",
    DerivedBoundAuthAttempt: "derived_bound_auth_attempt",
  } as const,
);
export type OrganizationContextPolicy =
  (typeof OrganizationContextPolicy)[keyof typeof OrganizationContextPolicy];
export function isOrganizationContextPolicy(
  value: unknown,
): value is OrganizationContextPolicy {
  return typeof value === "string" &&
    (Object.values(OrganizationContextPolicy) as readonly string[]).includes(
      value,
    );
}

export type CatalogAction = {
  group: string;
  method: string;
  path: string;
  action: CatalogActionName;
  access: CatalogAccessPolicy;
  permission: CatalogPermissionKey | null;
  resourceGuard?: string;
  input: ContractInputName;
  output: ContractOutputName;
  event: string;
  mcp: string | null;
  idempotency: string;
  idempotencyKeyOptional?: boolean;
  errors: string[];
  organizationContext?: OrganizationContextPolicy;
  organizationHeaderOptional?: boolean;
  organizationIdParam?: string;
};

function validCatalogAccess(value: unknown): value is string {
  return typeof value === "string" && catalogAccessValues.has(value);
}

const loadedCatalogActions = catalog.actions;
const permissionKeyPattern = /^[a-z][a-zA-Z]*:[a-z][a-zA-Z]*$/;
for (const [index, action] of loadedCatalogActions.entries()) {
  if (!validCatalogAccess(action.access)) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: invalid access ${action.access}`,
    );
  }
  if (
    action.permission !== null &&
    (typeof action.permission !== "string" ||
      !permissionKeyPattern.test(action.permission))
  ) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: invalid permission ${action.permission}`,
    );
  }
  const resourceGuard = "resourceGuard" in action
    ? action.resourceGuard
    : undefined;
  if (
    resourceGuard !== undefined &&
    (typeof resourceGuard !== "string" ||
      !/^[a-z][a-zA-Z]*$/.test(resourceGuard))
  ) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: invalid resource guard ${resourceGuard}`,
    );
  }
  const organizationContext = "organizationContext" in action
    ? action.organizationContext
    : OrganizationContextPolicy.None;
  if (!isOrganizationContextPolicy(organizationContext)) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: invalid organization context ${organizationContext}`,
    );
  }
  const organizationHeaderOptional = "organizationHeaderOptional" in action
    ? action.organizationHeaderOptional
    : undefined;
  if (
    organizationHeaderOptional !== undefined &&
    (typeof organizationHeaderOptional !== "boolean" ||
      (organizationHeaderOptional &&
        organizationContext !==
          OrganizationContextPolicy.RequiredAuthenticatedContext))
  ) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: organizationHeaderOptional requires a required authenticated context action`,
    );
  }
  const organizationIdParam = "organizationIdParam" in action
    ? action.organizationIdParam
    : undefined;
  if (
    organizationIdParam !== undefined &&
    (typeof organizationIdParam !== "string" ||
      !routeParameterNames(action.path).includes(organizationIdParam) ||
      organizationContext !==
        OrganizationContextPolicy.RequiredAuthenticatedContext)
  ) {
    throw new ContractQualityError(
      `inventory action ${index} ${action.action}: organizationIdParam must name a route parameter of a required authenticated context action`,
    );
  }
}
export const catalogActions = loadedCatalogActions as readonly CatalogAction[];

const catalogActionNames = new Set<string>(
  catalogActions.map(({ action }) => action),
);
export function isCatalogActionName(
  value: unknown,
): value is CatalogActionName {
  return typeof value === "string" && catalogActionNames.has(value);
}

export function normalizeRoutePath(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:([A-Za-z0-9_]+)/g, ":param");
}

export function routeParameterNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)|\{([^}]+)\}/g)].map(
    ([, colonName, braceName]) => colonName ?? braceName,
  );
}

const denied = new Set([
  "ciphertext",
  "leaseTokenHash",
  "rawProviderPayload",
  "resumeHandle",
]);
const bigintMax = 9223372036854775807n;
const strictObjects = new WeakSet<object>();
const binarySchemas = new WeakSet<object>();
const serializedJsonSchemas = new WeakSet<object>();
const uuidSchemas = new WeakSet<object>();
export function isUuidContractSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  if (
    uuidSchemas.has(schema) ||
    schema instanceof z.ZodUUID ||
    (schema instanceof z.ZodString && schema.format === "uuid")
  ) {
    return true;
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional
  ) {
    return isUuidContractSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options;
    return options.length === 2 &&
      options.some((option) => option instanceof z.ZodNull) &&
      options.some((option) =>
        !(option instanceof z.ZodNull) && isUuidContractSchema(option)
      );
  }
  return false;
}
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
const opaqueChildren = new WeakSet<object>();
/** Fields whose wire type is the strict, typed organization rule entry list. */
const repositoryRuleEntryPaths = new Set([
  "RepositoryRuleVersionCreate.entries",
  "RepositoryRulePreviewOrganizationCreate.entries",
  "OrganizationRepositoryRuleVersion.entries",
  "OrganizationRepositoryRulesRead.entries",
]);
const REPOSITORY_RULE_ENTRY_LIMIT = REPOSITORY_RULE_KEYS.length;
const record = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const title = (name: string) =>
  name.replace(/(^|[_-])(\w)/g, (_, __, c: string) => c.toUpperCase());

function schemaDescription(
  value: unknown,
  path: string,
  _type: string,
): string {
  if (!text(value)) {
    throw new ContractQualityError(`missing schema description at ${path}`);
  }
  return value;
}
function described<T extends Schema>(schema: T, description: string): T {
  if (!text(description)) {
    throw new ContractQualityError("schema description must be non-empty");
  }
  const result = schema.describe(description);
  if (strictObjects.has(schema)) strictObjects.add(result);
  if (opaqueChildren.has(schema)) opaqueChildren.add(result);
  if (binarySchemas.has(schema)) markBinary(result);
  if (serializedJsonSchemas.has(schema)) serializedJsonSchemas.add(result);
  return result;
}

function optionalSchema<T extends Schema>(schema: T, fallback: string): T {
  const result = described(
    schema.optional(),
    text(schema.description) ? schema.description : fallback,
  ) as unknown as T;
  if (uuidSchemas.has(schema)) uuidSchemas.add(result);
  return result;
}

function markBinary<T extends Schema>(schema: T): T {
  binarySchemas.add(schema);
  z.globalRegistry.add(schema, {
    ...(text(schema.description) ? { description: schema.description } : {}),
    type: "string",
    format: "binary",
  });
  return schema;
}

function strictObject(shape: Record<string, Schema>): Schema {
  const schema = z.object(shape).strict().describe(
    "Strict object schema used by a Bakery contract builder.",
  );
  strictObjects.add(schema);
  return schema;
}
function createJsonValueNode(): z.ZodType<JsonValue> {
  const value: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
      z.string().describe("JSON string value."),
      z.number().describe("JSON number value."),
      z.boolean().describe("JSON boolean value."),
      z.null().describe("JSON null value."),
      z.array(value).describe("JSON array value."),
      z.record(
        z.string().describe("JSON object key."),
        value,
      ).describe("JSON object value."),
    ]).describe("JSON value node.")
  ).describe("JSON value node.");
  return value;
}
// Anonymous recursive Zod definitions are positional. Keep new harness JSON
// metadata on a named definition so existing contract references do not move.
const stableJsonValueNode = createJsonValueNode();
z.globalRegistry.add(stableJsonValueNode, {
  id: "harnessJsonValue",
  description: "JSON value node.",
});
function jsonValue(description: string): Schema {
  const schema = described(createJsonValueNode(), description);
  serializedJsonSchemas.add(schema);
  return schema;
}
function stableJsonValue(): Schema {
  serializedJsonSchemas.add(stableJsonValueNode);
  return stableJsonValueNode;
}

export const BillingConfigSchema = z.object({
  provider: z.string().min(1).max(200).describe(
    "Provider selected for billing.",
  ),
  billingAccountId: z.string().min(1).max(200).describe(
    "Immutable provider billing account selected for execution.",
  ),
  model: z.string().min(1).max(200).describe("Model selected for billing."),
  billingRoute: z.enum(["api", "subscription"]).describe(
    "Billing route used for execution.",
  ),
  maxTokens: z.number().int().min(1).max(200000).describe(
    "Maximum tokens reserved for one execution.",
  ),
  maxUsdReservation: z.number().min(0).max(1000).describe(
    "Maximum US-dollar reservation for one execution.",
  ),
  pricingMetadataSnapshot: z.string().min(1).max(32000).describe(
    "Immutable pricing metadata captured for settlement.",
  ),
}).strict().describe(
  "Bounded billing policy copied into an immutable agent version.",
);
export type BillingConfig = z.infer<typeof BillingConfigSchema>;

function generatedWorkerActionCapabilityNames(): readonly string[] {
  const actions = record(transport.workerActions)
    ? transport.workerActions as JsonObject
    : {};
  const capabilities = new Set<string>();
  for (const definition of Object.values(actions)) {
    if (
      !record(definition) || !Array.isArray(definition.capabilities) ||
      definition.capabilities.some((capability) => !text(capability))
    ) {
      throw new ContractQualityError(
        "worker action capabilities must be non-empty strings",
      );
    }
    for (const capability of definition.capabilities) {
      capabilities.add(capability as string);
    }
  }
  return Object.freeze([...capabilities].sort());
}

/** Closed execution-capability vocabulary declared by generated worker actions. */
export const workerActionCapabilityNames =
  generatedWorkerActionCapabilityNames();
const workerActionCapabilitySet = new Set(workerActionCapabilityNames);

const AgentCapabilitySchema = z.string().min(1).max(200).refine(
  (capability) => workerActionCapabilitySet.has(capability),
  { error: "Capability is not declared by a registered worker action." },
).describe(
  "Execution capability declared by at least one registered worker action.",
);

const AgentAllowedCapabilitiesSchema = z.array(AgentCapabilitySchema).max(100)
  .superRefine((capabilities, context) => {
    const seen = new Set<string>();
    for (const [index, capability] of capabilities.entries()) {
      if (seen.has(capability)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Capability names must be unique.",
        });
      }
      seen.add(capability);
    }
  }).describe(
    "Unique execution capabilities available to this agent version.",
  );

export const AgentVersionCreateConfigSchema = z.object({
  harness: z.enum(["pi", "claude_code", "codex", "mastra"]).describe(
    "Execution harness selected for this agent version.",
  ),
  billing: BillingConfigSchema.optional().describe(
    "Optional model billing policy for this agent version.",
  ),
  allowedCapabilities: AgentAllowedCapabilitiesSchema.optional().describe(
    "Optional unique capabilities from the registered worker-action vocabulary.",
  ),
  promptBindings: z.record(
    z.string().min(1).describe("Prompt binding name."),
    z.string().min(1).describe("Immutable prompt version identifier."),
  ).optional().describe(
    "Validated prompt bindings owned by this agent version.",
  ),
  skillBindings: z.record(
    z.string().min(1).describe("Skill binding name."),
    z.string().min(1).describe("Immutable skill version identifier."),
  ).optional().describe(
    "Validated skill bindings owned by this agent version.",
  ),
}).strict().describe(
  "Immutable agent execution configuration accepted by the AgentVersionCreate transport.",
);
export type AgentVersionCreateConfig = z.infer<
  typeof AgentVersionCreateConfigSchema
>;

export function serializedJsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("value is not JSON serializable");
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function byteLength(value: unknown, serializedJson = false): number {
  if (serializedJson) return serializedJsonByteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(encoded ?? "").length;
}

function bounded<T extends Schema>(
  schema: T,
  bounds: JsonObject,
  path: string,
): T {
  let result: Schema = schema;
  const kind = (result as unknown as Node)._def?.type;
  if (kind === "nullable" || kind === "optional") {
    const inner = (result as unknown as Node)._def?.innerType as Schema;
    const boundedInner = bounded(inner, bounds, path);
    return kind === "nullable"
      ? nullableSchema(boundedInner, `${path} may be null.`) as unknown as T
      : optionalSchema(boundedInner, `${path} may be omitted.`) as unknown as T;
  }
  const boundedKind = kind === "nullable" || kind === "optional"
    ? ((result as unknown as Node)._def?.innerType as Node)?._def?.type
    : kind;
  if (boundedKind === "string" && typeof bounds.minLength === "number") {
    result = described(
      (result as z.ZodString).min(bounds.minLength),
      `${path} must contain at least ${bounds.minLength} characters.`,
    );
  }
  if (boundedKind === "string" && typeof bounds.maxLength === "number") {
    result = described(
      (result as z.ZodString).max(bounds.maxLength),
      `${path} must contain at most ${bounds.maxLength} characters.`,
    );
  }
  const lowerBytes = typeof bounds.minBytes === "number"
    ? bounds.minBytes
    : undefined;
  const upperBytes = typeof bounds.maxBytes === "number"
    ? bounds.maxBytes
    : undefined;
  if (lowerBytes !== undefined || upperBytes !== undefined) {
    const wasOpaque = opaqueChildren.has(result);
    const wasBinary = binarySchemas.has(result);
    const wasSerializedJson = serializedJsonSchemas.has(result);
    const refined = result.refine((value) =>
      (lowerBytes === undefined ||
        byteLength(value, wasSerializedJson) >= lowerBytes) &&
      (upperBytes === undefined ||
        byteLength(value, wasSerializedJson) <= upperBytes)
    );
    if (wasOpaque) opaqueChildren.add(refined);
    if (wasBinary) markBinary(refined);
    if (wasSerializedJson) serializedJsonSchemas.add(refined);
    z.globalRegistry.add(refined, {
      ...(lowerBytes === undefined ? {} : { "x-utf8-min-bytes": lowerBytes }),
      ...(upperBytes === undefined ? {} : { "x-utf8-max-bytes": upperBytes }),
    });
    result = described(
      refined,
      lowerBytes !== undefined && upperBytes !== undefined
        ? `${path} must contain between ${lowerBytes} and ${upperBytes} UTF-8 bytes.`
        : lowerBytes !== undefined
        ? `${path} must contain at least ${lowerBytes} UTF-8 bytes.`
        : `${path} must contain at most ${upperBytes} UTF-8 bytes.`,
    );
  }
  if (boundedKind === "array" && typeof bounds.minItems === "number") {
    result = described(
      (result as z.ZodArray).min(bounds.minItems),
      `${path} must contain at least ${bounds.minItems} items.`,
    );
  }
  if (boundedKind === "array" && typeof bounds.maxItems === "number") {
    result = described(
      (result as z.ZodArray).max(bounds.maxItems),
      `${path} must contain at most ${bounds.maxItems} items.`,
    );
  }
  if (
    boundedKind === "array" &&
    bounds.uniqueItems === true
  ) {
    result = described(
      (result as z.ZodArray).refine(
        (items) => new Set(items).size === items.length,
        `${path} must contain unique items.`,
      ),
      `${path} must contain unique items.`,
    );
  }
  if (
    boundedKind === "number" &&
    typeof bounds.min === "number"
  ) {
    result = described(
      (result as z.ZodNumber).min(bounds.min),
      `${path} must be at least ${bounds.min}.`,
    );
  }
  if (
    boundedKind === "number" &&
    typeof bounds.max === "number"
  ) {
    result = described(
      (result as z.ZodNumber).max(bounds.max),
      `${path} must be at most ${bounds.max}.`,
    );
  }
  return result as T;
}

export const MEDIA_TYPE_MAX_LENGTH = 255;
export const MEDIA_TYPE_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*;[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*=[ \t]*(?:"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"|[!#$%&'*+\-.^_`|~0-9A-Za-z]+))?)*$/;

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) && code !== 43 && code !== 47
    ) return false;
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function namedFormat(base: string): Schema | undefined {
  switch (base) {
    case "string":
      return described(
        z.string().max(65536),
        "UTF-8 text value bounded for transport safety.",
      );
    case "nonBlankString":
      return described(
        z.string().regex(
          /\S/,
          "Text must contain at least one non-whitespace character.",
        ),
        "UTF-8 text value containing at least one non-whitespace character.",
      );
    case "repositorySlug":
      return described(
        z.string().regex(
          /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/,
          "Repository slugs must use lowercase ASCII letters, digits, and internal hyphens.",
        ),
        "Canonical repository slug; never normalized or derived from provider identity.",
      );
    case "slug":
      return described(
        z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(100),
        "Lowercase identifier with separators.",
      );
    case "mediaType":
      return described(
        z.string().regex(MEDIA_TYPE_PATTERN).max(MEDIA_TYPE_MAX_LENGTH),
        "HTTP-safe MIME media type value.",
      );
    case "bytes":
      return markBinary(described(
        z.any().refine(
          (value): value is Uint8Array => value instanceof Uint8Array,
          "Binary content must be normalized bytes.",
        ),
        "Normalized binary content supplied as bytes.",
      ));
    case "gitSha":
      return described(
        z.string().regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/),
        "Git commit identifier.",
      );
    case "secretAction":
      return z.literal("identity.read").describe(
        "Only supported GitHub credential-use operation; not a metadata action grant.",
      );
    case "secretName":
      return z.string().min(1).max(200).regex(
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
        "Secret name uses safe display characters.",
      ).describe(
        "Bounded credential label; request-specific credential echoes are rejected before storage.",
      );
    case "githubLogin":
      return z.string().min(1).max(39).regex(
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
        "Invalid provider identity.",
      ).describe(
        "Bounded GitHub login selected from authenticated user verification.",
      );
    case "projectCredential":
      return z.string().min(1).max(4096).refine(
        (value) =>
          Array.from(value).every((character) => {
            const code = character.charCodeAt(0);
            return code > 32 && (code < 127 || code > 159);
          }),
        "Invalid credential format.",
      ).describe(
        "Write-only credential, no control characters or whitespace; at most 4096 UTF-8 bytes.",
      );
    case "secretString":
      return described(
        z.string().min(1).max(65536),
        "Non-empty secret string value.",
      );
    case "decimalString":
      return described(
        z.string().regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
          try {
            return BigInt(value) <= bigintMax;
          } catch {
            return false;
          }
        }),
        "Non-negative decimal integer string.",
      );
    case "decimal":
      return described(
        z.string().regex(/^-?(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/),
        "Bounded decimal string.",
      );
    case "httpRange":
      return described(
        z.string().regex(/^bytes=(?:\d+-\d*|-\d+)$/).max(200),
        "HTTP byte range value, including suffix ranges.",
      );
    case "relativePath":
    case "safeRelativePath":
      return described(
        z.string().min(1).max(65536).refine((value) =>
          !value.startsWith("/") && !value.includes("\\") &&
          !value.includes("\0") && !value.split("/").some((part) =>
            part === "." || part === ".." || part === ""
          )
        ),
        "Safe relative path value.",
      );
    case "uri":
      return described(z.string().url(), "Absolute URI value.");
    case "base64":
      return described(
        z.string().refine(isBase64),
        "Base64-encoded value.",
      );
    case "jsonSchema":
      return jsonValue("JSON Schema document for a registered contract.");
    case "actionName":
      return described(
        z.enum(catalogActions.map((action) => action.action) as [
          string,
          ...string[],
        ]),
        "Exact action name declared by the Bakery API catalog.",
      );
    case "permissionKey":
      return described(
        z.enum(
          [
            ...new Set(
              catalogActions.flatMap((action) =>
                action.permission === null ? [] : [action.permission]
              ),
            ),
          ] as [CatalogPermissionKey, ...CatalogPermissionKey[]],
        ),
        "Exact permission key declared by the Bakery API catalog.",
      );
    default:
      return undefined;
  }
}
function artifactReferenceSchema(path: string): Schema {
  return described(
    strictObject({
      artifactId: described(
        z.string().uuid(),
        `${path}.artifactId immutable artifact identifier.`,
      ),
      versionId: described(
        z.string().uuid(),
        `${path}.versionId immutable artifact-version identifier.`,
      ),
      sha256: described(
        z.string().regex(/^[0-9a-f]{64}$/),
        `${path}.sha256 lowercase content digest.`,
      ),
    }),
    `${path} immutable artifact version reference.`,
  );
}
function harnessCheckpointSchema(path: string): Schema {
  return described(
    strictObject({
      schemaVersion: described(
        z.literal(1),
        `${path}.schemaVersion checkpoint metadata version.`,
      ),
      repositoryId: described(
        z.string().min(1).max(512),
        `${path}.repositoryId repository identity.`,
      ),
      agentSessionId: described(
        z.string().min(1).max(512),
        `${path}.agentSessionId Bakery agent session identity.`,
      ),
      nativeSessionId: described(
        z.string().min(1).max(512),
        `${path}.nativeSessionId native harness session identity, kept apart from Bakery sessionId references.`,
      ),
      checkpointToken: described(
        z.string().min(1).max(1024),
        `${path}.checkpointToken opaque resume token.`,
      ),
      worktreeRevision: described(
        z.string().min(1).max(512),
        `${path}.worktreeRevision repository revision.`,
      ),
      harnessVersion: optionalSchema(
        described(
          z.string().min(1).max(128),
          `${path}.harnessVersion first line of the pinned harness CLI --version that wrote the checkpoint; resume across a different version, or from a checkpoint that lacks it, starts fresh.`,
        ),
        `${path}.harnessVersion optional harness CLI version.`,
      ),
      sessionFile: described(
        z.string().min(1).max(1024),
        `${path}.sessionFile retained session file path.`,
      ),
      sessionFileSha256: described(
        z.string().regex(/^[0-9a-f]{64}$/),
        `${path}.sessionFileSha256 retained session digest.`,
      ),
      eligible: described(
        z.literal(true),
        `${path}.eligible checkpoint is eligible for resume.`,
      ),
      resumeEligible: described(
        z.literal(true),
        `${path}.resumeEligible session is eligible for resume.`,
      ),
      checkpointEligible: described(
        z.literal(true),
        `${path}.checkpointEligible checkpoint proof is eligible.`,
      ),
    }),
    `${path} verified harness resume checkpoint.`,
  );
}

function primitive(
  type: string,
  path: string,
  field: Field,
  source: JsonObject,
  stack: string[],
): Schema {
  const nullable = type.includes("|null") || field.nullable === true;
  const optional = type.includes("?");
  let base = type.replace(/(?:\|null|\?)/g, "");
  const embedded: JsonObject = {};
  const length = base.match(/^string<=(\d+)bytes$/);
  if (length) {
    base = "string";
    embedded.maxBytes = Number(length[1]);
  }
  const range = base.match(/^number([[(])(.*?),(.*?)([\])])$/);
  const exclusiveMin = range?.[1] === "(";
  const exclusiveMax = range?.[4] === ")";
  if (range) {
    base = "number";
    embedded.min = Number(range[2]);
    embedded.max = Number(range[3]);
  }
  let schema: Schema | undefined;
  const literal = base.match(
    /^literal\((true|false|null|[-\d.]+|[A-Za-z][A-Za-z0-9_-]*)\)$/,
  );
  if (literal) {
    const value = literal[1] === "true"
      ? true
      : literal[1] === "false"
      ? false
      : literal[1] === "null"
      ? null
      : /^[-\d.]+$/.test(literal[1])
      ? Number(literal[1])
      : literal[1];
    schema = z.literal(value);
  } else if (base.startsWith("enum(") && base.endsWith(")[]")) {
    schema = z.array(
      primitive(
        base.slice(0, -2),
        `${path}[]`,
        {
          description: text(field.description)
            ? `${field.description} Each array item follows this format.`
            : undefined,
        },
        source,
        stack,
      ),
    );
  } else if (
    base === "enum" || base.startsWith("enum(") || Array.isArray(field.enum)
  ) {
    const values = base.startsWith("enum(")
      ? base.slice(5, -1).split("|")
      : field.enum;
    if (
      !Array.isArray(values) || values.length === 0 ||
      values.some((value) => typeof value !== "string")
    ) throw new Error(`malformed enum at ${path}`);
    schema = z.enum(values as [string, ...string[]]);
  } else if (base.includes("|") && !base.includes("/")) {
    const values = base.split("|");
    if (values.length < 2 || values.some((value) => !text(value))) {
      throw new Error(`malformed union at ${path}`);
    }
    schema = z.enum(values as [string, ...string[]]);
  } else if (base.endsWith("[]")) {
    schema = z.array(
      primitive(
        base.slice(0, -2),
        `${path}[]`,
        {
          description: text(field.description)
            ? `${field.description} Each array item follows this format.`
            : undefined,
        },
        source,
        stack,
      ),
    );
  } else if (base === "array") {
    schema = z.array(jsonValue(`${path} item JSON value.`));
  } else if (base === "object") {
    schema = z.record(
      described(z.string(), `${path} object key.`),
      jsonValue(`${path} object value.`),
    );
  } else if (base === "uuid") schema = z.string().uuid();
  else if (base === "sha256") schema = z.string().regex(/^[a-f0-9]{64}$/i);
  else if (base === "timestamp" || base === "timestamptz") {
    schema = z.string().datetime({ offset: true });
  } else if (base === "integer") schema = z.number().int().finite();
  else if (base === "positiveInteger") {
    schema = z.number().int().positive().finite();
  } else if (base === "nonnegativeInteger") {
    schema = z.number().int().nonnegative().finite();
  } else if (base === "number") schema = z.number().finite();
  else if (base === "boolean") schema = z.boolean();
  else if (base === "json") {
    const stable = path === "HarnessOutput.events[]" ||
      path === "HarnessOutput.telemetry";
    schema = stable
      ? stableJsonValue()
      : jsonValue(`${path} bounded JSON value.`);
  } else if (base === "ArtifactRef") schema = artifactReferenceSchema(path);
  else if (base === "HarnessCheckpoint") {
    schema = harnessCheckpointSchema(path);
  } else if (base === "BillingConfig" && own(source.inputs as object, base)) {
    schema = buildInput(
      base,
      (source.inputs as JsonObject)[base],
      source,
      stack.concat(base),
    );
  } else if (base === "BillingConfig") {
    schema = jsonValue(`${path} validated billing configuration.`);
  } else if (
    own(source.inputs as object, base) ||
    own(source.outputs as object, base) ||
    own(source.projections as object, base)
  ) {
    schema = resolveNamed(base, source, stack.concat(base));
  } else schema = namedFormat(base);
  if (path === "JobAssignment.action" && record(source.workerActions)) {
    schema = z.enum(Object.keys(source.workerActions) as [string, ...string[]]);
  } else if (
    path.endsWith(".action") && !Array.isArray(field.enum) &&
    base !== "enum" && !base.startsWith("enum(")
  ) {
    schema = z.enum([
      "rpi.design",
      "harness.implement",
      "harness.repair",
      "quality.check",
      "quality.review",
      "delivery.commit",
    ]);
  }
  if (path === "JobAssignment.input" && record(source.workerActions)) {
    const inputs = Object.values(source.workerActions).flatMap((action) => {
      if (!record(action)) return [];
      if (text(action.inputSchema)) {
        const input = resolveNamed(action.inputSchema, source, stack);
        return [
          action.inputSchema === "RepositoryInspectionInput"
            ? input
            : withRepositoryContext(input),
        ];
      }
      if (!record(action.inputFields)) return [];
      const shape: Record<string, Schema> = {};
      for (const [field, type] of Object.entries(action.inputFields)) {
        shape[field] = primitive(
          String(type),
          `${path}.${field}`,
          { description: `Registered action input ${field}.` },
          source,
          stack,
        );
      }
      return [
        described(
          withRepositoryContext(strictObject(shape)),
          "Input schema registered for a worker action.",
        ),
      ];
    });
    if (inputs.length < 2) {
      throw new Error("worker action input registry is incomplete");
    }
    schema = z.union(inputs as [Schema, Schema, ...Schema[]]);
  }
  if (path === "AgentVersionCreate.config") {
    schema = AgentVersionCreateConfigSchema;
  }
  if (repositoryRuleEntryPaths.has(path)) {
    schema = z.array(OrganizationRepositoryRuleEntrySchema).max(
      REPOSITORY_RULE_ENTRY_LIMIT,
    );
  }
  if (path === "RepositoryRulePreviewSample.commitMessages") {
    schema = z.array(
      repositoryRuleFreeText(
        z.string().max(2000).describe(
          "One sample commit message of at most 2000 characters.",
        ),
      ),
    ).max(20);
  }
  if (path === "RepositoryRulePreviewSample.pullRequestTitle") {
    schema = repositoryRuleFreeText(
      z.string().max(300).describe(
        "Sample change request title of at most 300 characters.",
      ),
    );
  }
  if (path === "RepositoryRulePreviewSample.pullRequestDescription") {
    schema = repositoryRuleFreeText(
      z.string().max(8000).describe(
        "Sample change request description of at most 8000 characters.",
      ),
    );
  }
  if (path === "RepositoryRulePreviewRepositoryCreate.overrides") {
    // Duplicate keys are checked by the handler (UNPROCESSABLE, like profile
    // publication), so the wire schema is the strict list without uniqueness.
    schema = z.object({
      entries: z.array(RepositoryRuleOverrideEntrySchema).max(
        REPOSITORY_RULE_ENTRY_LIMIT,
      ).describe("Proposed repository entries, at most one per rule key."),
    }).strict().describe("Proposed repository rule overrides.");
  }
  if (
    path === "RepositoryEffectiveRules.entries" ||
    path === "RepositoryRulePreviewEffective.entries"
  ) {
    schema = z.array(EffectiveRepositoryRuleEntrySchema).max(
      REPOSITORY_RULE_ENTRY_LIMIT,
    );
  }
  if (
    path === "RepositoryEffectiveRules.supersededOverrides" ||
    path === "RepositoryRulePreviewEffective.supersededOverrides"
  ) {
    schema = z.array(SupersededRepositoryRuleOverrideSchema).max(
      REPOSITORY_RULE_ENTRY_LIMIT,
    );
  }
  if (!schema && own(source.inputs as object, base)) {
    if (stack.includes(base)) {
      throw new Error(`cyclic schema reference at ${path}: ${base}`);
    }
    schema = buildInput(
      base,
      (source.inputs as JsonObject)[base],
      source,
      stack.concat(base),
    );
  }
  if (!schema && own(source.outputs as object, base)) {
    if (stack.includes(base)) {
      throw new Error(`cyclic schema reference at ${path}: ${base}`);
    }
    schema = buildOutput(
      base,
      (source.outputs as JsonObject)[base],
      source,
      stack.concat(base),
    );
  }
  if (!schema && base === "AssignedActionOutput") {
    schema = assignedActionOutput();
  }
  if (!schema && actionOutputTypes.has(base)) schema = actionOutput(base);
  if (!schema) {
    throw new Error(`unsupported inventory type at ${path}: ${type}`);
  }
  if (schema !== stableJsonValueNode) {
    schema = described(
      schema,
      schemaDescription(field.description, path, type),
    );
  }
  if (path === "AgentVersionCreate.config") opaqueChildren.add(schema);
  schema = bounded(schema, {
    ...embedded,
    ...(record(field.bounds) ? field.bounds : {}),
  }, path);
  if (base === "decimalString" && record(field.bounds)) {
    const lower = typeof field.bounds.min === "number"
      ? BigInt(field.bounds.min)
      : undefined;
    const upper = typeof field.bounds.max === "number"
      ? BigInt(field.bounds.max)
      : undefined;
    if (lower !== undefined || upper !== undefined) {
      const refined = schema.refine((value) => {
        try {
          const parsed = BigInt(value as string);
          return (lower === undefined || parsed >= lower) &&
            (upper === undefined || parsed <= upper);
        } catch {
          return false;
        }
      });
      z.globalRegistry.add(refined, {
        ...(lower === undefined ? {} : { "x-bigint-minimum": String(lower) }),
        ...(upper === undefined ? {} : { "x-bigint-maximum": String(upper) }),
      });
      schema = described(refined, `${path} is a bounded decimal string.`);
    }
  }
  if (exclusiveMin && typeof embedded.min === "number") {
    schema = described(
      (schema as z.ZodNumber).gt(embedded.min),
      `${path} must be greater than ${embedded.min}.`,
    );
  }
  if (exclusiveMax && typeof embedded.max === "number") {
    schema = described(
      (schema as z.ZodNumber).lt(embedded.max),
      `${path} must be less than ${embedded.max}.`,
    );
  }
  if (nullable) {
    schema = nullableSchema(
      schema,
      `${path} may be null in this transport value.`,
    );
  }
  if (optional) {
    schema = optionalSchema(schema, `${path} may be omitted.`);
  }
  if (base === "uuid") uuidSchemas.add(schema);
  return schema;
}

function nullableSchema<T extends Schema>(
  schema: T,
  description: string,
  nullDescription = "Null indicates that the value is unavailable.",
): T {
  const result = described(
    z.union([
      schema,
      z.null().describe(nullDescription),
    ]),
    description,
  ) as unknown as T;
  if (uuidSchemas.has(schema)) uuidSchemas.add(result);
  return result;
}

function fieldList(definition: Definition, name: string): Field[] {
  if (!Array.isArray(definition.fields)) {
    throw new Error(`malformed schema definition: ${name}`);
  }
  return definition.fields.map((field) => {
    if (
      text(field) && record(definition.fieldTypes) &&
      text(definition.fieldTypes[field])
    ) {
      return {
        name: field,
        type: definition.fieldTypes[field],
        description: record(definition.fieldDescriptions)
          ? definition.fieldDescriptions[field]
          : undefined,
      };
    }
    if (!record(field) || !text(field.name) || !text(field.type)) {
      throw new Error(`malformed field in ${name}`);
    }
    return field as Field;
  });
}

function definitionBounds(definition: Definition, field: string): JsonObject {
  const bounds: JsonObject = {};
  const source = record(definition.bounds) ? definition.bounds : {};
  for (const [key, value] of Object.entries(source)) {
    if (key === `${field}MaxBytes`) bounds.maxBytes = value;
    if (key === `${field}MinBytes`) bounds.minBytes = value;
    if (key === `${field}MaxItems`) bounds.maxItems = value;
    if (key === `${field}MinItems`) bounds.minItems = value;
  }
  return bounds;
}

function withRepositoryContext(input: Schema): Schema {
  if (!(input instanceof z.ZodObject)) {
    throw new Error("worker action input must be an object");
  }
  return input.safeExtend({
    repositoryProfile: RepositoryExecutionContextSchema.optional().describe(
      "Server-admitted immutable execution context; absent for standalone inspection and cloud-only jobs.",
    ),
  }).describe(
    input.description ??
      "Registered worker action input with authorized repository context.",
  );
}

function workerActionInputSchema(
  actionName: string,
  source: JsonObject,
): Schema | undefined {
  if (!record(source.workerActions)) return undefined;
  const action = (source.workerActions as JsonObject)[actionName];
  if (!record(action)) return undefined;
  if (text(action.inputSchema)) {
    const input = resolveNamed(action.inputSchema, source, []);
    return action.inputSchema === "RepositoryInspectionInput"
      ? input
      : withRepositoryContext(input);
  }
  if (record(action.inputFields)) {
    const fields: Record<string, Schema> = {};
    for (const [field, type] of Object.entries(action.inputFields)) {
      fields[field] = primitive(
        String(type),
        `workerActions.${actionName}.input.${field}`,
        {
          description: `Registered action input ${field}.`,
        },
        source,
        [],
      );
    }
    return described(
      withRepositoryContext(strictObject(fields)),
      `Input schema registered for worker action ${actionName}.`,
    );
  }
  return undefined;
}

function refineJobAssignment(schema: Schema, source: JsonObject): Schema {
  if (!record(source.workerActions)) return schema;
  return schema.superRefine((value, context) => {
    const assignment = value as JsonObject;
    const actionName = assignment.action as string;
    const action = (source.workerActions as JsonObject)[actionName];
    if (!record(action)) {
      context.addIssue({
        code: "custom",
        message: "unregistered worker action",
      });
      return;
    }
    const expectedInput = workerActionInputSchema(actionName, source);
    if (!expectedInput?.safeParse(assignment.input).success) {
      context.addIssue({
        code: "custom",
        path: ["input"],
        message: "input does not match the registered action schema",
      });
    }
    if (
      Array.isArray(action.capabilities) &&
      action.capabilities.includes("model")
    ) {
      for (
        const field of [
          "agentVersionId",
          "billing",
          "installationReservationId",
        ]
      ) {
        if (assignment[field] === null || assignment[field] === undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is required for model actions`,
          });
        }
      }
    }
  });
}

const jobAssignmentPayloadFieldNames = [
  "action",
  "requirements",
  "input",
  "currentCheckpoints",
  "agentConfig",
  "skillRefs",
  "agentVersionId",
  "billing",
  "installationReservationId",
] as const;

function buildJobAssignmentPayloadSchema(source: JsonObject): Schema {
  if (!record(source.outputs)) {
    throw new Error("malformed transport source");
  }
  const definition = source.outputs.JobAssignment;
  const assignmentSchema = projection("JobAssignment", definition, source);
  if (!(assignmentSchema instanceof z.ZodObject)) {
    throw new Error("JobAssignment projection must be an object");
  }
  const assignmentShape = assignmentSchema.shape;
  const payloadShape = Object.fromEntries(
    jobAssignmentPayloadFieldNames.map((
      field,
    ) => [field, assignmentShape[field]]),
  ) as Record<string, Schema>;
  return refineJobAssignment(
    described(
      strictObject(payloadShape),
      "Strict persisted assignment payload before lease and secret preparation.",
    ),
    source,
  ).describe(
    "Registered-action assignment payload shape; validation does not prove funding or authorization.",
  );
}

function fieldsSchema(
  name: string,
  definition: Definition,
  source: JsonObject,
  stack: string[],
): Schema {
  const shape: Record<string, Schema> = {};
  for (const field of fieldList(definition, name)) {
    const fieldName = field.name as string;
    const bounds = definitionBounds(definition, fieldName);
    let schema = primitive(
      field.type as string,
      `${name}.${fieldName}`,
      {
        ...field,
        ...(Object.keys(bounds).length
          ? {
            bounds: {
              ...(record(field.bounds) ? field.bounds : {}),
              ...bounds,
            },
          }
          : {}),
      },
      source,
      stack,
    );
    if (field.required === false) {
      schema = optionalSchema(
        schema,
        `${name}.${fieldName} may be omitted.`,
      );
    }
    if (
      name === "SecretCreate" &&
      (fieldName === "allowedPrincipalIds" || fieldName === "allowedActions")
    ) {
      schema = schema.default([]).describe(
        "Creation grant defaults canonicalize omission to no permitted use.",
      ).optional().describe(
        "Default-deny creation grants; omission canonicalizes to an empty list before fingerprinting.",
      );
    }
    shape[fieldName] = schema;
  }
  let result: Schema = strictObject(shape);
  if (name === "JobAssignment") {
    result = refineJobAssignment(result, source);
  }
  return described(
    result,
    schemaDescription(definition.description, name, "object"),
  );
}

const actionSpecs: Record<
  string,
  {
    fields: Record<string, string>;
    bounds?: Record<string, JsonObject>;
    /** What a field means; generated bounds text is appended, never substituted. */
    meanings?: Record<string, string>;
  }
> = {
  ArtifactOutput: { fields: { artifact: "ArtifactRef" } },
  ResearchOutput: {
    fields: { artifact: "ArtifactRef", repositoryRevision: "string" },
    bounds: { repositoryRevision: { minLength: 1 } },
    meanings: {
      artifact:
        "Immutable research artifact the step published; the design step reads it.",
      repositoryRevision:
        "Full commit SHA of the repository revision the research read, so a later reader knows what the findings describe.",
    },
  },
  CandidateEvidence: {
    fields: {
      headSha: "string",
      baseSha: "string",
      policyDigest: "string",
      checksPassed: "boolean",
      checkRunIds: "uuid[]",
      failedCheckIds: "uuid[]",
      blockingFindings: "integer",
      reviewId: "uuid",
      findings: "Finding[]",
    },
    bounds: {
      headSha: { minLength: 1 },
      baseSha: { minLength: 1 },
      policyDigest: { minLength: 1 },
      checkRunIds: { minItems: 1, maxItems: CHECK_OBSERVATION_MAX_ITEMS },
      failedCheckIds: { maxItems: CHECK_OBSERVATION_MAX_ITEMS },
      blockingFindings: { min: 0, max: REVIEW_LOOP_LIMITS.maxFindings },
      findings: { maxItems: REVIEW_LOOP_LIMITS.maxFindings },
    },
    meanings: {
      headSha:
        "Full commit SHA of the candidate the checks ran on and the review judged.",
      baseSha:
        "Base commit SHA pinned by the inspected repository profile, as the checks and the review reported it.",
      policyDigest:
        "Digest of the effective policy the checks ran under, as the check step reported it.",
      checksPassed:
        "True only when every required check passed, taken from the check step's allRequired.",
      checkRunIds:
        "Identifiers of the recorded check runs of this candidate, in input order, which the delivery gate can cite.",
      failedCheckIds:
        "Identifiers of the required check runs that did not pass; empty when checksPassed is true.",
      blockingFindings:
        "Count of review findings with severity blocker or major, taken from the review step; a merge requires zero.",
      reviewId:
        "Identifier of the independent review cycle that judged this candidate.",
      findings:
        "Structured findings from that review in severity order; empty for a clean review.",
    },
  },
  PrepareOutput: {
    fields: {
      releaseId: "string",
      artifactDigest: "string",
      environment: "string",
      status: "literal(prepared)",
    },
    bounds: {
      releaseId: { minLength: 1 },
      artifactDigest: { minLength: 1 },
      environment: { minLength: 1 },
    },
    meanings: {
      releaseId:
        "Identifier of the prepared release; the deploy step takes it as its input.",
      artifactDigest:
        "Digest of the release artifact that was prepared, so a deploy can prove it rolls out the same bytes.",
      environment: "Environment the release was prepared for.",
      status: "Always prepared: a failed prepare fails the step instead.",
    },
  },
  MergeOutput: {
    fields: {
      commitSha: "string",
      providerEffectId: "string",
      status: "literal(confirmed)",
    },
    bounds: {
      commitSha: { minLength: 1 },
      providerEffectId: { minLength: 1 },
    },
    meanings: {
      commitSha:
        "Full commit SHA of the merge commit the provider confirmed; the prepare step builds exactly this commit.",
      providerEffectId:
        "Identifier of the provider-side merge effect, kept so the merge can be reconciled later.",
      status:
        "Always confirmed: an uncertain merge is reconciled before the step finishes, never reported as done.",
    },
  },
  DeployOutput: {
    fields: {
      deploymentId: "uuid",
      commitSha: "string",
      status: "enum(accepted|queued|deploying)",
      providerEffectId: "string",
    },
    bounds: {
      commitSha: { minLength: 1 },
      providerEffectId: { minLength: 1 },
    },
    meanings: {
      deploymentId:
        "Identifier of the deployment the provider accepted; the health step observes it.",
      commitSha: "Full commit SHA the deployment rolls out.",
      status:
        "How far the provider has taken the deployment when the step returns; health, not this status, decides whether it is good.",
      providerEffectId:
        "Identifier of the provider-side deploy effect, kept so the deploy can be reconciled later.",
    },
  },
  HealthOutput: {
    fields: {
      deploymentId: "uuid",
      status: "enum(healthy|degraded|failed)",
      checkedAt: "timestamp",
      evidenceArtifact: "ArtifactRef",
    },
    meanings: {
      deploymentId: "Deployment whose health was observed.",
      status:
        "Observed health; only healthy lets a delivery count as released.",
      checkedAt: "When the health observation was taken.",
      evidenceArtifact:
        "Immutable artifact holding the evidence the observation is based on.",
    },
  },
  HarnessOutput: {
    fields: {
      headSha: "string",
      baseSha: "string",
      sessionId: "uuid",
      checkpoint: "HarnessCheckpoint?",
      piVersion: "string|null?",
      codexVersion: "string|null?",
      artifacts: "ArtifactRef[]",
      claudeCodeVersion: "string|null?",
      model: "string|null?",
      capabilities: "string[]?",
      events: "json[]?",
      telemetry: "json?",
    },
    bounds: { headSha: { minLength: 1 }, baseSha: { minLength: 1 } },
  },
  CheckOutput: {
    fields: {
      allRequired: "boolean",
      checkRunIds: "uuid[]",
      failedCheckIds: "uuid[]",
      observations: "CheckObservation[]",
      headSha: "string",
      baseSha: "string",
      policyDigest: "string",
    },
    bounds: {
      checkRunIds: { minItems: 1, maxItems: CHECK_OBSERVATION_MAX_ITEMS },
      failedCheckIds: { maxItems: CHECK_OBSERVATION_MAX_ITEMS },
      observations: { minItems: 1, maxItems: CHECK_OBSERVATION_MAX_ITEMS },
      headSha: { minLength: 1 },
      baseSha: { minLength: 1 },
      policyDigest: { minLength: 1 },
    },
    meanings: {
      allRequired:
        "True only when every required command of the fixed policy passed. The worker reports it and the server recomputes it from the verified observations, rejecting a report that disagrees, so a worker's claim never establishes a pass.",
      checkRunIds:
        "Identifiers of the reported observations in input order; each becomes the id of one recorded check run row and must be unique and never replayed.",
      failedCheckIds:
        "Identifiers (checkRunId) of the required observations that did not pass, whether failed, unavailable or canceled, in input order; empty when every required command passed.",
      observations:
        "One observation per selected fixed command, in input order. The worker reports what each process did; the server verifies the set against its own admission pins before it writes any row.",
      headSha:
        "Full commit SHA the checks ran against; the server requires it to equal the revision admitted for the job.",
      baseSha:
        "Base commit SHA pinned by the inspected repository profile; the server requires it to equal its own pin.",
      policyDigest:
        "Digest of the effective policy the checks ran under (fixed policy, trusted checker and rule entries); the server recomputes it from its pins and rejects a mismatch.",
    },
  },
  ReviewOutput: {
    fields: {
      reviewId: "uuid",
      sessionId: "uuid",
      headSha: "string",
      baseSha: "string",
      policyDigest: "string",
      findings: "Finding[]",
      blockingFindings: "integer",
    },
    bounds: {
      headSha: { minLength: 1 },
      baseSha: { minLength: 1 },
      policyDigest: { minLength: 1 },
      findings: { maxItems: REVIEW_LOOP_LIMITS.maxFindings },
      blockingFindings: { min: 0, max: REVIEW_LOOP_LIMITS.maxFindings },
    },
    meanings: {
      reviewId:
        "Identifier the reviewer generated for this review; it becomes the id of the recorded review cycle and must never repeat.",
      sessionId:
        "Agent session the reviewer ran in. The server created it when it admitted the review step and requires the report to name exactly that session, so a review cannot claim another session's identity.",
      headSha:
        "Full commit SHA the reviewer judged; the server requires it to equal the revision admitted for the job and the run's current candidate.",
      baseSha:
        "Base commit SHA pinned by the inspected repository profile; the server requires it to equal its own pin.",
      policyDigest:
        "Digest of the effective policy the review ran under; the server recomputes it from its pins and rejects a mismatch.",
      findings:
        "Structured findings in severity order, blocker first, each with a stable fingerprint; fingerprints are unique within the report. The server rejects a report whose blocking flags disagree with severities, or whose serialized size exceeds the review result byte budget.",
      blockingFindings:
        "Count of findings with severity blocker or major. The server recomputes it from the findings and rejects a report that disagrees, so the worker's count never establishes an approval.",
    },
  },
  FreeformOutput: {
    fields: {
      sessionId: "uuid",
      artifacts: "ArtifactRef[]",
      status: "enum(completed|failed|canceled|timed_out)",
    },
  },
};
const actionOutputTypes = new Set(Object.keys(actionSpecs));

function actionOutput(name: string): Schema {
  const spec = actionSpecs[name];
  if (!spec) throw new Error(`unsupported worker action output: ${name}`);
  const shape: Record<string, Schema> = {};
  for (const [field, type] of Object.entries(spec.fields)) {
    const optional = type.endsWith("?");
    const fieldType = optional ? type.slice(0, -1) : type;
    const meaning = spec.meanings?.[field];
    let schema = bounded(
      described(
        primitive(
          fieldType,
          `${name}.${field}`,
          { description: `${name}.${field} emitted by the worker action.` },
          transport as unknown as JsonObject,
          [],
        ),
        meaning ?? `${name}.${field} output.`,
      ),
      spec.bounds?.[field] ?? {},
      `${name}.${field}`,
    );
    // `bounded` states only the bound; keep what the field means in front of it.
    if (meaning !== undefined && schema.description !== meaning) {
      schema = described(schema, `${meaning} ${schema.description}`);
    }
    if (optional) {
      schema = schema.optional().describe(
        `${name}.${field} output may be omitted by adapters that do not expose it.`,
      );
    }
    shape[field] = schema;
  }
  return described(
    strictObject(shape),
    `${name} is the pinned worker action output contract.`,
  );
}

function assignedActionOutput(): Schema {
  const workerActions = record(transport.workerActions)
    ? transport.workerActions as JsonObject
    : {};
  const namedOutputs = new Set<string>();
  const schemas = Object.entries(workerActions).flatMap(
    ([action, definition]) => {
      if (record(definition) && text(definition.outputSchema)) {
        if (namedOutputs.has(definition.outputSchema)) return [];
        namedOutputs.add(definition.outputSchema);
      }
      return [workerActionOutputSchema(action)];
    },
  );
  if (schemas.length < 2) {
    throw new Error("worker action registry has too few output schemas");
  }
  return described(
    z.union(schemas as [Schema, Schema, ...Schema[]]),
    "The output schema pinned to the worker action for this attempt.",
  );
}
export function workerActionOutputSchema(action: string): z.ZodType {
  if (action === "secret.identity.read") {
    return SecretIdentityToolResultSchema;
  }
  const workerActions = record(transport.workerActions)
    ? transport.workerActions as JsonObject
    : {};
  const definition = workerActions[action];
  if (!record(definition)) {
    throw new Error(`unsupported worker action: ${action}`);
  }
  if (text(definition.outputSchema)) {
    const outputName = definition.outputSchema;
    if (actionOutputTypes.has(outputName)) return actionOutput(outputName);
    return resolveNamed(outputName, transport as unknown as JsonObject, []);
  }
  if (record(definition.outputFields)) {
    const shape: Record<string, Schema> = {};
    for (const [field, type] of Object.entries(definition.outputFields)) {
      shape[field] = eventPrimitive(
        String(type),
        `workerActions.${action}.output.${field}`,
      );
    }
    return described(
      strictObject(shape),
      `Output schema registered for worker action ${action}.`,
    );
  }
  throw new Error(`worker action ${action} has no output schema`);
}

/** True when the action's registered output names a server-created agent session. */
export function workerActionOutputCarriesSession(action: string): boolean {
  try {
    const schema = workerActionOutputSchema(action);
    return schema instanceof z.ZodObject &&
      Object.hasOwn(schema.shape, "sessionId");
  } catch {
    return false;
  }
}

/** Resolve the registered input contract without fabricating an assignment envelope. */
export function registeredWorkerActionInputSchema(action: string): z.ZodType {
  const actions = record(transport.workerActions)
    ? transport.workerActions as JsonObject
    : {};
  const definition = actions[action];
  if (!record(definition)) {
    throw new Error(`unsupported worker action: ${action}`);
  }
  if (text(definition.inputSchema)) {
    return resolveNamed(
      definition.inputSchema,
      transport as unknown as JsonObject,
      [],
    );
  }
  if (record(definition.inputFields)) {
    const shape: Record<string, Schema> = {};
    for (const [field, type] of Object.entries(definition.inputFields)) {
      shape[field] = eventPrimitive(
        String(type),
        `workerActions.${action}.input.${field}`,
      );
    }
    return described(
      strictObject(shape),
      `Input schema registered for worker action ${action}.`,
    );
  }
  throw new Error(`worker action ${action} has no input schema`);
}

export function workerActionCapabilities(action: string): readonly string[] {
  const actions = record(transport.workerActions)
    ? transport.workerActions as JsonObject
    : {};
  const definition = actions[action];
  if (
    !record(definition) || !Array.isArray(definition.capabilities) ||
    definition.capabilities.some((capability) => !text(capability))
  ) {
    throw new Error(`unsupported worker action capabilities: ${action}`);
  }
  assertWorkflowWorkerContract(action, definition);
  return Object.freeze([...(definition.capabilities as string[])]);
}

function eventPrimitive(type: string, path: string): Schema {
  const nullable = type.endsWith("|null");
  const withoutNullable = nullable ? type.slice(0, -5) : type;
  const array = /^(.+)\[\]<=(\d+)$/.exec(withoutNullable);
  let schema: Schema;
  if (array) {
    schema = z.array(eventPrimitive(array[1], `${path}[]`)).max(
      Number(array[2]),
    ).describe(`${path} array.`);
  } else if (/^string<=\d+$/.test(withoutNullable)) {
    const limit = Number(withoutNullable.slice("string<=".length));
    schema = z.string().max(limit).describe(`${path} string.`);
  } else if (/^number[[(].*[\])]$/.test(withoutNullable)) {
    const range = /^number([[(])(.*?),(.*?)([\])])$/.exec(withoutNullable);
    if (!range) throw new Error(`malformed event number at ${path}`);
    const min = Number(range[2]);
    const max = Number(range[3]);
    const lower = range[1] === "["
      ? z.number().gte(min).describe(`${path} lower-bounded number.`)
      : z.number().gt(min).describe(`${path} lower-bounded number.`);
    const bounded = range[4] === "]" ? lower.lte(max) : lower.lt(max);
    schema = bounded.describe(`${path} bounded number.`);
  } else if (withoutNullable.startsWith("enum(")) {
    const values = withoutNullable.slice(5, -1).split("|");
    schema = z.enum(values as [string, ...string[]]).describe(
      `${path} enumerated value.`,
    );
  } else if (withoutNullable.startsWith("literal(")) {
    const literal = withoutNullable.slice(8, -1);
    const value = literal === "true"
      ? true
      : literal === "false"
      ? false
      : literal === "null"
      ? null
      : literal;
    schema = z.literal(value).describe(`${path} literal.`);
  } else if (withoutNullable === "string") {
    schema = z.string().describe(`${path} string.`);
  } else if (withoutNullable === "uuid") {
    schema = z.string().uuid().describe(`${path} UUID.`);
  } else if (withoutNullable === "decimalString") {
    schema = z.string().regex(/^(0|[1-9]\d*)$/).describe(
      `${path} nonnegative decimal integer string.`,
    );
  } else if (withoutNullable === "sha256") {
    schema = z.string().regex(/^[a-f0-9]{64}$/i).describe(`${path} SHA-256.`);
  } else if (withoutNullable === "timestamp") {
    schema = z.string().datetime({ offset: true }).describe(
      `${path} timestamp.`,
    );
  } else if (withoutNullable === "integer") {
    schema = z.number().int().finite().describe(`${path} integer.`);
  } else if (withoutNullable === "boolean") {
    schema = z.boolean().describe(`${path} boolean.`);
  } else if (withoutNullable === "json") {
    schema = jsonValue(`${path} JSON value.`);
  } else {
    throw new Error(
      `unsupported event schema type at ${path}: ${withoutNullable}`,
    );
  }
  return nullable
    ? z.union([schema, z.null().describe(`${path} null.`)]).describe(
      `${path} nullable value.`,
    )
    : schema;
}

const domainEventPayloadSchemas = new Map<string, Schema>();
export function domainEventPayloadSchema(
  eventType: string,
): z.ZodType | null {
  const cached = domainEventPayloadSchemas.get(eventType);
  if (cached) return cached;
  const events = record(transport.events) ? transport.events as JsonObject : {};
  const definition = events[eventType];
  if (!record(definition) || !record(definition.payloadFields)) return null;
  const shape: Record<string, Schema> = {};
  for (const [field, type] of Object.entries(definition.payloadFields)) {
    shape[field] = eventPrimitive(
      String(type),
      `events.${eventType}.${field}`,
    );
  }
  const schema = described(
    strictObject(shape),
    `Payload schema for canonical domain event ${eventType}.`,
  );
  domainEventPayloadSchemas.set(eventType, schema);
  return schema;
}

function variantsSchema(
  name: string,
  definition: Definition,
  source: JsonObject,
  stack: string[],
): Schema {
  const rawVariants = Array.isArray(definition.variants)
    ? definition.variants.map((value) =>
      [record(value) ? value.status : undefined, value] as const
    )
    : Object.entries(record(definition.variants) ? definition.variants : {});
  if (
    rawVariants.length < 2 ||
    rawVariants.some(([tag, value]) => !text(tag) || !record(value))
  ) throw new Error(`malformed variants: ${name}`);
  const baseFields = Array.isArray(definition.fields)
    ? fieldList(definition, name)
    : [];
  const baseByName = new Map(
    baseFields.map((field) => [field.name as string, field]),
  );
  const variants = rawVariants.map(([tag, value]) => {
    const variant = value as JsonObject;
    const shape: Record<string, Schema> = {};
    for (const field of baseFields) {
      if (field.name !== "status") {
        shape[field.name as string] = primitive(
          field.type as string,
          `${name}.${tag}.${field.name}`,
          field,
          source,
          stack,
        );
      }
    }
    const fields = Array.isArray(variant.fields)
      ? variant.fields
      : Object.entries(variant).filter(([key]) =>
        ![
          "status",
          "required",
          "forbidden",
          "resultSchema",
          "faultSchema",
          "cancellationSchema",
        ].includes(key)
      );
    for (const item of fields) {
      const fieldName = Array.isArray(item)
        ? item[0]
        : record(item)
        ? item.name
        : undefined;
      const fieldType = Array.isArray(item)
        ? record(item[1]) ? item[1].type : item[1]
        : record(item)
        ? item.type
        : undefined;
      if (!text(fieldName) || !text(fieldType)) {
        throw new Error(`malformed variant field in ${name}.${tag}`);
      }
      const variantField = Array.isArray(item)
        ? record(item[1]) ? item[1] : {}
        : record(item)
        ? item
        : {};
      shape[fieldName] = fieldName === "kind" && fieldType === tag
        ? described(z.literal(tag), `${name}.${tag} discriminator.`)
        : primitive(
          fieldType,
          `${name}.${tag}.${fieldName}`,
          {
            ...(baseByName.get(fieldName) ?? {}),
            ...variantField,
          },
          source,
          stack,
        );
    }
    const required = Array.isArray(variant.required)
      ? variant.required
      : Object.keys(shape).filter((field) => field !== "status");
    for (const field of required) {
      if (!text(field)) {
        throw new Error(`malformed required field in ${name}.${tag}`);
      }
      const schemaName = field === "result"
        ? variant.resultSchema
        : field === "fault"
        ? variant.faultSchema
        : field === "cancellation"
        ? variant.cancellationSchema
        : undefined;
      if (typeof schemaName === "string") {
        shape[field] = primitive(
          schemaName,
          `${name}.${tag}.${field}`,
          baseByName.get(field) ?? {},
          source,
          stack,
        );
      } else if (record(schemaName)) {
        const nested: Record<string, Schema> = {};
        for (const [nestedName, nestedType] of Object.entries(schemaName)) {
          nested[nestedName] = primitive(
            String(nestedType),
            `${name}.${tag}.${field}.${nestedName}`,
            {
              description: text(baseByName.get(field)?.description)
                ? `${
                  baseByName.get(field)?.description
                } Nested field ${nestedName}.`
                : undefined,
            },
            source,
            stack,
          );
        }
        shape[field] = described(
          strictObject(nested),
          `${name}.${tag}.${field} payload.`,
        );
      }
    }
    if (
      baseByName.has("status") || own(variant, "status") ||
      Array.isArray(definition.variants)
    ) {
      shape.status = described(
        z.literal(tag as string),
        `${name}.${tag} discriminator.`,
      );
    }
    for (
      const field of Array.isArray(variant.forbidden) ? variant.forbidden : []
    ) if (text(field)) delete shape[field];
    const baseRequired = new Set(
      baseFields.filter((field) => field.required !== false).map((field) =>
        field.name as string
      ),
    );
    for (const field of Object.keys(shape)) {
      if (
        !baseRequired.has(field) && !required.includes(field) &&
        field !== "status"
      ) {
        shape[field] = optionalSchema(
          shape[field],
          `${name}.${tag}.${field} may be omitted.`,
        );
      }
    }
    let variantSchema: Schema = strictObject(shape);
    if (tag === "image") {
      variantSchema = variantSchema.refine((value) => {
        const image = value as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        return image.x + image.width <= 1 && image.y + image.height <= 1;
      });
    }
    if (name === "RepositoryBindingResolution" && tag === "ambiguous") {
      variantSchema = variantSchema.refine(
        (value) => {
          const resolution = value as {
            candidates: { repositoryId: string }[];
            truncated: boolean;
          };
          return new Set(resolution.candidates.map((item) => item.repositoryId))
                .size ===
              resolution.candidates.length &&
            (!resolution.truncated || resolution.candidates.length === 32);
        },
        "Ambiguity requires distinct repositories; overflow exposes exactly 32 candidates.",
      )
        .describe("Bounded ambiguity over distinct authorized repositories.");
    }
    return described(variantSchema, `${name} ${tag} variant.`);
  });
  let schema: Schema = z.union(
    variants as unknown as [Schema, Schema, ...Schema[]],
  ).describe("Validated union of the declared contract variants.");
  if (
    record(definition.bounds) && typeof definition.bounds.maxBytes === "number"
  ) schema = bounded(schema, { maxBytes: definition.bounds.maxBytes }, name);
  return described(
    schema,
    schemaDescription(definition.description, name, "variant union"),
  );
}

function oneOfSchema(
  name: string,
  definition: Definition,
  source: JsonObject,
  stack: string[],
): Schema {
  if (
    !Array.isArray(definition.oneOf) ||
    definition.oneOf.length < 2 ||
    definition.oneOf.some((variant) =>
      !record(variant) || !Array.isArray(variant.fields)
    )
  ) {
    throw new Error(`malformed input union: ${name}`);
  }
  const variants = definition.oneOf.map((variant, index) => {
    const variantDefinition = variant as JsonObject;
    return fieldsSchema(
      `${name} variant ${index + 1}`,
      {
        ...variantDefinition,
        description: text(variantDefinition.description)
          ? variantDefinition.description
          : `${name} variant ${index + 1}.`,
      },
      source,
      stack,
    );
  });
  return described(
    z.union(variants as [Schema, Schema, ...Schema[]]),
    schemaDescription(definition.description, name, "input union"),
  );
}

function buildInput(
  name: string,
  definition: unknown,
  source: JsonObject,
  stack: string[] = [name],
): Schema {
  if (!record(definition)) {
    throw new Error(`malformed input definition: ${name}`);
  }
  if (name === "RepositoryInspectionInput") {
    return RepositoryInspectionJobInputSchema;
  }
  if (name === "CoordinatorTurnInput") return CoordinatorTurnJobInputSchema;
  if (name === "RunCreate") {
    const refined = fieldsSchema(name, definition, source, stack).refine(
      (value) => {
        const run = value as JsonObject;
        return [run.workflowVersionId, run.presetId, run.workflowId]
          .filter((selector) => selector !== undefined).length === 1;
      },
      "Exactly one of workflowVersionId, presetId and workflowId is required.",
    );
    strictObjects.add(refined);
    return described(
      refined,
      schemaDescription(definition.description, name, "object"),
    );
  }
  return definition.oneOf
    ? oneOfSchema(name, definition, source, stack)
    : definition.variants
    ? variantsSchema(name, definition, source, stack)
    : fieldsSchema(name, definition, source, stack);
}

function resolveNamed(
  name: string,
  source: JsonObject,
  stack: string[],
): Schema {
  if (own(source.inputs as object, name)) {
    return buildInput(
      name,
      (source.inputs as JsonObject)[name],
      source,
      stack.concat(name),
    );
  }
  if (own(source.outputs as object, name)) {
    return buildOutput(
      name,
      (source.outputs as JsonObject)[name],
      source,
      stack.concat(name),
    );
  }
  if (own(source.projections as object, name)) {
    return projection(name, (source.projections as JsonObject)[name], source);
  }
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  if (own(source.projections as object, singular)) {
    return projection(
      singular,
      (source.projections as JsonObject)[singular],
      source,
    );
  }
  if (actionOutputTypes.has(name)) return actionOutput(name);
  throw new Error(`missing named schema: ${name}`);
}

function projection(
  name: string,
  definition: unknown,
  source: JsonObject,
): Schema {
  if (
    !record(definition) || !Array.isArray(definition.fields) ||
    !record(definition.fieldTypes)
  ) throw new Error(`malformed projection: ${name}`);
  const shape: Record<string, Schema> = {};
  for (const field of definition.fields) {
    if (!text(field) || denied.has(field)) {
      throw new Error(
        `unsafe or malformed output field at projections.${name}`,
      );
    }
    const type = definition.fieldTypes[field];
    if (!text(type)) {
      throw new Error(`missing output type at projections.${name}.${field}`);
    }
    const fieldBounds = record(definition.fieldBounds) &&
        record(definition.fieldBounds[field])
      ? definition.fieldBounds[field]
      : record(definition.bounds) && record(definition.bounds[field])
      ? definition.bounds[field]
      : definitionBounds(definition, field);
    const fieldDescription = record(definition.fieldDescriptions)
      ? definition.fieldDescriptions[field]
      : undefined;
    let schema = primitive(
      type,
      `${name}.${field}`,
      {
        description: fieldDescription,
        ...(Object.keys(fieldBounds).length ? { bounds: fieldBounds } : {}),
      },
      source,
      [],
    );
    if (
      Array.isArray(definition.optionalFields) &&
      definition.optionalFields.includes(field)
    ) schema = optionalSchema(schema, `${name}.${field} may be omitted.`);
    if (
      Array.isArray(definition.nullableFields) &&
      definition.nullableFields.includes(field) && !type.includes("|null")
    ) {
      schema = nullableSchema(
        schema,
        `${name}.${field} may be null in the safe projection.`,
        "Null indicates that the projected value is unavailable.",
      );
    }
    shape[field] = schema;
  }
  return described(
    strictObject(shape),
    schemaDescription(definition.description, name, "safe projection"),
  );
}

function pageSchema(
  name: string,
  definition: JsonObject,
  source: JsonObject,
  stack: string[],
): Schema {
  if (!text(definition.pageOf)) throw new Error(`malformed page: ${name}`);
  const item = definition.pageOf;
  const envelope = record(source.pageEnvelope) ? source.pageEnvelope : {};
  const shape: Record<string, Schema> = {
    items: bounded(
      described(
        z.array(resolveNamed(item, source, stack)),
        `${item} items in this cursor page.`,
      ),
      { maxItems: 100 },
      `${name}.items`,
    ),
    nextCursor: nullableSchema(
      described(z.string().max(512), "Opaque continuation cursor value."),
      "Opaque continuation cursor, or null at the end.",
      "Null indicates that no continuation page remains.",
    ),
  };
  for (const field of fieldList(envelope, "pageEnvelope")) {
    const fieldName = field.name as string;
    if (fieldName === "items" || fieldName === "nextCursor") continue;
    let child = primitive(
      field.type as string,
      `${name}.${fieldName}`,
      field,
      source,
      stack,
    );
    const bounds = definitionBounds(envelope, fieldName);
    if (Object.keys(bounds).length) {
      child = bounded(child, bounds, `${name}.${fieldName}`);
    }
    if (field.required === false) {
      child = optionalSchema(child, `${name}.${fieldName} may be omitted.`);
    }
    shape[fieldName] = child;
  }
  return described(strictObject(shape), `Cursor page of ${item}.`);
}

function buildOutput(
  name: string,
  definition: unknown,
  source: JsonObject,
  stack: string[] = [name],
): Schema {
  if (!record(definition)) {
    throw new Error(`unsupported output definition: ${name}`);
  }
  if (name === "RepositoryProfileObservationPayload") {
    return RepositoryProfileObservationPayloadSchema;
  }
  if (name === "OutputBatch") return OutputBatchSchema;
  if (name === "OutputPart") return OutputPartSchema;
  if (name === "RepositoryInspectionReport") {
    return RepositoryInspectionReportSchema;
  }
  if (name === "CoordinatorTurnOutput") return CoordinatorTurnJobOutputSchema;
  if (name === "SecretIdentityToolResult") {
    return SecretIdentityToolResultSchema;
  }
  if (definition.pageOf) return pageSchema(name, definition, source, stack);
  if (definition.body === "bytes") {
    const schema = namedFormat("bytes");
    if (!schema) throw new Error(`unsupported binary output: ${name}`);
    return described(
      schema,
      schemaDescription(definition.description, name, "binary response"),
    );
  }
  if (name === "BinaryArtifact" || name === "BinarySkillFile") {
    return described(
      z.string().base64(),
      schemaDescription(definition.description, name, "binary response"),
    );
  }
  if (definition.body === null) {
    return described(z.null(), "Empty successful response body.");
  }
  if (definition.frames) {
    return described(
      z.array(
        resolveNamed(
          String(definition.frames).replace(/\[\]$/, ""),
          source,
          stack,
        ),
      ),
      `${name} frames.`,
    );
  }
  if (Array.isArray(definition.oneOf)) {
    const variants = definition.oneOf.map((entry) => {
      if (!record(entry) || !text(entry.body)) {
        throw new Error(`malformed response union: ${name}`);
      }
      return resolveNamed(entry.body, source, stack);
    });
    if (variants.length < 2) {
      throw new Error(`response union requires two variants: ${name}`);
    }
    return described(
      z.union(variants as [Schema, Schema, ...Schema[]]),
      schemaDescription(definition.description, name, "response union"),
    );
  }
  if (definition.union) return unionSchema(name, definition, source, stack);
  if (definition.variants) {
    return variantsSchema(name, definition, source, stack);
  }
  if (definition.fields) {
    let result = projection(name, definition, source);
    if (name === "JobAssignment") {
      result = refineJobAssignment(result, source).describe(
        schemaDescription(
          definition.description,
          name,
          "registered worker assignment",
        ),
      );
    }
    if (name === "ResolvedRepositoryBinding") {
      result = result.refine(
        (value) => {
          const binding = value as JsonObject;
          const profileMissing = binding.repositoryProfileId === null;
          const observationMissing = binding.observationId === null;
          return profileMissing ===
              (binding.repositoryProfileRevision === null) &&
            profileMissing === (binding.repositoryProfileDigest === null) &&
            observationMissing === (binding.observationDigest === null) &&
            observationMissing === (binding.baseSha === null) &&
            (!profileMissing || observationMissing);
        },
        "Profile and observation triples must each be complete; observation pins require a profile.",
      ).describe(
        schemaDescription(
          definition.description,
          name,
          "authorized repository identity with an optional complete immutable execution tuple",
        ),
      );
    }
    if (name === "RepositoryOnboarding") {
      result = result.refine(
        (value) => {
          const onboarding = value as JsonObject;
          const published = onboarding.profileId !== null;
          return published === (onboarding.observationId !== null) &&
            published === (onboarding.status === "completed");
        },
        "Only completed onboarding exposes a complete profile and observation pair.",
      ).describe(
        schemaDescription(
          definition.description,
          name,
          "exact inspection lifecycle",
        ),
      );
    }
    if (name === "RepositoryProfileObservation") {
      result = result.refine(
        (value) => {
          const observation = value as JsonObject;
          const payload = observation.payload;
          return record(payload) && record(payload.source) &&
            observation.repositoryId === payload.repositoryId &&
            observation.profileId === payload.profileId &&
            observation.profileRevision === payload.profileRevision &&
            observation.profileDigest === payload.profileDigest &&
            observation.baseSha === payload.source.baseSha;
        },
        "Observation projection must preserve the exact payload profile and source identities.",
      ).describe(
        schemaDescription(
          definition.description,
          name,
          "exact immutable observation",
        ),
      );
    }
    return result;
  }
  if (definition.projection) {
    return resolveNamed(title(String(definition.projection)), source, stack);
  }
  throw new Error(`unsupported output definition: ${name}`);
}

function unionSchema(
  name: string,
  definition: Definition,
  source: JsonObject,
  stack: string[],
): Schema {
  if (!Array.isArray(definition.union) || !record(definition.fieldTypes)) {
    throw new Error(`malformed union: ${name}`);
  }
  const variants = definition.union.map((entry) => {
    if (!record(entry) || !text(entry.type)) {
      throw new Error(`malformed union variant: ${name}`);
    }
    const shape: Record<string, Schema> = {};
    for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
      if (!text(field)) throw new Error(`malformed union field: ${name}`);
      const variantFieldTypes = record(entry.fieldTypes)
        ? entry.fieldTypes
        : {};
      const type = variantFieldTypes[field] ??
        (definition.fieldTypes as JsonObject)[field];
      if (!text(type)) {
        throw new Error(
          `missing union field type at ${name}.${entry.type}.${field}`,
        );
      }
      const variantDescriptions = record(entry.fieldDescriptions)
        ? entry.fieldDescriptions
        : {};
      const fieldBounds = record(entry.fieldBounds) &&
          record(entry.fieldBounds[field])
        ? entry.fieldBounds[field]
        : undefined;
      let schema = primitive(
        type,
        `${name}.${entry.type}.${field}`,
        {
          description: variantDescriptions[field] ??
            (record(definition.fieldDescriptions)
              ? definition.fieldDescriptions[field]
              : undefined),
          ...(fieldBounds === undefined ? {} : { bounds: fieldBounds }),
        },
        source,
        stack,
      );
      if (
        Array.isArray(entry.optionalFields) &&
        entry.optionalFields.includes(field)
      ) {
        schema = optionalSchema(
          schema,
          `${name}.${entry.type}.${field} may be omitted.`,
        );
      }
      shape[field] = schema;
    }
    shape.type = described(
      z.literal(entry.type),
      `${name}.${entry.type} discriminator.`,
    );
    return described(strictObject(shape), `${name} ${entry.type} frame.`);
  });
  let schema: Schema = z.union(
    variants as unknown as [Schema, Schema, ...Schema[]],
  ).describe("Validated union of the declared response variants.");
  if (
    record(definition.bounds) && typeof definition.bounds.maxBytes === "number"
  ) schema = bounded(schema, { maxBytes: definition.bounds.maxBytes }, name);
  return described(
    schema,
    schemaDescription(definition.description, name, "discriminated union"),
  );
}

function buildSchemas(
  source: JsonObject,
  selectedNames?: ReadonlySet<string>,
): Record<string, Schema> {
  if (
    !record(source.inputs) || !record(source.outputs) ||
    !record(source.projections)
  ) throw new Error("malformed transport source");
  const selected = (name: string) =>
    selectedNames === undefined || selectedNames.has(name);
  const schemas: Record<string, Schema> = Object.create(null);
  for (const [name, definition] of Object.entries(source.inputs)) {
    if (selected(name)) schemas[name] = buildInput(name, definition, source);
  }
  for (const [name, definition] of Object.entries(source.projections)) {
    if (!selected(name) && !selected(title(name))) continue;
    const schema = projection(name, definition, source);
    if (selected(name)) schemas[name] = schema;
    if (selected(title(name))) schemas[title(name)] = schema;
    if (name.endsWith("s") && selected(title(name.slice(0, -1)))) {
      schemas[title(name.slice(0, -1))] = schema;
    }
  }
  for (const [name, definition] of Object.entries(source.outputs)) {
    if (selected(name)) schemas[name] = buildOutput(name, definition, source);
  }
  for (const name of actionOutputTypes) {
    if (selected(name)) schemas[name] = actionOutput(name);
  }
  return schemas;
}

export function buildImplementedClientSchemas(
  source: TransportSource = transport,
): Record<string, Schema> {
  const names = new Set<string>(["Problem"]);
  for (const action of catalogActions) {
    if (!implementedActionNames.includes(action.action as never)) continue;
    names.add(action.input);
    names.add(action.output);
  }
  return buildSchemas(source as unknown as JsonObject, names);
}
export const contractSchemas: ContractSchemas = buildSchemas(
  transport as unknown as JsonObject,
) as unknown as ContractSchemas;
export const contractTypes = contractSchemas;
export const jobAssignmentPayloadSchema = buildJobAssignmentPayloadSchema(
  transport as unknown as JsonObject,
) as z.ZodType<JobAssignmentPayload>;

function childEntries(node: Node): Array<[string, unknown]> {
  const def = record(node._def) ? node._def : {};
  const children: Array<[string, unknown]> = [];
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (record(shape)) {
    for (const [key, child] of Object.entries(shape)) {
      children.push([`.${key}`, child]);
    }
  }
  for (
    const [suffix, key] of [
      ["[]", "element"],
      ["?", "innerType"],
      ["{key}", "keyType"],
      ["{value}", "valueType"],
      ["<in>", "in"],
      ["<out>", "out"],
      ["<left>", "left"],
      ["<right>", "right"],
      ["{catchall}", "catchall"],
      ["{rest}", "rest"],
    ] as const
  ) {
    if (
      def[key] &&
      !(key === "catchall" && strictObjects.has(node))
    ) children.push([suffix, def[key]]);
  }
  if (Array.isArray(def.options)) {
    def.options.forEach((child, index) => children.push([`|${index}`, child]));
  }
  if (Array.isArray(def.items)) {
    def.items.forEach((child, index) => children.push([`[${index}]`, child]));
  }
  return children;
}

type DescriptionDefect = { path: string; missing: boolean };

function visitDescriptions(
  schema: unknown,
  path: string,
  defects: DescriptionDefect[],
  seen = new Set<object>(),
): void {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);
  const node = schema as Node;
  const kind = descriptionDefectKind(node.description, path);
  if (kind) defects.push({ path, missing: kind === "missing" });
  if (opaqueChildren.has(node)) return;
  for (const [suffix, child] of childEntries(node)) {
    const childNode = child as Node;
    const childType = record(childNode?._def) ? childNode._def.type : undefined;
    if (
      suffix === "{catchall}" && childType === "never" &&
      path.startsWith("schemas.")
    ) continue;
    visitDescriptions(child, `${path}${suffix}`, defects, seen);
  }
  const def = record(node._def) ? node._def : {};
  if (typeof def.getter === "function") {
    visitDescriptions(def.getter(), `${path}<lazy>`, defects, seen);
  }
}

export function findDescriptionDefects(
  schema: Schema,
  path = "schema",
): string[] {
  const defects: DescriptionDefect[] = [];
  visitDescriptions(schema, path, defects);
  return defects.map(({ path }) => path);
}

export function findMissingDescriptions(
  schema: Schema,
  path = "schema",
): string[] {
  const defects: DescriptionDefect[] = [];
  visitDescriptions(schema, path, defects);
  return defects.filter(({ missing }) => missing).map(({ path }) => path);
}
export function assertDescribedSchema(schema: Schema, path = "schema"): void {
  const defects = findDescriptionDefects(schema, path);
  if (defects.length) {
    throw new ContractQualityError(
      `invalid schema descriptions: ${defects.join(", ")}`,
    );
  }
}

export function assertSafeProjection(schema: Schema, path = "output"): void {
  const visit = (
    value: unknown,
    current: string,
    seen = new Set<object>(),
  ): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as Node;
    const shape = typeof node._def?.shape === "function"
      ? node._def.shape()
      : node._def?.shape;
    if (record(shape)) {
      for (const [key, child] of Object.entries(shape)) {
        if (denied.has(key)) {
          throw new Error(`unsafe output field at ${current}.${key}`);
        }
        visit(child, `${current}.${key}`, seen);
      }
    }
    for (const [suffix, child] of childEntries(node)) {
      visit(child, `${current}${suffix}`, seen);
    }
    if (typeof node._def?.getter === "function") {
      visit(node._def.getter(), `${current}<lazy>`, seen);
    }
  };
  visit(schema, path);
}

export function assertInventoryCoverage(
  source: TransportSource = transport,
): void {
  const input = source as unknown as JsonObject;
  const failures: string[] = [];
  const actionNames = new Map<string, string[]>();
  const routeNames = new Map<string, string[]>();
  const mcpNames = new Map<string, string[]>();
  for (const [index, action] of catalogActions.entries()) {
    if (!validCatalogAccess(action.access)) {
      failures.push(
        `inventory action ${index} ${action.action}: invalid access ${action.access}`,
      );
    }
    const organizationContext = action.organizationContext ??
      OrganizationContextPolicy.None;
    if (!isOrganizationContextPolicy(organizationContext)) {
      failures.push(
        `inventory action ${index} ${action.action}: invalid organization context ${organizationContext}`,
      );
    }
    if (
      action.organizationIdParam !== undefined &&
      (typeof action.organizationIdParam !== "string" ||
        !routeParameterNames(action.path).includes(
          action.organizationIdParam,
        ) ||
        organizationContext !==
          OrganizationContextPolicy.RequiredAuthenticatedContext)
    ) {
      failures.push(
        `inventory action ${index} ${action.action}: organizationIdParam must name a route parameter of a required authenticated context action`,
      );
    }
    const names = actionNames.get(action.action) ?? [];
    names.push(action.action);
    actionNames.set(action.action, names);

    const route = `${action.method.toUpperCase()} ${
      normalizeRoutePath(
        action.path,
      )
    }`;
    const routeActions = routeNames.get(route) ?? [];
    routeActions.push(action.action);
    routeNames.set(route, routeActions);

    if (text(action.mcp)) {
      const mcpActions = mcpNames.get(action.mcp) ?? [];
      mcpActions.push(action.action);
      mcpNames.set(action.mcp, mcpActions);
    }
  }
  for (const [action, names] of actionNames) {
    if (names.length > 1) {
      failures.push(
        `duplicate catalog action ${action}: ${names.join(", ")}`,
      );
    }
  }
  for (const [route, names] of routeNames) {
    if (names.length > 1) {
      failures.push(`duplicate catalog route ${route}: ${names.join(", ")}`);
    }
  }
  for (const [mcp, names] of mcpNames) {
    if (names.length > 1) {
      failures.push(`duplicate catalog MCP name ${mcp}: ${names.join(", ")}`);
    }
  }

  const inputs = record(input.inputs) ? input.inputs : {};
  const outputs = record(input.outputs) ? input.outputs : {};
  for (const [index, action] of catalogActions.entries()) {
    if (!own(inputs, action.input)) {
      failures.push(
        `inventory action ${index} ${action.action}: missing input ${action.input}`,
      );
    }
    if (!own(outputs, action.output)) {
      failures.push(
        `inventory action ${index} ${action.action}: missing output ${action.output}`,
      );
    }
  }

  const defaultTools =
    record(input.mcp) && Array.isArray(input.mcp.defaultTools)
      ? input.mcp.defaultTools
      : undefined;
  if (!defaultTools) {
    failures.push("transport MCP defaultTools must be an array");
  } else {
    for (const tool of defaultTools) {
      const matches = text(tool) && mcpNames.has(tool)
        ? mcpNames.get(tool)!
        : [];
      if (matches.length !== 1) {
        failures.push(
          `MCP default tool ${
            String(tool)
          } resolves to ${matches.length} catalog actions${
            matches.length ? `: ${matches.join(", ")}` : ""
          }`,
        );
      }
    }
  }

  if (failures.length) {
    throw new ContractQualityError(failures.join("; "));
  }

  const schemas = buildSchemas(input);
  for (const [index, action] of catalogActions.entries()) {
    if (!own(schemas, action.output)) {
      failures.push(
        `inventory action ${index} ${action.action}: output schema ${action.output} missing`,
      );
    }
  }
  if (failures.length) throw new ContractQualityError(failures.join("; "));
  for (const [name, schema] of Object.entries(schemas)) {
    assertDescribedSchema(schema, `schemas.${name}`);
    assertSafeProjection(schema, `schemas.${name}`);
  }
}

export type InventoryAction = {
  action: string;
  method: string;
  path: string;
  permission: CatalogPermissionKey | null;
  resourceGuard?: string;
  input: string;
  output: string;
  mcp: string;
  organizationContext: OrganizationContextPolicy;
  organizationHeaderOptional?: boolean;
  idempotencyKeyOptional?: boolean;
  errors: string[];
  organizationIdParam?: string;
  implemented: boolean;
};
export type GeneratedContracts = {
  schemas: Record<string, Schema>;
  actions: InventoryAction[];
  implementedActions: string[];
  openapi: Record<string, unknown>;
  compatibilityDigest: string;
  mcp: JsonObject;
};
export type ContractName =
  | keyof typeof transport.inputs
  | keyof typeof transport.outputs;
export type JsonValue = string | number | boolean | null | JsonValue[] | {
  [key: string]: JsonValue;
};
type SplitUnion<Type extends string> = Type extends
  `${infer Head}|${infer Tail}` ? Head | SplitUnion<Tail>
  : Type;
type StripTypeSuffix<Type extends string> = Type extends `${infer Base}?`
  ? StripTypeSuffix<Base>
  : Type extends `${infer Base}|null` ? StripTypeSuffix<Base>
  : Type;
type InventoryFieldType<
  Type extends string,
  Field = never,
> = StripTypeSuffix<Type> extends infer Base extends string ? Base extends
    | "string"
    | "slug"
    | "mediaType"
    | "gitSha"
    | "secretString"
    | "decimalString"
    | "decimal"
    | "timestamp"
    | "timestamptz"
    | "uri"
    | "base64"
    | "httpRange"
    | "relativePath"
    | "safeRelativePath" ? string
  : Base extends "actionName" ? string
  : Base extends "permissionKey" ? CatalogPermissionKey
  : Base extends "bytes" ? Uint8Array
  : Base extends "boolean" ? boolean
  : Base extends "integer" | "positiveInteger" | "nonnegativeInteger" | "number"
    ? number
  : Base extends "uuid" | "sha256" ? string
  : Base extends "json" | "array" | "object" ? JsonValue
  : Base extends `enum(${infer Values})` ? SplitUnion<Values>
  : Base extends "enum"
    ? Field extends { enum: readonly (infer Value extends string)[] } ? Value
    : never
  : Base extends `${infer Item}[]` ? InventoryFieldType<Item>[]
  : Base extends keyof typeof transport.inputs
    ? InputShape<(typeof transport.inputs)[Base]>
  : Base extends keyof typeof transport.outputs
    ? OutputShape<(typeof transport.outputs)[Base]>
  : string
  : never;
type InventoryField<F> = F extends {
  name: infer Name extends string;
  type: infer Type extends string;
}
  ? InventoryFieldType<Type, F> extends infer Value
    ? F extends { nullable: true } ? Value | null : Value
  : never
  : F extends { type: infer Type extends string }
    ? InventoryFieldType<Type, F> extends infer Value
      ? F extends { nullable: true } ? Value | null : Value
    : never
  : never;
type FieldName<Field> = Field extends { name: infer Name extends string } ? Name
  : never;
type RequiredFields<Fields extends readonly unknown[]> = Fields[number] extends
  infer Field ? Field extends { required: false } ? never : FieldName<Field>
  : never;
type OptionalFields<Fields extends readonly unknown[]> = Fields[number] extends
  infer Field ? Field extends { required: false } ? FieldName<Field> : never
  : never;
type FieldShape<
  Fields extends readonly unknown[],
> =
  & {
    [Name in RequiredFields<Fields>]: InventoryField<
      Extract<Fields[number], { name: Name }>
    >;
  }
  & {
    [Name in OptionalFields<Fields>]?: InventoryField<
      Extract<Fields[number], { name: Name }>
    >;
  };
/**
 * Deliberately inlined as one conditional rather than split across helper
 * generics (as `InputShape`'s field derivation is). Splitting the
 * "does `Field` carry `{name, type}` for this position" computation into a
 * separate generic type and calling it from here defeats TypeScript's
 * per-key homomorphic evaluation of this mapped type: every position
 * collapses to the union of all positions instead of its own field, and
 * `FieldShape` then sees `Fields[number]` as an unresolvable mix and
 * produces `{}` for every output. Keeping the whole expression inline
 * keeps each position's `Field` literal, so `FieldShape` resolves the real
 * per-field type instead of silently degrading to an unchecked shape.
 */
type UnionFieldType<Definition, Variant, Name extends string> = Variant extends
  { fieldTypes: infer VariantTypes }
  ? Name extends keyof VariantTypes ? VariantTypes[Name]
  : Definition extends { fieldTypes: infer Types }
    ? Name extends keyof Types ? Types[Name] : never
  : never
  : Definition extends { fieldTypes: infer Types }
    ? Name extends keyof Types ? Types[Name] : never
  : never;
type UnionInventoryFieldType<Type extends string> = Type extends
  `${string}|null` ? InventoryFieldType<Type> | null
  : InventoryFieldType<Type>;
type UnionVariantShape<Definition, Variant> = Variant extends {
  type: infer Tag extends string;
  fields: readonly (infer Name extends string)[];
} ?
    & { type: Tag }
    & {
      [
        Field in Exclude<
          Name,
          Variant extends { optionalFields: readonly (infer Optional)[] }
            ? Extract<Optional, string>
            : never
        >
      ]: UnionFieldType<Definition, Variant, Field> extends
        infer Type extends string ? UnionInventoryFieldType<Type> : never;
    }
    & {
      [
        Field in Extract<
          Name,
          Variant extends { optionalFields: readonly (infer Optional)[] }
            ? Extract<Optional, string>
            : never
        >
      ]?: UnionFieldType<Definition, Variant, Field> extends
        infer Type extends string ? UnionInventoryFieldType<Type> : never;
    }
  : never;
type UnionOutputShape<Definition> = Definition extends {
  union: readonly (infer Variant)[];
} ? Variant extends unknown ? UnionVariantShape<Definition, Variant> : never
  : never;
type OutputShape<Definition> = Definition extends { union: readonly unknown[] }
  ? UnionOutputShape<Definition>
  : Definition extends { variants: unknown } ? InputShape<Definition>
  : Definition extends {
    fields: readonly (infer Field extends string)[];
  } ? FieldShape<
      (Definition extends { fieldTypes: infer Types }
        ? Field extends keyof Types ?
            & { type: Types[Field] }
            & { name: Field }
            & (Definition extends
              { optionalFields: readonly (infer OptionalName)[] }
              ? Field extends OptionalName ? { required: false } : unknown
              : unknown)
            & (
              (Definition extends
                { nullableFields: readonly (infer NullableName)[] }
                ? Field extends NullableName ? true : false
                : false) extends true ? { nullable: true }
                : Types[Field] extends `${string}|null` ? { nullable: true }
                : unknown
            )
        : never
        : never)[]
    >
  : JsonValue;
type VariantObjectShape<Variant> = Variant extends Record<
  string,
  { type: string }
> ? {
    [Name in keyof Variant]: Variant[Name] extends
      { type: infer FieldType extends string }
      ? VariantValue<Variant[Name], FieldType>
      : never;
  }
  : never;
type VariantValue<Field, Type extends string> = Type extends
  `${infer Inner}|null` ? VariantValue<Field, Inner> | null
  : Type extends `${string}[]` ? InventoryFieldType<Type, Field>
  : Type extends `string<=${string}` ? string
  : Type extends `number${"[" | "("}${string}` ? number
  : StripTypeSuffix<Type> extends infer Base extends string
    ? Base extends
      keyof typeof transport.inputs | keyof typeof transport.outputs
      ? InventoryFieldType<Type, Field>
    : Base extends
      | "string"
      | "slug"
      | "mediaType"
      | "gitSha"
      | "secretString"
      | "decimalString"
      | "decimal"
      | "timestamp"
      | "timestamptz"
      | "uri"
      | "base64"
      | "httpRange"
      | "relativePath"
      | "safeRelativePath"
      | "bytes"
      | "boolean"
      | "integer"
      | "positiveInteger"
      | "nonnegativeInteger"
      | "number"
      | "json"
      | "array"
      | "object"
      | "enum" ? InventoryFieldType<Type, Field>
    : Base extends `enum(${string})` ? InventoryFieldType<Type, Field>
    : Type extends `${string}|null` ? InventoryFieldType<Type, Field>
    : Base
  : never;
type VariantArrayShape<Definition, Variant> = Variant extends {
  status: infer Status extends string;
  required: readonly (infer Required extends string)[];
  forbidden?: readonly (infer Forbidden extends string)[];
  resultSchema?: infer Result extends string;
  faultSchema?: infer Fault extends string;
  cancellationSchema?: infer Cancellation;
} ?
    & Omit<
      InputShape<Omit<Definition, "variants">>,
      Extract<Forbidden, string> | Extract<Required, string> | "status"
    >
    & { status: Status }
    & {
      [Name in Extract<Required, string>]: Name extends "result"
        ? Result extends keyof typeof transport.outputs ? OutputShape<
            (typeof transport.outputs)[Result]
          >
        : JsonValue
        : Name extends "fault"
          ? Fault extends keyof typeof transport.outputs ? OutputShape<
              (typeof transport.outputs)[Fault]
            >
          : JsonValue
        : Name extends "cancellation"
          ? Cancellation extends Record<string, string> ? {
              [Key in keyof Cancellation]: InventoryFieldType<
                Cancellation[Key]
              >;
            }
          : JsonValue
        : JsonValue;
    }
  : never;
type InputShape<Definition> = Definition extends {
  variants: infer Variants;
}
  ? Variants extends readonly (infer Variant)[]
    ? VariantArrayShape<Definition, Variant>
  : Variants extends Record<string, infer Variant>
    ? Variant extends Record<string, { type: infer Type extends string }>
      ? VariantObjectShape<Variant>
    : never
  : never
  : Definition extends {
    fields: readonly (infer Field)[];
  } ? FieldShape<readonly Field[]>
  : Record<string, never>;
type SupportedInputName = keyof typeof transport.inputs;
export type ContractInputMap = {
  [Name in SupportedInputName]: Name extends keyof ContractInputOverrides
    ? ContractInputOverrides[Name]
    : InputShape<(typeof transport.inputs)[Name]>;
};
type SupportedOutputName = keyof typeof transport.outputs;
export type ContractOutputMap = {
  [Name in SupportedOutputName]: Name extends "OutputBatch" ? OutputBatch
    : Name extends "OutputPart" ? OutputPart
    : Name extends "SecretIdentityToolResult" ? SecretIdentityToolResult
    : Name extends
      | "BinaryArtifact"
      | "BinarySkillFile" ? string
    : Name extends "BinaryArtifactBytes" ? Uint8Array
    : Name extends "RepositoryEffectiveRules" | "RepositoryRulePreviewEffective"
      ?
        & Omit<
          OutputShape<(typeof transport.outputs)[Name]>,
          "entries" | "supersededOverrides"
        >
        & {
          entries: EffectiveRepositoryRuleEntry[];
          supersededOverrides: SupersededRepositoryRuleOverride[];
        }
    : Name extends
      | "OrganizationRepositoryRuleVersion"
      | "OrganizationRepositoryRulesRead" ?
        & Omit<OutputShape<(typeof transport.outputs)[Name]>, "entries">
        & { entries: OrganizationRepositoryRuleEntry[] }
    : OutputShape<(typeof transport.outputs)[Name]>;
};
export type ContractOutput<Name extends string> = Name extends
  keyof ContractOutputMap ? ContractOutputMap[Name] : never;
export type JobAssignmentPayload = Pick<
  ContractOutput<"JobAssignment">,
  (typeof jobAssignmentPayloadFieldNames)[number]
>;
/**
 * The runtime schema registry, precisely typed. Every catalog input and
 * output name resolves to the physical Zod schema instance generated for
 * it; `ActionDefinition.input`/`.output` are these schema values directly; no
 * name-based lookup remains. `CommentAnchor` is the one name shared by both
 * an input and an output definition -- `buildSchemas` builds the output
 * shape second, so the output type wins here too.
 */
export type ContractSchemas =
  & { [Name in ContractOutputName]: z.ZodType<ContractOutputMap[Name]> }
  & {
    [Name in Exclude<ContractInputName, ContractOutputName>]: z.ZodType<
      ContractInputMap[Name]
    >;
  };
/**
 * `AgentVersionCreateConfig` is a hand-authored Zod schema, not one the
 * generic transport-schema field-type derivation can see through: the
 * catalog only declares `config`'s wire type as opaque `"json"`.
 */
type ContractInputOverrides = {
  AgentVersionCreate: {
    revision: number;
    config: AgentVersionCreateConfig;
    digest: string;
  };
  RepositoryRuleVersionCreate: {
    expectedRevision: number;
    entries: OrganizationRepositoryRuleEntry[];
  };
  RepositoryRulePreviewOrganizationCreate: {
    expectedRevision: number;
    entries: OrganizationRepositoryRuleEntry[];
    cursor?: string;
    limit?: number;
  };
  RepositoryRulePreviewRepositoryCreate: {
    overrides: RepositoryRuleOverrides;
    sample?: {
      commitMessages?: string[];
      pullRequestTitle?: string;
      pullRequestDescription?: string;
    };
  };
};
export type ContractInput<Name extends string> = Name extends
  keyof ContractInputMap ? ContractInputMap[Name] : never;
export function toJsonSchema(schema: Schema): Record<string, unknown> {
  const root = z.toJSONSchema(schema) as JsonObject;
  const defs = record(root.$defs) ? root.$defs : {};
  const expanding = new Set<string>();
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (!record(value)) return value;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
      const name = value.$ref.slice("#/$defs/".length);
      if (!defs[name]) return value;
      if (expanding.has(name)) return { $ref: value.$ref };
      expanding.add(name);
      const expanded = expand(defs[name]);
      expanding.delete(name);
      if (!record(expanded)) return expanded;
      return {
        ...expanded,
        ...Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "$ref"),
        ),
      };
    }
    const expanded = Object.fromEntries(
      Object.entries(value).map((
        [key, child],
      ) => [key, expand(child)]),
    ) as JsonObject;
    return expanded;
  };
  const expanded = expand(root) as Record<string, unknown>;
  return expanded;
}

export type JsonSchemaResolver = (reference: string) => unknown;

function resolveJsonPointer(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let value = root;
  for (const part of reference.slice(2).split("/")) {
    if (!value || typeof value !== "object") return undefined;
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function assertDescribedJsonSchema(
  value: unknown,
  path = "root",
  resolver?: JsonSchemaResolver,
): void {
  const failures: string[] = [];
  const seen = new Set<object>();
  const resolve = resolver ??
    ((reference: string) => resolveJsonPointer(value, reference));
  const visit = (
    node: unknown,
    current: string,
  ): void => {
    if (typeof node === "boolean") return;
    if (node === null || typeof node !== "object") {
      failures.push(`${current} must be a JSON Schema object`);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const schema = node as JsonObject;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
      const target = resolve(schema.$ref);
      if (target === undefined) {
        failures.push(`${current} unresolved local reference ${schema.$ref}`);
      } else {
        visit(target, current);
      }
      return;
    }
    if (descriptionDefectKind(schema.description, current)) {
      failures.push(`${current} must have a meaningful description`);
    }

    const children: Array<[string, unknown]> = [];
    if (schema.properties !== undefined) {
      if (!record(schema.properties)) {
        failures.push(`${current}.properties must be an object`);
      } else {
        for (const [name, child] of Object.entries(schema.properties)) {
          children.push([`${current}.properties.${name}`, child]);
        }
      }
    }
    for (const key of ["patternProperties", "dependentSchemas"] as const) {
      const map = schema[key];
      if (map !== undefined) {
        if (!record(map)) {
          failures.push(`${current}.${key} must be an object`);
        } else {
          for (const [name, child] of Object.entries(map)) {
            children.push([`${current}.${key}.${name}`, child]);
          }
        }
      }
    }
    for (
      const key of [
        "items",
        "additionalItems",
        "additionalProperties",
        "unevaluatedItems",
        "unevaluatedProperties",
        "contains",
        "propertyNames",
        "contentSchema",
        "not",
        "if",
        "then",
        "else",
      ] as const
    ) {
      if (schema[key] !== undefined) {
        children.push([`${current}.${key}`, schema[key]]);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
      const variants = schema[key];
      if (variants !== undefined) {
        if (!Array.isArray(variants)) {
          failures.push(`${current}.${key} must be an array`);
        } else {
          variants.forEach((child, index) =>
            children.push([`${current}.${key}[${index}]`, child])
          );
        }
      }
    }
    for (const key of ["$defs", "definitions"] as const) {
      const definitions = schema[key];
      if (definitions !== undefined) {
        if (!record(definitions)) {
          failures.push(`${current}.${key} must be an object`);
        } else {
          for (const [name, child] of Object.entries(definitions)) {
            children.push([`${current}.${key}.${name}`, child]);
          }
        }
      }
    }
    for (const [childPath, child] of children) {
      visit(child, childPath);
    }
  };
  visit(value, path);
  if (failures.length) {
    throw new ContractQualityError(
      `invalid JSON Schema descriptions: ${failures.join(", ")}`,
    );
  }
}

export function assertDescribedOpenApi(openapi: Record<string, unknown>): void {
  const resolver = (reference: string) =>
    resolveJsonPointer(openapi, reference);
  const components = record(openapi.components) ? openapi.components : {};
  const componentSchemas = record(components.schemas) ? components.schemas : {};
  for (const [name, schema] of Object.entries(componentSchemas)) {
    assertDescribedJsonSchema(
      schema,
      `openapi.components.schemas.${name}`,
      resolver,
    );
  }

  const paths = record(openapi.paths) ? openapi.paths : {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!record(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method === "parameters" || !record(operation)) continue;
      if (Array.isArray(operation.parameters)) {
        for (const [index, parameter] of operation.parameters.entries()) {
          if (record(parameter) && parameter.schema !== undefined) {
            assertDescribedJsonSchema(
              parameter.schema,
              `openapi.paths.${path}.${method}.parameters[${index}].schema`,
              resolver,
            );
          }
        }
      }
      const requestBody = record(operation.requestBody)
        ? operation.requestBody
        : undefined;
      if (requestBody && record(requestBody.content)) {
        for (const [media, content] of Object.entries(requestBody.content)) {
          if (record(content) && content.schema !== undefined) {
            assertDescribedJsonSchema(
              content.schema,
              `openapi.paths.${path}.${method}.requestBody.content.${media}.schema`,
              resolver,
            );
          }
        }
      }
      if (record(operation.responses)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!record(response) || !record(response.content)) continue;
          for (const [media, content] of Object.entries(response.content)) {
            if (record(content) && content.schema !== undefined) {
              assertDescribedJsonSchema(
                content.schema,
                `openapi.paths.${path}.${method}.responses.${status}.content.${media}.schema`,
                resolver,
              );
            }
          }
        }
      }
    }
  }
}

export function assertCompatible(
  previous: Pick<GeneratedContracts, "actions" | "openapi">,
  current: Pick<GeneratedContracts, "actions" | "openapi">,
): void {
  const compareSchema = (
    oldSchema: unknown,
    newSchema: unknown,
    path: string,
  ): void => {
    if (!record(oldSchema) || !record(newSchema)) {
      if (oldSchema !== undefined && newSchema === undefined) {
        throw new Error(`breaking contract drift at ${path}: value removed`);
      }
      return;
    }
    if (oldSchema.$ref !== undefined && oldSchema.$ref !== newSchema.$ref) {
      throw new Error(
        `breaking contract drift at ${path}.$ref: reference changed`,
      );
    }
    if (Array.isArray(oldSchema.anyOf) && Array.isArray(newSchema.anyOf)) {
      const nextAnyOf = newSchema.anyOf as unknown[];
      if (nextAnyOf.length < oldSchema.anyOf.length) {
        throw new Error(
          `breaking contract drift at ${path}.anyOf: variant removed`,
        );
      }
      oldSchema.anyOf.forEach((child, index) =>
        compareSchema(child, nextAnyOf[index], `${path}.anyOf[${index}]`)
      );
    }
    if (record(oldSchema.properties) && record(newSchema.properties)) {
      for (const [key, child] of Object.entries(oldSchema.properties)) {
        if (!record(newSchema.properties[key])) {
          throw new Error(
            `breaking contract drift at ${path}.properties.${key}: field removed`,
          );
        }
        compareSchema(
          child,
          newSchema.properties[key],
          `${path}.properties.${key}`,
        );
      }
    }
    if (record(oldSchema.properties) && !record(newSchema.properties)) {
      throw new Error(
        `breaking contract drift at ${path}.properties: property map removed`,
      );
    }
    if (record(oldSchema.items) && record(newSchema.items)) {
      compareSchema(oldSchema.items, newSchema.items, `${path}.items`);
    }
    for (const key of ["type", "format", "pattern"] as const) {
      if (oldSchema[key] !== undefined && oldSchema[key] !== newSchema[key]) {
        throw new Error(
          `breaking contract drift at ${path}.${key}: constraint changed`,
        );
      }
    }
    if (Array.isArray(oldSchema.enum) && Array.isArray(newSchema.enum)) {
      for (const value of oldSchema.enum) {
        if (!newSchema.enum.includes(value)) {
          throw new Error(
            `breaking contract drift at ${path}.enum: value removed`,
          );
        }
      }
    }
    if (oldSchema.items !== undefined && newSchema.items === undefined) {
      throw new Error(
        `breaking contract drift at ${path}.items: item schema removed`,
      );
    }
    if (
      oldSchema.additionalProperties !== undefined &&
      newSchema.additionalProperties === undefined
    ) {
      throw new Error(
        `breaking contract drift at ${path}.additionalProperties: schema removed`,
      );
    }
    if (
      record(oldSchema.additionalProperties) &&
      record(newSchema.additionalProperties)
    ) {
      compareSchema(
        oldSchema.additionalProperties,
        newSchema.additionalProperties,
        `${path}.additionalProperties`,
      );
    }
    if (
      oldSchema.pattern !== undefined && oldSchema.pattern !== newSchema.pattern
    ) {
      throw new Error(
        `breaking contract drift at ${path}.pattern: constraint changed`,
      );
    }
    if (oldSchema.type !== undefined && oldSchema.type !== newSchema.type) {
      throw new Error(
        `breaking contract drift at ${path}.type: constraint changed`,
      );
    }
    if (
      Array.isArray(oldSchema.required) && Array.isArray(newSchema.required)
    ) {
      for (const field of newSchema.required) {
        if (!oldSchema.required.includes(field)) {
          throw new Error(
            `breaking contract drift at ${path}.required: field became required`,
          );
        }
      }
    }
    if (
      !Array.isArray(oldSchema.required) && Array.isArray(newSchema.required) &&
      newSchema.required.length
    ) {
      throw new Error(
        `breaking contract drift at ${path}.required: constraint added`,
      );
    }
    if (Array.isArray(oldSchema.enum) && Array.isArray(newSchema.enum)) {
      for (const value of oldSchema.enum) {
        if (!newSchema.enum.includes(value)) {
          throw new Error(
            `breaking contract drift at ${path}.enum: value removed`,
          );
        }
      }
    }
    if (!Array.isArray(oldSchema.enum) && Array.isArray(newSchema.enum)) {
      throw new Error(
        `breaking contract drift at ${path}.enum: constraint added`,
      );
    }
    if (oldSchema.const !== undefined && oldSchema.const !== newSchema.const) {
      throw new Error(
        `breaking contract drift at ${path}.const: value changed`,
      );
    }
    if (oldSchema.const === undefined && newSchema.const !== undefined) {
      throw new Error(
        `breaking contract drift at ${path}.const: constraint added`,
      );
    }
    if (
      oldSchema.exclusiveMinimum !== undefined &&
      oldSchema.exclusiveMinimum !== newSchema.exclusiveMinimum
    ) {
      throw new Error(
        `breaking contract drift at ${path}.exclusiveMinimum: constraint changed`,
      );
    }
    if (
      oldSchema.exclusiveMinimum === undefined &&
      newSchema.exclusiveMinimum !== undefined
    ) {
      throw new Error(
        `breaking contract drift at ${path}.exclusiveMinimum: constraint added`,
      );
    }
    if (
      oldSchema.exclusiveMaximum !== undefined &&
      oldSchema.exclusiveMaximum !== newSchema.exclusiveMaximum
    ) {
      throw new Error(
        `breaking contract drift at ${path}.exclusiveMaximum: constraint changed`,
      );
    }
    if (
      oldSchema.exclusiveMaximum === undefined &&
      newSchema.exclusiveMaximum !== undefined
    ) {
      throw new Error(
        `breaking contract drift at ${path}.exclusiveMaximum: constraint added`,
      );
    }
    for (
      const key of [
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "x-bigint-minimum",
        "x-bigint-maximum",
      ] as const
    ) {
      if (oldSchema[key] !== undefined && oldSchema[key] !== newSchema[key]) {
        throw new Error(
          `breaking contract drift at ${path}.${key}: constraint changed`,
        );
      }
      if (oldSchema[key] === undefined && newSchema[key] !== undefined) {
        throw new Error(
          `breaking contract drift at ${path}.${key}: constraint added`,
        );
      }
    }
  };
  const compareContent = (
    oldContent: unknown,
    newContent: unknown,
    path: string,
  ): void => {
    if (oldContent !== undefined && newContent === undefined) {
      throw new Error(`breaking contract drift at ${path}: value removed`);
    }
    if (!record(oldContent) || !record(newContent)) return;
    for (const key of Object.keys(oldContent)) {
      if (!(key in newContent)) {
        throw new Error(
          `breaking contract drift at ${path}.${key}: media type removed`,
        );
      }
      const oldMedia = oldContent[key];
      const newMedia = newContent[key];
      if (record(oldMedia) && record(newMedia)) {
        compareSchema(
          oldMedia.schema,
          newMedia.schema,
          `${path}.${key}.schema`,
        );
      }
    }
  };
  const oldActions = new Map(
    previous.actions.map((action) => [action.action, action]),
  );
  const newActions = new Map(
    current.actions.map((action) => [action.action, action]),
  );
  for (const [name, oldAction] of oldActions) {
    const next = newActions.get(name);
    if (!next) {
      throw new Error(
        `breaking contract drift at actions.${name}: action removed`,
      );
    }
    if (
      oldAction.method !== next.method || oldAction.path !== next.path
    ) {
      throw new Error(
        `breaking contract drift at actions.${name}: method or path changed`,
      );
    }
  }
  const oldPaths = (previous.openapi as JsonObject).paths as JsonObject ?? {};
  const newPaths = (current.openapi as JsonObject).paths as JsonObject ?? {};
  for (const [path, oldPath] of Object.entries(oldPaths)) {
    const nextPath = newPaths[path];
    if (!record(oldPath) || !record(nextPath)) {
      throw new Error(`breaking contract drift at paths.${path}: path removed`);
    }
    for (const [method, oldEntry] of Object.entries(oldPath)) {
      const nextEntry = nextPath[method];
      if (!record(oldEntry) || !record(nextEntry)) {
        throw new Error(
          `breaking contract drift at paths.${path}.${method}: operation removed`,
        );
      }
      for (const section of ["responses", "requestBody"] as const) {
        const oldSection = oldEntry[section];
        if (oldSection === undefined) continue;
        const nextSection = nextEntry[section];
        if (nextSection === undefined) {
          throw new Error(
            `breaking contract drift at paths.${path}.${method}.${section}: value removed`,
          );
        }
        if (
          section === "responses" && record(oldSection) && record(nextSection)
        ) {
          for (const key of Object.keys(oldSection)) {
            if (!(key in nextSection)) {
              throw new Error(
                `breaking contract drift at paths.${path}.${method}.responses.${key}: response removed`,
              );
            }
            const oldResponse = oldSection[key];
            const newResponse = nextSection[key];
            if (record(oldResponse) && record(newResponse)) {
              compareContent(
                oldResponse.content,
                newResponse.content,
                `paths.${path}.${method}.responses.${key}.content`,
              );
            }
          }
        }
        if (
          section === "requestBody" && record(oldSection) && record(nextSection)
        ) {
          compareContent(
            oldSection.content,
            nextSection.content,
            `paths.${path}.${method}.requestBody.content`,
          );
        }
        compareSchema(
          oldSection,
          nextSection,
          `paths.${path}.${method}.${section}`,
        );
      }
    }
  }
  const oldSchemas = ((previous.openapi as JsonObject).components as JsonObject)
    ?.schemas as JsonObject ?? {};
  const newSchemas = ((current.openapi as JsonObject).components as JsonObject)
    ?.schemas as JsonObject ?? {};
  for (const [name, oldValue] of Object.entries(oldSchemas)) {
    const next = newSchemas[name] as JsonObject | undefined;
    if (!next) {
      throw new Error(
        `breaking contract drift at schemas.${name}: schema removed`,
      );
    }
    compareSchema(oldValue, next, `schemas.${name}`);
    const oldProperties = record(oldValue) && record(oldValue.properties)
      ? oldValue.properties
      : {};
    const newProperties = record(next.properties) ? next.properties : {};
    for (const [field, oldField] of Object.entries(oldProperties)) {
      const nextField = newProperties[field] as JsonObject | undefined;
      if (!nextField) {
        throw new Error(
          `breaking contract drift at schemas.${name}.${field}: field removed`,
        );
      }
      for (const key of ["type", "format", "pattern"] as const) {
        if (
          oldField && record(oldField) && oldField[key] !== undefined &&
          oldField[key] !== nextField[key]
        ) {
          throw new Error(
            `breaking contract drift at schemas.${name}.${field}.${key}: constraint changed`,
          );
        }
      }
      if (
        record(oldField) && Array.isArray(oldField.enum) &&
        Array.isArray(nextField.enum)
      ) {
        for (const value of oldField.enum) {
          if (!nextField.enum.includes(value)) {
            throw new Error(
              `breaking contract drift at schemas.${name}.${field}.enum: value removed`,
            );
          }
        }
      }
    }
    const oldRequiredValues =
      record(oldValue) && Array.isArray(oldValue.required)
        ? oldValue.required
        : [];
    const oldRequired = new Set(oldRequiredValues);
    const newRequired = new Set(
      Array.isArray(next.required) ? next.required : [],
    );
    for (const field of newRequired) {
      if (!oldRequired.has(field)) {
        throw new Error(
          `breaking contract drift at schemas.${name}.${field}: field became required`,
        );
      }
    }
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(
          ",",
        )
    }}`;
  }
  return JSON.stringify(value);
}

function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  const constants = [
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = (words[i - 15] >>> 7 | words[i - 15] << 25) ^
        (words[i - 15] >>> 18 | words[i - 15] << 14) ^ (words[i - 15] >>> 3);
      const s1 = (words[i - 2] >>> 17 | words[i - 2] << 15) ^
        (words[i - 2] >>> 19 | words[i - 2] << 13) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^
        (e >>> 25 | e << 7);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + constants[i] + words[i]) >>> 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^
        (a >>> 22 | a << 10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      [h, g, f, e, d, c, b, a] = [
        g,
        f,
        e,
        (d + temp1) >>> 0,
        c,
        b,
        a,
        (temp1 + temp2) >>> 0,
      ];
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join(
    "",
  );
}

function inputFieldTransportType(
  source: JsonObject,
  inputName: string,
  fieldName: string,
): string | undefined {
  const inputs = record(source.inputs) ? source.inputs : {};
  const definition = record(inputs[inputName]) ? inputs[inputName] : {};
  const fields = Array.isArray(definition.fields) ? definition.fields : [];
  const field = fields.find((value) =>
    record(value) && value.name === fieldName
  );
  return record(field) && typeof field.type === "string"
    ? field.type
    : undefined;
}

function openApiParameters(
  action: InventoryAction,
  schemas: Record<string, Schema>,
  source: JsonObject,
): unknown[] {
  const names = [...action.path.matchAll(/\{([^}]+)\}/g)].map((match) =>
    match[1]
  );
  const json = toJsonSchema(schemas[action.input]);
  const properties = record(json.properties) ? json.properties : {};
  const required = Array.isArray(json.required) ? json.required : [];
  const idJson = schemas.IdPath ? toJsonSchema(schemas.IdPath) : {};
  const idProperties = record(idJson.properties) ? idJson.properties : {};
  const parameters: unknown[] = names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: properties[name] ?? idProperties[name] ?? idProperties.id ??
      { type: "string", format: "uuid" },
  }));
  if (
    action.method === "GET" ||
    (action.method === "DELETE" && action.input !== "SecretRevoke")
  ) {
    for (const [name, schema] of Object.entries(properties)) {
      if (names.includes(name)) {
        continue;
      }
      const isHttpRange =
        inputFieldTransportType(source, action.input, name) ===
          "httpRange";
      parameters.push({
        name: isHttpRange ? "Range" : name,
        in: isHttpRange ? "header" : "query",
        required: required.includes(name),
        schema,
      });
    }
  }
  if (
    action.organizationContext ===
      OrganizationContextPolicy.RequiredAuthenticatedContext
  ) {
    const organizationHeaderOptional =
      action.organizationHeaderOptional === true;
    parameters.push({
      name: "Bakery-Organization-Id",
      in: "header",
      required: !organizationHeaderOptional,
      schema: toJsonSchema(
        z.string().uuid().describe(
          organizationHeaderOptional
            ? "Requested organization UUID selecting live authority; provide this header or the organizationId query parameter because upgrade requests cannot carry headers. Omitting both is rejected before upgrade, and the value grants no access by itself."
            : "Requested organization UUID that must match live authority; this header selects context and grants no access by itself.",
        ),
      ),
    });
  }
  if (action.input === "SecretRevoke") {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: {
        type: "string",
        description:
          "Strong quoted metadata.version ETag for this revocation request; weak, wildcard and omitted versions are rejected.",
      },
    }, {
      name: "Idempotency-Key",
      in: "header",
      required: false,
      schema: {
        type: "string",
        description:
          "Optional scoped replay key; omission uses the canonical revoke route natural key, with body and metadata.version bound to the original request.",
      },
    });
  }
  return parameters;
}

function componentSchemas(
  schemas: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const components: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const definitions = record(schema.$defs) ? schema.$defs : {};
    const names = new Map(
      Object.keys(definitions).map((definition) => [
        definition,
        `${name}__${definition}`,
      ]),
    );
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (!record(value)) return value;
      if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
        const definition = value.$ref.slice("#/$defs/".length);
        return names.has(definition)
          ? { $ref: `#/components/schemas/${names.get(definition)}` }
          : value;
      }
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$defs")
          .map(([key, child]) => [key, rewrite(child)]),
      );
    };
    components[name] = rewrite(schema) as Record<string, unknown>;
    for (const [definition, value] of Object.entries(definitions)) {
      components[names.get(definition)!] = rewrite(value) as Record<
        string,
        unknown
      >;
    }
  }
  return components;
}

export function generateContracts(
  source: TransportSource = transport,
  previous?: Pick<GeneratedContracts, "actions" | "openapi">,
): GeneratedContracts {
  const input = source as unknown as JsonObject;
  assertInventoryCoverage(source);
  const schemas = buildSchemas(input);
  const implemented = Object.fromEntries(
    implementedActionNames.map((name) => [name, true]),
  ) as Readonly<Record<string, true>>;
  const actions = catalogActions.map((action) => ({
    group: action.group,
    method: action.method,
    path: action.path,
    action: action.action,
    access: action.access,
    permission: action.permission,
    ...(action.resourceGuard === undefined
      ? {}
      : { resourceGuard: action.resourceGuard }),
    input: action.input,
    output: action.output,
    event: action.event,
    mcp: action.mcp ?? "",
    idempotency: action.idempotency,
    ...(action.idempotencyKeyOptional === undefined
      ? {}
      : { idempotencyKeyOptional: action.idempotencyKeyOptional }),
    errors: action.errors,
    organizationContext: action.organizationContext ??
      OrganizationContextPolicy.None,
    ...(action.organizationHeaderOptional === undefined
      ? {}
      : { organizationHeaderOptional: action.organizationHeaderOptional }),
    ...(action.organizationIdParam === undefined
      ? {}
      : { organizationIdParam: action.organizationIdParam }),
    implemented: implemented[action.action] === true,
  }));
  const jsonSchemas = Object.fromEntries(
    Object.entries(schemas).map((
      [name, schema],
    ) => [
      name,
      toJsonSchema(schema),
    ]),
  );
  for (const [name, schema] of Object.entries(jsonSchemas)) {
    assertDescribedJsonSchema(schema, `schemas.${name}`);
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const action of actions) {
    paths[action.path] ??= {};
    const method = action.method.toLowerCase();
    const outputDefinition =
      record(input.outputs) && record(input.outputs[action.output])
        ? input.outputs[action.output] as JsonObject
        : {};
    const importAction = action.action === "artifactVersions.import";
    const variants = importAction
      ? [{ status: 201, body: action.output }]
      : Array.isArray(outputDefinition.httpVariants)
      ? outputDefinition.httpVariants
      : [{
        status: action.output === "NoContent" ? 204 : 200,
        body: action.output,
      }];
    const responses = Object.fromEntries(variants.map((variant) => {
      const status = record(variant) && typeof variant.status === "number"
        ? String(variant.status)
        : "200";
      const body = record(variant) ? variant.body : action.output;
      const contentType = record(variant) && text(variant.contentType)
        ? variant.contentType
        : action.path.includes("/content")
        ? "application/octet-stream"
        : "application/json";
      const bodySchema = {
        $ref: `#/components/schemas/${
          typeof body === "string" ? body : action.output
        }`,
      };
      const content = contentType === "*/*"
        ? {
          "application/octet-stream": {
            schema: { $ref: `#/components/schemas/${action.output}` },
          },
          [contentType]: { schema: bodySchema },
        }
        : { [contentType]: { schema: bodySchema } };
      return [status, {
        description: record(variant) && text(variant.description)
          ? variant.description
          : "Successful response",
        ...(body === null ? {} : { content }),
      }];
    }));
    const entry: JsonObject = {
      operationId: action.action,
      parameters: importAction
        ? [
          ...openApiParameters(action, schemas, input),
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: {
              type: "string",
              description:
                `${action.idempotency}; identifies this import request for safe replay handling.`,
            },
          },
          {
            name: "If-Match",
            in: "header",
            required: true,
            schema: {
              type: "string",
              description:
                `${action.idempotency}; quoted strong parent-version ETag for the artifact version being imported; weak and wildcard ETags are not accepted.`,
            },
          },
        ]
        : openApiParameters(action, schemas, input),
      responses: {
        ...responses,
        "400": { description: "Malformed request." },
        "401": { description: "Authentication required." },
        "403": { description: "Forbidden." },
        ...(importAction && action.errors.includes("RESOURCE_NOT_FOUND")
          ? {
            "404": {
              description: "Resource not found (RESOURCE_NOT_FOUND).",
            },
          }
          : {}),
        ...(importAction && action.errors.includes("IDEMPOTENCY_IN_FLIGHT")
          ? {
            "409": {
              description:
                "Idempotency request still in flight (IDEMPOTENCY_IN_FLIGHT).",
            },
          }
          : {}),
        ...(importAction && action.errors.includes("PRECONDITION_FAILED")
          ? {
            "412": {
              description:
                "Parent version precondition failed (PRECONDITION_FAILED).",
            },
          }
          : {}),
        ...(importAction &&
            action.errors.includes("UNPROCESSABLE") &&
            action.errors.includes("IDEMPOTENCY_PAYLOAD_MISMATCH")
          ? {
            "422": {
              description:
                "Unprocessable import (UNPROCESSABLE) or nonretryable idempotency payload mismatch (IDEMPOTENCY_PAYLOAD_MISMATCH).",
            },
          }
          : {}),
        ...(importAction && action.errors.includes("PRECONDITION_REQUIRED")
          ? {
            "428": {
              description: "Precondition required (PRECONDITION_REQUIRED).",
            },
          }
          : {}),
        "500": { description: "Internal server error." },
        ...(importAction &&
            action.errors.includes("DEPENDENCY_UNAVAILABLE")
          ? {
            "503": {
              description: "Dependency unavailable (DEPENDENCY_UNAVAILABLE).",
            },
          }
          : {}),
        ...(importAction && action.errors.includes("DEPENDENCY_TIMEOUT")
          ? {
            "504": {
              description: "Dependency timeout (DEPENDENCY_TIMEOUT).",
            },
          }
          : {}),
      },
    };
    if (
      !["GET", "DELETE"].includes(action.method) ||
      action.input === "SecretRevoke"
    ) {
      entry.requestBody = {
        required: true,
        content: {
          [
            action.action === "worker.artifacts"
              ? "multipart/form-data"
              : "application/json"
          ]: {
            schema: { $ref: `#/components/schemas/${action.input}` },
          },
        },
      };
    }
    paths[action.path][method] = entry;
  }
  const openapi = {
    openapi: "3.1.0",
    info: { title: "Bakery API", version: String(input.schemaVersion ?? 1) },
    paths,
    components: { schemas: componentSchemas(jsonSchemas) },
  };
  assertDescribedOpenApi(openapi);
  const compatibility = { actions, schemas: jsonSchemas, openapi };
  const generated = {
    schemas,
    actions,
    implementedActions: [...implementedActionNames],
    openapi,
    compatibilityDigest: `sha256:${sha256(stable(compatibility))}`,
    mcp: record(input.mcp) ? input.mcp : {},
  };
  if (previous) assertCompatible(previous, generated);
  return generated;
}
