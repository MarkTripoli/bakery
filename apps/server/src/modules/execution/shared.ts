import { type Context, type MiddlewareHandler } from "hono";
import type { BudgetRuntimeConfig, SecretsKeyConfig } from "@bakery/config";
import { z } from "zod";
import {
  contractSchemas,
  type OrganizationId,
  organizationId,
} from "@bakery/contracts/contracts";
import { parseIdempotencyKey, StandardError } from "@bakery/contracts/http";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  resolveOrganizationActor,
} from "../auth/adapters/authority-postgres.ts";
import { authorize } from "../auth/application/authorize.ts";
import type { AuthenticatedSubject } from "../auth/application/identity.ts";
import type { PgDatabase, PgTransactionClient } from "@bakery/persistence";
import { loadWorkerIdentity, withPgTransaction } from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { reconcileFailedLifecycleTasks } from "../work/coordination-projection.ts";

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

const EVENT_PAYLOAD_MAX_BYTES = 32_000;
const COORDINATOR_POLL_MILLISECONDS = 15_000;
const COORDINATOR_TRANSIENT_RETRY_DELAYS_MILLISECONDS = [25, 50, 100] as const;
const WORKER_PROTOCOL_HEADER = "X-Bakery-Worker-Protocol-Version";
const BASE_WORKER_PROTOCOL_VERSION = 1;
const WORKER_PROTOCOL_VERSION = 2;
const WORKER_EVENT_TYPES: Record<string, true> = {
  "job.accepted": true,
  "job.started": true,
  "job.progress": true,
  "job.output": true,
  "job.checkpoint": true,
  "job.artifact": true,
  "job.effect_pending": true,
  "job.effect_committed": true,
  "job.succeeded": true,
  "job.failed": true,
  "job.cancelled": true,
  "job.lease_lost": true,
};
const TERMINAL_WORKER_EVENT_TYPES: Record<string, true> = {
  "job.succeeded": true,
  "job.failed": true,
  "job.cancelled": true,
};

const workerEventTimestampSchema = z.string().datetime({ offset: true })
  .describe("RFC 3339 timestamp emitted by a worker.");
const workerEventUuidSchema = z.string().uuid().describe(
  "UUID identifying a worker event resource.",
);
const workerEventSha256Schema = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest.",
);
const artifactRefSchema = z.object({
  artifactId: workerEventUuidSchema,
  versionId: workerEventUuidSchema,
  sha256: workerEventSha256Schema,
}).strict().describe("Immutable artifact version reference.");
const WORKER_EVENT_PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  "job.output": contractSchemas.OutputBatch,
  "job.accepted": z.object({
    acceptedAt: workerEventTimestampSchema,
  }).strict().describe("Worker acceptance payload."),
  "job.started": z.object({
    startedAt: workerEventTimestampSchema,
    workspaceId: workerEventUuidSchema,
  }).strict().describe("Worker start payload."),
  "job.progress": z.object({
    message: z.string().max(2_000).describe("Progress message."),
    percent: z.number().min(0).max(100).nullable().describe(
      "Optional progress percentage.",
    ),
  }).strict().describe("Worker progress payload."),
  "job.checkpoint": z.object({
    artifact: artifactRefSchema,
    resumeHandleRef: z.string().max(200).nullable().describe(
      "Opaque resume handle reference.",
    ),
  }).strict().describe(
    "Worker checkpoint payload with an immutable artifact reference.",
  ),
  "job.artifact": z.object({ artifact: artifactRefSchema }).strict().describe(
    "Worker artifact payload with an immutable artifact reference.",
  ),
  "job.effect_pending": z.object({
    externalEffectId: workerEventUuidSchema,
  }).strict().describe("Pending external effect payload."),
  "job.effect_committed": z.object({
    externalEffectId: workerEventUuidSchema,
    remoteId: z.string().max(1_000).describe("Remote effect identifier."),
  }).strict().describe("Committed external effect payload."),
  "job.succeeded": z.object({
    result: z.unknown().describe("Action result."),
  }).strict().describe(
    "Worker success payload containing the validated action result.",
  ),
  "job.failed": z.object({
    fault: contractSchemas.Problem,
    processExited: z.boolean().describe("Whether the worker process exited."),
  }).strict().describe("Worker failure payload."),
  "job.cancelled": z.object({
    processExited: z.literal(true).describe(
      "Cancellation requires process exit.",
    ),
    exitedAt: workerEventTimestampSchema,
    cleanupStatus: z.enum(["complete", "pending"]).describe(
      "Worker cleanup disposition.",
    ),
  }).strict().describe("Worker cancellation payload."),
  "job.lease_lost": z.object({
    observedAt: workerEventTimestampSchema,
    processExited: z.boolean().describe("Whether the worker process exited."),
  }).strict().describe("Worker lease loss payload."),
};

type ExecutionRouteOptions = {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secret: string;
  budget?: BudgetRuntimeConfig;
  secretsKey?: SecretsKeyConfig;
  secretsFetch?: typeof fetch;
};

type HostRow = {
  id: string;
  organization_id: string;
  principal_id: string;
  principal_type: string;
  name: string;
  os: string;
  architecture: string;
  capabilities: unknown;
  slots: number;
  status: string;
  desired_mode: string;
  credential_hash: string;
  credential_generation: number;
  protocol_version: number;
  inventory_revision: number;
  readiness_revision: number;
  worker_session_id: string | null;
  worker_session_generation: string | number;
  last_heartbeat_at: Date | string | null;
};

type AttemptRow = {
  id: string;
  organization_id: string;
  job_id: string;
  worker_host_id: string;
  worker_session_id: string;
  worker_session_generation: string | number;
  fence: string | number;
  lease_token_hash: string;
  lease_expires_at: Date | string;
  lease_expired: boolean;
  job_current_fence: string | number;
  status: string;
  last_event_seq: string | number;
};
type WorkerResultInput = z.output<typeof contractSchemas.WorkerResult>;

type ExistingEventRow = {
  local_seq: string | number;
  event_id: string;
  event_type: string;
  payload_digest: string;
  saved_ack: unknown;
};

type JobRow = {
  id: string;
  organization_id: string;
  run_step_id: string;
  action: string;
  requirements: unknown;
  input: unknown;
  current_checkpoints: unknown;
  agent_config: unknown;
  skill_refs: unknown;
  agent_version_id: string | null;
  billing: unknown;
  installation_reservation_id: string | null;
  current_fence: string | number;
};

type WorkerIdentity = {
  tokenHash: string;
  host: HostRow;
};
const WORKER_OS_VALUES = ["linux", "macos"] as const;
const WORKER_HOST_STATUS_VALUES = [
  "online",
  "offline",
  "draining",
  "revoked",
] as const;
const WORKER_DESIRED_MODE_VALUES = [
  "accepting",
  "paused",
  "draining",
  "revoked",
] as const;
const ATTEMPT_STATUS_VALUES = [
  "leased",
  "running",
  "canceling",
  "completed",
  "failed",
  "canceled",
  "lost",
  "quarantined",
] as const;

function assertEnum(value: string, values: readonly string[]): void {
  if (!values.includes(value)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertNonEmptyText(value: string): void {
  if (!value.trim()) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertSlotCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertSha256Hex(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertBigIntAtLeast(
  value: string | number,
  minimum: bigint,
): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch (cause) {
    throw new StandardError({ code: "UNPROCESSABLE", cause });
  }
  if (parsed < minimum) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return parsed;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertHostRowIntegrity(host: HostRow): void {
  if (host.principal_type !== "worker") {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  assertNonEmptyText(host.name);
  assertEnum(host.os, WORKER_OS_VALUES);
  assertNonEmptyText(host.architecture);
  assertSlotCount(host.slots);
  assertEnum(host.status, WORKER_HOST_STATUS_VALUES);
  assertEnum(host.desired_mode, WORKER_DESIRED_MODE_VALUES);
  assertSha256Hex(host.credential_hash);
  assertPositiveInteger(host.credential_generation);
  assertPositiveInteger(host.protocol_version);
  if (
    host.worker_session_id !== null &&
    !z.string().uuid().safeParse(host.worker_session_id).success
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const generation = assertBigIntAtLeast(
    host.worker_session_generation,
    0n,
  );
  if (host.worker_session_id === null && generation !== 0n) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function assertAttemptRowIntegrity(attempt: AttemptRow): void {
  assertBigIntAtLeast(attempt.fence, 1n);
  assertSha256Hex(attempt.lease_token_hash);
  assertEnum(attempt.status, ATTEMPT_STATUS_VALUES);
  assertBigIntAtLeast(attempt.last_event_seq, 0n);
}

function assertJobIntegrity(
  job: { action: string; currentFence: string | number },
): bigint {
  assertNonEmptyText(job.action);
  return assertBigIntAtLeast(job.currentFence, 0n);
}

type Ack = z.output<typeof contractSchemas.WorkerAck>;
type Assignment = z.output<typeof contractSchemas.JobAssignment>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  const parsed = jsonValue(value, []);
  return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ? parsed
    : [];
}

function normalizeCapabilities(value: unknown): string[] {
  const parsed = jsonValue(value, undefined);
  if (!Array.isArray(parsed)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const normalized = [
    ...new Set(parsed.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      return entry.trim().toLowerCase();
    })),
  ].sort();
  if (normalized.length > 100) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return normalized;
}

function normalizeSupportedActions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = jsonValue(value, undefined);
  if (!Array.isArray(parsed)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const normalized = [
    ...new Set(parsed.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      return entry.trim();
    })),
  ].sort();
  if (normalized.length > 100) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return normalized;
}

function sessionGeneration(value: string | number, minimum = 0n): bigint {
  return assertBigIntAtLeast(value, minimum);
}

function assertWorkerSessionPair(
  workerSessionId: string | undefined,
  workerSessionGeneration: string | undefined,
): void {
  if (
    (workerSessionId === undefined) !==
      (workerSessionGeneration === undefined)
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  if (workerSessionId !== undefined) {
    if (!z.string().uuid().safeParse(workerSessionId).success) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    sessionGeneration(workerSessionGeneration!, 0n);
  }
}

type WorkerSessionHost =
  | Pick<
    HostRow,
    "worker_session_id" | "worker_session_generation" | "protocol_version"
  >
  | {
    workerSessionId: string | null;
    workerSessionGeneration: string | number;
    protocolVersion: number;
  };

function assertCurrentWorkerSession(
  host: WorkerSessionHost,
  workerSessionId: string | undefined,
  workerSessionGeneration: string | undefined,
): void {
  assertWorkerSessionPair(workerSessionId, workerSessionGeneration);
  if (workerSessionId === undefined) return;
  const currentSessionId = "workerSessionId" in host
    ? host.workerSessionId
    : host.worker_session_id;
  const currentSessionGeneration = "workerSessionGeneration" in host
    ? host.workerSessionGeneration
    : host.worker_session_generation;
  if (
    currentSessionId === null ||
    workerSessionId !== currentSessionId ||
    sessionGeneration(workerSessionGeneration!) !==
      sessionGeneration(currentSessionGeneration, 0n)
  ) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
}

function assertWorkerMutationSessionShape(
  host: WorkerSessionHost,
  workerSessionId: string | undefined,
  workerSessionGeneration: string | undefined,
): void {
  assertWorkerSessionPair(workerSessionId, workerSessionGeneration);
  const protocolVersion = "protocolVersion" in host
    ? host.protocolVersion
    : host.protocol_version;
  if (protocolVersion >= 2 && workerSessionId === undefined) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
}
function assertAttemptMutationSession(
  host: HostRow,
  attempt: AttemptRow,
  workerSessionId: string | undefined,
  workerSessionGeneration: string | undefined,
): void {
  assertWorkerMutationSessionShape(
    host,
    workerSessionId,
    workerSessionGeneration,
  );
  if (workerSessionId === undefined) return;
  assertCurrentWorkerSession(host, workerSessionId, workerSessionGeneration);
  if (
    attempt.worker_session_id !== workerSessionId ||
    sessionGeneration(attempt.worker_session_generation, 0n) !==
      sessionGeneration(workerSessionGeneration!, 0n)
  ) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
}

function isSubset(
  requested: readonly string[],
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((capability) => allowedSet.has(capability));
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("EXECUTION_TIMESTAMP_INVALID");
  }
  return date.toISOString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
function normalizeArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "x64":
    case "x86_64":
    case "amd64":
    case "x8664":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x86":
    case "i386":
    case "i686":
      return "x86";
    default:
      return normalized;
  }
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(bytes);
}

async function secretKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`bakery-worker-replay:${secret}`),
  );
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function protect(secret: string, value: unknown): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
    await secretKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${encodeBase64Url(nonce)}.${
    encodeBase64Url(new Uint8Array(ciphertext))
  }`;
}

async function unprotect(secret: string, value: string): Promise<unknown> {
  const [encodedNonce, encodedCiphertext] = value.split(".", 2);
  const nonce = encodedNonce ? decodeBase64(encodedNonce) : null;
  const ciphertext = encodedCiphertext ? decodeBase64(encodedCiphertext) : null;
  if (!nonce || nonce.byteLength !== 12 || !ciphertext) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
      await secretKey(secret),
      ciphertext.buffer as ArrayBuffer,
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch (cause) {
    throw new StandardError({
      code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
      cause,
    });
  }
}

function stripWorkerSessionFields(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const stable = { ...input };
  delete stable.workerSessionId;
  delete stable.workerSessionGeneration;
  return stable;
}

async function requestDigest(input: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(input));
}
function canonicalWorkerUuid(value: string): string {
  return value.toLowerCase();
}
function workerIdempotencyUuid(value: string | null | undefined): string {
  const key = parseIdempotencyKey(value);
  if (!workerEventUuidSchema.safeParse(key).success) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return key;
}
async function claimRequestDigest(input: unknown): Promise<string> {
  return await requestDigest(stripWorkerSessionFields(input));
}
type RequestMetadata = {
  readonly requestId: string;
  readonly traceId: string;
};

function requestMetadata(context: Context): RequestMetadata {
  const requestId = context.req.header("x-request-id")?.trim() ||
    crypto.randomUUID();
  const traceId = context.req.header("x-trace-id")?.trim() || requestId;
  return { requestId, traceId };
}
type ExecutionEventScope = {
  readonly applicationId?: string | null;
  readonly repositoryId?: string | null;
  readonly taskId?: string | null;
  readonly conversationId?: string | null;
};

function parseWorkerProtocolVersion(headers: Headers): number {
  const raw = headers.get(WORKER_PROTOCOL_HEADER);
  if (raw === null || raw.trim() === "") return BASE_WORKER_PROTOCOL_VERSION;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new StandardError({
      code: "WORKER_PROTOCOL_UNSUPPORTED",
      status: 426,
    });
  }
  const version = Number(raw);
  if (
    !Number.isSafeInteger(version) ||
    version < BASE_WORKER_PROTOCOL_VERSION ||
    version > WORKER_PROTOCOL_VERSION
  ) {
    throw new StandardError({
      code: "WORKER_PROTOCOL_UNSUPPORTED",
      status: 426,
    });
  }
  return version;
}

function withWorkerProtocolHeader(
  response: Response,
  version: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set(WORKER_PROTOCOL_HEADER, String(version));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function readBearer(headers: Headers): string {
  const value = headers.get("authorization");
  if (!value) throw new StandardError({ code: "AUTH_REQUIRED" });
  const match = /^Bearer ([^\s]+)$/.exec(value);
  if (!match) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  return match[1];
}

function readAttemptId(context: Context): string {
  const value = context.req.param("id");
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return value.toLowerCase();
}
async function workerTransaction<T>(
  database: PgDatabase,
  headers: Headers,
  work: (
    transaction: PgTransactionClient,
    identity: WorkerIdentity,
  ) => Promise<T>,
): Promise<T> {
  const token = readBearer(headers);
  const tokenHash = await sha256Hex(token);
  const requestedProtocolVersion = parseWorkerProtocolVersion(headers);
  return await withPgTransaction(database, async (transaction) => {
    const loaded = await loadWorkerIdentity(
      transaction,
      tokenHash,
      requestedProtocolVersion,
    );
    const row: HostRow = {
      id: loaded.host.id,
      organization_id: loaded.host.organizationId,
      principal_id: loaded.host.principalId,
      principal_type: loaded.host.principalType,
      name: loaded.host.name,
      os: loaded.host.os,
      architecture: loaded.host.architecture,
      capabilities: loaded.host.capabilities,
      slots: loaded.host.slots,
      status: loaded.host.status,
      desired_mode: loaded.host.desiredMode,
      credential_hash: loaded.host.credentialHash,
      credential_generation: loaded.host.credentialGeneration,
      protocol_version: loaded.host.protocolVersion,
      inventory_revision: loaded.host.inventoryRevision,
      readiness_revision: loaded.host.readinessRevision,
      worker_session_id: loaded.host.workerSessionId,
      worker_session_generation: loaded.host.workerSessionGeneration,
      last_heartbeat_at: loaded.host.lastHeartbeatAt,
    };
    assertHostRowIntegrity(row);
    const result = await work(transaction, { tokenHash, host: row });
    await reconcileFailedLifecycleTasks(transaction);
    return result;
  });
}

async function adminTransaction<T>(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
  work: (
    transaction: PgTransactionClient,
    organization: OrganizationId,
    principal: AuthenticatedSubject,
  ) => Promise<T>,
): Promise<T> {
  const principal = context.get("principal");
  if (!principal) throw new StandardError({ code: "AUTH_REQUIRED" });
  const organizationHeader = context.req.header("Bakery-Organization-Id");
  if (!organizationHeader) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  let organization: OrganizationId;
  try {
    organization = organizationId(organizationHeader);
  } catch (cause) {
    throw new StandardError({ code: "AUTH_FORBIDDEN", cause });
  }
  return await withPgTransaction(options.database, async (transaction) => {
    const actor = await resolveOrganizationActor(
      transaction,
      principal.principalId,
      organization,
    );
    authorize(actor, "worker:manage", { action: "workers.enroll" });
    return await work(transaction, organization, principal);
  }, context.req.raw.signal);
}

export {
  adminTransaction,
  assertAttemptMutationSession,
  assertAttemptRowIntegrity,
  assertBigIntAtLeast,
  assertCurrentWorkerSession,
  assertEnum,
  assertHostRowIntegrity,
  assertJobIntegrity,
  assertNonEmptyText,
  assertPositiveInteger,
  assertSha256Hex,
  assertSlotCount,
  assertWorkerMutationSessionShape,
  assertWorkerSessionPair,
  asStringArray,
  BASE_WORKER_PROTOCOL_VERSION,
  canonicalJson,
  canonicalWorkerUuid,
  claimRequestDigest,
  contractSchemas,
  COORDINATOR_POLL_MILLISECONDS,
  COORDINATOR_TRANSIENT_RETRY_DELAYS_MILLISECONDS,
  decodeBase64,
  ENROLLMENT_TTL_MS,
  EVENT_PAYLOAD_MAX_BYTES,
  iso,
  isRecord,
  isSubset,
  jsonValue,
  normalizeArchitecture,
  normalizeCapabilities,
  normalizeSupportedActions,
  parseIdempotencyKey,
  parseWorkerProtocolVersion,
  protect,
  randomSecret,
  readAttemptId,
  readBearer,
  requestDigest,
  requestMetadata,
  sessionGeneration,
  sha256Hex,
  TERMINAL_WORKER_EVENT_TYPES,
  unprotect,
  withPgTransaction,
  withWorkerProtocolHeader,
  WORKER_EVENT_PAYLOAD_SCHEMAS,
  WORKER_EVENT_TYPES,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  workerIdempotencyUuid,
  workerTransaction,
};
export type {
  Ack,
  Assignment,
  AttemptRow,
  AuthenticatedSubject,
  ExecutionEventScope,
  ExecutionRouteOptions,
  ExistingEventRow,
  HostRow,
  JobRow,
  PgDatabase,
  PgTransactionClient,
  RequestMetadata,
  WorkerIdentity,
  WorkerResultInput,
};
