export { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
export { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
export { WorkerRequestError } from "../../../apps/worker/src/client.ts";
export {
  readWorkerConfig,
  readWorkerEnrollmentToken,
  readWorkerLaunchPermissions,
  WORKER_RUNTIME_ENVIRONMENT_NAMES,
  type WorkerConfig,
} from "../../../apps/worker/src/config.ts";
export { createDeterministicExecutor } from "../../../apps/worker/src/executor.ts";
export { main } from "../../../apps/worker/src/main.ts";
export { RegistrationStore } from "../../../apps/worker/src/registration.ts";
export { EventSpool, SpoolError } from "../../../apps/worker/src/spool.ts";
export { resultRequest } from "../../../apps/worker/src/supervisor-support.ts";
export { type Sleep } from "../../../apps/worker/src/supervisor.ts";
export {
  type JobAssignment,
  OUTPUT_STATUS_RESERVE_BYTES,
  OUTPUT_STATUS_RESERVE_RECORDS,
  type RegistrationState,
  terminalReservationBytes,
  WORKER_RESULT_MAX_BYTES,
  WORKER_SPOOL_MIN_BYTES,
  WORKER_SPOOL_MIN_RECORDS,
  type WorkerHeartbeatRequest,
  type WorkerResultRequest,
} from "../../../apps/worker/src/types.ts";
export { acquireStateLock } from "../../../apps/worker/src/storage.ts";
export type {
  StateLock,
  StateLockFactory,
} from "../../../apps/worker/src/storage.ts";

import { RegistrationStore } from "../../../apps/worker/src/registration.ts";
import { EventSpool, SpoolError } from "../../../apps/worker/src/spool.ts";
import {
  WorkerSupervisor as ProductionWorkerSupervisor,
} from "../../../apps/worker/src/supervisor.ts";
import type { WorkerConfig } from "../../../apps/worker/src/config.ts";
import type { Sleep } from "../../../apps/worker/src/supervisor.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";
import {
  WorkerApiClient as ProductionWorkerApiClient,
} from "../../../apps/worker/src/client.ts";
import { workerFixtureCapabilities } from "../worker-execution.ts";
const legacyHeartbeatResponses = new WeakSet<Response>();
const legacyLeaseRenewalResponses = new WeakSet<Response>();

/**
 * Test-only adapter for legacy recovery fixtures. It resolves omitted
 * heartbeat reconciliation from the request and supplies complete lease
 * responses only for explicitly marked incomplete successes.
 */

/**
 * Mark a successful lease-renewal response whose omitted fields are
 * intentionally supplied by the recovery adapter.
 */
export function legacyLeaseRenewalResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const response = protocolResponse(body, init);
  legacyLeaseRenewalResponses.add(response);
  return response;
}
export class RecoveryWorkerApiClient extends ProductionWorkerApiClient {
  constructor(
    options: ConstructorParameters<typeof ProductionWorkerApiClient>[0],
  ) {
    const fetcher = options.fetcher;
    super({
      ...options,
      ...(fetcher
        ? {
          fetcher: async (input, init) => {
            const response = await fetcher(input, init);
            const pathname = new URL(String(input)).pathname;
            if (
              pathname.endsWith("/heartbeat") &&
              response.status === 200
            ) {
              const responseBody = await response.json() as Record<
                string,
                unknown
              >;
              if (
                !("reconciledAttemptIds" in responseBody) &&
                legacyHeartbeatResponses.has(response)
              ) {
                const requestBody = JSON.parse(
                  String(init?.body ?? "{}"),
                ) as Record<string, unknown>;
                const activeAttemptIds = Array.isArray(
                    requestBody.activeAttemptIds,
                  )
                  ? requestBody.activeAttemptIds.filter(
                    (attemptId): attemptId is string =>
                      typeof attemptId === "string",
                  )
                  : [];
                const headers = new Headers(response.headers);
                headers.delete("content-length");
                return Response.json({
                  ...responseBody,
                  reconciledAttemptIds: activeAttemptIds,
                }, { status: 200, headers });
              }
              const headers = new Headers(response.headers);
              headers.delete("content-length");
              return Response.json(responseBody, {
                status: response.status,
                headers,
              });
            }
            if (
              !pathname.endsWith("/lease-renewals") ||
              response.status !== 200 ||
              !legacyLeaseRenewalResponses.has(response)
            ) return response;
            const requestBody = JSON.parse(
              String(init?.body ?? "{}"),
            ) as Record<string, unknown>;
            const responseBody = await response.json() as Record<
              string,
              unknown
            >;
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            return Response.json({
              attemptId: pathname.split("/").at(-2),
              fence: responseBody.fence ?? requestBody.fence ?? "1",
              leaseExpiresAt: responseBody.leaseExpiresAt ??
                requestBody.leaseExpiresAt ??
                new Date(Date.now() + 45_000).toISOString(),
              status: responseBody.status ?? "active",
              leaseDurationSeconds: responseBody.leaseDurationSeconds ?? 45,
              serverTime: responseBody.serverTime ??
                new Date().toISOString(),
            }, { status: 200, headers });
          },
        }
        : {}),
    });
  }
}
export { RecoveryWorkerApiClient as WorkerApiClient };

export const WorkerSupervisor = ProductionWorkerSupervisor;
export type WorkerSupervisorInstance = InstanceType<
  typeof ProductionWorkerSupervisor
>;
export type EventSpoolInstance = EventSpool;
export type SpoolErrorInstance = SpoolError;

export function supervisorConfig(stateDir: string): WorkerConfig {
  return {
    environment: "test",
    serverUrl: "http://127.0.0.1:8788",
    version: "issue39-test",
    name: "issue39-supervisor",
    os: "linux",
    architecture: "x64",
    capabilities: [...workerFixtureCapabilities],
    toolchainVersions: { deno: "2.x" },
    slots: 1,
    stateDir,
    registrationPath: `${stateDir}/registration.json`,
    spoolPath: `${stateDir}/spool.json`,
    heartbeatIntervalMs: 100,
    claimBackoffBaseMs: 10,
    claimBackoffMaxMs: 20,
    requestTimeoutMs: 1_000,
    drainTimeoutMs: 1_000,
    terminationGraceMs: 1_000,
    spoolMaxRecords: 100,
    spoolMaxBytes: 100_000,
  };
}

export const fastSleep: Sleep = (milliseconds, signal) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, Math.max(1, milliseconds));
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
};

export const recoverySleep: Sleep = (milliseconds, signal) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, Math.min(50, Math.max(1, milliseconds)));
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
};

export type AckPayload = {
  eventId: string;
  status: "applied";
  lastEventSeq: string;
};

export function ackPayload(init?: RequestInit): AckPayload {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    events?: Array<{ eventId?: string; localSeq?: string }>;
    localSeq?: string;
  };
  const event = body.events?.at(-1);
  const requestKey = new Headers(init?.headers).get("Idempotency-Key");
  return {
    eventId: requestKey ?? event?.eventId ?? crypto.randomUUID(),
    status: "applied",
    lastEventSeq: event?.localSeq ?? body.localSeq ?? "1",
  };
}

export function protocolResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("X-Bakery-Worker-Protocol-Version", "2");
  return Response.json(body, { ...init, headers });
}

export function ackResponse(init?: RequestInit): Response {
  return protocolResponse(ackPayload(init));
}

export function protocolEmptyResponse(init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("X-Bakery-Worker-Protocol-Version", "2");
  return new Response(null, { ...init, headers });
}

export function journalTuple(
  kind: "event" | "result",
  body: Record<string, unknown>,
): unknown {
  if (kind === "event") {
    return {
      leaseToken: body.leaseToken,
      fence: body.fence,
      events: body.events,
    };
  }
  return {
    leaseToken: body.leaseToken,
    fence: body.fence,
    localSeq: body.localSeq,
    status: body.status,
    result: body.result,
    fault: body.fault,
    cancellation: body.cancellation,
  };
}
export async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  code: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lockTimeout: Error | undefined;
  while (Date.now() < deadline) {
    let satisfied = false;
    try {
      satisfied = await check();
      lockTimeout = undefined;
    } catch (error) {
      // A poll that reads the worker state while the supervisor holds its lock
      // can wait out the 1s lock budget on a loaded host; the next poll reads
      // again. Any other error ends the wait.
      if (
        !(error instanceof Error && error.message === "WORKER_STATE_LOCKED")
      ) {
        throw error;
      }
      lockTimeout = error;
    }
    if (satisfied) return;
    const delay = Math.min(10, Math.max(1, deadline - Date.now()));
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delay);
    await promise;
  }
  throw new Error(
    `${code}_TIMEOUT`,
    lockTimeout === undefined ? undefined : { cause: lockTimeout },
  );
}

/**
 * Observes a run() from creation. A run() that rejects while its test is still
 * waiting on something else fails the `await run` that follows, not the whole
 * module as an unhandled rejection that cancels every later test.
 */
export function observeRun(run: Promise<void>): Promise<void> {
  run.catch(() => undefined);
  return run;
}

export function localAssignment(
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString(),
): JobAssignment {
  const value = {
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    leaseToken: "x".repeat(43),
    fence: "1",
    leaseExpiresAt,
    action: "harness.implement",
    requirements: {},
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
    },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
    leaseDurationSeconds: 45,
    serverTime: new Date().toISOString(),
    sealedCredentialOperation: null,
  };
  return value as JobAssignment;
}

/** Valid claim-response fixture for lifecycle tests without model authorization. */
export function nonmodelAssignment(
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString(),
): JobAssignment {
  return {
    ...localAssignment(leaseExpiresAt),
    action: "quality.check",
    input: {
      repositoryId: crypto.randomUUID(),
      revision: "fixture",
      checks: ["source.integrity"],
    },
  };
}
/**
 * Build a v2 heartbeat body. Explicit reconciliation ids are emitted on the
 * wire; omitted ids are tagged only in memory for the recovery adapter.
 */
export function heartbeatResponse(
  workerHostId: string,
  pendingCommands: unknown[] = [],
  commandAcks: unknown[] = [],
  workerSessionId: string = workerHostId,
  workerSessionGeneration = "1",
  reconciledAttemptIds?: string[],
  init: ResponseInit = {},
): Response {
  const body = {
    workerHostId,
    status: "accepted" as const,
    receivedAt: new Date().toISOString(),
    pendingCommands,
    commandAcks,
    workerSessionId,
    workerSessionGeneration,
    ...(reconciledAttemptIds === undefined ? {} : { reconciledAttemptIds }),
    serverTime: new Date().toISOString(),
    inventoryRevision: 1,
  };
  const response = protocolResponse(body, init);
  if (reconciledAttemptIds === undefined) {
    legacyHeartbeatResponses.add(response);
  }
  return response;
}
export async function openRecoveryState(
  directory: string,
  options: {
    registrationPath?: string;
    spoolPath?: string;
    maxRecords?: number;
    maxBytes?: number;
  } = {},
): Promise<{ registrationStore: RegistrationStore; spool: EventSpool }> {
  const registrationStore = new RegistrationStore(
    options.registrationPath ?? `${directory}/registration.json`,
  );
  const spool = await EventSpool.open({
    path: options.spoolPath ?? `${directory}/spool.json`,
    maxRecords: options.maxRecords ?? 100,
    maxBytes: options.maxBytes ?? 100_000,
  });
  return { registrationStore, spool };
}

export function createRecoverySupervisor(
  directory: string,
  options: Omit<ConstructorParameters<typeof WorkerSupervisor>[0], "config"> & {
    serverUrl?: string;
  },
): WorkerSupervisorInstance {
  const { serverUrl, ...supervisorOptions } = options;
  return new WorkerSupervisor({
    config: {
      ...supervisorConfig(directory),
      ...(serverUrl === undefined ? {} : { serverUrl }),
    },
    ...supervisorOptions,
  });
}
