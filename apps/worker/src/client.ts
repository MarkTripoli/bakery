import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  type RepositoryInspectionSourceChunk,
  RepositoryInspectionSourceChunkSchema,
} from "../../../packages/contracts/src/repository-inspection.ts";
import type { z } from "zod";
import {
  WORKER_SKILL_READ_HEADERS,
  WORKER_SKILL_RESPONSE_HEADERS,
  WorkerSkillFileResponseMetadataSchema,
  WorkerSkillReadAuthoritySchema,
  WorkerSkillVersionResponseSchema,
} from "@bakery/contracts/worker-skill-read";
import {
  type SealedCredentialOperation,
  type SecretIdentityInvocationProof,
  type SecretIdentityToolResult,
  SecretIdentityToolResultSchema,
} from "../../../packages/contracts/src/secret-identity.ts";
import type {
  JobAssignment,
  LeaseRenewalRequest,
  LeaseState,
  WorkerAck,
  WorkerClaimRequest,
  WorkerCleanupRequest,
  WorkerCleanupResult,
  WorkerEventBatchRequest,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResult,
  WorkerInventoryReceipt,
  WorkerInventoryReport,
  WorkerOutputBinding,
  WorkerOutputClose,
  WorkerOutputFinalization,
  WorkerOutputFinalize,
  WorkerOutputOpen,
  WorkerOutputRevoke,
  WorkerOutputRevokeReceipt,
  WorkerRegistration,
  WorkerRegistrationResult,
  WorkerResultRequest,
  WorkerSkillFileRequest,
  WorkerSkillFileResponse,
  WorkerSkillVersionRequest,
  WorkerSkillVersionResponse,
} from "./types.ts";

/** Immutable artifact version reference returned by the publish route. */
export type ArtifactRef = {
  artifactId: string;
  versionId: string;
  sha256: string;
};

export type WorkerArtifactPublishRequest = {
  leaseToken: string;
  fence: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  idempotencyKey: string;
  artifactType: "plan" | "patch" | "check";
  mediaType: string;
  name: string;
  bytes: Uint8Array;
  subjectHeadSha?: string;
  subjectBaseSha?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  authenticated?: boolean;
  signal?: AbortSignal;
  successStatuses?: readonly number[];
  headers?: Record<string, string>;
  requireNoStore?: boolean;
};
export type WorkerResponse<T> = {
  readonly value: T;
  readonly replayed: boolean;
};

function parseResponseEnvelope<T>(
  schema: z.ZodType<T>,
  response: WorkerResponse<unknown | null>,
  code: string,
): WorkerResponse<T> {
  return {
    value: parseResponse(schema, response.value, code),
    replayed: response.replayed,
  };
}

export class WorkerRequestError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly diagnostic: string | undefined;
  /**
   * True only for a problem response the server produced after the protocol
   * header passed. Local validation failures, header-less proxy responses and
   * unreadable bodies are ambiguous and stay false.
   */
  readonly serverProblem: boolean;

  constructor(
    code: string,
    status: number | null,
    retryable: boolean,
    diagnostic?: string,
    options?: { serverProblem?: boolean },
  ) {
    super(code);
    this.name = "WorkerRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
    this.serverProblem = options?.serverProblem ?? false;
  }
}

function requireOutputBinding(
  response: WorkerResponse<WorkerOutputBinding>,
  attemptId: string,
  input: WorkerOutputOpen,
  close?: WorkerOutputClose,
): WorkerResponse<WorkerOutputBinding> {
  const value = response.value;
  if (
    value.attemptId !== attemptId ||
    value.workerSessionId !== input.workerSessionId ||
    value.workerSessionGeneration !== input.workerSessionGeneration ||
    value.fence !== input.fence ||
    BigInt(value.writerGeneration) < 1n ||
    BigInt(value.nextSequence) !== BigInt(value.highwater) + 1n ||
    (close &&
      (!value.closed || value.sessionId !== close.sessionId ||
        value.writerGeneration !== close.writerGeneration))
  ) {
    throw new WorkerRequestError("WORKER_OUTPUT_BINDING_INVALID", null, false);
  }
  return response;
}

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const WORKER_PROTOCOL_VERSION = 2;
const TERMINAL_EVENT_TYPES: Record<string, true> = {
  "job.succeeded": true,
  "job.failed": true,
  "job.cancelled": true,
};
const COMPATIBILITY_FIELDS = [
  "workerSessionId",
  "workerSessionGeneration",
  "serverTime",
  "leaseDurationSeconds",
  "pendingClaimKey",
  "reconciledAttemptIds",
  "protocolVersion",
] as const;

function withoutCompatibilityFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const copy = { ...(value as Record<string, unknown>) };
  for (const field of COMPATIBILITY_FIELDS) delete copy[field];
  return copy;
}

function withCompatibilityFields<T>(parsed: T, original: unknown): T {
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    !original || typeof original !== "object" || Array.isArray(original)
  ) {
    return parsed;
  }
  const merged = { ...(parsed as Record<string, unknown>) };
  const source = original as Record<string, unknown>;
  for (const field of COMPATIBILITY_FIELDS) {
    if (source[field] !== undefined) merged[field] = source[field];
  }
  return merged as T;
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
): T {
  try {
    return withCompatibilityFields(schema.parse(value), value);
  } catch {
    try {
      return withCompatibilityFields(
        schema.parse(withoutCompatibilityFields(value)),
        value,
      );
    } catch {
      throw new WorkerRequestError(code, null, false);
    }
  }
}

function validateLegacyCompatibleRequest(
  schema: z.ZodType,
  value: unknown,
): void {
  try {
    schema.parse(value);
  } catch {
    try {
      schema.parse(withoutCompatibilityFields(value));
    } catch {
      throw new WorkerRequestError("WORKER_REQUEST_INVALID", null, false);
    }
  }
}
function requireAppliedAck(
  response: WorkerResponse<WorkerAck>,
  idempotencyKey: string,
  submittedHead: string,
): WorkerResponse<WorkerAck> {
  if (response.value.status !== "applied") {
    throw new WorkerRequestError("WORKER_ACK_REJECTED", 200, false);
  }
  if (
    response.value.eventId !== idempotencyKey ||
    response.value.lastEventSeq !== submittedHead
  ) {
    throw new WorkerRequestError("WORKER_ACK_INVALID", 200, false);
  }
  return response;
}

function hasNoStore(response: Response): boolean {
  return response.headers.get("cache-control")?.split(",").some((directive) =>
    directive.trim().toLowerCase() === "no-store"
  ) === true;
}

const PROBLEM_SECRET_FIELD =
  /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
const PROBLEM_LOG_DETAIL_BYTES = 400;
const PROBLEM_LOG_PARAMS_BYTES = 800;
const PROBLEM_LOG_ROUTE_BYTES = 512;
const PROBLEM_LOG_CODE_BYTES = 160;
const PROBLEM_LOG_REQUEST_ID_BYTES = 128;
const PROBLEM_ENCODER = new TextEncoder();

function boundedProblemText(
  value: unknown,
  maximum: number,
  secrets: readonly string[] = [],
): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/[^\x20-\x7e]+/g, " ").trim();
  for (const secret of secrets) {
    if (secret.length > 0) text = text.split(secret).join("[REDACTED]");
  }
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = PROBLEM_ENCODER.encode(character).byteLength;
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result.length < text.length ? `${result}...` : result;
}

function redactProblemValue(
  value: unknown,
  fieldName = "",
  depth = 0,
  secrets: readonly string[] = [],
): unknown {
  if (PROBLEM_SECRET_FIELD.test(fieldName)) return "[REDACTED]";
  if (depth >= 2) return "[TRUNCATED]";
  if (
    value === null || typeof value === "boolean" || typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return boundedProblemText(value, 160, secrets) ?? "";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) =>
      redactProblemValue(item, fieldName, depth + 1, secrets)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 8).map(([key, item]) => [
        boundedProblemText(key, 64, secrets) ?? "[invalid-key]",
        redactProblemValue(item, key, depth + 1, secrets),
      ]),
    );
  }
  return null;
}
function collectProblemSecrets(...values: readonly unknown[]): string[] {
  const secrets = new Set<string>();
  const visit = (value: unknown, fieldName = "", depth = 0): void => {
    if (depth > 3) return;
    if (typeof value === "string") {
      if (PROBLEM_SECRET_FIELD.test(fieldName) && value.length > 0) {
        secrets.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) visit(item, fieldName, depth + 1);
      return;
    }
    if (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) return;
    if (value && typeof value === "object") {
      let count = 0;
      for (const key in value as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        visit((value as Record<string, unknown>)[key], key, depth + 1);
        if (++count >= 64) break;
      }
    }
  };
  for (const value of values) visit(value);
  return [...secrets];
}

function problemDiagnostic(
  route: string,
  status: number,
  code: string,
  problem: Record<string, unknown>,
  secrets: readonly string[] = [],
): string {
  let params: unknown = redactProblemValue(
    problem.params,
    "params",
    0,
    secrets,
  );
  const paramsText = JSON.stringify(params);
  if (
    PROBLEM_ENCODER.encode(paramsText).byteLength > PROBLEM_LOG_PARAMS_BYTES
  ) {
    params = "[TRUNCATED]";
  }
  return JSON.stringify({
    component: "worker-client",
    event: "problem_response",
    route: boundedProblemText(route, PROBLEM_LOG_ROUTE_BYTES, secrets) ?? "",
    status,
    code: boundedProblemText(code, PROBLEM_LOG_CODE_BYTES, secrets) ?? "",
    detail: boundedProblemText(
      problem.detail,
      PROBLEM_LOG_DETAIL_BYTES,
      secrets,
    ),
    params,
    requestId: boundedProblemText(
      problem.requestId,
      PROBLEM_LOG_REQUEST_ID_BYTES,
      secrets,
    ),
  });
}

async function throwWorkerHttpError(
  response: Response,
  route: string,
  logProblem: (message: string) => void,
  secrets: readonly string[] = [],
): Promise<never> {
  let body: unknown = null;
  let rawBody: string;
  try {
    rawBody = await readResponseBody(response);
  } catch (error) {
    const code = error instanceof WorkerRequestError
      ? error.code
      : "WORKER_RESPONSE_BODY_INVALID";
    const diagnostic = problemDiagnostic(
      route,
      response.status,
      code,
      {},
      secrets,
    );
    logProblem(diagnostic);
    if (error instanceof WorkerRequestError) {
      throw new WorkerRequestError(
        error.code,
        response.status,
        error.retryable,
        diagnostic,
      );
    }
    throw new WorkerRequestError(
      "WORKER_RESPONSE_BODY_INVALID",
      response.status,
      false,
      diagnostic,
    );
  }
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
  }
  const problem = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const rawCode = typeof problem.code === "string" && problem.code.length > 0
    ? problem.code
    : `WORKER_HTTP_${response.status}`;
  const code = rawCode.includes("PROTOCOL")
    ? "WORKER_PROTOCOL_UNSUPPORTED"
    : rawCode;
  const retryable = typeof problem.retryable === "boolean"
    ? problem.retryable
    : response.status >= 500 || response.status === 408 ||
      response.status === 429;
  const diagnostic = problemDiagnostic(
    route,
    response.status,
    code,
    problem,
    secrets,
  );
  logProblem(diagnostic);
  throw new WorkerRequestError(
    code,
    response.status,
    retryable,
    diagnostic,
    { serverProblem: code !== "WORKER_PROTOCOL_UNSUPPORTED" },
  );
}
async function readWorkerProblemError(
  response: Response,
  route: string,
  logProblem: (message: string) => void,
  secrets: readonly string[],
): Promise<WorkerRequestError> {
  try {
    await throwWorkerHttpError(response, route, logProblem, secrets);
  } catch (error) {
    if (error instanceof WorkerRequestError) return error;
    throw error;
  }
  throw new Error("WORKER_PROBLEM_ERROR_UNREACHABLE");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (
      entry === null || typeof entry === "string" ||
      typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    if (typeof entry === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        const child = (entry as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = canonical(child);
      }
      return result;
    }
    throw new WorkerRequestError(
      "WORKER_SKILL_MANIFEST_INVALID",
      null,
      false,
    );
  };
  return JSON.stringify(canonical(value));
}

async function readResponseBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new WorkerRequestError(
        "WORKER_RESPONSE_LENGTH_INVALID",
        response.status,
        false,
      );
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      throw new WorkerRequestError(
        "WORKER_RESPONSE_TOO_LARGE",
        response.status,
        false,
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (offset + value.byteLength > MAX_RESPONSE_BYTES) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_TOO_LARGE",
          response.status,
          false,
        );
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, offset));
}

function validateEventBatch(body: WorkerEventBatchRequest): void {
  try {
    validateLegacyCompatibleRequest(contractSchemas.WorkerEventBatch, body);
    if (
      typeof body.workerSessionId !== "string" ||
      typeof body.workerSessionGeneration !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(body.workerSessionGeneration)
    ) throw new Error("session");
    let previous: bigint | null = null;
    for (const item of body.events as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("event");
      }
      const event = item as Record<string, unknown>;
      if (
        typeof event.eventType !== "string" ||
        typeof event.localSeq !== "string" ||
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) throw new Error("event");
      if (TERMINAL_EVENT_TYPES[event.eventType]) {
        throw new Error("terminal");
      }
      const sequence = BigInt(event.localSeq);
      if (previous !== null && sequence <= previous) {
        throw new Error("sequence");
      }
      previous = sequence;
    }
  } catch {
    throw new WorkerRequestError(
      "WORKER_EVENT_BATCH_INVALID",
      null,
      false,
    );
  }
}
function parseCleanupResponse(
  response: WorkerResponse<unknown | null>,
  expected: {
    attemptId: string;
    observedByWorkerSessionId: string;
    observedByWorkerSessionGeneration: string;
    exitedAt: string;
  },
): WorkerResponse<WorkerCleanupResult> {
  const value = response.value;
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    typeof (value as Record<string, unknown>).attemptId !== "string" ||
    (value as Record<string, unknown>).attemptId !== expected.attemptId ||
    (value as Record<string, unknown>).status !== "canceled"
  ) {
    throw new WorkerRequestError(
      "WORKER_RESPONSE_CLEANUP_INVALID",
      200,
      false,
    );
  }
  const cancellation = (value as Record<string, unknown>).cancellation;
  if (
    !cancellation || typeof cancellation !== "object" ||
    Array.isArray(cancellation)
  ) {
    throw new WorkerRequestError(
      "WORKER_RESPONSE_CLEANUP_INVALID",
      200,
      false,
    );
  }
  const fields = cancellation as Record<string, unknown>;
  const observer = fields.cleanupObserver;
  const observerFields = observer && typeof observer === "object" &&
      !Array.isArray(observer)
    ? observer as Record<string, unknown>
    : null;
  const observedBy = observerFields?.observedBy;
  const observedByFields = observedBy && typeof observedBy === "object" &&
      !Array.isArray(observedBy)
    ? observedBy as Record<string, unknown>
    : null;
  if (
    fields.processExited !== true ||
    fields.cleanupStatus !== "complete" ||
    fields.terminationStatus !== "confirmed" ||
    fields.exitedAt !== expected.exitedAt ||
    observedByFields?.workerSessionId !== expected.observedByWorkerSessionId ||
    observedByFields.workerSessionGeneration !==
      expected.observedByWorkerSessionGeneration
  ) {
    throw new WorkerRequestError(
      "WORKER_RESPONSE_CLEANUP_INVALID",
      200,
      false,
    );
  }
  return {
    value: value as WorkerCleanupResult,
    replayed: response.replayed,
  };
}
export class WorkerApiClient {
  private credential: string | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly requestTimeoutMs: number;
  private readonly logProblem: (message: string) => void;
  private readonly lifecycleController = new AbortController();

  constructor(options: {
    baseUrl: string;
    credential?: string;
    fetcher?: Fetcher;
    requestTimeoutMs?: number;
    logger?: (message: string) => void;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential;
    this.fetcher = options.fetcher || fetch;
    this.requestTimeoutMs = options.requestTimeoutMs || 10_000;
    this.logProblem = options.logger ?? ((message) => console.error(message));
  }

  setCredential(credential: string): void {
    this.credential = credential;
  }

  abort(): void {
    this.lifecycleController.abort();
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<WorkerResponse<T | null>> {
    if (options.authenticated && !this.credential) {
      throw new WorkerRequestError("WORKER_CREDENTIAL_MISSING", null, false);
    }
    const controller = new AbortController();
    let deadlineExpired = false;
    const abort = () => controller.abort();
    const signals = [this.lifecycleController.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Bakery-Worker-Protocol-Version": String(WORKER_PROTOCOL_VERSION),
    });
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    if (options.idempotencyKey) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    if (options.authenticated) {
      headers.set("Authorization", `Bearer ${this.credential}`);
    }
    const abortError = (): WorkerRequestError => {
      const externalAbort = this.lifecycleController.signal.aborted ||
        options.signal?.aborted === true;
      return new WorkerRequestError(
        deadlineExpired && !externalAbort
          ? "WORKER_REQUEST_DEADLINE"
          : "WORKER_REQUEST_ABORTED",
        null,
        deadlineExpired && !externalAbort,
      );
    };
    try {
      if (controller.signal.aborted) throw abortError();
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw abortError();
        if (error instanceof WorkerRequestError) throw error;
        throw new WorkerRequestError("WORKER_NETWORK_ERROR", null, true);
      }
      const problemSecrets = [
        ...(this.credential ? [this.credential] : []),
        ...collectProblemSecrets(options.body, options.headers),
      ];
      const protocolHeader = response.headers.get(
        "X-Bakery-Worker-Protocol-Version",
      );
      if (protocolHeader !== String(WORKER_PROTOCOL_VERSION)) {
        let diagnostic: string | undefined;
        if (!response.ok) {
          diagnostic = (await readWorkerProblemError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          )).diagnostic;
        }
        throw new WorkerRequestError(
          "WORKER_PROTOCOL_UNSUPPORTED",
          response.status,
          false,
          diagnostic,
        );
      }
      if (options.requireNoStore && !hasNoStore(response)) {
        let diagnostic: string | undefined;
        if (!response.ok) {
          diagnostic = (await readWorkerProblemError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          )).diagnostic;
        }
        throw new WorkerRequestError(
          "WORKER_RESPONSE_CACHE_POLICY_INVALID",
          response.status,
          false,
          diagnostic,
        );
      }
      if (!response.ok) {
        try {
          await throwWorkerHttpError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          );
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          throw error;
        }
      }
      const successStatuses = options.successStatuses ?? [200];
      if (!successStatuses.includes(response.status)) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_STATUS_INVALID",
          response.status,
          false,
        );
      }
      const replayed = response.headers.get("Idempotent-Replayed") === "true";
      if (response.status === 204) return { value: null, replayed };
      let body: unknown = null;
      let rawBody: string;
      try {
        rawBody = await readResponseBody(response);
      } catch (error) {
        if (controller.signal.aborted) throw abortError();
        if (error instanceof WorkerRequestError) throw error;
        throw new WorkerRequestError(
          "WORKER_RESPONSE_BODY_INVALID",
          response.status,
          false,
        );
      }
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }
      }
      if (body === null) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_BODY_INVALID",
          response.status,
          false,
        );
      }
      return { value: body as T, replayed };
    } finally {
      clearTimeout(timer);
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    }
  }

  private async requestSkillFile(
    path: string,
    request: WorkerSkillFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerSkillFileResponse>> {
    if (!this.credential) {
      throw new WorkerRequestError("WORKER_CREDENTIAL_MISSING", null, false);
    }
    const controller = new AbortController();
    let deadlineExpired = false;
    const abort = () => controller.abort();
    const signals = [this.lifecycleController.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    for (const current of signals) {
      if (current.aborted) controller.abort();
      else current.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const abortError = () =>
      new WorkerRequestError(
        deadlineExpired && !signal?.aborted &&
          !this.lifecycleController.signal.aborted
          ? "WORKER_REQUEST_DEADLINE"
          : "WORKER_REQUEST_ABORTED",
        null,
        deadlineExpired && !signal?.aborted &&
          !this.lifecycleController.signal.aborted,
      );
    const headers = new Headers({
      Accept: "application/octet-stream",
      Authorization: `Bearer ${this.credential}`,
      "X-Bakery-Worker-Protocol-Version": String(WORKER_PROTOCOL_VERSION),
      [WORKER_SKILL_READ_HEADERS.attemptId]: request.attemptId,
      [WORKER_SKILL_READ_HEADERS.leaseToken]: request.leaseToken,
      [WORKER_SKILL_READ_HEADERS.fence]: request.fence,
      [WORKER_SKILL_READ_HEADERS.workerSessionId]: request.workerSessionId,
      [WORKER_SKILL_READ_HEADERS.workerSessionGeneration]:
        request.workerSessionGeneration,
    });
    try {
      if (controller.signal.aborted) throw abortError();
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw abortError();
        if (error instanceof WorkerRequestError) throw error;
        throw new WorkerRequestError("WORKER_NETWORK_ERROR", null, true);
      }
      const problemSecrets = [
        this.credential,
        ...collectProblemSecrets(request, {
          [WORKER_SKILL_READ_HEADERS.leaseToken]: request.leaseToken,
          [WORKER_SKILL_READ_HEADERS.fence]: request.fence,
          [WORKER_SKILL_READ_HEADERS.workerSessionId]: request.workerSessionId,
          [WORKER_SKILL_READ_HEADERS.workerSessionGeneration]:
            request.workerSessionGeneration,
        }),
      ].filter((value): value is string => value !== undefined);
      const protocolHeader = response.headers.get(
        "X-Bakery-Worker-Protocol-Version",
      );
      if (protocolHeader !== String(WORKER_PROTOCOL_VERSION)) {
        let diagnostic: string | undefined;
        if (!response.ok) {
          diagnostic = (await readWorkerProblemError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          )).diagnostic;
        }
        throw new WorkerRequestError(
          "WORKER_PROTOCOL_UNSUPPORTED",
          response.status,
          false,
          diagnostic,
        );
      }
      if (!hasNoStore(response)) {
        let diagnostic: string | undefined;
        if (!response.ok) {
          diagnostic = (await readWorkerProblemError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          )).diagnostic;
        }
        throw new WorkerRequestError(
          "WORKER_RESPONSE_CACHE_POLICY_INVALID",
          response.status,
          false,
          diagnostic,
        );
      }
      if (!response.ok) {
        try {
          await throwWorkerHttpError(
            response,
            path,
            this.logProblem,
            problemSecrets,
          );
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          throw error;
        }
      }
      if (response.status !== 200) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_STATUS_INVALID",
          response.status,
          false,
        );
      }
      const lengthText = response.headers.get("content-length");
      if (!lengthText || !/^(?:0|[1-9][0-9]*)$/.test(lengthText)) {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_LENGTH_INVALID",
          response.status,
          false,
        );
      }
      const declaredLength = Number(lengthText);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength > MAX_SKILL_FILE_BYTES ||
        declaredLength !== request.file.sizeBytes
      ) {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_LENGTH_INVALID",
          response.status,
          false,
        );
      }
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(
          response.headers.get(WORKER_SKILL_RESPONSE_HEADERS.filePath) ?? "",
        );
      } catch {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_METADATA_INVALID",
          response.status,
          false,
        );
      }
      const executable = response.headers.get(
        WORKER_SKILL_RESPONSE_HEADERS.fileExecutable,
      );
      const parsedMetadata = WorkerSkillFileResponseMetadataSchema.safeParse({
        organizationId: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.organizationId,
        ),
        attemptId: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.attemptId,
        ),
        workerHostId: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.workerHostId,
        ),
        workerSessionId: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.workerSessionId,
        ),
        workerSessionGeneration: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.workerSessionGeneration,
        ),
        fence: response.headers.get(WORKER_SKILL_RESPONSE_HEADERS.fence),
        versionId: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.versionId,
        ),
        versionDigest: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.versionDigest,
        ),
        path: decodedPath,
        mediaType: response.headers.get("content-type"),
        sizeBytes: declaredLength,
        sha256: response.headers.get(
          WORKER_SKILL_RESPONSE_HEADERS.fileSha256,
        ),
        isExecutable: executable === "true"
          ? true
          : executable === "false"
          ? false
          : executable,
      });
      if (!parsedMetadata.success) {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_METADATA_INVALID",
          response.status,
          false,
        );
      }
      const metadata = parsedMetadata.data;
      if (
        metadata.organizationId !== request.organizationId ||
        metadata.attemptId !== request.attemptId ||
        metadata.workerHostId !== request.workerHostId ||
        metadata.workerSessionId !== request.workerSessionId ||
        metadata.workerSessionGeneration !== request.workerSessionGeneration ||
        metadata.fence !== request.fence ||
        metadata.versionId !== request.versionId ||
        metadata.versionDigest !== request.digest ||
        metadata.path !== request.file.path ||
        metadata.mediaType !== request.file.mediaType ||
        metadata.sizeBytes !== request.file.sizeBytes ||
        metadata.sha256 !== request.file.sha256 ||
        metadata.isExecutable !== request.file.isExecutable ||
        response.headers.get("etag") !== `"${request.file.sha256}"` ||
        response.headers.get("x-content-type-options") !== "nosniff" ||
        !response.headers.get("content-disposition")
      ) {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_IDENTITY_INVALID",
          response.status,
          false,
        );
      }
      const bytes = new Uint8Array(declaredLength);
      let offset = 0;
      if (response.body) {
        const reader = response.body.getReader();
        const cancelBody = () => {
          reader.cancel().catch(() => undefined);
        };
        if (controller.signal.aborted) cancelBody();
        else {
          controller.signal.addEventListener("abort", cancelBody, {
            once: true,
          });
        }
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (offset + next.value.byteLength > declaredLength) {
              await reader.cancel().catch(() => undefined);
              throw new WorkerRequestError(
                "WORKER_SKILL_FILE_TOO_LARGE",
                response.status,
                false,
              );
            }
            bytes.set(next.value, offset);
            offset += next.value.byteLength;
          }
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          if (error instanceof WorkerRequestError) throw error;
          throw new WorkerRequestError(
            "WORKER_RESPONSE_BODY_INVALID",
            response.status,
            false,
          );
        } finally {
          controller.signal.removeEventListener("abort", cancelBody);
          reader.releaseLock();
        }
      }
      if (controller.signal.aborted) throw abortError();
      if (
        offset !== declaredLength ||
        await sha256Bytes(bytes) !== request.file.sha256
      ) {
        throw new WorkerRequestError(
          "WORKER_SKILL_FILE_INTEGRITY_INVALID",
          response.status,
          false,
        );
      }
      return { value: { ...metadata, content: bytes }, replayed: false };
    } finally {
      clearTimeout(timer);
      for (const current of signals) {
        current.removeEventListener("abort", abort);
      }
    }
  }

  async register(
    body: WorkerRegistration,
    idempotencyKey: string,
  ): Promise<WorkerResponse<WorkerRegistrationResult>> {
    contractSchemas.WorkerRegistration.parse(body);
    const response = await this.request<unknown>(
      "POST",
      "/v1/worker/registration",
      {
        body,
        idempotencyKey,
        authenticated: false,
        successStatuses: [200],
      },
    );
    return parseResponseEnvelope(
      contractSchemas.WorkerRegistrationResult,
      response,
      "WORKER_RESPONSE_REGISTRATION_INVALID",
    );
  }

  async heartbeat(
    body: WorkerHeartbeatRequest,
    signal?: AbortSignal,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<WorkerResponse<WorkerHeartbeatResult>> {
    const wireBody = { ...body };
    validateLegacyCompatibleRequest(contractSchemas.WorkerHeartbeat, wireBody);
    const response = await this.request<unknown>(
      "POST",
      "/v1/worker/heartbeat",
      {
        body: wireBody,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return parseResponseEnvelope(
      contractSchemas.WorkerHeartbeatResult,
      response,
      "WORKER_RESPONSE_HEARTBEAT_INVALID",
    );
  }

  /**
   * Reports host checks. `body.reportId` makes delivery idempotent on the
   * server, so a retried identical report returns the same receipt.
   */
  async reportInventory(
    body: WorkerInventoryReport,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerInventoryReceipt>> {
    const wireBody = { ...body };
    validateLegacyCompatibleRequest(
      contractSchemas.WorkerInventoryReport,
      wireBody,
    );
    const response = await this.request<unknown>(
      "POST",
      "/v1/worker/inventory",
      {
        body: wireBody,
        idempotencyKey: body.reportId,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return parseResponseEnvelope(
      contractSchemas.WorkerInventoryReceipt,
      response,
      "WORKER_RESPONSE_INVENTORY_INVALID",
    );
  }

  async claim(
    body: WorkerClaimRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<JobAssignment | null>> {
    const wireBody = { ...body };
    validateLegacyCompatibleRequest(contractSchemas.WorkerClaim, wireBody);
    const response = await this.request<unknown>("POST", "/v1/worker/claims", {
      body: wireBody,
      idempotencyKey: body.claimKey,
      authenticated: true,
      signal,
      successStatuses: [200, 204],
    });
    return {
      value: response.value === null ? null : parseResponse(
        contractSchemas.JobAssignment,
        response.value,
        "WORKER_RESPONSE_ASSIGNMENT_INVALID",
      ),
      replayed: response.replayed,
    };
  }

  async invokePreparedSecretTool(
    attemptId: string,
    operation: SealedCredentialOperation,
    proof: SecretIdentityInvocationProof,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<SecretIdentityToolResult>> {
    if (
      operation.attemptId !== attemptId ||
      new TextEncoder().encode(JSON.stringify({
          preparedOperationId: operation.preparedOperationId,
        })).length > 128
    ) {
      throw new WorkerRequestError(
        "PREPARED_SECRET_BINDING_INVALID",
        null,
        false,
      );
    }
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/tools/secrets`,
      {
        body: { preparedOperationId: operation.preparedOperationId },
        idempotencyKey: operation.preparedOperationId,
        authenticated: true,
        signal,
        successStatuses: [200],
        headers: {
          "X-Worker-Lease-Token": proof.leaseToken,
          "X-Worker-Fence": proof.fence,
          "X-Worker-Session-Id": proof.workerSessionId,
          "X-Worker-Session-Generation": proof.workerSessionGeneration,
        },
      },
    );
    return parseResponseEnvelope(
      SecretIdentityToolResultSchema,
      response,
      "WORKER_RESPONSE_SECRET_IDENTITY_INVALID",
    );
  }

  async renewLease(
    attemptId: string,
    body: LeaseRenewalRequest,
    signal?: AbortSignal,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<WorkerResponse<LeaseState>> {
    if (typeof body.workerSessionId !== "string") {
      throw new WorkerRequestError(
        "WORKER_SESSION_FIELDS_REQUIRED",
        null,
        false,
      );
    }
    const wireBody = { ...body };
    validateLegacyCompatibleRequest(contractSchemas.LeaseRenewal, wireBody);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/lease-renewals`,
      {
        body: wireBody,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return parseResponseEnvelope(
      contractSchemas.LeaseState,
      response,
      "WORKER_RESPONSE_LEASE_INVALID",
    );
  }

  async openOutput(
    attemptId: string,
    body: WorkerOutputOpen,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerOutputBinding>> {
    const input = contractSchemas.WorkerOutputOpen.parse(body);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/output-bindings`,
      {
        body: input,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return requireOutputBinding(
      parseResponseEnvelope(
        contractSchemas.WorkerOutputBinding,
        response,
        "WORKER_OUTPUT_BINDING_INVALID",
      ),
      attemptId,
      input,
    );
  }
  async closeOutput(
    attemptId: string,
    body: WorkerOutputClose,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerOutputBinding>> {
    const input = contractSchemas.WorkerOutputClose.parse(body);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${
        encodeURIComponent(attemptId)
      }/output-bindings/close`,
      {
        body: input,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return requireOutputBinding(
      parseResponseEnvelope(
        contractSchemas.WorkerOutputBinding,
        response,
        "WORKER_OUTPUT_BINDING_INVALID",
      ),
      attemptId,
      input,
      input,
    );
  }

  async finalizeOutput(
    attemptId: string,
    grantId: string,
    body: WorkerOutputFinalize,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerOutputFinalization>> {
    const input = contractSchemas.WorkerOutputFinalize.parse(body);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${
        encodeURIComponent(attemptId)
      }/output-finalizations/${encodeURIComponent(grantId)}`,
      { body: input, authenticated: true, signal, successStatuses: [200] },
    );
    return parseResponseEnvelope(
      contractSchemas.OutputFinalizationReceipt,
      response,
      "WORKER_OUTPUT_FINALIZATION_INVALID",
    );
  }

  async revokeOutput(
    attemptId: string,
    grantId: string,
    body: WorkerOutputRevoke,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerOutputRevokeReceipt>> {
    const input = contractSchemas.WorkerOutputRevoke.parse(body);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${
        encodeURIComponent(attemptId)
      }/output-finalizations/${encodeURIComponent(grantId)}/revoke`,
      {
        body: input,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return parseResponseEnvelope(
      contractSchemas.OutputRevokeReceipt,
      response,
      "WORKER_OUTPUT_REVOKE_INVALID",
    );
  }

  async postEvents(
    attemptId: string,
    body: WorkerEventBatchRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerAck>> {
    const wireBody = { ...body };
    validateEventBatch(wireBody);
    const lastEvent = (wireBody.events as unknown[])[
      wireBody.events.length - 1
    ];
    const eventId = lastEvent && typeof lastEvent === "object" &&
        !Array.isArray(lastEvent) &&
        typeof (lastEvent as Record<string, unknown>).eventId === "string"
      ? (lastEvent as Record<string, string>).eventId
      : undefined;
    const submittedHead = lastEvent && typeof lastEvent === "object" &&
        !Array.isArray(lastEvent) &&
        typeof (lastEvent as Record<string, unknown>).localSeq === "string"
      ? (lastEvent as Record<string, string>).localSeq
      : undefined;
    if (!eventId || !submittedHead) {
      throw new WorkerRequestError("WORKER_EVENT_EMPTY", null, false);
    }
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/events`,
      {
        body: wireBody,
        idempotencyKey: eventId,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return requireAppliedAck(
      parseResponseEnvelope(
        contractSchemas.WorkerAck,
        response,
        "WORKER_RESPONSE_ACK_INVALID",
      ),
      eventId,
      submittedHead,
    );
  }

  async postResult(
    attemptId: string,
    body: WorkerResultRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerAck>> {
    const wireBody = { ...body };
    validateLegacyCompatibleRequest(contractSchemas.WorkerResult, wireBody);
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/result`,
      {
        body: wireBody,
        idempotencyKey,
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return requireAppliedAck(
      parseResponseEnvelope(
        contractSchemas.WorkerAck,
        response,
        "WORKER_RESPONSE_ACK_INVALID",
      ),
      idempotencyKey,
      wireBody.localSeq,
    );
  }
  async confirmCleanup(
    attemptId: string,
    body: WorkerCleanupRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerCleanupResult>> {
    if (
      !/^(0|[1-9][0-9]*)$/.test(body.fence) ||
      !/^(0|[1-9][0-9]*)$/.test(body.workerSessionGeneration) ||
      !/^(0|[1-9][0-9]*)$/.test(
        body.observedByWorkerSessionGeneration,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(body.workerSessionId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(body.observedByWorkerSessionId) ||
      !Number.isFinite(Date.parse(body.exitedAt))
    ) {
      throw new WorkerRequestError(
        "WORKER_CLEANUP_REQUEST_INVALID",
        null,
        false,
      );
    }
    const response = await this.request<unknown>(
      "POST",
      `/v1/worker/attempts/${encodeURIComponent(attemptId)}/cleanup`,
      {
        body,
        idempotencyKey: crypto.randomUUID(),
        authenticated: true,
        signal,
        successStatuses: [200],
      },
    );
    return parseCleanupResponse(response, {
      attemptId,
      observedByWorkerSessionId: body.observedByWorkerSessionId,
      observedByWorkerSessionGeneration: body.observedByWorkerSessionGeneration,
      exitedAt: body.exitedAt,
    });
  }
  /**
   * Publishes one immutable artifact version through the worker byte boundary.
   * The returned reference is trusted only after its digest equals the digest
   * of the exact bytes sent.
   */
  async publishArtifact(
    attemptId: string,
    request: WorkerArtifactPublishRequest,
  ): Promise<ArtifactRef> {
    if (!this.credential) {
      throw new WorkerRequestError("WORKER_CREDENTIAL_MISSING", null, false);
    }
    const localDigest = await sha256Hex(request.bytes);
    const form = new FormData();
    form.set("leaseToken", request.leaseToken);
    form.set("fence", request.fence);
    form.set("workerSessionId", request.workerSessionId);
    form.set("workerSessionGeneration", request.workerSessionGeneration);
    form.set("artifactType", request.artifactType);
    form.set("name", request.name);
    form.set("contentType", request.mediaType);
    form.set("contentDigest", localDigest);
    form.set("metadata", JSON.stringify(request.metadata ?? {}));
    if (request.subjectHeadSha !== undefined) {
      form.set("subjectHeadSha", request.subjectHeadSha);
    }
    if (request.subjectBaseSha !== undefined) {
      form.set("subjectBaseSha", request.subjectBaseSha);
    }
    form.set(
      "content",
      new File([request.bytes.slice().buffer as ArrayBuffer], "artifact.bin", {
        type: request.mediaType,
      }),
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = [this.lifecycleController.signal, request.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(
          `${this.baseUrl}/v1/worker/attempts/${
            encodeURIComponent(attemptId)
          }/artifacts`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.credential}`,
              "Idempotency-Key": request.idempotencyKey,
              "X-Bakery-Worker-Protocol-Version": String(
                WORKER_PROTOCOL_VERSION,
              ),
            },
            body: form,
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (error instanceof WorkerRequestError) throw error;
        if (controller.signal.aborted) {
          throw new WorkerRequestError(
            deadlineExpired
              ? "WORKER_REQUEST_DEADLINE"
              : "WORKER_REQUEST_ABORTED",
            null,
            deadlineExpired,
          );
        }
        throw new WorkerRequestError("WORKER_NETWORK_ERROR", null, true);
      }
      const problemSecrets = [
        this.credential,
        ...collectProblemSecrets(request),
      ].filter((value): value is string => value !== undefined);
      const artifactPath = `/v1/worker/attempts/${
        encodeURIComponent(attemptId)
      }/artifacts`;
      const protocolHeader = response.headers.get(
        "X-Bakery-Worker-Protocol-Version",
      );
      if (protocolHeader !== String(WORKER_PROTOCOL_VERSION)) {
        let diagnostic: string | undefined;
        if (!response.ok) {
          diagnostic = (await readWorkerProblemError(
            response,
            artifactPath,
            this.logProblem,
            problemSecrets,
          )).diagnostic;
        }
        throw new WorkerRequestError(
          "WORKER_PROTOCOL_UNSUPPORTED",
          response.status,
          false,
          diagnostic,
        );
      }
      if (!response.ok) {
        await throwWorkerHttpError(
          response,
          artifactPath,
          this.logProblem,
          problemSecrets,
        );
      }
      if (response.status !== 201) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_STATUS_INVALID",
          response.status,
          false,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await readResponseBody(response));
      } catch {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_BODY_INVALID",
          response.status,
          false,
        );
      }
      const version = contractSchemas.ArtifactVersion.safeParse(body);
      if (!version.success) {
        throw new WorkerRequestError(
          "WORKER_RESPONSE_ARTIFACT_INVALID",
          response.status,
          false,
        );
      }
      if (version.data.sha256 !== localDigest) {
        throw new WorkerRequestError(
          "WORKER_ARTIFACT_DIGEST_MISMATCH",
          response.status,
          false,
        );
      }
      return {
        artifactId: version.data.artifactId,
        versionId: version.data.id,
        sha256: version.data.sha256,
      };
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  }

  async getSkillVersion(
    request: WorkerSkillVersionRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerSkillVersionResponse>> {
    const authority = WorkerSkillReadAuthoritySchema.safeParse({
      attemptId: request.attemptId,
      leaseToken: request.leaseToken,
      fence: request.fence,
      workerSessionId: request.workerSessionId,
      workerSessionGeneration: request.workerSessionGeneration,
    });
    const pin = contractSchemas.PinnedSkillRef.safeParse({
      versionId: request.versionId,
      digest: request.digest,
    });
    if (
      !authority.success || !pin.success ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(request.workerHostId)
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_REQUEST_INVALID",
        null,
        false,
      );
    }
    const response = await this.request<unknown>(
      "GET",
      `/v1/skill-versions/${encodeURIComponent(request.versionId)}`,
      {
        authenticated: true,
        signal,
        requireNoStore: true,
        headers: {
          [WORKER_SKILL_READ_HEADERS.attemptId]: request.attemptId,
          [WORKER_SKILL_READ_HEADERS.leaseToken]: request.leaseToken,
          [WORKER_SKILL_READ_HEADERS.fence]: request.fence,
          [WORKER_SKILL_READ_HEADERS.workerSessionId]: request.workerSessionId,
          [WORKER_SKILL_READ_HEADERS.workerSessionGeneration]:
            request.workerSessionGeneration,
        },
      },
    );
    const parsed = WorkerSkillVersionResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_RESPONSE_INVALID",
        200,
        false,
      );
    }
    const value = parsed.data;
    const manifest = value.version.manifest;
    const manifestRecord = manifest !== null && typeof manifest === "object" &&
        !Array.isArray(manifest)
      ? manifest as Record<string, unknown>
      : null;
    const paths = new Set(value.files.map((file) => file.path));
    const totalBytes = value.files.reduce(
      (total, file) => total + file.sizeBytes,
      0,
    );
    if (
      value.attemptId !== request.attemptId ||
      value.workerHostId !== request.workerHostId ||
      value.workerSessionId !== request.workerSessionId ||
      value.workerSessionGeneration !== request.workerSessionGeneration ||
      value.fence !== request.fence
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_AUTHORITY_INVALID",
        200,
        false,
      );
    }
    if (
      value.version.id !== request.versionId ||
      value.version.digest !== request.digest ||
      value.version.status !== "published"
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_PIN_INVALID",
        200,
        false,
      );
    }
    if (
      !manifestRecord ||
      await sha256Bytes(
          new TextEncoder().encode(canonicalJson(manifestRecord)),
        ) !== request.digest
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_DIGEST_INVALID",
        200,
        false,
      );
    }
    if (
      manifestRecord.entryPath !== value.version.entryPath ||
      canonicalJson(manifestRecord.files) !== canonicalJson(value.files) ||
      paths.size !== value.files.length ||
      !paths.has(value.version.entryPath) || totalBytes > MAX_SKILL_FILE_BYTES
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_VERSION_INVENTORY_INVALID",
        200,
        false,
      );
    }
    return { value, replayed: response.replayed };
  }

  async getSkillFile(
    request: WorkerSkillFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse<WorkerSkillFileResponse>> {
    const authority = WorkerSkillReadAuthoritySchema.safeParse({
      attemptId: request.attemptId,
      leaseToken: request.leaseToken,
      fence: request.fence,
      workerSessionId: request.workerSessionId,
      workerSessionGeneration: request.workerSessionGeneration,
    });
    const pin = contractSchemas.PinnedSkillRef.safeParse({
      versionId: request.versionId,
      digest: request.digest,
    });
    const file = contractSchemas.SkillFileManifestEntry.safeParse(request.file);
    if (
      !authority.success || !pin.success || !file.success ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(request.organizationId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(request.workerHostId)
    ) {
      throw new WorkerRequestError(
        "WORKER_SKILL_FILE_REQUEST_INVALID",
        null,
        false,
      );
    }
    const encodedPath = request.file.path.split("/").map(encodeURIComponent)
      .join("/");
    return await this.requestSkillFile(
      `/v1/skill-versions/${
        encodeURIComponent(request.versionId)
      }/files/${encodedPath}`,
      request,
      signal,
    );
  }

  async getRepositorySource(
    attemptId: string,
    request: {
      leaseToken: string;
      fence: string;
      workerSessionId: string;
      workerSessionGeneration: string;
      offset: number;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<WorkerResponse<RepositoryInspectionSourceChunk>> {
    if (
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 ||
      request.maxBytes > 32768
    ) {
      throw new WorkerRequestError(
        "INSPECTION_SOURCE_REQUEST_INVALID",
        null,
        false,
      );
    }
    const response = await this.request<unknown>(
      "GET",
      `/v1/job-attempts/${
        encodeURIComponent(attemptId)
      }/repository-source?offset=${request.offset}&maxBytes=${request.maxBytes}`,
      {
        authenticated: true,
        signal,
        headers: {
          "X-Worker-Lease-Token": request.leaseToken,
          "X-Worker-Fence": request.fence,
          "X-Worker-Session-Id": request.workerSessionId,
          "X-Worker-Session-Generation": request.workerSessionGeneration,
        },
      },
    );
    return parseResponseEnvelope(
      RepositoryInspectionSourceChunkSchema,
      response,
      "INSPECTION_SOURCE_RESPONSE_INVALID",
    );
  }
}
