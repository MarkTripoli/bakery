import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { jsonResponse, parseContract } from "./http.ts";
import { activeAttempt } from "./coordination.ts";
import {
  type Ack,
  assertAttemptMutationSession,
  assertAttemptRowIntegrity,
  assertWorkerMutationSessionShape,
  type AttemptRow,
  canonicalJson,
  canonicalWorkerUuid,
  contractSchemas,
  EVENT_PAYLOAD_MAX_BYTES,
  type ExecutionRouteOptions,
  type ExistingEventRow,
  isRecord,
  jsonValue,
  type PgTransactionClient,
  readAttemptId,
  type RequestMetadata,
  requestMetadata,
  sessionGeneration,
  sha256Hex,
  TERMINAL_WORKER_EVENT_TYPES,
  WORKER_EVENT_PAYLOAD_SCHEMAS,
  WORKER_EVENT_TYPES,
  workerIdempotencyUuid,
  type WorkerIdentity,
  workerTransaction,
} from "./shared.ts";

import {
  advanceAttemptEventSequence,
  appendAttemptEvent,
  appendOutputBatch,
  applyStartedLifecycle,
  loadEventsByIds,
  loadExistingEvent as loadPersistedEvent,
  lockAttempt as lockPersistedAttempt,
  throwAttemptMutationAuthorityError as throwPersistedAuthorityError,
  validateWorkerReferences as validatePersistedReferences,
} from "@bakery/persistence";
function persistenceIdentity(identity: WorkerIdentity) {
  return {
    tokenHash: identity.tokenHash,
    host: {
      id: identity.host.id,
      organizationId: identity.host.organization_id,
      principalId: identity.host.principal_id,
      principalType: identity.host.principal_type,
      name: identity.host.name,
      os: identity.host.os,
      architecture: identity.host.architecture,
      capabilities: identity.host.capabilities,
      slots: identity.host.slots,
      status: identity.host.status,
      desiredMode: identity.host.desired_mode,
      credentialHash: identity.host.credential_hash,
      credentialGeneration: identity.host.credential_generation,
      inventoryRevision: identity.host.inventory_revision,
      readinessRevision: identity.host.readiness_revision,
      protocolVersion: identity.host.protocol_version,
      workerSessionId: identity.host.worker_session_id,
      workerSessionGeneration: identity.host.worker_session_generation,
      lastHeartbeatAt: identity.host.last_heartbeat_at,
    },
  };
}

function persistenceAttempt(attempt: AttemptRow) {
  return {
    id: attempt.id,
    organizationId: attempt.organization_id,
    jobId: attempt.job_id,
    workerHostId: attempt.worker_host_id,
    workerSessionId: attempt.worker_session_id,
    workerSessionGeneration: attempt.worker_session_generation,
    fence: attempt.fence,
    leaseTokenHash: attempt.lease_token_hash,
    leaseExpiresAt: attempt.lease_expires_at,
    leaseExpired: attempt.lease_expired,
    jobCurrentFence: attempt.job_current_fence,
    status: attempt.status,
    lastEventSeq: attempt.last_event_seq,
  };
}

function serverAttempt(
  attempt: Awaited<ReturnType<typeof lockPersistedAttempt>>,
): AttemptRow {
  return {
    id: attempt.id,
    organization_id: attempt.organizationId,
    job_id: attempt.jobId,
    worker_host_id: attempt.workerHostId,
    worker_session_id: attempt.workerSessionId ?? "",
    worker_session_generation: attempt.workerSessionGeneration,
    fence: attempt.fence,
    lease_token_hash: attempt.leaseTokenHash,
    lease_expires_at: attempt.leaseExpiresAt,
    lease_expired: attempt.leaseExpired,
    job_current_fence: attempt.jobCurrentFence,
    status: attempt.status,
    last_event_seq: attempt.lastEventSeq,
  };
}

export async function lockAttempt(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
): Promise<AttemptRow> {
  const attempt = await lockPersistedAttempt(
    transaction,
    persistenceIdentity(identity),
    attemptId,
  );
  const row = serverAttempt(attempt);
  assertAttemptRowIntegrity(row);
  return row;
}
export async function throwAttemptMutationAuthorityError(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
  tokenHash: string,
  fence: string,
): Promise<never> {
  return await throwPersistedAuthorityError(
    transaction,
    persistenceIdentity(identity),
    attemptId,
    tokenHash,
    fence,
  );
}

export function assertActiveLease(
  attempt: AttemptRow,
  identity: WorkerIdentity,
  tokenHash: string,
  fence: string,
): void {
  if (
    attempt.worker_host_id !== identity.host.id ||
    attempt.lease_token_hash !== tokenHash ||
    BigInt(attempt.fence) !== BigInt(fence) ||
    BigInt(attempt.job_current_fence) !== BigInt(fence) ||
    attempt.worker_session_id !== identity.host.worker_session_id ||
    sessionGeneration(attempt.worker_session_generation, 0n) !==
      sessionGeneration(identity.host.worker_session_generation, 0n)
  ) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
  if (attempt.lease_expired) {
    throw new StandardError({ code: "LEASE_EXPIRED" });
  }
  if (!activeAttempt(attempt.status)) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSON_VALUE_UNSERIALIZABLE");
  return new TextEncoder().encode(encoded).byteLength;
}

function validateWorkerEvent(event: {
  eventId: string;
  localSeq: string;
  eventType: string;
  payload: unknown;
}): void {
  if (
    WORKER_EVENT_TYPES[event.eventType] !== true ||
    TERMINAL_WORKER_EVENT_TYPES[event.eventType] === true ||
    !WORKER_EVENT_PAYLOAD_SCHEMAS[event.eventType] ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(event.eventId) ||
    !/^(?:0|[1-9][0-9]*)$/.test(event.localSeq)
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  try {
    if (BigInt(event.localSeq) < 1n) {
      throw new Error("local sequence");
    }
    if (jsonByteLength(event.payload) > EVENT_PAYLOAD_MAX_BYTES) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
  } catch (cause) {
    if (cause instanceof StandardError) throw cause;
    throw new StandardError({ code: "MALFORMED_REQUEST", cause });
  }
  const schema = WORKER_EVENT_PAYLOAD_SCHEMAS[event.eventType];
  if (!schema.safeParse(event.payload).success) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
}
export async function validateWorkerReferences(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  eventType: string,
  payload: unknown,
): Promise<void> {
  return await validatePersistedReferences(
    transaction,
    persistenceAttempt(attempt),
    eventType,
    payload,
  );
}

export async function loadExistingEvent(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
  localSeq: string,
): Promise<ExistingEventRow | undefined> {
  const row = await loadPersistedEvent(
    transaction,
    organizationId,
    attemptId,
    localSeq,
  );
  return row
    ? {
      local_seq: row.localSeq,
      event_id: row.eventId,
      event_type: row.eventType,
      payload_digest: row.payloadDigest,
      saved_ack: row.savedAck,
    }
    : undefined;
}

async function loadExistingEventsByIds(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
  eventIds: readonly string[],
): Promise<ExistingEventRow[]> {
  const rows = await loadEventsByIds(
    transaction,
    organizationId,
    attemptId,
    eventIds,
  );
  return rows.map((row) => ({
    local_seq: row.localSeq,
    event_id: row.eventId,
    event_type: row.eventType,
    payload_digest: row.payloadDigest,
    saved_ack: row.savedAck,
  }));
}

export function compareExistingEvent(
  existing: ExistingEventRow,
  eventId: string,
  eventType: string,
  digest: string,
): Ack {
  if (
    canonicalWorkerUuid(existing.event_id) !== canonicalWorkerUuid(eventId) ||
    existing.event_type !== eventType ||
    existing.payload_digest !== digest
  ) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return contractSchemas.WorkerAck.parse(jsonValue(existing.saved_ack, {}));
}

async function applyLifecycleEvent(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  eventType: string,
  metadata: RequestMetadata,
  principalId: string | null,
): Promise<void> {
  if (eventType !== "job.started") return;
  await applyStartedLifecycle(
    transaction,
    persistenceAttempt(attempt),
    metadata,
    principalId,
  );
}

export async function events(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const input = await parseContract(context, contractSchemas.WorkerEventBatch);
  const idempotencyKey = workerIdempotencyUuid(
    context.req.header("Idempotency-Key"),
  );
  const eventsInput = input.events.map((candidate) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) =>
        !["eventId", "localSeq", "eventType", "payload"].includes(key)
      ) ||
      !("eventId" in candidate) ||
      !("localSeq" in candidate) ||
      !("eventType" in candidate) ||
      !("payload" in candidate)
    ) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const eventId = candidate.eventId;
    const localSeq = candidate.localSeq;
    const eventType = candidate.eventType;
    if (
      typeof eventId !== "string" ||
      typeof localSeq !== "string" ||
      typeof eventType !== "string"
    ) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const event = {
      eventId,
      localSeq,
      eventType,
      payload: candidate.payload,
    };
    validateWorkerEvent(event);
    return event;
  });
  const tailEvent = eventsInput[eventsInput.length - 1];
  if (
    !tailEvent ||
    canonicalWorkerUuid(idempotencyKey) !==
      canonicalWorkerUuid(tailEvent.eventId)
  ) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  let previousLocalSeq = 0n;
  for (const event of eventsInput) {
    const localSeq = BigInt(event.localSeq);
    if (localSeq <= previousLocalSeq) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    previousLocalSeq = localSeq;
  }
  const eventIds = new Set<string>();
  for (const event of eventsInput) {
    const eventUuid = canonicalWorkerUuid(event.eventId);
    if (eventIds.has(eventUuid)) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    eventIds.add(eventUuid);
  }
  const metadata = requestMetadata(context);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const attempt = await lockAttempt(transaction, identity, attemptId);
      const tokenHash = await sha256Hex(input.leaseToken);
      const existingRows = new Map<string, ExistingEventRow>();
      const existingById = await loadExistingEventsByIds(
        transaction,
        identity.host.organization_id,
        attemptId,
        eventsInput.map((event) => event.eventId),
      );
      for (const existing of existingById) {
        const incoming = eventsInput.find((event) =>
          canonicalWorkerUuid(event.eventId) ===
            canonicalWorkerUuid(existing.event_id)
        );
        if (
          !incoming || BigInt(existing.local_seq) !== BigInt(incoming.localSeq)
        ) {
          throw new StandardError({
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
          });
        }
      }
      let hasUnseen = false;
      for (const event of eventsInput) {
        const existing = await loadExistingEvent(
          transaction,
          identity.host.organization_id,
          attemptId,
          event.localSeq,
        );
        if (existing) existingRows.set(event.localSeq, existing);
        else hasUnseen = true;
      }
      // Output retries retain the original submitted bytes' fingerprint even
      // though durable journal payloads contain only references. Validate saved
      // output receipts before checking authority for any unseen append.
      for (const event of eventsInput) {
        const existing = existingRows.get(event.localSeq);
        if (existing && event.eventType === "job.output") {
          compareExistingEvent(
            existing,
            event.eventId,
            event.eventType,
            await sha256Hex(canonicalJson(event)),
          );
        }
      }
      if (hasUnseen) {
        assertAttemptMutationSession(
          identity.host,
          attempt,
          input.workerSessionId,
          input.workerSessionGeneration,
        );
        assertActiveLease(attempt, identity, tokenHash, input.fence);
      }
      let expected = BigInt(attempt.last_event_seq);
      let lastAck: Ack | undefined;
      let replayed = true;
      for (const event of eventsInput) {
        const digest = await sha256Hex(canonicalJson({
          eventId: event.eventId,
          localSeq: event.localSeq,
          eventType: event.eventType,
          payload: event.payload,
        }));
        const existing = existingRows.get(event.localSeq);
        if (existing) {
          lastAck = compareExistingEvent(
            existing,
            event.eventId,
            event.eventType,
            digest,
          );
          continue;
        }
        const localSeq = BigInt(event.localSeq);
        if (localSeq !== expected + 1n) {
          throw new StandardError({
            code: "EXPECTED_SEQUENCE",
            params: {
              expectedLocalSeq: (expected + 1n).toString(),
              ackedLocalSeq: expected.toString(),
            },
          });
        }
        const journalPayload = event.eventType === "job.output"
          ? await appendOutputBatch(
            transaction,
            outputProducer(attempt),
            contractSchemas.OutputBatch.parse(event.payload),
            event.eventId,
          )
          : event.payload;
        if (event.eventType !== "job.output") {
          await validateWorkerReferences(
            transaction,
            attempt,
            event.eventType,
            event.payload,
          );
        }
        const ack = contractSchemas.WorkerAck.parse({
          eventId: event.eventId,
          status: "applied",
          lastEventSeq: localSeq.toString(),
        });
        await appendAttemptEvent(transaction, {
          organizationId: attempt.organization_id,
          attemptId: attempt.id,
          localSeq: event.localSeq,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: journalPayload,
          payloadDigest: digest,
          savedAck: ack,
        });
        const attemptUpdated = await advanceAttemptEventSequence(
          transaction,
          {
            organizationId: attempt.organization_id,
            attemptId: attempt.id,
            localSeq: event.localSeq,
            workerHostId: identity.host.id,
            leaseTokenHash: tokenHash,
            fence: input.fence,
          },
        );
        if (!attemptUpdated) {
          await throwAttemptMutationAuthorityError(
            transaction,
            identity,
            attempt.id,
            tokenHash,
            input.fence,
          );
        }
        await applyLifecycleEvent(
          transaction,
          attempt,
          event.eventType,
          metadata,
          identity.host.principal_id,
        );
        expected = localSeq;
        lastAck = ack;
        replayed = false;
      }
      if (!lastAck) throw new StandardError({ code: "UNPROCESSABLE" });
      return { ack: lastAck, replayed };
    },
  );
  return jsonResponse(result.ack, 200, result.replayed);
}

export function outputProducer(attempt: AttemptRow) {
  return {
    organizationId: attempt.organization_id,
    jobId: attempt.job_id,
    attemptId: attempt.id,
    workerHostId: attempt.worker_host_id,
    workerSessionId: attempt.worker_session_id,
    workerSessionGeneration: sessionGeneration(
      attempt.worker_session_generation,
      1n,
    ).toString(),
    fence: String(attempt.fence),
  };
}
