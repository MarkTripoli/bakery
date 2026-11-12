import { z } from "zod";
import type { SupportedLocale } from "@bakery/i18n";
import {
  type ActionAccess as ActionAccessValue,
  assertSafeProjection,
  type CatalogActionName,
  catalogActions,
  contractSchemas,
  isActionAccess,
  isOrganizationContextPolicy,
  isUuid,
  isUuidContractSchema,
  normalizeRoutePath,
  OrganizationContextPolicy,
  type OrganizationContextPolicy as OrganizationContextPolicyValue,
  routeParameterNames,
} from "./contracts.ts";
import { BakeryException } from "./exceptions.ts";

export const ActionKind = Object.freeze(
  {
    Command: "command",
    Query: "query",
  } as const,
);
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];
export const HttpMethod = Object.freeze(
  {
    Get: "GET",
    Post: "POST",
    Patch: "PATCH",
    Put: "PUT",
    Delete: "DELETE",
  } as const,
);
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];
export const TransactionIsolation = Object.freeze(
  {
    ReadCommitted: "read committed",
    RepeatableRead: "repeatable read",
  } as const,
);
export type TransactionIsolation =
  (typeof TransactionIsolation)[keyof typeof TransactionIsolation];
const httpMethods = new Set<string>(Object.values(HttpMethod));
const transactionIsolations: Record<TransactionIsolation, true> = {
  [TransactionIsolation.ReadCommitted]: true,
  [TransactionIsolation.RepeatableRead]: true,
};

export type NormalizedCommandMetadata = Readonly<{
  operation: string;
  idempotencyKey: string;
  target: string;
  expectedVersion?: number;
}>;
export const StableResponseHeaderName = Object.freeze(
  {
    ContentType: "content-type",
    Location: "location",
    ETag: "etag",
  } as const,
);
export type StableResponseHeaderName =
  (typeof StableResponseHeaderName)[keyof typeof StableResponseHeaderName];
export type StableResponseHeaders = Readonly<
  Partial<Record<StableResponseHeaderName, string>>
>;
export type EncodedSuccessResponse = Readonly<{
  status: number;
  body: Uint8Array;
  headers: StableResponseHeaders;
  replayed?: boolean;
}>;
export type ActionPolicy = {
  type: ActionKind;
  access: ActionAccessValue;
  organizationContext?: OrganizationContextPolicyValue;
  /**
   * Route parameter that names the organization the action operates on. When
   * set, the authority runner requires it to match the organization header.
   * Only valid with `RequiredAuthenticatedContext`.
   */
  organizationIdParam?: string;
  /**
   * Access-management mutation that changes who has access or mints a durable
   * credential. The authority runner refuses it with `SESSION_REQUIRED` when
   * the request was authenticated by an access token.
   */
  sessionOnly?: boolean;
  authorize?: (
    context: ActionContext,
    input: unknown,
  ) => void | Promise<void>;
};
export type ActionContext = {
  request: Request;
  params: Readonly<Record<string, string>>;
  requestId: string;
  traceId: string;
  signal: AbortSignal;
  principal?: unknown;
  /**
   * Effective locale resolved for this request (person preference, then
   * `Accept-Language`, then `en`). Carries no authorization meaning.
   */
  locale?: SupportedLocale;
  /**
   * Server-side identifier of the browser session that authenticated this
   * request, when one exists. Carries no authorization meaning; used only to
   * mark a listed session as the caller's own.
   */
  sessionId?: string;
  /**
   * The organization-bound access token that authenticated this request, when
   * one did. Scopes only narrow the principal's live permissions.
   */
  accessToken?: {
    id: string;
    organizationId: string;
    scopes: readonly string[];
  };
};
type RequiredStringOutputFieldNames<Shape extends z.ZodRawShape> = {
  [Key in keyof Shape & string]-?: z.output<Shape[Key]> extends string ? Key
    : never;
}[keyof Shape & string];

export type NaturalIdempotencyInputField<
  InputSchema extends z.ZodType,
> = InputSchema extends z.ZodObject<infer Shape extends z.ZodRawShape>
  ? RequiredStringOutputFieldNames<Shape>
  : string;

export type ActionDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> = {
  name: CatalogActionName;
  method: HttpMethod;
  path: string;
  input: InputSchema;
  output: OutputSchema;
  policy: ActionPolicy;
  transactionIsolation?: TransactionIsolation;
  /**
   * Commands that use a deterministic target-derived replay key instead of
   * requiring callers to send Idempotency-Key.
   */
  naturalIdempotency?: boolean;
  /**
   * Commands that always require a client `Idempotency-Key` and replay through
   * the command runner even in a registry that otherwise scopes replay to
   * natural-idempotency actions. `key` needs only the key (the version
   * precondition travels in the body); `key-and-if-match` also needs a strong
   * `If-Match` on PATCH.
   */
  explicitIdempotency?: "key" | "key-and-if-match";
  /**
   * Validated input field to append to a natural idempotency target.
   * Omit for route-only natural keys.
   */
  naturalIdempotencyInputField?: NaturalIdempotencyInputField<InputSchema>;
  /**
   * Success status for a command. Defaults to 201 for POST and 200 otherwise.
   * Compatibility routes that must match an external provider envelope (for
   * example Better Auth recipient transitions) pin 200 explicitly; a command
   * that only queues work for later (an accepted receipt) pins 202.
   */
  successStatus?: 200 | 201 | 202;
  /**
   * Strong validator a query returns in the ETag header, derived from its
   * validated output; the If-Match value a later command must send.
   */
  responseEtag?: (output: unknown) => string | undefined;
  handler: (
    context: ActionContext,
    input: z.output<InputSchema>,
  ) => z.output<OutputSchema> | Promise<z.output<OutputSchema>>;
};
export type ActionAuthorityRunner = {
  run(
    action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: (authorizedContext: ActionContext) => Promise<unknown>,
  ): Promise<unknown>;
};

export type CommandRunnerRequest = {
  action: ActionDefinition;
  context: ActionContext;
  input: unknown;
  metadata: NormalizedCommandMetadata;
  invokeAndEncode: (
    transactionContext?: ActionContext,
  ) => Promise<EncodedSuccessResponse>;
};
export type CommandRunner = {
  run: (
    request: CommandRunnerRequest,
  ) => EncodedSuccessResponse | Promise<EncodedSuccessResponse>;
};

export class ActionRegistryError extends BakeryException {
  constructor(message: string) {
    super(message);
    this.name = "ActionRegistryError";
  }
}

export class ActionAuthorizationError extends ActionRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "ActionAuthorizationError";
  }
}

export const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const MAX_ENCODED_RESPONSE_BYTES = 1024 * 1024;
const MAX_STABLE_HEADER_VALUE_BYTES = 2048;
const stableResponseHeaderNames = new Set<string>(
  Object.values(StableResponseHeaderName),
);

function invalidEncodedResponse(action: ActionDefinition): ActionRegistryError {
  return new ActionRegistryError(
    `action ${action.name} returned an invalid encoded success response`,
  );
}

function successStatus(
  action: Pick<ActionDefinition, "method" | "output" | "successStatus">,
): number {
  if (action.output === contractSchemas.NoContent) return 204;
  return action.successStatus ??
    (action.method.toUpperCase() === "POST" ? 201 : 200);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isEncodedSuccessResponse(
  value: unknown,
): value is EncodedSuccessResponse {
  return isPlainRecord(value) && typeof value.status === "number" &&
    value.body instanceof Uint8Array && isPlainRecord(value.headers);
}

export function validateEncodedSuccessResponse(
  action: ActionDefinition,
  value: unknown,
): EncodedSuccessResponse {
  if (!isEncodedSuccessResponse(value)) throw invalidEncodedResponse(action);
  if (
    !Number.isInteger(value.status) || value.status !== successStatus(action) ||
    value.body.byteLength > MAX_ENCODED_RESPONSE_BYTES ||
    value.body.byteLength > 0 && value.status === 204 ||
    action.output !== contractSchemas.NoContent && value.body.byteLength === 0
  ) throw invalidEncodedResponse(action);
  if (value.replayed !== undefined && typeof value.replayed !== "boolean") {
    throw invalidEncodedResponse(action);
  }
  for (const [name, header] of Object.entries(value.headers)) {
    if (
      !stableResponseHeaderNames.has(name) || typeof header !== "string" ||
      /[\r\n]/.test(header) ||
      new TextEncoder().encode(header).byteLength >
        MAX_STABLE_HEADER_VALUE_BYTES
    ) throw invalidEncodedResponse(action);
  }
  if (value.body.byteLength) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(value.body),
      );
    } catch {
      throw invalidEncodedResponse(action);
    }
    if (!action.output.safeParse(parsed).success) {
      throw invalidEncodedResponse(action);
    }
  }
  return value;
}

export function encodeValidatedSuccess(
  action: ActionDefinition,
  result: unknown,
): EncodedSuccessResponse {
  const validated = action.output.safeParse(result);
  if (!validated.success) {
    throw new ActionRegistryError(
      `action ${action.name} returned an invalid output`,
    );
  }
  if (action.output === contractSchemas.NoContent) {
    return validateEncodedSuccessResponse(action, {
      status: 204,
      body: new Uint8Array(),
      headers: {},
    });
  }
  const serialized = JSON.stringify(validated.data);
  if (serialized === undefined) {
    throw new ActionRegistryError(
      `action ${action.name} returned an invalid output`,
    );
  }
  return validateEncodedSuccessResponse(action, {
    status: successStatus(action),
    body: new TextEncoder().encode(serialized),
    headers: { [StableResponseHeaderName.ContentType]: "application/json" },
  });
}

export function canonicalResourceIdentifier(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

type InputFieldSchemas = Readonly<Record<string, z.ZodType>>;

function inputFieldSchemas(input: z.ZodType): InputFieldSchemas {
  if (!(input instanceof z.ZodObject)) return {};
  const shape = (input as z.ZodObject)._def.shape;
  return typeof shape === "function" ? shape() : shape;
}
function isRequiredStringInputSchema(schema: unknown): boolean {
  if (schema instanceof z.ZodReadonly) {
    return isRequiredStringInputSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodNonOptional) {
    const inner = schema.unwrap();
    return isRequiredStringInputSchema(
      inner instanceof z.ZodOptional ? inner.unwrap() : inner,
    );
  }
  return schema instanceof z.ZodString || schema instanceof z.ZodUUID;
}

function isUuidInputField(
  fields: InputFieldSchemas,
  name: string,
  fallbackByName: boolean,
): boolean {
  const schema = fields[name];
  return schema === undefined
    ? fallbackByName && /^(?:id|.*Id)$/.test(name)
    : isUuidContractSchema(schema);
}

export function canonicalRouteParams(
  params: Readonly<Record<string, string>>,
  input: z.ZodType,
): Readonly<Record<string, string>> {
  const fields = inputFieldSchemas(input);
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      isUuidInputField(fields, name, true)
        ? canonicalResourceIdentifier(value)
        : value,
    ]),
  );
}

function canonicalActionInput(
  action: Pick<
    ActionDefinition,
    "input" | "naturalIdempotencyInputField"
  >,
  input: unknown,
  pathNames: readonly string[],
): unknown {
  if (!isPlainRecord(input)) return input;
  const inputFields = inputFieldSchemas(action.input);
  const fields = new Set(
    Object.entries(inputFields).flatMap(([field, schema]) =>
      isUuidContractSchema(schema) ? [field] : []
    ),
  );
  for (const field of pathNames) {
    if (isUuidInputField(inputFields, field, true)) fields.add(field);
  }
  const naturalField = action.naturalIdempotencyInputField;
  if (
    typeof naturalField === "string" &&
    isUuidInputField(inputFields, naturalField, false)
  ) {
    fields.add(naturalField);
  }
  let canonical: Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const normalized = canonicalResourceIdentifier(value);
    if (normalized === value) continue;
    canonical ??= { ...input };
    canonical[field] = normalized;
  }
  return canonical ?? input;
}

function validateCommandMetadata(
  action: ActionDefinition,
  context: ActionContext,
  metadata: unknown,
): NormalizedCommandMetadata {
  if (!isPlainRecord(metadata)) {
    throw new ActionRegistryError(
      `action ${action.name} requires normalized command metadata`,
    );
  }
  const key = metadata.idempotencyKey;
  const target = metadata.target;
  const expectedVersion = metadata.expectedVersion;
  const validExpectedVersion = expectedVersion === undefined ||
    typeof expectedVersion === "number" &&
      Number.isSafeInteger(expectedVersion) && expectedVersion >= 1;
  if (
    metadata.operation !== action.name || typeof key !== "string" ||
    !key.trim() || new TextEncoder().encode(key).byteLength >
      MAX_IDEMPOTENCY_KEY_BYTES ||
    typeof target !== "string" || !target ||
    target !== normalizeRegisteredRouteTarget(action, context.params) ||
    !validExpectedVersion
  ) {
    throw new ActionRegistryError(
      `action ${action.name} requires valid normalized command metadata`,
    );
  }
  return metadata as NormalizedCommandMetadata;
}

export function normalizeRegisteredRouteTarget(
  action: Pick<ActionDefinition, "path"> | string,
  params: Readonly<Record<string, string>>,
): string {
  const path = typeof action === "string" ? action : action.path;
  return path.replace(
    /:([A-Za-z0-9_]+)|\{([^}]+)\}/g,
    (_match, colonName: string | undefined, braceName: string | undefined) => {
      const name = colonName ?? braceName;
      if (!name) {
        throw new ActionRegistryError("route target has an unnamed parameter");
      }
      const value = params[name];
      if (value === undefined) {
        throw new ActionRegistryError(
          `route target is missing parameter ${name}`,
        );
      }
      return encodeURIComponent(value);
    },
  );
}

const actionTypes = new Set<ActionKind>([
  ActionKind.Command,
  ActionKind.Query,
]);
export class ActionRegistry {
  readonly #actions = new Map<string, ActionDefinition>();
  readonly #bindings = new Map<string, string>();
  readonly #authorityRunner?: ActionAuthorityRunner;
  readonly #commandRunner?: CommandRunner;
  readonly #commandRunnerScope: "all" | "natural-idempotency";
  constructor(
    authorityRunner?: ActionAuthorityRunner,
    commandRunner?: CommandRunner,
    commandRunnerScope: "all" | "natural-idempotency" = "all",
  ) {
    this.#authorityRunner = authorityRunner;
    this.#commandRunner = commandRunner;
    this.#commandRunnerScope = commandRunnerScope;
  }
  register<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ActionDefinition<InputSchema, OutputSchema>,
  ): this {
    if (!definition.name || this.#actions.has(definition.name)) {
      throw new ActionRegistryError(
        `duplicate action registration: ${definition.name || "<empty>"}`,
      );
    }
    if (
      !actionTypes.has(definition.policy?.type) ||
      !isActionAccess(definition.policy.access)
    ) {
      throw new ActionRegistryError(
        `action ${definition.name} requires an explicit valid policy`,
      );
    }
    if (
      !isOrganizationContextPolicy(
        definition.policy.organizationContext ?? OrganizationContextPolicy.None,
      )
    ) {
      throw new ActionRegistryError(
        `action ${definition.name} requires a valid organization context policy`,
      );
    }
    if (
      definition.transactionIsolation !== undefined &&
      !Object.hasOwn(transactionIsolations, definition.transactionIsolation)
    ) {
      throw new ActionRegistryError(
        `action ${definition.name} requires a valid transaction isolation`,
      );
    }
    const method = definition.method.toUpperCase() as HttpMethod;
    if (!httpMethods.has(method)) {
      throw new ActionRegistryError(
        `action ${definition.name} uses an unsupported method ${definition.method}`,
      );
    }
    const { organizationIdParam, organizationContext } = definition.policy;
    if (
      organizationIdParam !== undefined &&
      (organizationContext !==
          OrganizationContextPolicy.RequiredAuthenticatedContext ||
        !routeParameterNames(definition.path).includes(organizationIdParam))
    ) {
      throw new ActionRegistryError(
        `action ${definition.name} declares organizationIdParam ${organizationIdParam} that is not a route parameter of a required-context action`,
      );
    }
    const binding = `${method} ${normalizeRoutePath(definition.path)}`;
    const existing = this.#bindings.get(binding);
    if (existing) {
      throw new ActionRegistryError(
        `duplicate action binding: ${binding} (${existing}, ${definition.name})`,
      );
    }
    if (
      !(definition.input instanceof z.ZodType) ||
      !(definition.output instanceof z.ZodType)
    ) {
      throw new ActionRegistryError(
        `action ${definition.name} requires physical input and output schemas`,
      );
    }
    if (definition.naturalIdempotencyInputField !== undefined) {
      const shape = definition.input instanceof z.ZodObject
        ? (definition.input as z.ZodObject)._def.shape
        : undefined;
      const fields = typeof shape === "function" ? shape() : shape;
      const field = definition.naturalIdempotencyInputField;
      const identitySchema = typeof field === "string"
        ? fields?.[field]
        : undefined;
      if (
        typeof field !== "string" ||
        field.length === 0 ||
        definition.naturalIdempotency !== true ||
        definition.policy.type !== ActionKind.Command ||
        !isRequiredStringInputSchema(identitySchema)
      ) {
        throw new ActionRegistryError(
          `action ${definition.name} requires a valid natural idempotency input field`,
        );
      }
    }
    assertSafeProjection(
      definition.output,
      `actions.${definition.name}.output`,
    );
    this.#actions.set(
      definition.name,
      { ...definition, method } as ActionDefinition,
    );
    this.#bindings.set(binding, definition.name);
    return this;
  }
  get(name: string): ActionDefinition {
    const action = this.#actions.get(name);
    if (!action) {
      throw new ActionRegistryError(`unknown action: ${name}`);
    }
    return action;
  }
  list(): readonly ActionDefinition[] {
    return [...this.#actions.values()];
  }
  async execute(
    name: string,
    context: ActionContext,
    value: unknown,
    commandMetadata?:
      | NormalizedCommandMetadata
      | ((input: unknown) => NormalizedCommandMetadata),
  ): Promise<unknown> {
    const action = this.get(name);
    if (context.signal.aborted) {
      throw new DOMException("Action aborted", "AbortError");
    }
    const { input, output } = action;
    const pathNames = routeParameterNames(action.path);
    const fields = inputFieldSchemas(input);
    const normalizedContext = Object.assign({}, context, {
      params: canonicalRouteParams(context.params, input),
    }) as ActionContext;
    if (pathNames.length) {
      const pathSchema = z.object(
        Object.fromEntries(pathNames.map((name) => [
          name,
          fields[name] ??
            (/^(?:id|.*Id)$/.test(name)
              ? z.string().uuid().describe(`UUID route identifier ${name}.`)
              : z.string().min(1).describe(
                `Non-empty route parameter ${name}.`,
              )),
        ])),
      ).strict().describe("Validated route parameters for this action.");
      const parsedPath = pathSchema.safeParse(normalizedContext.params);
      if (!parsedPath.success) throw parsedPath.error;
    }
    const parsed = input.safeParse(value);
    if (!parsed.success) throw parsed.error;
    const normalizedInput = canonicalActionInput(
      action,
      parsed.data,
      pathNames,
    );
    if (isPlainRecord(normalizedInput)) {
      for (const name of pathNames) {
        if (
          name in normalizedInput &&
          normalizedInput[name] !== normalizedContext.params[name]
        ) {
          throw new z.ZodError([{
            code: "custom",
            path: [name],
            message: "Route parameter conflicts with input.",
          }]);
        }
      }
    }
    const organizationContext = action.policy.organizationContext ??
      OrganizationContextPolicy.None;
    const scoped = organizationContext !== OrganizationContextPolicy.None;
    if (scoped && !this.#authorityRunner) {
      throw new ActionAuthorizationError(
        `action ${name} has no authority runner`,
      );
    }
    if (
      action.policy.access !== "Public" && !scoped && !action.policy.authorize
    ) {
      throw new ActionAuthorizationError(
        `action ${name} has no authorization guard`,
      );
    }
    const next = async (authorizedContext: ActionContext) => {
      await action.policy.authorize?.(authorizedContext, normalizedInput);
      if (authorizedContext.signal.aborted) {
        throw new DOMException("Action aborted", "AbortError");
      }
      const commandRunner = action.policy.type === ActionKind.Command &&
          this.#commandRunner &&
          (this.#commandRunnerScope === "all" || action.naturalIdempotency ||
            action.explicitIdempotency !== undefined)
        ? this.#commandRunner
        : undefined;
      const metadata =
        action.policy.type === ActionKind.Command && commandMetadata &&
          (commandRunner || action.naturalIdempotency)
          ? validateCommandMetadata(
            action,
            authorizedContext,
            typeof commandMetadata === "function"
              ? commandMetadata(normalizedInput)
              : commandMetadata,
          )
          : undefined;
      if (commandRunner) {
        if (!metadata) {
          throw new ActionRegistryError(
            `action ${name} requires normalized command metadata`,
          );
        }
        const invokeAndEncode = async (
          transactionContext = authorizedContext,
        ) =>
          encodeValidatedSuccess(
            action,
            await action.handler(transactionContext, normalizedInput),
          );
        return validateEncodedSuccessResponse(
          action,
          await commandRunner.run({
            action,
            context: authorizedContext,
            input: normalizedInput,
            metadata,
            invokeAndEncode,
          }),
        );
      }
      const handlerContext = metadata
        ? Object.assign({}, authorizedContext, {
          commandMetadata: metadata,
        }) as ActionContext
        : authorizedContext;
      const result = await action.handler(handlerContext, normalizedInput);
      const validated = output.safeParse(result);
      if (!validated.success) {
        throw new ActionRegistryError(
          `action ${name} returned an invalid output`,
        );
      }
      return validated.data;
    };
    const result = scoped && this.#authorityRunner
      ? await this.#authorityRunner.run(
        action,
        normalizedContext,
        normalizedInput,
        next,
      )
      : await next(normalizedContext);
    return result;
  }
}

function describeMismatchValue(value: unknown): string {
  return value instanceof z.ZodType
    ? value.description ?? "<schema>"
    : String(value);
}

export function assertRegisteredActions(
  registry: Pick<ActionRegistry, "list">,
): void {
  for (const action of registry.list()) {
    const matches = catalogActions.filter((catalog) =>
      catalog.action === action.name
    );
    if (matches.length !== 1) {
      throw new ActionRegistryError(
        `action ${action.name} must match exactly one catalog entry (found ${matches.length})`,
      );
    }
    const catalog = matches[0];
    const fields: [string, unknown, unknown][] = [
      ["method", action.method.toUpperCase(), catalog.method.toUpperCase()],
      [
        "path",
        normalizeRoutePath(action.path),
        normalizeRoutePath(catalog.path),
      ],
      [
        "path parameter names",
        routeParameterNames(action.path).join(","),
        routeParameterNames(catalog.path).join(","),
      ],
      ["input", action.input, contractSchemas[catalog.input]],
      ["output", action.output, contractSchemas[catalog.output]],
      ["access", action.policy.access, catalog.access],
      [
        "organization context",
        action.policy.organizationContext ?? OrganizationContextPolicy.None,
        catalog.organizationContext ?? OrganizationContextPolicy.None,
      ],
      [
        "natural idempotency",
        action.naturalIdempotency === true,
        catalog.idempotencyKeyOptional === true,
      ],
    ];
    if (
      action.policy.organizationIdParam !== undefined ||
      catalog.organizationIdParam !== undefined
    ) {
      fields.push([
        "organization id route parameter",
        action.policy.organizationIdParam,
        catalog.organizationIdParam,
      ]);
    }
    for (const [field, actual, expected] of fields) {
      if (actual !== expected) {
        throw new ActionRegistryError(
          `action ${action.name} ${field} mismatch: runtime ${
            describeMismatchValue(actual)
          }, catalog ${describeMismatchValue(expected)}`,
        );
      }
    }
  }
}

export function coerceQueryInput(
  schema: z.ZodType,
  value: Record<string, string>,
): Record<string, unknown> {
  const shape = (schema as z.ZodObject)._def.shape;
  const fields = typeof shape === "function" ? shape() : shape;
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      let field = fields[key] as z.ZodType | undefined;
      while (
        field?._def.type === "optional" || field?._def.type === "nullable"
      ) {
        field = (field._def as unknown as { innerType: z.ZodType }).innerType;
      }
      if (field?._def.type === "number" && /^-?(?:\d+|\d*\.\d+)$/.test(raw)) {
        return [key, Number(raw)];
      }
      // Only the exact literals; anything else stays a string and fails the
      // boolean schema.
      if (
        field?._def.type === "boolean" && (raw === "true" || raw === "false")
      ) {
        return [key, raw === "true"];
      }
      return [key, raw];
    }),
  );
}
