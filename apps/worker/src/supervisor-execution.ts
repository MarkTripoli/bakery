import { WorkerRequestError } from "./client.ts";
import {
  MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT,
  mergeTerminationEvidence,
  syncAdmissionPause,
  terminationEvidence,
  TerminationEvidenceCapacityError,
} from "./control-state.ts";
import { boundedNativeDiagnostic, NativeExecutorError } from "./executor.ts";
import type { ExecutionOutcome } from "./executor.ts";
import { openNativeOutputCapture } from "./native-output.ts";
import { PreparedSecretInvocationError } from "./prepared-secret-invoker.ts";
import { validatePublicationAuthority } from "./quarantine.ts";
import { SpoolError } from "./spool.ts";

import {
  type JobAssignment,
  type JsonValue,
  type PreparedSkillContext,
  type SpoolRecord,
  terminalReservationBytes,
} from "./types.ts";
import type { SupervisorState } from "./supervisor-state.ts";
import { withControlPlane } from "./supervisor-control-plane.ts";
import {
  type ActiveAssignment,
  canPublishActiveAssignment,
  errorFault,
  isAlreadyTerminal,
  isLeaseLoss,
  leaseValid,
  nowIso,
  outcomeResult,
  parseActionOutput,
  resultRequest,
  withinBytes,
} from "./supervisor-support.ts";
import { WORKER_RESULT_MAX_BYTES } from "./types.ts";
const MAX_HELD_RELEASED_JOURNALS = 64;
const MAX_TERMINATION_CLEANUP_CONFLICTS = 3;
const MAX_SERVER_TERMINAL_OBSERVATIONS = 64;
const TERMINATION_CLEANUP_RETRY_BASE_MS = 250;
const LEASE_LOSS_REASONS: Record<string, true> = {
  ATTEMPT_FENCE_MISMATCH: true,
  HEARTBEAT_NOT_RECONCILED: true,
  LEASE_EXPIRED: true,
  LEASE_FENCED: true,
  LEASE_RENEWAL_EXPIRED: true,
  LEASE_RENEWAL_REPLAYED: true,
  LEASE_REVOKED: true,
  LEASE_STATE_MISMATCH: true,
  LEASE_TOKEN_MISMATCH: true,
  SESSION_GENERATION_MISMATCH: true,
  SESSION_MISMATCH: true,
  PUBLICATION_LEASE_EXPIRED: true,
  PUBLICATION_LEASE_FENCED: true,
};
const TERMINATION_UNCERTAIN_REASONS: Record<string, true> = {
  CONTROL_COMMAND_ABORTED: true,
  TERMINATION_PENDING: true,
  TERMINATION_UNKNOWN: true,
};
const JOURNAL_RETIREMENT_REASONS: Record<string, true> = {
  CANCEL_ACCEPTED: true,
  PUBLICATION_ATTEMPT_MISMATCH: true,
  PUBLICATION_AUTHORITY_REJECTED: true,
  PUBLICATION_NOT_AUTHORIZED: true,
  RELEASED_JOURNAL_REJECTED: true,
  TERMINAL_RESULT_ALREADY_ACCEPTED: true,
};
type ReportSupervisorFault = (error: unknown) => void;
class FlushAttemptError extends Error {
  readonly original: unknown;

  constructor(
    readonly attemptId: string,
    original: unknown,
  ) {
    super(
      original instanceof Error
        ? original.message
        : "WORKER_FLUSH_ATTEMPT_FAILED",
    );
    this.name = "FlushAttemptError";
    this.original = original;
  }
}

/**
 * A protocol-valid 4xx problem is a definitive refusal. A local
 * response-validation failure, header-less proxy response or unreadable body
 * is ambiguous, so the journal is kept and the worker fails fatal for replay.
 */
function isServerPublicationRejection(
  error: unknown,
): error is WorkerRequestError {
  return error instanceof WorkerRequestError && error.serverProblem &&
    !error.retryable && error.status !== null && error.status >= 400 &&
    error.status <= 499;
}

/** Returns the wrapped error for a FlushAttemptError, else the error. */
export function unwrapFlushAttemptError(error: unknown): unknown {
  return error instanceof FlushAttemptError ? error.original : error;
}

function flushAttemptError(
  attemptId: string,
  error: unknown,
): FlushAttemptError {
  return error instanceof FlushAttemptError
    ? error
    : new FlushAttemptError(attemptId, error);
}

async function releaseAttemptForFlush(
  state: SupervisorState,
  attemptId: string,
  reason: string,
  options: { discardJournal?: boolean },
  failFatal?: (reason: string) => void,
): Promise<void> {
  try {
    await releaseAttempt(state, attemptId, reason, options, failFatal);
  } catch (error) {
    throw flushAttemptError(attemptId, error);
  }
}

function boundedSupervisorFault(error: unknown): string {
  const text = error instanceof WorkerRequestError
    ? error.diagnostic ?? `${error.code}:${error.status ?? "unknown"}`
    : error instanceof Error
    ? error.message
    : "SUPERVISOR_FAULT";
  return boundedNativeDiagnostic(text);
}

async function retireFailedPublication(
  state: SupervisorState,
  attemptId: string,
  error: unknown,
  failFatal: ((reason: string) => void) | undefined,
  reportFault: ReportSupervisorFault | undefined,
): Promise<void> {
  reportFault?.(error);
  const active = state.active.get(attemptId);
  const releaseReason = active?.executionStarted &&
      active.executionSettled !== true
    ? "TERMINATION_UNKNOWN"
    : "RESULT_PUBLICATION_FAILED";
  try {
    await releaseAttempt(
      state,
      attemptId,
      releaseReason,
      { discardJournal: true },
      failFatal,
    );
  } catch (releaseError) {
    reportFault?.(releaseError);
    failFatal?.(boundedSupervisorFault(releaseError));
  }
}

export type ExecutionCallbacks = {
  reportError?: (error: unknown) => void;
  reportSupervisorFault?: (error: unknown) => void;
  failFatal: (reason: string) => void;
  startLeaseRenewal: (active: ActiveAssignment) => void;
};

function sameSkillRefs(
  left: JobAssignment["skillRefs"],
  right: JobAssignment["skillRefs"],
): boolean {
  return left.length === right.length &&
    left.every((ref, index) =>
      ref.versionId === right[index]?.versionId &&
      ref.digest === right[index]?.digest
    );
}

function canInvokeWithPreparedSkills(
  state: SupervisorState,
  active: ActiveAssignment,
  preparedFrom: JobAssignment,
  prepared: PreparedSkillContext | undefined,
  signal: AbortSignal,
): boolean {
  const current = active.assignment;
  const registration = state.registration;
  const authority = state.publicationAuthorities.get(current.attemptId);
  return state.active.get(current.attemptId) === active &&
    !state.stopping && !state.draining && state.processSessionAcquired &&
    state.freshHeartbeatReady && !signal.aborted &&
    !active.controller.signal.aborted &&
    !active.renewalController.signal.aborted &&
    leaseValid(active) && canPublishActiveAssignment(state, active) &&
    registration?.workerHostId === current.workerHostId &&
    registration.workerSessionId === state.processSessionId &&
    String(registration.workerSessionGeneration) ===
      state.processSessionGeneration &&
    current.workerSessionId === state.processSessionId &&
    current.workerSessionGeneration === state.processSessionGeneration &&
    current.jobId === preparedFrom.jobId &&
    current.attemptId === preparedFrom.attemptId &&
    current.workerHostId === preparedFrom.workerHostId &&
    current.leaseToken === preparedFrom.leaseToken &&
    String(current.fence) === String(preparedFrom.fence) &&
    sameSkillRefs(current.skillRefs, preparedFrom.skillRefs) &&
    (prepared === undefined || (
      prepared.owner.workerHostId === current.workerHostId &&
      prepared.owner.workerSessionId === state.processSessionId &&
      prepared.owner.workerSessionGeneration ===
        state.processSessionGeneration &&
      prepared.owner.jobId === current.jobId &&
      prepared.owner.attemptId === current.attemptId &&
      prepared.owner.fence === String(current.fence)
    )) &&
    authority !== undefined && validatePublicationAuthority({
      ...current,
      workerSessionId: state.processSessionId,
      workerSessionGeneration: state.processSessionGeneration,
    }, authority).allowed;
}

function hasTerminalRecord(state: SupervisorState, attemptId: string): boolean {
  return state.spool.records().some((record) =>
    record.attemptId === attemptId && record.kind === "result"
  );
}

function hasDurableTerminalResult(
  state: SupervisorState,
  attemptId: string,
): boolean {
  return state.spool.records().some((record) => {
    if (record.attemptId !== attemptId || record.kind !== "result") {
      return false;
    }
    const payload = record.payload;
    if (
      payload === null || typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return false;
    }
    const status = (payload as Record<string, unknown>).status;
    return status === "completed" || status === "failed";
  });
}
function hasProvenCancellationTermination(
  outcome: ExecutionOutcome,
): boolean {
  if (
    outcome.status !== "canceled" ||
    outcome.cancellation === null ||
    typeof outcome.cancellation !== "object" ||
    Array.isArray(outcome.cancellation)
  ) return false;
  const cancellation = outcome.cancellation as Record<string, JsonValue>;
  const exitedAt = typeof cancellation.exitedAt === "string"
    ? cancellation.exitedAt
    : typeof cancellation.observedExitAt === "string"
    ? cancellation.observedExitAt
    : null;
  return cancellation.processExited === true &&
    cancellation.cleanupStatus === "complete" &&
    cancellation.terminationStatus === "confirmed" &&
    exitedAt !== null &&
    Number.isFinite(Date.parse(exitedAt));
}

// Aborts and executor rejections are not process-exit proof. Only an explicit,
// timestamped confirmation can make a started attempt safe to replay.
function canPublishDuringDrain(
  state: SupervisorState,
  active: ActiveAssignment | undefined,
): boolean {
  return Boolean(
    state.draining &&
      active?.executionStarted &&
      active.executionSettled !== true &&
      !active.publicationRevoked &&
      !state.terminationEvidence.has(active.assignment.attemptId) &&
      !state.serverTerminalObservations.has(active.assignment.attemptId),
  );
}

function clearAbandonmentTimer(
  state: SupervisorState,
  active: ActiveAssignment,
): void {
  const timer = active.abandonmentTimer;
  if (timer === undefined) return;
  clearTimeout(timer);
  state.abandonmentTimers.delete(timer);
  active.abandonmentTimer = undefined;
}
function logTerminationEvent(
  event: string,
  details: Record<string, string | number | boolean | undefined> = {},
): void {
  console.warn(JSON.stringify({
    component: "worker-supervisor",
    event,
    ...details,
  }));
}

async function clearTerminationEvidence(
  state: SupervisorState,
  attemptId: string,
): Promise<void> {
  const hadCapacityPause = state.registration?.capacityPaused === true;
  state.registration = await state.registrationStore.clearTerminationEvidence(
    attemptId,
  );
  state.terminationEvidence = new Map(
    Object.entries(state.registration.terminationEvidence ?? {}),
  );
  state.terminationCleanupFailures.delete(attemptId);
  state.terminationCleanupRetries.delete(attemptId);
  state.terminationCleanupNextRetryAt.delete(attemptId);
  state.serverTerminalObservations.delete(attemptId);
  if (hadCapacityPause && state.registration.capacityPaused !== true) {
    state.controlState.capacityPaused = false;
    syncAdmissionPause(state.controlState);
    logTerminationEvent("termination_evidence_capacity_resumed");
  }
}

async function syncActiveJournal(
  state: SupervisorState,
  active: ActiveAssignment,
): Promise<void> {
  const journal = state.spool.journalState(active.assignment.attemptId);
  state.registration = await state.registrationStore.updateActiveAssignment(
    active.assignment.attemptId,
    journal,
  );
}

async function waitForRecordAck(
  state: SupervisorState,
  record: SpoolRecord,
  active: ActiveAssignment,
): Promise<boolean> {
  while (
    !state.stopping && leaseValid(active) &&
    state.active.has(active.assignment.attemptId) &&
    !active.controller.signal.aborted &&
    !state.terminationEvidence.has(active.assignment.attemptId)
  ) {
    if (!state.spool.hasRecord(record.attemptId, record.localSeq)) {
      await syncActiveJournal(state, active);
      return true;
    }
    await state.sleep(
      Math.min(250, state.config.heartbeatIntervalMs),
      state.lifecycleController.signal,
    );
  }
  if (
    !active.controller.signal.aborted &&
    !state.terminationEvidence.has(active.assignment.attemptId) &&
    !state.spool.hasRecord(record.attemptId, record.localSeq)
  ) {
    await syncActiveJournal(state, active);
    return true;
  }
  return false;
}

async function waitForOutputClose(
  state: SupervisorState,
  active: ActiveAssignment,
): Promise<boolean> {
  while (
    !state.stopping && leaseValid(active) &&
    state.active.get(active.assignment.attemptId) === active &&
    (!active.controller.signal.aborted ||
      canPublishDuringDrain(state, active)) &&
    !state.terminationEvidence.has(active.assignment.attemptId)
  ) {
    if (!state.spool.hasPendingOutputClose(active.assignment.attemptId)) {
      return true;
    }
    await state.sleep(
      Math.min(250, state.config.heartbeatIntervalMs),
      state.lifecycleController.signal,
    );
  }
  return !state.spool.hasPendingOutputClose(active.assignment.attemptId);
}

async function waitForAttemptDrain(
  state: SupervisorState,
  active: ActiveAssignment,
): Promise<void> {
  while (
    !state.stopping && leaseValid(active) &&
    state.active.has(active.assignment.attemptId)
  ) {
    if (!state.spool.attemptIds().includes(active.assignment.attemptId)) return;
    await state.sleep(
      Math.min(250, state.config.heartbeatIntervalMs),
      state.lifecycleController.signal,
    );
  }
}

async function ensureEvent(
  state: SupervisorState,
  active: ActiveAssignment,
  eventType: string,
  payload: JsonValue,
  localSeq: string,
): Promise<boolean> {
  const attemptId = active.assignment.attemptId;
  const journal = state.spool.journalState(attemptId);
  if (BigInt(journal.ackedLocalSeq) >= BigInt(localSeq)) {
    await syncActiveJournal(state, active);
    return true;
  }
  const existing = state.spool.records().find((record) =>
    record.attemptId === attemptId && record.localSeq === localSeq &&
    record.type === eventType
  );
  const record = existing ?? await state.spool.enqueueEvent({
    attemptId,
    leaseToken: active.assignment.leaseToken,
    fence: active.assignment.fence,
    localSeq,
    eventId: crypto.randomUUID(),
    eventType,
    payload,
  });
  await syncActiveJournal(state, active);
  return await waitForRecordAck(state, record, active);
}

export async function releaseAttempt(
  state: SupervisorState,
  attemptId: string,
  reason: string,
  options: { discardJournal?: boolean } = {},
  failFatal?: (reason: string) => void,
): Promise<void> {
  const active = state.active.get(attemptId);
  const hasReplaySafeJournal = state.spool.hasReplaySafeRecord(attemptId);
  const executionUncertain = active?.executionStarted === true &&
    active.executionSettled !== true;
  const terminalResultAwaitingAck = reason === "HEARTBEAT_NOT_RECONCILED" &&
    hasDurableTerminalResult(state, attemptId);
  const replaySafeRelease = hasReplaySafeJournal &&
    (!executionUncertain || terminalResultAwaitingAck) &&
    (active === undefined
      ? reason === "HEARTBEAT_NOT_RECONCILED"
      : LEASE_LOSS_REASONS[reason] === true);
  const terminalRejection = reason === "ALREADY_TERMINAL" ||
    reason === "CANCEL_REQUESTED";
  const serverTerminalObservation = terminalRejection ||
    reason === "RESULT_ACKED" ||
    reason === "TERMINAL_RESULT_ALREADY_ACCEPTED";
  const journalRetirement = !executionUncertain &&
    (JOURNAL_RETIREMENT_REASONS[reason] === true || terminalRejection);
  const leaseLoss = !replaySafeRelease && !journalRetirement &&
    LEASE_LOSS_REASONS[reason] === true;
  const terminationUncertain = !replaySafeRelease && !journalRetirement &&
    (TERMINATION_UNCERTAIN_REASONS[reason] === true ||
      (terminalRejection && executionUncertain));
  const quarantine = leaseLoss || terminationUncertain;
  const hasSpool = state.spool.attemptIds().includes(attemptId);
  const shouldPersist = state.registration?.activeAssignments?.[attemptId] !==
      undefined ||
    state.registration?.releaseMarkers?.[attemptId] !== undefined ||
    active !== undefined ||
    hasSpool ||
    quarantine;
  if (quarantine || serverTerminalObservation) {
    state.publicationAuthorities.delete(attemptId);
    if (active) active.publicationRevoked = true;
  }
  if (active) {
    active.controller.abort();
    active.renewalController.abort();
  }
  try {
    if (quarantine) {
      const existing = state.terminationEvidence.get(attemptId);
      const assignment = active?.assignment ??
        state.registration?.activeAssignments?.[attemptId]?.assignment;
      const incoming = {
        status: reason === "TERMINATION_UNKNOWN" || leaseLoss ||
            (terminalRejection && executionUncertain)
          ? "unknown" as const
          : "pending" as const,
        observedAt: nowIso(),
        ...(assignment ? { fence: String(assignment.fence) } : {}),
      };
      const fenceMatches = existing?.fence === undefined ||
        incoming.fence === undefined || existing.fence === incoming.fence;
      const evidence = fenceMatches
        ? mergeTerminationEvidence(existing, incoming)
        : existing ?? incoming;
      let retryDelayMs = 25;
      while (true) {
        try {
          state.registration = await state.registrationStore
            .saveTerminationEvidence(attemptId, evidence);
          state.terminationEvidence = new Map(
            Object.entries(state.registration.terminationEvidence ?? {}),
          );
          const persistedEvidence = state.registration.terminationEvidence?.[
            attemptId
          ];
          if (!persistedEvidence) {
            throw new Error("WORKER_TERMINATION_EVIDENCE_SAVE_MISSING");
          }
          break;
        } catch (error) {
          if (error instanceof TerminationEvidenceCapacityError) throw error;
          failFatal?.(error instanceof Error ? error.message : reason);
          await new Promise<void>((resolve) =>
            setTimeout(resolve, retryDelayMs)
          );
          retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
        }
      }
      logTerminationEvent("termination_quarantined", {
        attemptId,
        reason,
        status: evidence.status,
      });
    } else {
      state.releasedJournalAttempts.delete(attemptId);
    }
    const releaseMarkerReason = replaySafeRelease
      ? "HEARTBEAT_NOT_RECONCILED"
      : reason;
    if (shouldPersist) {
      state.registration = await state.registrationStore.saveReleaseMarker(
        attemptId,
        releaseMarkerReason,
      );
    }
    if (
      !replaySafeRelease &&
      (quarantine || options.discardJournal || !hasSpool)
    ) {
      await state.spool.discardAttempt(attemptId);
    }
    if (replaySafeRelease) {
      state.registration = await state.registrationStore.clearActiveAssignment(
        attemptId,
      );
      if (
        !state.releasedJournalAttempts.has(attemptId) &&
        state.releasedJournalAttempts.size >= MAX_HELD_RELEASED_JOURNALS
      ) {
        const oldest = state.releasedJournalAttempts.values().next().value as
          | string
          | undefined;
        if (oldest) {
          state.releasedJournalAttempts.delete(oldest);
          await state.spool.discardAttempt(oldest);
          state.registration = await state.registrationStore.completeRelease(
            oldest,
          );
        }
      }
      state.releasedJournalAttempts.add(attemptId);
    } else if (shouldPersist) {
      state.registration = await state.registrationStore.completeRelease(
        attemptId,
      );
    }
  } catch (error) {
    if (error instanceof TerminationEvidenceCapacityError) {
      state.controlState.capacityPaused = true;
      syncAdmissionPause(state.controlState);
      state.registration = await state.registrationStore.setCapacityPaused(
        true,
      );
      logTerminationEvent("termination_evidence_capacity_exhausted", {
        attemptId,
        reason,
        admissionPaused: state.controlState.admissionPaused,
      });
      return;
    }
    const failure = error instanceof Error ? error.message : reason;
    failFatal?.(failure);
    throw error;
  }
  if (serverTerminalObservation && executionUncertain) {
    if (
      !state.serverTerminalObservations.has(attemptId) &&
      state.serverTerminalObservations.size >=
        MAX_SERVER_TERMINAL_OBSERVATIONS
    ) {
      const oldest = state.serverTerminalObservations.values().next().value as
        | string
        | undefined;
      if (oldest) state.serverTerminalObservations.delete(oldest);
    }
    state.serverTerminalObservations.add(attemptId);
  }
  state.publicationAuthorities.delete(attemptId);
  if (
    active &&
    quarantine &&
    active.executionStarted &&
    active.executionSettled !== true
  ) {
    return;
  }
  if (active) {
    state.active.delete(attemptId);
    state.serverTerminalObservations.delete(attemptId);
  }
}
type TerminationCleanupAttempt = "confirmed" | "retryable" | "permanent";

async function confirmTerminationCleanup(
  state: SupervisorState,
  attemptId: string,
  evidence: {
    fence?: string;
    observedExitAt?: string;
    cleanupComplete?: boolean;
    observedBy?: {
      workerSessionId: string;
      workerSessionGeneration: string;
    };
  },
): Promise<TerminationCleanupAttempt> {
  if (
    evidence.fence === undefined ||
    evidence.observedExitAt === undefined ||
    evidence.cleanupComplete !== true ||
    evidence.observedBy === undefined
  ) return "permanent";
  try {
    await state.client.confirmCleanup(attemptId, {
      fence: evidence.fence,
      workerSessionId: state.processSessionId,
      workerSessionGeneration: state.processSessionGeneration,
      observedByWorkerSessionId: evidence.observedBy.workerSessionId,
      observedByWorkerSessionGeneration:
        evidence.observedBy.workerSessionGeneration,
      exitedAt: evidence.observedExitAt,
    }, state.lifecycleController.signal);
    await clearTerminationEvidence(state, attemptId);
    logTerminationEvent("termination_cleanup_confirmed", { attemptId });
    return "confirmed";
  } catch (error) {
    if (error instanceof WorkerRequestError) {
      const permanent = !error.retryable;
      logTerminationEvent(
        permanent
          ? "termination_cleanup_permanent_conflict"
          : "termination_cleanup_retry",
        {
          attemptId,
          reason: error.code,
        },
      );
      return permanent ? "permanent" : "retryable";
    }
    throw error;
  }
}

async function retireTerminationEvidence(
  state: SupervisorState,
  attemptId: string,
  reason: string,
): Promise<void> {
  const active = state.active.get(attemptId);
  if (active && active.executionSettled !== true) return;
  await clearTerminationEvidence(state, attemptId);
  logTerminationEvent("termination_evidence_retired", {
    attemptId,
    reason,
  });
}

export async function retryPendingTerminationCleanup(
  state: SupervisorState,
): Promise<void> {
  const keys = [...state.terminationEvidence.keys()];
  if (keys.length === 0) return;
  const cursorIndex = state.terminationCleanupCursor === null
    ? -1
    : keys.indexOf(state.terminationCleanupCursor);
  let attempted = 0;
  let boundLogged = false;
  for (let offset = 0; offset < keys.length; offset++) {
    const attemptId = keys[(cursorIndex + 1 + offset) % keys.length];
    const evidence = state.terminationEvidence.get(attemptId);
    if (!evidence) continue;
    if (
      evidence.cleanupComplete !== true ||
      evidence.observedExitAt === undefined
    ) continue;
    // An unsettled execution confirms its own cleanup under the control plane;
    // a heartbeat retry of the same evidence would post it twice.
    if (state.active.get(attemptId)?.executionSettled === false) continue;
    const nextRetryAt = state.terminationCleanupNextRetryAt.get(attemptId);
    if (nextRetryAt !== undefined && nextRetryAt > performance.now()) continue;
    if (attempted >= MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT) {
      if (!boundLogged) {
        logTerminationEvent("termination_cleanup_retry_bound_reached", {
          limit: MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT,
        });
        boundLogged = true;
      }
      continue;
    }
    attempted++;
    state.terminationCleanupCursor = attemptId;
    const outcome = await confirmTerminationCleanup(state, attemptId, evidence);
    if (outcome === "confirmed") continue;
    if (outcome === "permanent") {
      const failures = (state.terminationCleanupFailures.get(attemptId) ?? 0) +
        1;
      state.terminationCleanupFailures.set(attemptId, failures);
      state.terminationCleanupRetries.delete(attemptId);
      state.terminationCleanupNextRetryAt.delete(attemptId);
      if (failures >= MAX_TERMINATION_CLEANUP_CONFLICTS) {
        await retireTerminationEvidence(state, attemptId, "STATE_CONFLICT");
      }
      continue;
    }
    const retries = (state.terminationCleanupRetries.get(attemptId) ?? 0) + 1;
    state.terminationCleanupRetries.set(attemptId, retries);
    state.terminationCleanupNextRetryAt.set(
      attemptId,
      performance.now() +
        Math.min(
          30_000,
          TERMINATION_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(retries - 1, 6),
        ),
    );
  }
}

export async function executeAssignment(
  state: SupervisorState,
  assignment: JobAssignment,
  signal: AbortSignal,
  callbacks: ExecutionCallbacks,
  release: (
    attemptId: string,
    reason: string,
    options?: { discardJournal?: boolean },
  ) => Promise<void>,
): Promise<void> {
  const active = state.active.get(assignment.attemptId);
  const executor = state.executor;
  if (!active || !executor || state.stopping || state.draining) return;
  if (active.terminalAcked || hasTerminalRecord(state, assignment.attemptId)) {
    await waitForAttemptDrain(state, active);
    return;
  }
  callbacks.startLeaseRenewal(active);
  active.executionSettled = false;
  active.cleanCancellationEligible = false;
  try {
    if (!leaseValid(active)) {
      await release(assignment.attemptId, "LEASE_EXPIRED");
      return;
    }
    if (
      !(await ensureEvent(state, active, "job.accepted", {
        acceptedAt: nowIso(),
      }, "1"))
    ) return;
    if (
      !leaseValid(active) ||
      state.active.get(assignment.attemptId) !== active ||
      signal.aborted || state.terminationEvidence.has(assignment.attemptId)
    ) return;
    if (
      !(await ensureEvent(state, active, "job.started", {
        startedAt: nowIso(),
        workspaceId: crypto.randomUUID(),
      }, "2"))
    ) return;
    if (
      !leaseValid(active) ||
      state.active.get(assignment.attemptId) !== active ||
      signal.aborted || active.controller.signal.aborted ||
      state.terminationEvidence.has(assignment.attemptId)
    ) return;
    const capturesNativeOutput =
      active.assignment.action !== "secret.identity.read" &&
      active.assignment.action !== "coordinator.turn" &&
      executor.capturesNativeOutput === true;
    // Authority without the heartbeat fence: freshHeartbeatReady is a short
    // pause while a heartbeat's commands apply, not lost authority.
    const nativeAuthorityHeld = () => {
      const authority = state.publicationAuthorities.get(assignment.attemptId);
      return state.processSessionAcquired &&
        leaseValid(active) &&
        (canPublishActiveAssignment(state, active) ||
          canPublishDuringDrain(state, active)) &&
        authority !== undefined && validatePublicationAuthority({
          ...assignment,
          workerSessionId: state.processSessionId,
          workerSessionGeneration: state.processSessionGeneration,
        }, authority).allowed;
    };
    const nativePublicationActive = () =>
      state.freshHeartbeatReady && nativeAuthorityHeld();
    // Waits out the fence; ends when authority is lost, the lease lapses (no
    // heartbeat renews it) or the worker stops.
    const awaitNativePublication = async () => {
      while (!state.lifecycleController.signal.aborted) {
        if (nativePublicationActive()) return true;
        if (!nativeAuthorityHeld()) return false;
        await state.sleep(
          Math.min(25, state.config.heartbeatIntervalMs),
          state.lifecycleController.signal,
        );
      }
      return false;
    };
    let outputCapture:
      | Awaited<ReturnType<typeof openNativeOutputCapture>>
      | undefined;
    let outcome: ExecutionOutcome;
    let preparedSkills: PreparedSkillContext | undefined;
    let executorInvoked = false;
    let executorTerminationConfirmed = false;
    try {
      if (active.assignment.action === "secret.identity.read") {
        if (active.assignment.skillRefs.length > 0) {
          throw new Error(
            "PREPARED_SKILL_ROOTS_UNSUPPORTED:secret.identity.read",
          );
        }
        if (
          !state.preparedSecretInvoker ||
          active.assignment.sealedCredentialOperation === null
        ) throw new Error("PREPARED_SECRET_INVOKER_REQUIRED");
        outcome = await state.preparedSecretInvoker.invoke(
          active.assignment,
          {
            workerSessionId: state.processSessionId,
            workerSessionGeneration: state.processSessionGeneration,
          },
          signal,
        );
      } else {
        // Computed before anything spawns: a credential file that cannot be
        // redacted fails the attempt closed through the catch below.
        const credentialSecrets =
          await executor.credentialRedactionSecrets?.(active.assignment) ?? [];
        outputCapture = capturesNativeOutput
          ? await (async () => {
            await state.spool.reserveTerminal(
              assignment.attemptId,
              terminalReservationBytes({
                attemptId: assignment.attemptId,
                leaseToken: assignment.leaseToken,
                fence: String(assignment.fence),
              }),
            );
            return await openNativeOutputCapture({
              assignment,
              client: state.client,
              spool: state.spool,
              workerSessionId: state.processSessionId,
              workerSessionGeneration: state.processSessionGeneration,
              configuredSecrets: state.config.outputRedactionSecrets,
              credentialSecrets,
              leaseActive: nativePublicationActive,
              awaitPublication: awaitNativePublication,
              waitForAck: () =>
                state.sleep(
                  Math.min(250, state.config.heartbeatIntervalMs),
                  state.lifecycleController.signal,
                ),
            });
          })()
          : undefined;
        const materializationAssignment = active.assignment;
        if (materializationAssignment.skillRefs.length > 0) {
          if (!state.skillMaterializer) {
            throw new Error("SKILL_MATERIALIZER_REQUIRED");
          }
          preparedSkills = await state.skillMaterializer.prepare({
            assignment: materializationAssignment,
            workerSessionId: state.processSessionId,
            workerSessionGeneration: state.processSessionGeneration,
          }, signal);
        }
        if (
          materializationAssignment.skillRefs.length > 0 &&
          !canInvokeWithPreparedSkills(
            state,
            active,
            materializationAssignment,
            preparedSkills,
            signal,
          )
        ) return;
        executorInvoked = true;
        const execution = executor.execute(
          active.assignment,
          signal,
          outputCapture,
          preparedSkills,
        );
        outcome = await execution;
        executorTerminationConfirmed = outcome.status !== "canceled" ||
          hasProvenCancellationTermination(outcome);
      }
    } catch (error) {
      if (error instanceof PreparedSecretInvocationError) {
        await release(
          assignment.attemptId,
          "TERMINATION_UNKNOWN",
          { discardJournal: true },
        );
        return;
      }
      if (error instanceof NativeExecutorError && error.boundaryFailure) {
        active.boundaryFailure = true;
        callbacks.failFatal(error.message);
        return;
      }
      if (executorInvoked) executorTerminationConfirmed = true;
      outcome = signal.aborted
        ? {
          status: "canceled",
          cancellation: {
            processExited: false,
            exitedAt: null,
            cleanupStatus: "pending",
            terminationStatus: terminationEvidence({}),
          },
        }
        : {
          status: "failed",
          fault: errorFault(
            "WORKER_EXECUTION_FAILED",
            "The worker executor failed.",
          ),
        };
    } finally {
      if (
        preparedSkills &&
        (!executorInvoked || executorTerminationConfirmed)
      ) {
        await preparedSkills.release();
      }
    }
    clearAbandonmentTimer(state, active);
    active.cleanCancellationEligible =
      hasProvenCancellationTermination(outcome) &&
      signal.aborted &&
      !active.publicationRevoked &&
      !state.terminationEvidence.has(assignment.attemptId) &&
      !state.serverTerminalObservations.has(assignment.attemptId);
    if (state.stopping) {
      if (state.fatalFailure || outcome.status !== "canceled") {
        await release(
          assignment.attemptId,
          "TERMINATION_UNKNOWN",
          { discardJournal: true },
        );
      }
      // The shutdown marker is persisted only after this task and all related
      // worker tasks settle; this does not assert executor process termination.
      return;
    }
    const canceledDuringDrain = state.draining && signal.aborted &&
      outcome.status === "canceled";
    if (state.draining && outcome.status !== "canceled") {
      // The effect may have completed, but drain fenced its result. Keep this
      // attempt quarantined rather than allowing clean-quiescence replay.
      await release(
        assignment.attemptId,
        "TERMINATION_UNKNOWN",
        { discardJournal: true },
      );
      return;
    }
    if (
      outcome.status === "canceled" &&
      (!canceledDuringDrain ||
        active.publicationRevoked === true ||
        state.terminationEvidence.has(assignment.attemptId) ||
        state.serverTerminalObservations.has(assignment.attemptId))
    ) {
      let cancellation: Record<string, JsonValue> = {};
      if (
        outcome.cancellation !== null &&
        typeof outcome.cancellation === "object" &&
        !Array.isArray(outcome.cancellation)
      ) {
        cancellation = outcome.cancellation as Record<string, JsonValue>;
      }
      const observedExitAt = typeof cancellation.observedExitAt === "string"
        ? cancellation.observedExitAt
        : typeof cancellation.exitedAt === "string"
        ? cancellation.exitedAt
        : null;
      const evidence = terminationEvidence({
        processExited: typeof cancellation.processExited === "boolean"
          ? cancellation.processExited
          : undefined,
        cleanupComplete: cancellation.cleanupStatus === "complete"
          ? true
          : cancellation.cleanupStatus === "pending"
          ? false
          : undefined,
        observedExitAt,
      });
      const existingTerminationEvidence = state.terminationEvidence.get(
        assignment.attemptId,
      );
      const incomingEvidence = {
        status: evidence === "confirmed" ? "pending" as const : evidence,
        observedAt: nowIso(),
        fence: String(assignment.fence),
        ...(observedExitAt
          ? {
            observedExitAt,
            cleanupComplete: evidence === "confirmed",
            observedBy: {
              workerSessionId: state.processSessionId,
              workerSessionGeneration: state.processSessionGeneration,
            },
          }
          : {}),
      };
      const fenceMatches = existingTerminationEvidence?.fence === undefined ||
        existingTerminationEvidence.fence === String(assignment.fence);
      const evidenceToSave = fenceMatches
        ? mergeTerminationEvidence(
          existingTerminationEvidence,
          incomingEvidence,
        )
        : existingTerminationEvidence ?? incomingEvidence;
      let persistedEvidence = evidenceToSave;
      try {
        state.registration = await state.registrationStore
          .saveTerminationEvidence(assignment.attemptId, evidenceToSave);
        state.terminationEvidence = new Map(
          Object.entries(state.registration.terminationEvidence ?? {}),
        );
        const savedEvidence = state.registration.terminationEvidence?.[
          assignment.attemptId
        ];
        if (!savedEvidence) {
          throw new Error("WORKER_TERMINATION_EVIDENCE_SAVE_MISSING");
        }
        persistedEvidence = savedEvidence;
      } catch (error) {
        if (error instanceof TerminationEvidenceCapacityError) {
          state.controlState.capacityPaused = true;
          syncAdmissionPause(state.controlState);
          state.registration = await state.registrationStore
            .setCapacityPaused(true);
          logTerminationEvent("termination_evidence_capacity_exhausted", {
            attemptId: assignment.attemptId,
            admissionPaused: state.controlState.admissionPaused,
          });
          return;
        }
        await release(
          assignment.attemptId,
          "TERMINATION_UNKNOWN",
          { discardJournal: true },
        );
        if (
          !state.registration?.terminationEvidence?.[assignment.attemptId]
        ) {
          throw new Error("WORKER_TERMINATION_EVIDENCE_SAVE_MISSING");
        }
        return;
      }
      if (evidence !== "confirmed") {
        await release(
          assignment.attemptId,
          `TERMINATION_${evidence.toUpperCase()}`,
          { discardJournal: true },
        );
        return;
      }
      // Cleanup acknowledgement and durable release must share heartbeat's
      // ownership boundary: reconciliation must not recreate cleared evidence.
      await withControlPlane(
        state.controlPlane,
        state.lifecycleController.signal,
        async () => {
          if (
            await confirmTerminationCleanup(
              state,
              assignment.attemptId,
              persistedEvidence,
            ) !== "confirmed"
          ) {
            await release(
              assignment.attemptId,
              "TERMINATION_PENDING",
              { discardJournal: true },
            );
            return;
          }
          await release(
            assignment.attemptId,
            "CLEANUP_CONFIRMED",
            { discardJournal: true },
          );
        },
      );
      return;
    }
    if (outcome.status === "completed") {
      try {
        outcome = {
          status: "completed",
          result: parseActionOutput(active.assignment, outcome.result),
        };
      } catch {
        outcome = {
          status: "failed",
          fault: errorFault(
            "WORKER_ACTION_RESULT_INVALID",
            "The executor returned output outside the assigned action schema.",
          ),
        };
      }
    }
    if (
      state.stopping || (!canceledDuringDrain && state.draining) ||
      (!canceledDuringDrain &&
        (signal.aborted || active.controller.signal.aborted)) ||
      active.publicationRevoked === true ||
      state.terminationEvidence.has(assignment.attemptId) ||
      !leaseValid(active) || state.active.get(assignment.attemptId) !== active
    ) return;
    if (outputCapture) {
      const disposition = await outputCapture.finish({
        leaveOpen: retryableFailureMayRequeue(outcome),
      });
      if (disposition === null || !(await waitForOutputClose(state, active))) {
        return;
      }
    }
    if (!withinBytes(outcomeResult(outcome), WORKER_RESULT_MAX_BYTES)) {
      outcome = {
        status: "failed",
        fault: errorFault(
          "WORKER_RESULT_TOO_LARGE",
          "The worker result exceeded its encoded byte limit.",
        ),
      };
    }
    const journal = state.spool.journalState(assignment.attemptId);
    const existing = state.spool.records().find((record) =>
      record.attemptId === assignment.attemptId &&
      record.localSeq === journal.nextLocalSeq &&
      record.kind === "result"
    );
    if (existing) {
      await syncActiveJournal(state, active);
      await waitForAttemptDrain(state, active);
      return;
    }
    if (capturesNativeOutput) {
      // The result waits out a heartbeat fence like the output close does;
      // only lost authority drops it.
      let enqueued = false;
      while (!enqueued) {
        if (!(await awaitNativePublication())) return;
        try {
          await state.spool.enqueueNextResult({
            attemptId: assignment.attemptId,
            leaseToken: active.assignment.leaseToken,
            fence: active.assignment.fence,
            eventId: crypto.randomUUID(),
            ...outcomeResult(outcome),
          }, nativePublicationActive);
          enqueued = true;
        } catch (error) {
          if (
            !(error instanceof SpoolError &&
              error.code === "SPOOL_PUBLICATION_NOT_AUTHORIZED")
          ) throw error;
          // Retry only a refusal the fence explains.
          if (nativePublicationActive() || !nativeAuthorityHeld()) return;
        }
      }
    } else {
      await state.spool.enqueueResult({
        attemptId: assignment.attemptId,
        leaseToken: active.assignment.leaseToken,
        fence: active.assignment.fence,
        localSeq: journal.nextLocalSeq,
        eventId: crypto.randomUUID(),
        ...outcomeResult(outcome),
      });
    }
    await syncActiveJournal(state, active);
    await waitForAttemptDrain(state, active);
  } catch (error) {
    callbacks.reportError?.(error);
    if (isServerPublicationRejection(error)) {
      await retireFailedPublication(
        state,
        assignment.attemptId,
        error,
        callbacks.failFatal,
        callbacks.reportSupervisorFault,
      );
      return;
    }
    callbacks.failFatal(
      error instanceof Error ? error.message : "ASSIGNMENT_EXECUTION_FAILED",
    );
  } finally {
    clearAbandonmentTimer(state, active);
    active.executionSettled = true;
    const serverTerminalObserved = state.serverTerminalObservations.has(
      assignment.attemptId,
    );
    if (
      state.active.get(assignment.attemptId) === active &&
      (state.terminationEvidence.has(assignment.attemptId) ||
        serverTerminalObserved)
    ) {
      state.active.delete(assignment.attemptId);
      state.publicationAuthorities.delete(assignment.attemptId);
      state.serverTerminalObservations.delete(assignment.attemptId);
    }
    if (state.active.get(assignment.attemptId) !== active) {
      active.renewalController.abort();
    }
  }
}

export async function runFlushLoop(
  state: SupervisorState,
  flushOnce: (signal?: AbortSignal) => Promise<boolean>,
  failFatal: (reason: string) => void,
  reportFault?: ReportSupervisorFault,
): Promise<void> {
  while (!state.stopping) {
    if (!state.freshHeartbeatReady) {
      await state.sleep(
        state.config.claimBackoffBaseMs,
        state.lifecycleController.signal,
      );
      continue;
    }
    try {
      await flushOnce(state.lifecycleController.signal);
    } catch (error) {
      if (state.stopping) return;
      const requestError = error instanceof FlushAttemptError &&
          error.original instanceof WorkerRequestError
        ? error.original
        : error instanceof WorkerRequestError
        ? error
        : undefined;
      if (requestError?.retryable) {
        await state.sleep(
          Math.min(250, state.config.claimBackoffBaseMs),
          state.lifecycleController.signal,
        );
        continue;
      }
      if (requestError && isServerPublicationRejection(requestError)) {
        const attemptId = error instanceof FlushAttemptError
          ? error.attemptId
          : undefined;
        if (attemptId) {
          await retireFailedPublication(
            state,
            attemptId,
            requestError,
            failFatal,
            reportFault,
          );
        } else {
          reportFault?.(requestError);
        }
        continue;
      }
      failFatal(error instanceof Error ? error.message : "SPOOL_FLUSH_FAILED");
      return;
    }
    await state.sleep(25, state.lifecycleController.signal);
  }
}

/**
 * Options for the recovery-only standalone replay seam.
 */
export type StandaloneReplayOptions = {
  /**
   * Recovery-fixture-only escape hatch for an unregistered lease-loss record.
   * Production callers must leave this unset.
   */
  discardUnregisteredLeaseLoss?: boolean;
};

type FlushOptions = {
  standaloneReplay?: boolean;
  discardUnregisteredLeaseLoss?: boolean;
};

export async function flushOnce(
  state: SupervisorState,
  signal?: AbortSignal,
  failFatal?: (reason: string) => void,
  reportFault?: ReportSupervisorFault,
  options: FlushOptions = {},
): Promise<boolean> {
  if (state.flushPromise) return await state.flushPromise;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  state.flushAbortController = controller;
  const promise = flushOnceInternal(
    state,
    controller.signal,
    failFatal,
    reportFault,
    options,
  );
  state.flushPromise = promise;
  try {
    return await promise;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (state.flushPromise === promise) state.flushPromise = null;
    if (state.flushAbortController === controller) {
      state.flushAbortController = null;
    }
  }
}

/**
 * True when the server will requeue the job for this outcome: a failed
 * result with a retryable fault and no usage receipt. The output stream must
 * then stay open for the next attempt (see `NativeOutputCapture.finish`).
 */
function retryableFailureMayRequeue(outcome: ExecutionOutcome): boolean {
  if (outcome.status !== "failed" || outcome.usage !== undefined) return false;
  const fault = outcome.fault;
  return typeof fault === "object" && fault !== null && !Array.isArray(fault) &&
    fault.retryable === true;
}

async function flushOutputClose(
  state: SupervisorState,
  signal: AbortSignal,
  failFatal?: (reason: string) => void,
  reportFault?: ReportSupervisorFault,
): Promise<boolean> {
  for (const close of state.spool.pendingOutputCloses()) {
    if (state.spool.outputDepth(close.attemptId).records > 0) continue;
    const active = state.active.get(close.attemptId);
    const authority = state.publicationAuthorities.get(close.attemptId);
    if (
      !state.processSessionAcquired || !state.freshHeartbeatReady ||
      !active || !leaseValid(active) || !authority ||
      (!canPublishActiveAssignment(state, active) &&
        !canPublishDuringDrain(state, active)) ||
      close.workerSessionId !== state.processSessionId ||
      close.workerSessionGeneration !== state.processSessionGeneration ||
      !validatePublicationAuthority(close, authority).allowed
    ) continue;
    try {
      await state.client.closeOutput(
        close.attemptId,
        {
          leaseToken: close.leaseToken,
          fence: close.fence,
          workerSessionId: close.workerSessionId,
          workerSessionGeneration: close.workerSessionGeneration,
          sessionId: close.sessionId,
          writerGeneration: close.writerGeneration,
          capture: close.capture,
          reason: close.reason,
        },
        close.idempotencyKey,
        signal,
      );
    } catch (error) {
      if (isLeaseLoss(error)) {
        await releaseAttemptForFlush(
          state,
          close.attemptId,
          error.code,
          { discardJournal: true },
          failFatal,
        );
        return true;
      }
      if (isServerPublicationRejection(error)) {
        reportFault?.(error);
        if (error.status === 422) {
          // The terminal result transaction force-closes any still-open
          // binding. Do not let a failed maintenance close hide a truthful
          // terminal result from the worker spool.
          await state.spool.acknowledgeOutputClose(close.attemptId);
          return true;
        }
        await retireFailedPublication(
          state,
          close.attemptId,
          error,
          failFatal,
          reportFault,
        );
        return true;
      }
      throw flushAttemptError(close.attemptId, error);
    }

    await state.spool.acknowledgeOutputClose(close.attemptId);
    return true;
  }
  return false;
}

async function flushOnceInternal(
  state: SupervisorState,
  signal: AbortSignal,
  failFatal?: (reason: string) => void,
  reportFault?: ReportSupervisorFault,
  options: FlushOptions = {},
): Promise<boolean> {
  if (await flushOutputClose(state, signal, failFatal, reportFault)) {
    return true;
  }
  const records = state.spool.records();
  const record = records[0];
  if (!record) return false;
  const standaloneReplay = options.standaloneReplay === true;
  if (
    !standaloneReplay &&
    (!state.processSessionAcquired || !state.freshHeartbeatReady)
  ) return false;
  const authority = state.publicationAuthorities.get(record.attemptId);
  const releasedJournalMarker =
    state.registration?.releaseMarkers?.[record.attemptId]?.reason ===
      "HEARTBEAT_NOT_RECONCILED" &&
    state.spool.hasReplaySafeRecord(record.attemptId);
  const releasedJournalReplay = !authority &&
    releasedJournalMarker;
  // A restart may retry only this immutable publication; it never restores
  // execution or claims work without an authoritative heartbeat admission.
  // A fatal drain must preserve unacknowledged records for the next startup.
  if (!standaloneReplay && !authority && !releasedJournalReplay) {
    if (state.draining) return false;
    await releaseAttemptForFlush(
      state,
      record.attemptId,
      "PUBLICATION_NOT_AUTHORIZED",
      { discardJournal: true },
      failFatal,
    );
    return true;
  }
  if (authority) {
    const active = state.active.get(record.attemptId);
    const drainPublication = canPublishDuringDrain(state, active);
    if (
      !active ||
      (!canPublishActiveAssignment(state, active) && !drainPublication)
    ) {
      if (state.draining && !drainPublication) return false;
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        "PUBLICATION_NOT_AUTHORIZED",
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
  }
  if (authority) {
    const authorized = state.spool.authorizedRecords(
      authority,
      {
        workerSessionId: state.processSessionId,
        workerSessionGeneration: state.processSessionGeneration,
      },
    );
    if (
      authorized.rejections.length > 0 ||
      !authorized.records.some((candidate) =>
        candidate.eventId === record.eventId &&
        candidate.localSeq === record.localSeq
      )
    ) {
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        `PUBLICATION_${authorized.rejections[0] ?? "AUTHORITY_REJECTED"}`,
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
  }
  if (authority) {
    const active = state.active.get(record.attemptId);
    const drainPublication = canPublishDuringDrain(state, active);
    if (
      !active ||
      (!canPublishActiveAssignment(state, active) && !drainPublication)
    ) {
      if (state.draining && !drainPublication) return false;
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        "PUBLICATION_NOT_AUTHORIZED",
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
  }
  let ack;
  try {
    ack = record.kind === "event"
      ? await state.client.postEvents(record.attemptId, {
        leaseToken: record.leaseToken,
        fence: record.fence,
        events: [{
          eventId: record.eventId,
          localSeq: record.localSeq,
          eventType: record.type,
          payload: record.payload,
        }],
        workerSessionId: state.processSessionId,
        workerSessionGeneration: state.processSessionGeneration,
      }, signal)
      : await state.client.postResult(
        record.attemptId,
        resultRequest(
          record,
          state.processSessionId,
          state.processSessionGeneration,
        ),
        record.eventId,
        signal,
      );
  } catch (error) {
    if (isAlreadyTerminal(error)) {
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        "ALREADY_TERMINAL",
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
    if (
      error instanceof WorkerRequestError &&
      error.code === "CANCEL_REQUESTED"
    ) {
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        "CANCEL_REQUESTED",
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
    if (isLeaseLoss(error)) {
      if (standaloneReplay && !state.active.has(record.attemptId)) {
        state.registration ??= await state.registrationStore.load();
        if (!state.registration) {
          if (options.discardUnregisteredLeaseLoss) {
            await state.spool.discardAttempt(record.attemptId);
            return true;
          }
          throw new Error("WORKER_REPLAY_REGISTRATION_REQUIRED");
        }
      }
      await releaseAttemptForFlush(
        state,
        record.attemptId,
        releasedJournalReplay ? "RELEASED_JOURNAL_REJECTED" : error.code,
        { discardJournal: true },
        failFatal,
      );
      return true;
    }
    if (isServerPublicationRejection(error)) {
      await retireFailedPublication(
        state,
        record.attemptId,
        error,
        failFatal,
        reportFault,
      );
      return true;
    }
    throw flushAttemptError(record.attemptId, error);
  }
  const active = state.active.get(record.attemptId);
  try {
    if (record.kind === "result") {
      state.registration = await state.registrationStore.updateActiveAssignment(
        record.attemptId,
        { terminalAcked: true },
      );
      if (active) active.terminalAcked = true;
    }
    await state.spool.acknowledge(record.attemptId, ack.value.lastEventSeq);
    if (active) {
      await syncActiveJournal(state, active);
    } else if (state.registration?.activeAssignments?.[record.attemptId]) {
      // Standalone replay has no in-memory active assignment, but it must
      // still advance durable journal progress before empty-journal cleanup.
      state.registration = await state.registrationStore.updateActiveAssignment(
        record.attemptId,
        state.spool.journalState(record.attemptId),
      );
    }
  } catch (error) {
    if (reportFault) reportFault(error);
    else failFatal?.(boundedSupervisorFault(error));
    return true;
  }
  // Release faults after the ACK are fatal: the release marker stays durable
  // and the supervisor must restart to finish the release.
  if (
    record.kind === "result" &&
    !state.spool.attemptIds().includes(record.attemptId)
  ) {
    await releaseAttemptForFlush(
      state,
      record.attemptId,
      "RESULT_ACKED",
      {},
      failFatal,
    );
  } else if (
    !active &&
    state.registration?.activeAssignments?.[record.attemptId] === undefined &&
    !state.spool.attemptIds().includes(record.attemptId)
  ) {
    try {
      if (state.registration?.releaseMarkers?.[record.attemptId]) {
        state.releasedJournalAttempts.delete(record.attemptId);
        await state.spool.discardAttempt(record.attemptId);
        state.registration = await state.registrationStore.completeRelease(
          record.attemptId,
        );
      } else {
        await state.spool.discardAttempt(record.attemptId);
      }
    } catch (error) {
      failFatal?.(boundedSupervisorFault(error));
      throw flushAttemptError(record.attemptId, error);
    }
  }
  return true;
}
