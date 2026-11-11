import { StandardError } from "@bakery/contracts/http";
import { retryAfterSeconds } from "../../platform/retry-after.ts";
import {
  parsePathTemplate,
  type RequestTemplate,
} from "@bakery/integration-sdk";
import {
  type ActiveIntegrationRegistry,
  assertNoDrift,
  type AuthoritySnapshotPort,
  type BoundInvocation,
  permissionsMet,
  type ProviderRequestPort,
  reauthorizeBound,
} from "./integration-gate.ts";
import {
  assertHostProfile,
  HOST_AUTH_PROFILES,
  type HostAuthProfile,
} from "./integration-gate-profiles.ts";
import {
  GATE_REFUSAL_CODES,
  markProviderFailure,
  type ProviderFailureClass,
  providerFailureClass,
} from "./integration-provider-outcome.ts";

declare const credentialBrand: unique symbol;

/** Credential value resolved by the host; only the broker unwraps it, and it never reaches an integration. */
export type OpaqueCredential = string & { readonly [credentialBrand]: true };

/** Wraps a host-resolved secret for the broker. Credential stores call this; integrations never see the result. */
export const opaqueCredential = (value: string): OpaqueCredential =>
  value as OpaqueCredential;

export type CredentialRequest = Readonly<{
  organizationId: string;
  connectionId: string;
  resourceId: string;
  profileId: string;
  providerPermissions: Readonly<Record<string, "read" | "write">>;
}>;

/** Resolves a short-lived credential for one connection and resource. Called only after authorization and validation. */
export type CredentialPort = {
  resolve(request: CredentialRequest): Promise<OpaqueCredential>;
};

export type BrokerDeps = Readonly<{
  registry: ActiveIntegrationRegistry;
  credentials: CredentialPort;
  fetch: typeof fetch;
  snapshotPort: AuthoritySnapshotPort;
  /** Wall-clock deadline for one provider request; default 15 seconds. */
  deadlineMs?: number;
  /** Default abort signal when the caller passes none. */
  signal?: AbortSignal;
  now?: () => Date;
}>;

const DEFAULT_DEADLINE_MS = 15_000;
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const SEGMENT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const FIXED_FAILURE = "provider request failed";

const unprocessable = (detail: string) =>
  new StandardError({ code: "UNPROCESSABLE", detail });
const providerFailure = () => unprocessable(FIXED_FAILURE);

const TERMINAL_REJECTION_STATUSES: ReadonlySet<number> = new Set([
  400,
  403,
  404,
  409,
  410,
  422,
]);

/**
 * Classifies a non-2xx provider response. Only authoritative refusals get a
 * class (a bare 401 is a retryable refusal); 408, 5xx and anything else leave
 * the outcome unknown (unmarked).
 */
function classifyRejection(
  response: Response,
  nowMs: number,
): ProviderFailureClass | undefined {
  const status = response.status;
  const after = retryAfterSeconds(response.headers, nowMs);
  const limited = response.headers.get("x-ratelimit-remaining")?.trim() === "0";
  if (
    status === 429 ||
    // A bare 401 is an authoritative pre-processing refusal (an expired or
    // revoked token): nothing was written, and the next attempt re-resolves
    // the credential. The executor bounds the retries.
    status === 401 ||
    (status === 403 && (limited || after !== undefined))
  ) {
    return {
      kind: "rejected",
      retryable: true,
      ...(after === undefined ? {} : { retryAfterSeconds: after }),
    };
  }
  if (TERMINAL_REJECTION_STATUSES.has(status)) {
    return { kind: "rejected", retryable: false };
  }
  return undefined;
}

type RequestPhase = { stage: "pre" | "credential" | "sent" };

/** Encodes one trusted or validated path segment; anything that could change the path shape is refused. */
function encodeSegment(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  ) text = String(value);
  else throw unprocessable("path value is not a safe segment");
  if (!SEGMENT_VALUE.test(text) || /^\.+$/.test(text)) {
    throw unprocessable("path value is not a safe segment");
  }
  return encodeURIComponent(text);
}

function credentialVariants(credential: string): string[] {
  const bytes = new TextEncoder().encode(credential);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return [
    credential,
    encodeURIComponent(credential),
    btoa(binary),
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  ].filter((variant) => variant.length > 0).map((v) => v.toLowerCase());
}

function leaksCredential(text: string, variants: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return variants.some((variant) => haystack.includes(variant));
}

/** Reads at most `max` bytes; cancels the stream and fails the moment the bound is exceeded. */
async function readBounded(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > max) {
      await response.body?.cancel().catch(() => {});
      throw providerFailure();
    }
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw providerFailure();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function lookupProfile(
  profiles: Readonly<Record<string, HostAuthProfile>>,
  id: string,
): HostAuthProfile | undefined {
  return Object.hasOwn(profiles, id) ? profiles[id] : undefined;
}

/**
 * Shared broker implementation. Callers own profile validation: the
 * production factory passes only `HOST_AUTH_PROFILES` after
 * `assertHostProfile`; the testing module is the only other caller.
 */
export function createBrokerWithProfiles(
  deps: BrokerDeps,
  profiles: Readonly<Record<string, HostAuthProfile>>,
): ProviderRequestPort {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  async function send(
    phase: RequestPhase,
    bound: BoundInvocation,
    ref: { readonly id: string; readonly version: number },
    rawInput: unknown,
    allowed?: readonly Readonly<{ id: string; version: number }>[],
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    // 1. Fresh snapshot; revocation, disablement or scope loss denies here.
    const evaluation = await reauthorizeBound(
      deps.registry,
      deps.snapshotPort,
      bound,
      deps.now?.() ?? new Date(),
    );
    const { provider, action, snapshot } = evaluation;
    assertNoDrift(snapshot, provider, bound);

    // 2. The ref must be an exact object and in the calling context's set.
    // The caller's set can only narrow what the action declares.
    const declared = [
      ...action.handler.requests,
      ...(action.handler.reconcileRequests ?? []),
    ];
    const permitted = (allowed ?? action.handler.requests).filter((a) =>
      declared.some((d) => d.id === a.id && d.version === a.version)
    );
    if (
      typeof ref !== "object" || ref === null || typeof ref.id !== "string" ||
      !Number.isSafeInteger(ref.version) ||
      !permitted.some((p) => p.id === ref.id && p.version === ref.version)
    ) throw unprocessable("undeclared request reference");
    const template: RequestTemplate | undefined = provider.definition.manifest
      .requests.find((t) => t.id === ref.id && t.version === ref.version);
    if (!template || template.resourceKind !== action.resourceKind) {
      throw unprocessable("undeclared request reference");
    }

    const profile = lookupProfile(profiles, provider.profile.id);
    if (!profile) throw unprocessable("unknown authentication profile");
    if (
      !permissionsMet(
        snapshot.connection.providerPermissions,
        template.providerPermissions,
      )
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        detail: "provider_permission_missing",
        params: { reason: "provider_permission_missing" },
      });
    }

    // 3. Template input. Binding-sourced names are never client input.
    if (
      typeof rawInput !== "object" || rawInput === null ||
      Array.isArray(rawInput)
    ) throw unprocessable("request input must be an object");
    const bindingParams = new Set<string>();
    for (const [name, source] of Object.entries(template.pathParams)) {
      if (source.startsWith("binding:")) bindingParams.add(name);
    }
    const kind = Object.hasOwn(profile.resourceKinds, template.resourceKind)
      ? profile.resourceKinds[template.resourceKind]
      : undefined;
    if (!kind) throw unprocessable("unknown resource kind");
    const bindingKeys = new Set(Object.keys(kind.bindingSchema.shape));
    for (const key of Object.keys(rawInput)) {
      if (bindingParams.has(key) || bindingKeys.has(key)) {
        throw unprocessable("request input names a host-bound value");
      }
    }
    const parsedInput = template.input.safeParse(rawInput);
    if (!parsedInput.success) throw unprocessable("invalid request input");
    const input = parsedInput.data as Record<string, unknown>;

    // 4. Binding from the fresh snapshot; absent or invalid values fail closed.
    const binding = kind.bindingSchema.safeParse(snapshot.resource.binding);
    if (!binding.success) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        detail: "resource_binding_incomplete",
        params: { reason: "resource_binding_incomplete" },
      });
    }
    const boundValues = binding.data as Record<string, unknown>;

    // 5-6. Path from the fixed template, one encoded segment per placeholder.
    const parsedTemplate = parsePathTemplate(template.pathTemplate);
    if (!parsedTemplate) throw unprocessable("invalid path template");
    const pathParamNames = new Set(Object.keys(template.pathParams));
    const segments = parsedTemplate.segments.map((segment) => {
      const match = /^\{([a-z][a-z0-9_]*)\}$/.exec(segment);
      if (!match) return segment;
      const name = match[1]!;
      const source = template.pathParams[name];
      if (source === undefined) throw unprocessable("unmapped path value");
      if (source === "input") return encodeSegment(input[name]);
      const attribute = source.slice("binding:".length);
      if (!Object.hasOwn(boundValues, attribute)) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          detail: "resource_binding_incomplete",
          params: { reason: "resource_binding_incomplete" },
        });
      }
      return encodeSegment(boundValues[attribute]);
    });
    const expectedPath = `/${segments.join("/")}`;
    const url = new URL(expectedPath, profile.origin);
    const queryKeys = new Set(template.query);
    for (const key of template.query) {
      const value = input[key];
      if (value === undefined) continue;
      if (
        typeof value !== "string" && typeof value !== "number" &&
        typeof value !== "boolean"
      ) throw unprocessable("query value must be a scalar");
      url.searchParams.set(key, String(value));
    }
    if (
      url.origin !== profile.origin || url.pathname !== expectedPath ||
      url.hash !== "" || url.username !== "" || url.password !== "" ||
      [...url.searchParams.keys()].some((key) => !queryKeys.has(key))
    ) throw unprocessable("request escapes the template");

    // 7. Anything not a path or query value is the body, parsed by the template.
    const bodyInput: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!pathParamNames.has(key) && !queryKeys.has(key)) {
        bodyInput[key] = value;
      }
    }
    let body: string | undefined;
    if (template.body) {
      const parsedBody = template.body.safeParse(bodyInput);
      if (!parsedBody.success) throw unprocessable("invalid request body");
      body = JSON.stringify(parsedBody.data);
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
        throw unprocessable("request body too large");
      }
    } else if (Object.keys(bodyInput).length > 0) {
      throw unprocessable("request input has no body slot");
    }

    // 8. Credential only now, after every check that can fail without it.
    phase.stage = "credential";
    const credential = await deps.credentials.resolve({
      organizationId: bound.organizationId,
      connectionId: bound.connectionId,
      resourceId: bound.resource.id,
      profileId: profile.id,
      providerPermissions: template.providerPermissions,
    });
    if (
      typeof credential !== "string" ||
      !/^[\x21-\x7e]+$/.test(credential)
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        detail: "auth_required",
        params: { reason: "auth_required" },
      });
    }
    phase.stage = "pre";
    const variants = credentialVariants(credential);

    const headers = new Headers();
    for (const [name, value] of Object.entries(profile.fixedHeaders)) {
      headers.set(name, value);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${credential}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const outer = callerSignal ?? deps.signal;
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      phase.stage = "sent";
      const response = await deps.fetch(url.href, {
        method: template.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) {
        const failureClass = response.redirected
          ? undefined
          : classifyRejection(response, (deps.now?.() ?? new Date()).getTime());
        await response.body?.cancel().catch(() => {});
        const failure = providerFailure();
        throw failureClass
          ? markProviderFailure(failure, failureClass)
          : failure;
      }
      const bytes = await readBounded(
        response,
        template.maxResponseBytes,
        controller.signal,
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (leaksCredential(text, variants)) throw providerFailure();
      const parsedResponse = template.response.safeParse(
        text.length === 0 ? undefined : JSON.parse(text),
      );
      if (!parsedResponse.success) throw providerFailure();
      if (
        leaksCredential(JSON.stringify(parsedResponse.data ?? null), variants)
      ) {
        throw providerFailure();
      }
      return parsedResponse.data;
    } catch (error) {
      if (error instanceof StandardError) throw error;
      // Never forward the underlying message: it can carry a URL or header.
      throw providerFailure();
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Marks any failure thrown before the fetch starts as `not_sent`: nothing
   * left the host. A credential-resolution failure and a non-StandardError
   * (store or snapshot transport) are transient; only gate refusal codes are
   * terminal, so a transient StandardError from reauth stays retryable.
   * Failures after the fetch starts keep only the classes `send` marked.
   */
  async function request(
    bound: BoundInvocation,
    ref: { readonly id: string; readonly version: number },
    rawInput: unknown,
    allowed?: readonly Readonly<{ id: string; version: number }>[],
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const phase: RequestPhase = { stage: "pre" };
    try {
      return await send(phase, bound, ref, rawInput, allowed, callerSignal);
    } catch (error) {
      if (phase.stage !== "sent" && providerFailureClass(error) === undefined) {
        markProviderFailure(error, {
          kind: "not_sent",
          retryable: phase.stage === "credential" ||
            !(error instanceof StandardError) ||
            !GATE_REFUSAL_CODES.includes(error.code),
        });
      }
      throw error;
    }
  }

  return Object.freeze({ request });
}

/**
 * Production broker. Takes no profile argument: origins, credential
 * placement and fixed headers come only from `HOST_AUTH_PROFILES`.
 */
export function createBroker(deps: BrokerDeps): ProviderRequestPort {
  for (const profile of Object.values(HOST_AUTH_PROFILES)) {
    assertHostProfile(profile);
  }
  return createBrokerWithProfiles(deps, HOST_AUTH_PROFILES);
}
