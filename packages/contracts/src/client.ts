import {
  type ClientActionDescriptor,
  clientManifest,
} from "../generated/client-manifest.ts";
import { type HealthResponse, healthResponseSchema } from "./health.ts";
import { type ContractOutput, contractSchemas } from "./contracts.ts";

export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  retryable: boolean;
  detail?: string;
  instance?: string;
  requestId?: string;
  traceId?: string;
  resetRequired?: boolean;
  retainedFrom?: string;
  retryWithoutAfter?: boolean;
  /** Which state rule a 409 STATE_CONFLICT refused on, e.g. `approval_required`. */
  reason?: string;
  /** Stable `code` of each reported issue, in order, e.g. a probe outcome. */
  issueCodes?: readonly string[];
};

export class ApiProblemError extends Error {
  override readonly name = "ApiProblemError";

  constructor(readonly problem: ApiProblem) {
    super(`Bakery API request failed (${problem.status} ${problem.code})`);
  }
}

export type ApiTransportErrorKind = "network" | "aborted" | "protocol";

export class ApiTransportError extends Error {
  override readonly name = "ApiTransportError";

  constructor(
    readonly kind: ApiTransportErrorKind,
    readonly status?: number,
  ) {
    super(`Bakery API ${kind} error`);
  }
}

export type BakeryClientContext = {
  organizationId?: string;
};

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export type BakeryClientOptions = {
  baseUrl: string;
  fetch?: FetchImplementation;
  getContext?: () => BakeryClientContext;
  createRequestId?: () => string;
};

type ActionName = ClientActionDescriptor["action"];
type DescriptorFor<Name extends ActionName> = Extract<
  ClientActionDescriptor,
  { action: Name }
>;
type SchemaValue<Schema> = Schema extends {
  readonly anyOf: readonly (infer Variant)[];
} ? SchemaValue<Variant>
  : Schema extends { readonly oneOf: readonly (infer Variant)[] }
    ? SchemaValue<Variant>
  : Schema extends { readonly enum: readonly (infer Value)[] } ? Value
  : Schema extends { readonly const: infer Value } ? Value
  : Schema extends { readonly type: "string" } ? string
  : Schema extends { readonly type: "integer" | "number" } ? number
  : Schema extends { readonly type: "boolean" } ? boolean
  : Schema extends { readonly type: "null" } ? null
  : Schema extends {
    readonly type: "array";
    readonly items: infer Item;
  } ? SchemaValue<Item>[]
  : Schema extends {
    readonly type: "object";
    readonly properties: infer Properties extends Record<string, unknown>;
    readonly required: readonly (infer Required extends string)[];
  } ?
      & {
        [Name in Extract<keyof Properties, Required>]: SchemaValue<
          Properties[Name]
        >;
      }
      & {
        [Name in Exclude<keyof Properties, Required>]?: SchemaValue<
          Properties[Name]
        >;
      }
  : Schema extends {
    readonly type: "object";
    readonly properties: infer Properties extends Record<string, unknown>;
  } ? { [Name in keyof Properties]?: SchemaValue<Properties[Name]> }
  : unknown;
type ClientSchemaName = keyof typeof clientManifest.schemas;
export type ClientInputMap = {
  [Name in ClientSchemaName]: SchemaValue<
    (typeof clientManifest.schemas)[Name]
  >;
};
export type BinaryArtifactClientResponse =
  | {
    status: 200;
    contentType: string;
    contentLength: number;
    contentDigest: string;
    content: Uint8Array;
    contentRange?: undefined;
  }
  | {
    status: 206;
    contentType: string;
    contentLength: number;
    contentDigest: string;
    content: Uint8Array;
    contentRange: string;
  }
  | {
    status: 416;
    contentType: string;
    contentLength: 0;
    contentDigest: string;
    content: Uint8Array;
    contentRange: string;
  };
export type ClientOutputMap = {
  [Name in ClientSchemaName]: Name extends "BinaryArtifact"
    ? BinaryArtifactClientResponse
    : ClientInputMap[Name];
};

type WebSocketFrameValue = ContractOutput<"WebSocketFrame">;
export type OutputSocketClientFrame = Extract<
  WebSocketFrameValue,
  { type: "output.subscribe" }
>;
export type OutputSocketServerFrame = Extract<
  WebSocketFrameValue,
  { type: "output.batch" | "output.cursor" | "output.reset_required" }
>;
type PathParameterNames<Path extends string> = Path extends
  `${string}{${infer Name}}${infer Rest}` ? Name | PathParameterNames<Rest>
  : never;
type PathInput<Path extends string> = [PathParameterNames<Path>] extends [never]
  ? unknown
  : { [Name in PathParameterNames<Path>]: string };
type ActionInput<Action extends ClientActionDescriptor> =
  & ClientInputMap[Action["input"]]
  & PathInput<Action["path"]>;
type BaseRequestOptions = {
  signal?: AbortSignal;
  requestId?: string;
};
type IdempotencyOptions<Action extends ClientActionDescriptor> = Action extends
  { readonly idempotencyKeyOptional: true } ? { idempotencyKey?: string }
  : Action["idempotency"] extends `${string}Idempotency-Key${string}`
    ? { idempotencyKey?: string }
  : { idempotencyKey?: never };
type ConcurrencyOptions<Action extends ClientActionDescriptor> =
  Action["idempotency"] extends `${string}If-Match${string}`
    ? { ifMatch?: string }
    : { ifMatch?: never };
export type ActionRequestOptions<Action extends ClientActionDescriptor> =
  & BaseRequestOptions
  & IdempotencyOptions<Action>
  & ConcurrencyOptions<Action>;
export type BakeryClientActions = {
  [Name in ActionName]: (
    input: ActionInput<DescriptorFor<Name>>,
    options?: ActionRequestOptions<DescriptorFor<Name>>,
  ) => Promise<
    DescriptorFor<Name>["output"] extends "NoContent" ? void
      : ClientOutputMap[DescriptorFor<Name>["output"]]
  >;
};

export type BakeryClient = {
  health: {
    live(options?: BaseRequestOptions): Promise<HealthResponse>;
    ready(options?: BaseRequestOptions): Promise<HealthResponse>;
  };
  actions: BakeryClientActions;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolvesLocalReference(
  reference: string,
  root: JsonObject,
): unknown {
  if (!reference.startsWith("#/$defs/") || !isObject(root.$defs)) {
    return undefined;
  }
  return root.$defs[reference.slice("#/$defs/".length)];
}

function matchesFormat(value: string, format: unknown): boolean {
  if (format === "uuid") {
    return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i
      .test(value);
  }
  if (format === "uri") {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (format === "date-time") {
    return !Number.isNaN(Date.parse(value));
  }
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return true;
}

function matchesJsonSchema(
  value: unknown,
  schemaValue: unknown,
  root: JsonObject,
  depth = 0,
): boolean {
  if (depth > 100 || typeof schemaValue === "boolean") {
    return schemaValue === true;
  }
  if (!isObject(schemaValue)) return false;
  if (typeof schemaValue.$ref === "string") {
    const target = resolvesLocalReference(schemaValue.$ref, root);
    return target !== undefined &&
      matchesJsonSchema(value, target, root, depth + 1);
  }
  if (
    Array.isArray(schemaValue.allOf) &&
    !schemaValue.allOf.every((part) =>
      matchesJsonSchema(value, part, root, depth + 1)
    )
  ) return false;
  if (
    Array.isArray(schemaValue.anyOf) &&
    !schemaValue.anyOf.some((part) =>
      matchesJsonSchema(value, part, root, depth + 1)
    )
  ) return false;
  if (Array.isArray(schemaValue.oneOf)) {
    const count = schemaValue.oneOf.filter((part) =>
      matchesJsonSchema(value, part, root, depth + 1)
    ).length;
    if (count !== 1) {
      return false;
    }
  }
  if ("const" in schemaValue && !Object.is(value, schemaValue.const)) {
    return false;
  }
  if (
    Array.isArray(schemaValue.enum) &&
    !schemaValue.enum.some((entry) => Object.is(value, entry))
  ) return false;

  const types = Array.isArray(schemaValue.type)
    ? schemaValue.type
    : schemaValue.type === undefined
    ? []
    : [schemaValue.type];
  if (types.length > 0) {
    const validType = types.some((type) => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object") return isObject(value);
      if (type === "integer") {
        return typeof value === "number" && Number.isInteger(value);
      }
      if (type === "string") return typeof value === "string";
      if (type === "number") return typeof value === "number";
      if (type === "boolean") return typeof value === "boolean";
      return false;
    });
    if (!validType) return false;
  }

  if (typeof value === "string") {
    if (
      typeof schemaValue.minLength === "number" &&
      value.length < schemaValue.minLength
    ) return false;
    if (
      typeof schemaValue.maxLength === "number" &&
      value.length > schemaValue.maxLength
    ) return false;
    if (
      typeof schemaValue.pattern === "string" &&
      !new RegExp(schemaValue.pattern, "u").test(value)
    ) return false;
    if (!matchesFormat(value, schemaValue.format)) return false;
  }

  if (typeof value === "number") {
    if (
      typeof schemaValue.minimum === "number" && value < schemaValue.minimum
    ) {
      return false;
    }
    if (
      typeof schemaValue.maximum === "number" && value > schemaValue.maximum
    ) {
      return false;
    }
    if (
      typeof schemaValue.exclusiveMinimum === "number" &&
      value <= schemaValue.exclusiveMinimum
    ) return false;
    if (
      typeof schemaValue.exclusiveMaximum === "number" &&
      value >= schemaValue.exclusiveMaximum
    ) return false;
  }

  if (Array.isArray(value)) {
    if (
      typeof schemaValue.minItems === "number" &&
      value.length < schemaValue.minItems
    ) {
      return false;
    }
    if (
      typeof schemaValue.maxItems === "number" &&
      value.length > schemaValue.maxItems
    ) {
      return false;
    }
    if (
      schemaValue.items !== undefined &&
      !value.every((entry) =>
        matchesJsonSchema(entry, schemaValue.items, root, depth + 1)
      )
    ) return false;
  }

  if (isObject(value)) {
    const properties = isObject(schemaValue.properties)
      ? schemaValue.properties
      : {};
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required
      : [];
    if (
      required.some((name) => typeof name !== "string" || !(name in value))
    ) return false;
    for (const [name, entry] of Object.entries(value)) {
      if (name in properties) {
        if (!matchesJsonSchema(entry, properties[name], root, depth + 1)) {
          return false;
        }
      } else if (schemaValue.additionalProperties === false) {
        return false;
      } else if (
        isObject(schemaValue.additionalProperties) &&
        !matchesJsonSchema(
          entry,
          schemaValue.additionalProperties,
          root,
          depth + 1,
        )
      ) return false;
    }
  }
  return true;
}

function validateSchema(value: unknown, schema: unknown): boolean {
  return isObject(schema) && matchesJsonSchema(value, schema, schema);
}

export function isOutputSocketServerFrame(
  value: unknown,
): value is OutputSocketServerFrame {
  if (!contractSchemas.WebSocketFrame.safeParse(value).success) return false;
  const type = (value as { type?: unknown }).type;
  return type === "output.batch" || type === "output.cursor" ||
    type === "output.reset_required";
}

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

const INPUT_COMPOSITION_KEYS = ["allOf", "anyOf", "oneOf"] as const;

function collectInputPropertyNames(
  schema: unknown,
  names: Set<string>,
): void {
  if (!isObject(schema)) return;
  if (isObject(schema.properties)) {
    for (const name in schema.properties) {
      if (Object.hasOwn(schema.properties, name)) names.add(name);
    }
  }
  for (const keyword of INPUT_COMPOSITION_KEYS) {
    const variants = schema[keyword];
    if (Array.isArray(variants)) {
      for (const variant of variants) collectInputPropertyNames(variant, names);
    }
  }
}

function inputPropertyNames(schema: unknown): string[] {
  const names = new Set<string>();
  collectInputPropertyNames(schema, names);
  return [...names];
}

function filteredInput(
  input: JsonObject,
  propertyNames: readonly string[],
): JsonObject {
  return Object.fromEntries(
    propertyNames.filter((name) => input[name] !== undefined).map((name) => [
      name,
      input[name],
    ]),
  );
}

async function parseBinaryArtifactResponse(
  response: Response,
): Promise<BinaryArtifactClientResponse> {
  const status = response.status;
  if (status !== 200 && status !== 206 && status !== 416) {
    throw new ApiTransportError("protocol", status);
  }
  const contentType = response.headers.get("content-type")?.trim();
  const contentLengthHeader = response.headers.get("content-length");
  const contentDigest = /^"([0-9a-f]{64})"$/.exec(
    response.headers.get("etag") ?? "",
  )?.[1];
  if (
    !contentType ||
    !contentLengthHeader ||
    !/^(?:0|[1-9]\d*)$/.test(contentLengthHeader) ||
    !contentDigest
  ) {
    throw new ApiTransportError("protocol", status);
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ApiTransportError("protocol", status);
  }
  const contentRange = response.headers.get("content-range")?.trim();
  if (
    (status === 206 && !contentRange) ||
    (status === 416 &&
      !/^bytes \*\/(?:0|[1-9]\d*)$/.test(contentRange ?? "")) ||
    (status === 200 && contentRange)
  ) {
    throw new ApiTransportError("protocol", status);
  }
  if (status === 206) {
    const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
      contentRange ?? "",
    );
    if (!range) throw new ApiTransportError("protocol", status);
    const start = Number(range[1]);
    const end = Number(range[2]);
    const total = Number(range[3]);
    const intervalLength = end - start + 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(intervalLength) ||
      start > end ||
      end >= total ||
      intervalLength !== contentLength
    ) {
      throw new ApiTransportError("protocol", status);
    }
  }
  let content: Uint8Array;
  try {
    content = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new ApiTransportError("protocol", status);
  }
  if (content.byteLength !== contentLength) {
    throw new ApiTransportError("protocol", status);
  }
  if (status === 416) {
    if (contentLength !== 0) {
      throw new ApiTransportError("protocol", status);
    }
    return {
      status: 416,
      contentType,
      contentLength: 0,
      contentDigest,
      content,
      contentRange: contentRange as string,
    };
  }
  if (status === 206) {
    return {
      status: 206,
      contentType,
      contentLength,
      contentDigest,
      content,
      contentRange: contentRange as string,
    };
  }
  return {
    status: 200,
    contentType,
    contentLength,
    contentDigest,
    content,
  };
}

function contentTypeIsJson(response: Response): boolean {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  return mediaType === "application/json" ||
    mediaType?.endsWith("+json") === true;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (!contentTypeIsJson(response)) {
    throw new ApiTransportError("protocol", response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ApiTransportError("protocol", response.status);
  }
}

function issueCodes(issues: unknown): readonly string[] | undefined {
  if (!Array.isArray(issues)) return undefined;
  const codes = issues.slice(0, 8).flatMap((issue) =>
    isObject(issue) && typeof issue.code === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(issue.code)
      ? [issue.code]
      : []
  );
  return codes.length > 0 ? codes : undefined;
}

/** RFC 6901 JSON Pointer for a server issue path; strings pass through. */
function issuePointer(path: unknown): unknown {
  if (!Array.isArray(path)) return path;
  return path.map((part) =>
    `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`
  ).join("");
}

/**
 * The server sends issue paths as arrays; the declared Problem schema wants a
 * JSON Pointer string. Normalize before validating, keep strings as they are.
 */
function normalizeIssuePaths(issues: unknown): unknown {
  if (!Array.isArray(issues)) return issues;
  return issues.map((issue) =>
    isObject(issue) && Array.isArray(issue.path)
      ? { ...issue, path: issuePointer(issue.path) }
      : issue
  );
}

function safeProblem(value: unknown): ApiProblem | undefined {
  const schema = clientManifest.schemas.Problem;
  if (!isObject(schema) || !isObject(value)) return undefined;
  // RFC 9457 permits extension members; validate the declared ones only.
  const properties = isObject(schema.properties) ? schema.properties : {};
  const declared = Object.fromEntries(
    Object.entries(value).filter(([name]) => name in properties).map((
      [name, entry],
    ) => [name, name === "issues" ? normalizeIssuePaths(entry) : entry]),
  );
  if (!validateSchema(declared, schema)) return undefined;
  return {
    type: declared.type as string,
    title: declared.title as string,
    status: declared.status as number,
    code: declared.code as string,
    retryable: declared.retryable as boolean,
    ...(typeof declared.detail === "string" ? { detail: declared.detail } : {}),
    ...(typeof declared.instance === "string"
      ? { instance: declared.instance }
      : {}),
    ...(typeof declared.requestId === "string"
      ? { requestId: declared.requestId }
      : {}),
    ...(typeof declared.traceId === "string"
      ? { traceId: declared.traceId }
      : {}),
    ...(typeof declared.resetRequired === "boolean"
      ? { resetRequired: declared.resetRequired }
      : {}),
    ...(typeof declared.retainedFrom === "string"
      ? { retainedFrom: declared.retainedFrom }
      : {}),
    ...(typeof declared.retryWithoutAfter === "boolean"
      ? { retryWithoutAfter: declared.retryWithoutAfter }
      : {}),
    ...(typeof declared.reason === "string" ? { reason: declared.reason } : {}),
    ...(issueCodes(declared.issues)
      ? { issueCodes: issueCodes(declared.issues) }
      : {}),
  };
}

async function checkedFetch(
  fetchImplementation: FetchImplementation,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(input, init);
  } catch {
    if (init.signal?.aborted) throw new ApiTransportError("aborted");
    throw new ApiTransportError("network");
  }
}

const PROBLEM_MEDIA_TYPE = "application/problem+json";

function contentTypeIsProblem(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0].trim()
    .toLowerCase() === PROBLEM_MEDIA_TYPE;
}

async function throwResponseError(response: Response): Promise<never> {
  if (!contentTypeIsProblem(response)) {
    throw new ApiTransportError("protocol", response.status);
  }
  const value = await parseJsonResponse(response);
  const problem = safeProblem(value);
  if (!problem || problem.status !== response.status) {
    throw new ApiTransportError("protocol", response.status);
  }
  throw new ApiProblemError(problem);
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function createBakeryClient(options: BakeryClientOptions): BakeryClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const getContext: () => BakeryClientContext = options.getContext ??
    (() => ({}));
  const createRequestId = options.createRequestId ??
    (() => crypto.randomUUID());

  const requestHealth = async (
    path: string,
    acceptedStatuses: readonly number[],
    requestOptions: BaseRequestOptions = {},
  ): Promise<HealthResponse> => {
    const response = await checkedFetch(
      fetchImplementation,
      joinBaseUrl(options.baseUrl, path),
      {
        method: "GET",
        credentials: "include",
        signal: requestOptions.signal,
        headers: {
          "X-Request-Id": requestOptions.requestId ?? createRequestId(),
        },
      },
    );
    if (!acceptedStatuses.includes(response.status)) {
      return await throwResponseError(response);
    }
    const parsed = healthResponseSchema.safeParse(
      await parseJsonResponse(response),
    );
    if (!parsed.success) {
      throw new ApiTransportError("protocol", response.status);
    }
    return parsed.data;
  };

  const actionEntries = clientManifest.actions.map((descriptor) => {
    const schema = clientManifest.schemas[descriptor.input];
    const schemaProperties = inputPropertyNames(schema);
    const pathNames = pathParameterNames(descriptor.path);
    const allowedNames = new Set([...schemaProperties, ...pathNames]);
    const invoke = async (
      rawInput: JsonObject,
      requestOptions: BaseRequestOptions & {
        idempotencyKey?: string;
        ifMatch?: string;
      } = {},
    ): Promise<unknown> => {
      if (!isObject(rawInput)) throw new ApiTransportError("protocol");
      if (Object.keys(rawInput).some((name) => !allowedNames.has(name))) {
        throw new ApiTransportError("protocol");
      }
      const contractInput = filteredInput(rawInput, schemaProperties);
      if (!validateSchema(contractInput, schema)) {
        throw new ApiTransportError("protocol");
      }

      let path: string = descriptor.path;
      for (const name of pathNames) {
        const value = rawInput[name];
        if (typeof value !== "string" || value.length === 0) {
          throw new ApiTransportError("protocol");
        }
        path = path.replace(`{${name}}`, encodeURIComponent(value));
      }

      const binaryOutput = descriptor.output === "BinaryArtifact";
      const headers = new Headers({
        Accept: binaryOutput ? "application/octet-stream" : "application/json",
        "X-Request-Id": requestOptions.requestId ?? createRequestId(),
      });
      if (binaryOutput && typeof contractInput.range === "string") {
        headers.set("Range", contractInput.range);
      }
      if (descriptor.organizationContext === "required_authenticated_context") {
        const organizationId = getContext().organizationId;
        if (!organizationId) throw new ApiTransportError("protocol");
        if (
          "organizationIdParam" in descriptor &&
          rawInput[descriptor.organizationIdParam] !== organizationId
        ) throw new ApiTransportError("protocol");
        headers.set("Bakery-Organization-Id", organizationId);
      }
      const declaresIdempotency = descriptor.idempotency.includes(
        "Idempotency-Key",
      );
      const allowsNaturalIdempotencyOverride =
        "idempotencyKeyOptional" in descriptor &&
        descriptor.idempotencyKeyOptional === true;
      if (declaresIdempotency) {
        headers.set(
          "Idempotency-Key",
          requestOptions.idempotencyKey ?? crypto.randomUUID(),
        );
      } else if (
        allowsNaturalIdempotencyOverride &&
        requestOptions.idempotencyKey !== undefined
      ) {
        headers.set("Idempotency-Key", requestOptions.idempotencyKey);
      } else if (requestOptions.idempotencyKey !== undefined) {
        throw new ApiTransportError("protocol");
      }
      const declaresIfMatch = descriptor.idempotency.includes("If-Match");
      if (!declaresIfMatch && requestOptions.ifMatch !== undefined) {
        throw new ApiTransportError("protocol");
      }
      if (
        descriptor.idempotency.includes("If-Match required") &&
        requestOptions.ifMatch === undefined
      ) throw new ApiTransportError("protocol");
      if (requestOptions.ifMatch !== undefined) {
        headers.set("If-Match", requestOptions.ifMatch);
      }

      const init: RequestInit = {
        method: descriptor.method,
        credentials: "include",
        headers,
        signal: requestOptions.signal,
      };
      if (descriptor.method === "GET") {
        const query = new URLSearchParams();
        for (const [name, value] of Object.entries(contractInput)) {
          if (
            pathNames.includes(name) ||
            (binaryOutput && name === "range") ||
            value === undefined
          ) continue;
          if (Array.isArray(value)) {
            for (const entry of value) query.append(name, String(entry));
          } else if (isObject(value)) {
            query.set(name, JSON.stringify(value));
          } else {
            query.set(name, String(value));
          }
        }
        const encoded = query.toString();
        if (encoded) path = `${path}?${encoded}`;
      } else if (
        descriptor.method !== "DELETE" || schemaProperties.length > 0
      ) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(contractInput);
      }

      const response = await checkedFetch(
        fetchImplementation,
        joinBaseUrl(options.baseUrl, path),
        init,
      );
      if (binaryOutput && response.status === 416) {
        return await parseBinaryArtifactResponse(response);
      }
      if (!response.ok) return await throwResponseError(response);
      if (descriptor.output === "NoContent") {
        if (response.status !== 204) {
          throw new ApiTransportError("protocol", response.status);
        }
        return undefined;
      }
      if (binaryOutput) {
        return await parseBinaryArtifactResponse(response);
      }
      const output = await parseJsonResponse(response);
      const outputSchema = clientManifest.schemas[descriptor.output];
      if (!validateSchema(output, outputSchema)) {
        throw new ApiTransportError("protocol", response.status);
      }
      return output;
    };
    return [descriptor.action, invoke] as const;
  });

  return {
    health: {
      live: (requestOptions) =>
        requestHealth("/health/live", [200], requestOptions),
      ready: (requestOptions) =>
        requestHealth("/health/ready", [200, 503], requestOptions),
    },
    actions: Object.fromEntries(
      actionEntries,
    ) as unknown as BakeryClientActions,
  };
}
