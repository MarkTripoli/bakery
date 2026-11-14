import { AgentImplementedAction } from "./implemented-actions.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  catalogs,
  createTranslator,
  englishCatalog,
  type MessageKey,
  parseAcceptLanguage,
  resolveLocale,
  type SupportedLocale,
  type Translator,
} from "@bakery/i18n";
import {
  ActionAuthorizationError,
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  canonicalRouteParams,
  coerceQueryInput,
  type EncodedSuccessResponse,
  isEncodedSuccessResponse,
  MAX_IDEMPOTENCY_KEY_BYTES,
  type NormalizedCommandMetadata,
  normalizeRegisteredRouteTarget,
} from "./action-registry.ts";
import { contractSchemas, routeParameterNames } from "./contracts.ts";
import { BakeryException } from "./exceptions.ts";
import { unsafeRequestJson } from "./request-json.ts";

export const FAULTS = {
  AUTH_REQUIRED: [401, false, "auth-required"],
  AUTH_FORBIDDEN: [403, false, "auth-forbidden"],
  RESOURCE_NOT_FOUND: [404, false, "resource-not-found"],
  ARTIFACT_CONTENT_EXPIRED: [410, false, "artifact-content-expired"],
  MALFORMED_REQUEST: [400, false, "malformed-request"],
  VALIDATION_FAILED: [422, false, "validation-failed"],
  UNPROCESSABLE: [422, false, "unprocessable"],
  IDEMPOTENCY_PAYLOAD_MISMATCH: [422, false, "idempotency-payload-mismatch"],
  IDEMPOTENCY_IN_FLIGHT: [409, true, "idempotency-in-flight"],
  PRECONDITION_FAILED: [412, false, "precondition-failed"],
  PRECONDITION_REQUIRED: [428, false, "precondition-required"],
  STATE_CONFLICT: [409, false, "state-conflict"],
  VERSION_CONFLICT: [409, false, "version-conflict"],
  EXPECTED_SEQUENCE: [409, true, "expected-sequence"],
  LEASE_EXPIRED: [409, true, "lease-expired"],
  LEASE_FENCED: [409, false, "lease-fenced"],
  CANCEL_REQUESTED: [409, false, "cancel-requested"],
  ALREADY_TERMINAL: [409, false, "already-terminal"],
  SCOPE_REQUIRED: [403, false, "scope-required"],
  INSUFFICIENT_SCOPE: [403, false, "insufficient-scope"],
  SESSION_REQUIRED: [403, false, "session-required"],
  PROVIDER_QUOTA_EXCEEDED: [429, true, "provider-quota-exceeded"],
  BUDGET_CAP_EXCEEDED: [429, false, "budget-cap-exceeded"],
  EXTERNAL_EFFECT_UNCERTAIN: [409, false, "external-effect-uncertain"],
  DEPENDENCY_UNAVAILABLE: [503, true, "dependency-unavailable"],
  DEPENDENCY_TIMEOUT: [504, true, "dependency-timeout"],
  REVIEWER_UNAVAILABLE: [503, true, "reviewer-unavailable"],
  WORKER_UNAVAILABLE: [503, true, "worker-unavailable"],
  SNAPSHOT_SCOPE_TOO_LARGE: [413, false, "snapshot-scope-too-large"],
  AUTH_INVALID: [401, false, "auth-invalid"],
  AUTH_EXPIRED: [401, false, "auth-expired"],
  AUTH_FACTOR_REQUIRED: [401, false, "auth-factor-required"],
  MALFORMED_JSON: [400, false, "malformed-json"],
  INVALID_CURSOR: [400, false, "invalid-cursor"],
  BODY_TOO_LARGE: [413, false, "body-too-large"],
  UNSUPPORTED_MEDIA_TYPE: [415, false, "unsupported-media-type"],
  WORKER_PROTOCOL_UNSUPPORTED: [426, false, "worker-protocol-unsupported"],
  METHOD_NOT_ALLOWED: [405, false, "method-not-allowed"],
  RATE_LIMITED: [429, true, "rate-limited"],
  INTERNAL: [500, false, "internal"],
  SKILL_CONTENT_INTEGRITY_FAILED: [
    409,
    false,
    "skill-content-integrity-failed",
  ],
} as const;
const ISSUE_PATH_MAX = 200;
const ISSUE_MESSAGE_MAX = 200;
const ISSUE_CODE_MAX = 64;
const ISSUE_COUNT_MAX = 20;
// Codes whose params may carry bounded `issues`. A STATE_CONFLICT lists the
// failed checks behind its reason, such as `ticket_not_ready`.
const ISSUE_FAULTS = new Set<ProblemCode>([
  "MALFORMED_REQUEST",
  "VALIDATION_FAILED",
  "UNPROCESSABLE",
  "STATE_CONFLICT",
]);
export type ProblemCode = keyof typeof FAULTS;

export const AuthProblemCode = Object.freeze(
  {
    Required: "AUTH_REQUIRED",
    Forbidden: "AUTH_FORBIDDEN",
    Invalid: "AUTH_INVALID",
    Expired: "AUTH_EXPIRED",
    FactorRequired: "AUTH_FACTOR_REQUIRED",
    Internal: "INTERNAL",
  } as const satisfies Record<string, ProblemCode>,
);
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  requestId: string;
  traceId: string;
  retryable: boolean;
  issues?: readonly unknown[];
  limit?: number;
  refineScope?: unknown;
  resetRequired?: boolean;
  retainedFrom?: string;
  retryWithoutAfter?: boolean;
  /** Stable slug naming the state rule a STATE_CONFLICT refused on. */
  reason?: string;
  /** Minimal access-token scope bundles that would allow the refused action. */
  requiredScopes?: readonly string[];
};

export class StandardError extends BakeryException {
  readonly code: ProblemCode;
  readonly status?: number;
  readonly safeDetail?: string;
  readonly params?: Record<string, unknown>;
  constructor(
    options: {
      code: ProblemCode;
      status?: number;
      detail?: string;
      params?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(options.detail ?? options.code, { cause: options.cause });
    this.name = "StandardError";
    this.code = options.code;
    this.status = options.status;
    this.safeDetail = options.detail;
    this.params = options.params;
  }
}

export function unprocessable(
  path: readonly (string | number)[],
  code: string,
  cause?: unknown,
): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    cause,
    params: {
      issues: [{ path, code, message: code.replaceAll("_", " ") }],
    },
  });
}

function normalizeActionValidationError(
  actionName: string,
  error: unknown,
): unknown {
  if (
    actionName !== AgentImplementedAction.AgentVersionsCreate ||
    !(error instanceof z.ZodError) || error.issues.length === 0 ||
    error.issues.some((issue) => issue.path[0] !== "config")
  ) return error;
  return new StandardError({
    code: "UNPROCESSABLE",
    cause: error,
    params: {
      issues: error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}

export function requireCommandMetadata(
  context: ActionContext,
): NormalizedCommandMetadata {
  const candidate = context as ActionContext & {
    commandMetadata?: NormalizedCommandMetadata;
  };
  if (!candidate.commandMetadata) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return candidate.commandMetadata;
}
function sanitizeIssues(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, ISSUE_COUNT_MAX).map((issue) => {
    const item = issue && typeof issue === "object"
      ? issue as Record<string, unknown>
      : {};
    const path = Array.isArray(item.path)
      ? item.path.slice(0, 8).map((part) =>
        typeof part === "string"
          ? part.slice(0, ISSUE_PATH_MAX)
          : typeof part === "number" && Number.isSafeInteger(part)
          ? part
          : "invalid"
      )
      : undefined;
    return {
      ...(path ? { path } : {}),
      message: typeof item.message === "string"
        ? item.message.slice(0, ISSUE_MESSAGE_MAX)
        : "Invalid value",
      code: typeof item.code === "string"
        ? item.code.slice(0, ISSUE_CODE_MAX)
        : "custom",
    };
  });
}
export function getTraceId(request: Request): string {
  const value = request.headers.get("traceparent") ?? "";
  return /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(value)
    ?.[1] ?? crypto.randomUUID().replaceAll("-", "");
}
function safeRefineScope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const scope = value as Record<string, unknown>;
  return scope.scopeType === "task" ? { scopeType: "task" } : undefined;
}
function safeResetMetadata(value: unknown):
  | {
    resetRequired: true;
    retainedFrom: string;
    retryWithoutAfter: true;
  }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const params = value as Record<string, unknown>;
  const retainedFrom = params.retainedFrom;
  if (
    params.resetRequired !== true || params.retryWithoutAfter !== true ||
    typeof retainedFrom !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(retainedFrom)
  ) return undefined;
  return { resetRequired: true, retainedFrom, retryWithoutAfter: true };
}
/**
 * A STATE_CONFLICT reason is a developer-chosen slug naming the refused state
 * rule (`approval_required`, `task_not_startable`). Only that shape is echoed;
 * anything else, such as free text or a value built from input, is dropped.
 */
function safeConflictReason(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}
/**
 * The only reasons a DEPENDENCY_UNAVAILABLE may name: a busy draft worker pool
 * or the caller's own organization share of it (#297). An exact allowlist,
 * so a 503 never carries free text or anything about another tenant.
 */
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "draft_worker_pool_busy",
  "draft_worker_organization_share_used",
]);
function safeUnavailableReason(value: unknown): string | undefined {
  return typeof value === "string" && UNAVAILABLE_REASONS.has(value)
    ? value
    : undefined;
}
function problemKey(
  code: ProblemCode,
  part: "title" | "description",
): MessageKey {
  return `problems.${code}.${part}`;
}
/**
 * `toProblem` is the last-resort error formatter and runs inside
 * `createApiRouter`'s catch, so it must never be the thing that throws.
 * `translate` cannot fail on an unknown key (`problemKey` returns `MessageKey`,
 * a compile-time check) or on unparseable ICU (the catalog validator parses
 * every string at build time). It can still fail if someone authors a
 * `{placeholder}` into a Problem title or description, because these are
 * formatted with no arguments — an authoring mistake whose only consequence
 * here is that the raw catalog string is served with its braces intact.
 * The fallback stays in the requested locale so `Content-Language` keeps
 * telling the truth.
 */
function resolveProblemMessage(
  locale: SupportedLocale,
  translate: Translator,
  key: MessageKey,
  fallback: string,
): string {
  try {
    return translate(key);
  } catch {
    return catalogs[locale][key] ?? englishCatalog[key] ?? fallback;
  }
}
let problemErrorReporter: ((error: unknown) => void) | undefined;

export function installProblemErrorReporter(
  reporter: (error: unknown) => void,
): () => void {
  const previous = problemErrorReporter;
  problemErrorReporter = reporter;
  return () => {
    problemErrorReporter = previous;
  };
}

export function toProblem(
  error: unknown,
  options: {
    requestId: string;
    traceId: string;
    publicBaseUrl: string;
    locale?: SupportedLocale;
  },
): Problem {
  const standard = error instanceof StandardError ? error : undefined;
  const isValidation = error instanceof z.ZodError;
  const isCursorValidation = isValidation &&
    error.issues.some((issue) =>
      issue.path[0] === "cursor" || issue.path[0] === "after"
    );
  const code = standard?.code ??
    (isCursorValidation
      ? "INVALID_CURSOR"
      : isValidation
      ? "MALFORMED_REQUEST"
      : error instanceof ActionAuthorizationError
      ? AuthProblemCode.Forbidden
      : "INTERNAL");
  const [defaultStatus, retryable, slug] = FAULTS[code];
  const locale = options.locale ?? "en";
  const translate = createTranslator({ locale, surface: "problem" });
  const rawParams = standard?.params;
  const params =
    (standard && ISSUE_FAULTS.has(standard.code)
      ? standard.params
      : undefined) ?? (isValidation
        ? {
          issues: (error as {
            issues?: readonly {
              path?: readonly (string | number)[];
              message?: string;
              code?: string;
            }[];
          }).issues?.map((issue) => ({
            path: issue.path?.slice(0, 8),
            message: typeof issue.message === "string"
              ? issue.message.slice(0, 200)
              : "Invalid value",
            code: typeof issue.code === "string"
              ? issue.code.slice(0, 64)
              : "custom",
          })),
        }
        : {});
  const issues = sanitizeIssues(
    params && typeof params === "object"
      ? (params as Record<string, unknown>).issues
      : undefined,
  );
  const limit = standard?.code === "BODY_TOO_LARGE" && rawParams &&
      typeof rawParams === "object" && typeof rawParams.limit === "number" &&
      Number.isSafeInteger(rawParams.limit) && rawParams.limit >= 0
    ? rawParams.limit
    : undefined;
  const refineScope = standard?.code === "SNAPSHOT_SCOPE_TOO_LARGE" &&
      rawParams && typeof rawParams === "object"
    ? safeRefineScope((rawParams as Record<string, unknown>).refineScope)
    : undefined;
  const resetMetadata = standard?.code === "STATE_CONFLICT"
    ? safeResetMetadata(rawParams)
    : undefined;
  const reason = standard?.code === "STATE_CONFLICT"
    ? safeConflictReason(rawParams?.reason)
    : standard?.code === "DEPENDENCY_UNAVAILABLE"
    ? safeUnavailableReason(rawParams?.reason)
    : undefined;
  const requiredScopes = code === "INSUFFICIENT_SCOPE" &&
      Array.isArray(rawParams?.requiredScopes)
    ? rawParams.requiredScopes.filter((scope): scope is string =>
      typeof scope === "string" && /^bakery:[a-z]+$/.test(scope)
    ).slice(0, 3)
    : undefined;
  const status = standard?.status;
  const safeStatus = typeof status === "number" && Number.isInteger(status) &&
      status >= 400 && status <= 599
    ? status
    : defaultStatus;
  if (safeStatus >= 500) {
    try {
      problemErrorReporter?.(error);
    } catch {
      // Telemetry failure must preserve the original safe HTTP response.
    }
  }
  return {
    type: `${options.publicBaseUrl.replace(/\/$/, "")}/problems/${slug}`,
    title: resolveProblemMessage(
      locale,
      translate,
      problemKey(code, "title"),
      slug,
    ),
    status: safeStatus,
    detail: resolveProblemMessage(
      locale,
      translate,
      problemKey(code, "description"),
      slug,
    ),
    instance: `urn:bakery:request:${options.requestId}`,
    code,
    requestId: options.requestId,
    traceId: options.traceId,
    retryable,
    ...(issues ? { issues } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(refineScope === undefined ? {} : { refineScope }),
    ...(resetMetadata ?? {}),
    ...(reason === undefined ? {} : { reason }),
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
    ...((code === "DEPENDENCY_UNAVAILABLE" ||
        code === "PROVIDER_QUOTA_EXCEEDED") &&
        typeof rawParams?.retryAfterSeconds === "number" &&
        Number.isInteger(rawParams.retryAfterSeconds) &&
        rawParams.retryAfterSeconds >= 1 && rawParams.retryAfterSeconds <= 3600
      ? { retryAfterSeconds: rawParams.retryAfterSeconds }
      : {}),
  };
}
export function problemResponse(
  context: Context,
  error: unknown,
  options: {
    publicBaseUrl: string;
    requestId?: string;
    traceId?: string;
    allow?: string;
    locale?: SupportedLocale;
  },
): Response {
  const requestId = options.requestId ?? context.req.header("x-request-id") ??
    crypto.randomUUID();
  const locale = options.locale ??
    resolveLocale(parseAcceptLanguage(context.req.header("accept-language")));
  const problem = toProblem(error, {
    publicBaseUrl: options.publicBaseUrl,
    requestId,
    traceId: options.traceId ?? getTraceId(context.req.raw),
    locale,
  });
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "Content-Language": locale,
    Vary: "Accept-Language",
  });
  if (options.allow) headers.set("Allow", options.allow);
  if (problem.code === "INSUFFICIENT_SCOPE") {
    headers.set(
      "WWW-Authenticate",
      `Bearer error="insufficient_scope", scope="${
        (problem.requiredScopes ?? []).join(" ")
      }"`,
    );
  }
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
}
async function readJson(
  context: Context,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBody(context, maxBytes, signal);
  if (!bytes.length) throw new StandardError({ code: "MALFORMED_JSON" });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new StandardError({ code: "MALFORMED_JSON", cause });
  }
}
async function readBody(
  context: Context,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = Number(context.req.header("content-length") ?? 0);
  if (length > maxBytes) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: maxBytes },
    });
  }
  const body = context.req.raw.body;
  if (!body) throw new StandardError({ code: "MALFORMED_JSON" });
  if (signal.aborted) throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new StandardError({
          code: "BODY_TOO_LARGE",
          params: { limit: maxBytes },
        });
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (signal.aborted) {
    throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new StandardError({ code: "DEPENDENCY_TIMEOUT" }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const VERSION_ETAG = /^"(?:(?:[A-Za-z][A-Za-z0-9._~-]*)-)?v?([1-9][0-9]*)"$/;
const MAX_STRONG_IF_MATCH_VERSION = 2_147_483_647;

function preconditionError(): StandardError {
  return new StandardError({ code: "PRECONDITION_REQUIRED" });
}

export function parseIdempotencyKey(
  value: string | null | undefined,
): string {
  const normalized = value?.trim();
  if (
    !normalized || Array.from(normalized).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    }) ||
    new TextEncoder().encode(normalized).byteLength > MAX_IDEMPOTENCY_KEY_BYTES
  ) throw preconditionError();
  return normalized;
}

export function parseStrongIfMatch(
  value: string | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const match = VERSION_ETAG.exec(value.trim());
  if (!match) throw preconditionError();
  const version = Number(match[1]);
  if (
    !Number.isSafeInteger(version) || version < 1 ||
    version > MAX_STRONG_IF_MATCH_VERSION
  ) throw preconditionError();
  return version;
}

function naturalIdempotencyTarget(
  action: Pick<
    ActionDefinition,
    "input" | "naturalIdempotencyInputField"
  >,
  target: string,
  input: unknown,
): string {
  const field = action.naturalIdempotencyInputField;
  if (field === undefined) return target;
  if (typeof field !== "string" || field.length === 0) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const value = input && typeof input === "object" && !Array.isArray(input) &&
      Object.hasOwn(input, field)
    ? (input as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const canonicalValue = canonicalRouteParams(
    { [field]: value },
    action.input,
  )[field];
  return `${target}:${field}:${encodeURIComponent(canonicalValue)}`;
}
export function createNormalizedCommandMetadata(
  action: Pick<
    ActionDefinition,
    | "name"
    | "method"
    | "path"
    | "input"
    | "naturalIdempotency"
    | "naturalIdempotencyInputField"
    | "explicitIdempotency"
  >,
  request: Request,
  params: Readonly<Record<string, string>>,
  input?: unknown,
): NormalizedCommandMetadata {
  const target = normalizeRegisteredRouteTarget(
    action,
    canonicalRouteParams(params, action.input),
  );
  const suppliedKey = request.headers.get("idempotency-key");
  const idempotencyKey = action.naturalIdempotency && suppliedKey === null
    ? `natural:${action.name}:${
      naturalIdempotencyTarget(action, target, input)
    }`
    : parseIdempotencyKey(suppliedKey);
  const method = action.method.toUpperCase();
  const conditionalPostActions: ReadonlySet<ActionDefinition["name"]> = new Set(
    ["artifactVersions.import", "repositoryProfiles.create"],
  );
  // PUT that creates when absent and replaces when present: If-Match is
  // parsed when sent and the handler decides whether it was required.
  const conditionalPutActions: ReadonlySet<ActionDefinition["name"]> = new Set(
    ["integrationAppRegistrations.put", "skillStorageSettings.put"],
  );
  const patchNeedsIfMatch = (method === "PATCH" &&
    action.explicitIdempotency !== "key") ||
    action.explicitIdempotency === "key-and-if-match";
  const expectedVersion = patchNeedsIfMatch ||
      (method === "DELETE" && action.naturalIdempotency) ||
      (method === "POST" && conditionalPostActions.has(action.name) &&
        request.headers.has("if-match")) ||
      (method === "PUT" && conditionalPutActions.has(action.name) &&
        request.headers.has("if-match"))
    ? parseStrongIfMatch(request.headers.get("if-match"))
    : undefined;
  if (patchNeedsIfMatch && expectedVersion === undefined) {
    throw preconditionError();
  }
  return {
    operation: action.name,
    idempotencyKey,
    target,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

function emitEncodedSuccess(
  value: EncodedSuccessResponse,
): Response {
  const headers = new Headers(value.headers as HeadersInit);
  if (value.replayed) headers.set("Idempotent-Replayed", "true");
  headers.set("Cache-Control", "no-store");
  const body = value.status === 204
    ? null
    : value.body.slice().buffer as ArrayBuffer;
  return new Response(body, { status: value.status, headers });
}

function emitSuccess(
  context: Context,
  action: ActionDefinition,
  result: unknown,
): Response {
  context.header("Cache-Control", "no-store");
  if (
    action.policy.type === ActionKind.Command &&
    isEncodedSuccessResponse(result)
  ) {
    return emitEncodedSuccess(result);
  }
  if (action.output === contractSchemas.NoContent) {
    return context.body(null, 204);
  }
  const etag = action.responseEtag?.(result);
  if (etag !== undefined) context.header("ETag", etag);
  return context.json(
    result,
    action.successStatus ?? (action.method === "POST" ? 201 : 200),
  );
}

export type ActionContextSeed = Pick<
  ActionContext,
  "principal" | "locale" | "sessionId" | "accessToken"
>;
function requestContext(
  context: Context,
  signal: AbortSignal,
  requestId: string,
  traceId: string,
  params: Record<string, string>,
  extra?: ActionContextSeed,
): ActionContext {
  return {
    request: context.req.raw,
    params,
    requestId,
    traceId,
    signal,
    ...extra,
  };
}
export function createApiRouter(
  options: {
    registry: ActionRegistry;
    createContext?: (context: Context) => ActionContextSeed;
    publicBaseUrl?: string;
    maxBodyBytes?: number;
    deadlineMs?: number;
  },
): Hono {
  const app = new Hono();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const base = options.publicBaseUrl ?? "http://localhost:8788";
  for (const action of options.registry.list()) {
    const handler = async (context: Context) => {
      const controller = new AbortController();
      const request = context.req.raw;
      const requestId = context.req.header("x-request-id") ??
        crypto.randomUUID();
      const traceId = getTraceId(request);
      const abort = () => controller.abort(request.signal.reason);
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort("deadline"), deadlineMs);
      let extra: ActionContextSeed | undefined;
      try {
        extra = options.createContext?.(context);
        if (controller.signal.aborted) {
          throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
        }
        let bodyBytes: Uint8Array | undefined;
        let params = context.req.param();
        const pathNames = routeParameterNames(action.path);
        const inputShape = action.input instanceof z.ZodObject
          ? action.input._def.shape
          : {};
        const fields = typeof inputShape === "function"
          ? inputShape()
          : inputShape;
        const inputPathNames = pathNames.filter((name) => name in fields);
        const pathOnly = pathNames.length > 0 &&
          action.input instanceof z.ZodObject &&
          Object.keys(fields).every((name) => pathNames.includes(name));
        const contentType = context.req.header("content-type") ?? "";
        const mediaType = contentType.toLowerCase().split(";", 1)[0].trim();
        const acceptsJson = mediaType === "application/json" ||
          /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+\+json$/.test(
            mediaType,
          );
        if (!["GET", "HEAD"].includes(action.method) && request.body) {
          bodyBytes = await readBody(context, maxBodyBytes, controller.signal);
        }
        const hasBody = bodyBytes
          ? bodyBytes.length > 0
          : request.body !== null;
        if (
          !["GET", "HEAD"].includes(action.method) &&
          !(pathOnly && !hasBody) &&
          !acceptsJson
        ) throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
        if (pathNames.length) {
          const pathSchema = z.object(
            Object.fromEntries(pathNames.map((name) => [
              name,
              fields[name] ??
                (/^(?:id|.*Id)$/.test(name)
                  ? z.string().uuid().describe(
                    `UUID route identifier ${name}.`,
                  )
                  : z.string().min(1).describe(
                    `Non-empty route parameter ${name}.`,
                  )),
            ])),
          ).strict().describe("Validated route parameters for this action.");
          const parsedPath = pathSchema.safeParse(params);
          if (!parsedPath.success) throw parsedPath.error;
        }
        params = canonicalRouteParams(
          params,
          action.input,
        ) as Record<string, string>;
        const inputParams = Object.fromEntries(
          inputPathNames.map((name) => [name, params[name]]),
        );
        let value: unknown;
        if (pathOnly && !["GET", "HEAD"].includes(action.method)) {
          if (bodyBytes?.length) {
            let body: unknown;
            try {
              body = JSON.parse(new TextDecoder().decode(bodyBytes));
            } catch (cause) {
              throw new StandardError({ code: "MALFORMED_JSON", cause });
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              throw new StandardError({ code: "MALFORMED_REQUEST" });
            }
            for (const [key, bodyValue] of Object.entries(body)) {
              if (
                !inputPathNames.includes(key) ||
                typeof bodyValue !== "string" ||
                canonicalRouteParams(
                    { [key]: bodyValue },
                    action.input,
                  )[key] !== params[key]
              ) {
                throw new StandardError({ code: "MALFORMED_REQUEST" });
              }
            }
          }
          value = inputParams;
        } else if (["GET", "HEAD"].includes(action.method)) {
          const query = coerceQueryInput(
            action.input,
            Object.fromEntries(new URL(context.req.url).searchParams.entries()),
          );
          value = {
            ...query,
            ...inputParams,
          };
        } else {
          let body: unknown;
          if (bodyBytes) {
            if (bodyBytes.length) {
              try {
                body = JSON.parse(new TextDecoder().decode(bodyBytes));
              } catch (cause) {
                throw new StandardError({ code: "MALFORMED_JSON", cause });
              }
            }
          } else {
            body = await readJson(context, maxBodyBytes, controller.signal);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new StandardError({ code: "MALFORMED_REQUEST" });
          }
          // Too deep for the recursive schemas, or a key that would be dropped.
          if (unsafeRequestJson(body) !== null) {
            throw new StandardError({ code: "MALFORMED_REQUEST" });
          }
          // Route fields are part of generated input shapes even when their
          // transport location is path. Merge them before schema validation;
          // the registry still rejects a conflicting body value.
          value = { ...inputParams, ...body };
        }
        const commandMetadata = action.policy.type === ActionKind.Command
          ? (input: unknown) =>
            createNormalizedCommandMetadata(action, request, params, input)
          : undefined;
        const actionContext = requestContext(
          context,
          controller.signal,
          requestId,
          traceId,
          params,
          extra,
        );
        const deadline = new Promise<never>((_, reject) => {
          const abort = () =>
            reject(new StandardError({ code: "DEPENDENCY_TIMEOUT" }));
          if (controller.signal.aborted) abort();
          else {controller.signal.addEventListener("abort", abort, {
              once: true,
            });}
        });
        const result = await Promise.race([
          deadline,
          options.registry.execute(
            action.name,
            actionContext,
            value,
            commandMetadata,
          ),
        ]);
        return emitSuccess(context, action, result);
      } catch (error) {
        return problemResponse(
          context,
          normalizeActionValidationError(action.name, error),
          {
            publicBaseUrl: base,
            requestId,
            traceId,
            locale: extra?.locale,
          },
        );
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    };
    app.on(
      action.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      action.path,
      handler,
    );
  }
  const paths = new Map<string, { path: string; methods: string[] }>();
  for (const action of options.registry.list()) {
    const key = action.path.replace(/:([A-Za-z0-9_]+)/g, ":param");
    const entry = paths.get(key) ?? { path: action.path, methods: [] };
    entry.methods.push(action.method);
    if (action.method === "GET" && !entry.methods.includes("HEAD")) {
      entry.methods.push("HEAD");
    }
    paths.set(key, entry);
  }
  for (const { path, methods } of paths.values()) {
    app.all(
      path,
      (context) =>
        problemResponse(
          context,
          new StandardError({ code: "METHOD_NOT_ALLOWED" }),
          { publicBaseUrl: base, allow: methods.join(", ") },
        ),
    );
  }
  app.notFound((context) =>
    problemResponse(
      context,
      new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      {
        publicBaseUrl: base,
      },
    )
  );
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: base })
  );
  return app;
}
