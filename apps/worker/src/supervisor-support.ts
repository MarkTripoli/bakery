import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import { WorkerRequestError, type WorkerResponse } from "./client.ts";
import type { ExecutionOutcome } from "./executor.ts";
import type {
  JobAssignment,
  JsonValue,
  LeaseState,
  SpoolRecord,
  WorkerHeartbeatRequest,
  WorkerResultRequest,
  WorkerSessionGeneration,
} from "./types.ts";

export const MAX_COMMAND_ACKS = 100;
export const MAX_ACTIVE_ATTEMPTS = 100;

const LEASE_LOSS_CODES: Record<string, true> = {
  LEASE_EXPIRED: true,
  LEASE_FENCED: true,
};

function leaseReconciliationReason(status: LeaseState["status"]): string {
  if (status === "expired") return "LEASE_EXPIRED";
  if (status === "revoked") return "LEASE_REVOKED";
  return "LEASE_STATE_MISMATCH";
}

export function isAlreadyTerminal(error: unknown): error is WorkerRequestError {
  return error instanceof WorkerRequestError &&
    error.status === 409 &&
    error.code === "ALREADY_TERMINAL";
}

export type Sleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export type ActiveAssignment = {
  assignment: JobAssignment;
  controller: AbortController;
  renewalController: AbortController;
  leaseSeconds: number;
  leaseDeadline: number;
  renewalKey?: string;
  renewalLoopStarted: boolean;
  abandonmentTimer?: number;
  terminalAcked: boolean;
  executionStarted: boolean;
  executionSettled?: boolean;
  boundaryFailure?: boolean;
  cleanCancellationEligible?: boolean;
  publicationRevoked?: boolean;
  restored: boolean;
};
export function canPublishActiveAssignment(
  state: {
    active: Map<string, ActiveAssignment>;
    terminationEvidence: Map<string, unknown>;
    serverTerminalObservations: Set<string>;
  },
  active: ActiveAssignment,
): boolean {
  const attemptId = active.assignment.attemptId;
  return state.active.get(attemptId) === active &&
    !active.publicationRevoked &&
    !active.controller.signal.aborted &&
    !active.renewalController.signal.aborted &&
    !state.terminationEvidence.has(attemptId) &&
    !state.serverTerminalObservations.has(attemptId);
}

export type PendingHeartbeat = {
  idempotencyKey: string;
  body: WorkerHeartbeatRequest;
};

export type WorkerSessionTiming = {
  workerSessionId: string;
  workerSessionGeneration: string;
  serverTime: string;
};

export type ResultPayload = {
  status: "completed" | "failed" | "canceled";
  result?: JsonValue;
  fault?: JsonValue;
  cancellation?: JsonValue;
};

export function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", wake);
      resolve();
    }, Math.max(0, milliseconds));
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    signal?.addEventListener("abort", wake, { once: true });
  });
}

export async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const result = Promise.withResolvers<T>();
  let settled = false;
  const cleanup = () => {
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    result.reject(new DOMException("The operation was aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(
    (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      result.resolve(value);
    },
    (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      result.reject(error);
    },
  );
  return await result.promise;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function leaseDeadline(
  serverTime: string,
  leaseExpiresAt: string,
  requestStartedAt: number,
  requestFinishedAt: number,
): number {
  const serverNow = Date.parse(serverTime);
  const serverExpiry = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(serverNow) || !Number.isFinite(serverExpiry)) {
    return requestFinishedAt;
  }
  const duration = Math.max(0, serverExpiry - serverNow);
  const roundTrip = Math.max(0, requestFinishedAt - requestStartedAt);
  return requestFinishedAt + Math.max(0, duration - roundTrip);
}

export function leaseDeadlineFromAuthoritativeServerTime(
  leaseExpiresAt: string,
  authoritativeServerTimeMs: number | null,
  authoritativeObservedAtMs: number | null,
  requestStartedAt: number,
): number {
  const serverExpiry = Date.parse(leaseExpiresAt);
  if (
    !Number.isFinite(serverExpiry) ||
    authoritativeServerTimeMs === null ||
    !Number.isFinite(authoritativeServerTimeMs) ||
    authoritativeObservedAtMs === null ||
    !Number.isFinite(authoritativeObservedAtMs)
  ) {
    return requestStartedAt;
  }
  return authoritativeObservedAtMs + serverExpiry - authoritativeServerTimeMs;
}

export function leaseValid(active: ActiveAssignment): boolean {
  return performance.now() < active.leaseDeadline;
}
export type LeaseReconciliation =
  | { status: "updated"; serverTime: string }
  | { status: "release"; reason: string };

export function reconcileLeaseResponse(input: {
  active: ActiveAssignment;
  response: WorkerResponse<LeaseState>;
  workerSessionId: string;
  workerSessionGeneration: string;
  authoritativeServerTimeMs: number | null;
  authoritativeObservedAtMs: number | null;
  requestStartedAt: number;
  requestFinishedAt: number;
}): LeaseReconciliation {
  const { active, response } = input;
  const leaseState = response.value;
  if (
    leaseState.attemptId !== active.assignment.attemptId ||
    leaseState.fence !== active.assignment.fence ||
    leaseState.status !== "active"
  ) {
    return {
      status: "release",
      reason: leaseState.attemptId !== active.assignment.attemptId ||
          leaseState.fence !== active.assignment.fence
        ? "LEASE_STATE_MISMATCH"
        : leaseReconciliationReason(leaseState.status),
    };
  }
  const serverTime = requireServerTime(leaseState);
  if (response.replayed) {
    active.leaseDeadline = leaseDeadlineFromAuthoritativeServerTime(
      leaseState.leaseExpiresAt,
      input.authoritativeServerTimeMs,
      input.authoritativeObservedAtMs,
      input.requestStartedAt,
    );
    if (!leaseValid(active)) {
      return { status: "release", reason: "LEASE_RENEWAL_EXPIRED" };
    }
  } else {
    const serverTimeMs = Date.parse(serverTime);
    if (
      Number.isFinite(serverTimeMs) &&
      input.authoritativeServerTimeMs !== null &&
      serverTimeMs < input.authoritativeServerTimeMs
    ) {
      return { status: "release", reason: "LEASE_RENEWAL_REPLAYED" };
    }
    active.leaseDeadline = leaseDeadline(
      serverTime,
      leaseState.leaseExpiresAt,
      input.requestStartedAt,
      input.requestFinishedAt,
    );
  }
  active.assignment = {
    ...active.assignment,
    leaseExpiresAt: leaseState.leaseExpiresAt,
    workerSessionId: input.workerSessionId,
    workerSessionGeneration: input.workerSessionGeneration,
  };
  return { status: "updated", serverTime };
}

function normalizeSessionGeneration(
  value: WorkerSessionGeneration | undefined,
): string | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value)
  ) return null;
  try {
    if (BigInt(value) > 9223372036854775807n) return null;
  } catch {
    return null;
  }
  return value;
}

export function proposedSessionGeneration(
  value: WorkerSessionGeneration | undefined,
): string {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) return String(value);
  return normalizeSessionGeneration(value) ?? "0";
}

export function requireWorkerSessionTiming(value: {
  workerSessionId?: string;
  workerSessionGeneration?: WorkerSessionGeneration;
  serverTime?: string;
}): WorkerSessionTiming {
  const generation = normalizeSessionGeneration(value.workerSessionGeneration);
  if (
    typeof value.workerSessionId !== "string" ||
    generation === null ||
    typeof value.serverTime !== "string" ||
    !Number.isFinite(Date.parse(value.serverTime))
  ) {
    throw new WorkerRequestError(
      "WORKER_PROTOCOL_UNSUPPORTED",
      null,
      false,
    );
  }
  return {
    workerSessionId: value.workerSessionId,
    workerSessionGeneration: generation,
    serverTime: value.serverTime,
  };
}

export function requireLeaseDuration(value: {
  leaseDurationSeconds?: number;
}): number {
  if (
    typeof value.leaseDurationSeconds !== "number" ||
    !Number.isFinite(value.leaseDurationSeconds)
  ) {
    throw new WorkerRequestError(
      "WORKER_PROTOCOL_UNSUPPORTED",
      null,
      false,
    );
  }
  return value.leaseDurationSeconds;
}

export function requireServerTime(value: { serverTime?: string }): string {
  if (
    typeof value.serverTime !== "string" ||
    !Number.isFinite(Date.parse(value.serverTime))
  ) {
    throw new WorkerRequestError(
      "WORKER_PROTOCOL_UNSUPPORTED",
      null,
      false,
    );
  }
  return value.serverTime;
}

export function requiredAssignmentTiming(assignment: JobAssignment): {
  workerSessionId: string;
  workerSessionGeneration: string;
  serverTime: string;
  leaseDurationSeconds: number;
} {
  return {
    ...requireWorkerSessionTiming(assignment),
    leaseDurationSeconds: requireLeaseDuration(assignment),
  };
}

export function errorFault(code: string, detail: string): JsonValue {
  return {
    type: "about:blank",
    title: "Worker execution failed",
    status: 500,
    detail,
    code,
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

export function outcomeResult(outcome: ExecutionOutcome): ResultPayload {
  const usage = outcome.usage === undefined ? {} : { usage: outcome.usage };
  if (outcome.status === "completed") {
    return { status: outcome.status, result: outcome.result, ...usage };
  }
  if (outcome.status === "failed") {
    return { status: outcome.status, fault: outcome.fault, ...usage };
  }
  return {
    status: outcome.status,
    cancellation: outcome.cancellation,
    ...usage,
  };
}

export function resultRequest(
  record: SpoolRecord,
  workerSessionId: string,
  workerSessionGeneration: string,
): WorkerResultRequest {
  return {
    leaseToken: record.leaseToken,
    fence: record.fence,
    localSeq: record.localSeq,
    workerSessionId,
    workerSessionGeneration,
    ...(record.payload as ResultPayload),
  } as WorkerResultRequest;
}

export function withinBytes(value: unknown, maximum: number): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
}

export function isLeaseLoss(error: unknown): error is WorkerRequestError {
  return error instanceof WorkerRequestError &&
    error.status === 409 &&
    LEASE_LOSS_CODES[error.code] === true;
}

/**
 * Transient control-plane failure: a retryable error, or any 5xx (including a
 * 500 INTERNAL from a server that is recovering from a database outage, which
 * the contracts table marks non-retryable). Heartbeat, claim and lease renewal
 * all carry idempotency keys and the server rolls a failed transaction back, so
 * retrying a 5xx cannot apply anything twice. 4xx failures (LEASE_FENCED, auth,
 * malformed, protocol) are never transient.
 */
export function isTransientControlPlaneFailure(
  error: unknown,
): error is WorkerRequestError {
  return error instanceof WorkerRequestError &&
    (error.retryable ||
      (error.status !== null && error.status >= 500 && error.status <= 599));
}

const CONTROL_PLANE_CODE = /^[A-Z0-9_]{1,64}$/;

export type ControlPlaneRetryRoute = "heartbeat" | "lease_renewal" | "claim";

/**
 * Logs one bounded line for a transient control-plane failure the worker is
 * about to retry. Only the route, a validated error code, the HTTP status and
 * the delay are written: never the diagnostic or the problem detail.
 */
export function logControlPlaneRetry(
  route: ControlPlaneRetryRoute,
  error: WorkerRequestError,
  delayMs: number,
): void {
  console.warn(JSON.stringify({
    component: "worker-supervisor",
    event: "control_plane_retry",
    route,
    code: CONTROL_PLANE_CODE.test(error.code) ? error.code : "UNCLASSIFIED",
    status: error.status,
    delayMs,
  }));
}

export function parseActionOutput(
  assignment: JobAssignment,
  result: JsonValue,
): JsonValue {
  return workerActionOutputSchema(assignment.action).parse(result) as JsonValue;
}
