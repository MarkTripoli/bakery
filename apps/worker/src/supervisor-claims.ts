import { WorkerRequestError } from "./client.ts";
import { publicationAuthorityForAssignment } from "./supervisor-recovery.ts";
import type { JobAssignment, PersistedActiveAssignment } from "./types.ts";
import type { SupervisorState } from "./supervisor-state.ts";
import {
  claimableCapabilities,
  claimHeldForReadiness,
} from "./supervisor-readiness.ts";
import {
  type ActiveAssignment,
  canPublishActiveAssignment,
  isAlreadyTerminal,
  isLeaseLoss,
  isTransientControlPlaneFailure,
  leaseDeadline,
  leaseDeadlineFromAuthoritativeServerTime,
  leaseValid,
  logControlPlaneRetry,
  reconcileLeaseResponse,
  requiredAssignmentTiming,
} from "./supervisor-support.ts";

export type ClaimCallbacks = {
  withControlPlane: <T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  releaseAttempt: (
    attemptId: string,
    reason: string,
    options?: { discardJournal?: boolean },
  ) => Promise<void>;
  executeAssignment: (
    assignment: JobAssignment,
    signal: AbortSignal,
  ) => Promise<void>;
  failFatal: (reason: string) => void;
};

function occupiedAttemptIds(state: SupervisorState): Set<string> {
  const ids = new Set(state.spool.attemptIds());
  for (const attemptId of state.active.keys()) ids.add(attemptId);
  for (
    const attemptId of Object.keys(
      state.registration?.activeAssignments ?? {},
    )
  ) ids.add(attemptId);
  return ids;
}

function supportedActions(state: SupervisorState): string[] | undefined {
  const actions = new Set(state.executor?.supportedActions ?? []);
  if (state.preparedSecretInvoker) actions.add("secret.identity.read");
  return actions.size > 0 ? [...actions] : undefined;
}

export async function runClaimLoop(
  state: SupervisorState,
  callbacks: ClaimCallbacks,
): Promise<void> {
  let emptyBackoff = state.config.claimBackoffBaseMs;
  while (!state.stopping) {
    const registration = state.registration;
    if (
      !state.executor || !state.freshHeartbeatReady ||
      !registration?.workerHostId || !state.healthy || state.draining ||
      state.controlState.admissionPaused ||
      !state.processSessionAcquired || claimHeldForReadiness(state)
    ) {
      await state.sleep(
        state.config.claimBackoffBaseMs,
        state.lifecycleController.signal,
      );
      continue;
    }
    const occupied = occupiedAttemptIds(state);
    if (occupied.size >= state.config.slots) {
      await state.sleep(
        state.config.claimBackoffBaseMs,
        state.lifecycleController.signal,
      );
      continue;
    }
    const claimActions = supportedActions(state);
    // Never request a capability whose local readiness check is failing. A
    // pending claim being replayed keeps its original body (idempotency).
    const claimCapabilities = claimableCapabilities(state);
    if (!registration.pendingClaim && claimCapabilities.length === 0) {
      await state.sleep(
        state.config.claimBackoffBaseMs,
        state.lifecycleController.signal,
      );
      continue;
    }
    const pendingClaim = registration.pendingClaim ?? {
      claimKey: registration.pendingClaimKey || crypto.randomUUID(),
      workerHostId: registration.workerHostId,
      capabilities: claimCapabilities,
      ...(claimActions ? { supportedActions: claimActions } : {}),
    };
    const claimKey = pendingClaim.claimKey;
    const claimController = new AbortController();
    state.inFlightClaimController = claimController;
    try {
      if (
        !registration.pendingClaim || registration.pendingClaimKey !== claimKey
      ) {
        state.registration = await state.registrationStore.savePendingClaim(
          pendingClaim,
        );
      }
      const active = await callbacks.withControlPlane(async (signal) => {
        if (
          state.stopping || signal.aborted ||
          state.controlState.admissionPaused
        ) return null;
        const claim = state.registration?.pendingClaim ?? pendingClaim;
        const requestStartedAt = performance.now();
        const response = await state.client.claim({
          claimKey: claim.claimKey,
          workerHostId: claim.workerHostId,
          capabilities: claim.capabilities,
          ...(claim.supportedActions
            ? { supportedActions: [...claim.supportedActions] }
            : {}),
          workerSessionId: state.processSessionId,
          workerSessionGeneration: state.processSessionGeneration,
        }, signal);
        const requestFinishedAt = performance.now();
        const assignment = response.value;
        if (assignment === null) {
          state.registration = await state.registrationStore
            .savePendingClaimKey(undefined);
          return null;
        }
        const timing = requiredAssignmentTiming(assignment);
        const active: ActiveAssignment = {
          assignment,
          controller: new AbortController(),
          renewalController: new AbortController(),
          leaseSeconds: Math.max(1, timing.leaseDurationSeconds),
          leaseDeadline: response.replayed
            ? leaseDeadlineFromAuthoritativeServerTime(
              assignment.leaseExpiresAt,
              state.latestAuthoritativeServerTimeMs,
              state.latestAuthoritativeServerTimeObservedAtMs,
              requestStartedAt,
            )
            : leaseDeadline(
              timing.serverTime,
              assignment.leaseExpiresAt,
              requestStartedAt,
              requestFinishedAt,
            ),
          renewalKey: state.registration?.pendingRenewalKeys?.[
            assignment.attemptId
          ] ?? crypto.randomUUID(),
          renewalLoopStarted: false,
          executionStarted: false,
          terminalAcked: false,
          restored: false,
        };
        if (assignment.workerHostId !== claim.workerHostId) {
          callbacks.failFatal("ASSIGNMENT_HOST_MISMATCH");
          return null;
        }
        const journal = state.spool.journalState(assignment.attemptId);
        const entry: PersistedActiveAssignment = {
          assignment: structuredClone(assignment),
          nextLocalSeq: journal.nextLocalSeq,
          ackedLocalSeq: journal.ackedLocalSeq,
          renewalKey: active.renewalKey,
        };
        state.registration = await state.registrationStore
          .commitClaimAssignment(
            entry,
          );
        state.active.set(assignment.attemptId, active);
        const authority = publicationAuthorityForAssignment(
          assignment,
          state.processSessionId,
          state.processSessionGeneration,
          active.leaseDeadline,
        );
        if (!authority) {
          callbacks.failFatal("ASSIGNMENT_AUTHORITY_INVALID");
          return null;
        }
        state.publicationAuthorities.set(assignment.attemptId, authority);
        if (
          signal.aborted || state.stopping ||
          state.controlState.admissionPaused ||
          state.terminationEvidence.has(assignment.attemptId)
        ) {
          await callbacks.releaseAttempt(
            assignment.attemptId,
            "ADMISSION_BLOCKED",
            { discardJournal: true },
          );
          return null;
        }
        return active;
      }, claimController.signal);
      if (active === null) {
        if (
          state.stopping || state.draining || claimController.signal.aborted
        ) {
          return;
        }
        await state.sleep(emptyBackoff, state.lifecycleController.signal);
        emptyBackoff = Math.min(
          state.config.claimBackoffMaxMs,
          emptyBackoff * 2,
        );
        continue;
      }
      emptyBackoff = state.config.claimBackoffBaseMs;
      if (state.stopping || state.draining) continue;
      if (!leaseValid(active)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "LEASE_EXPIRED",
        );
        continue;
      }
      active.executionStarted = true;
      void callbacks.executeAssignment(
        active.assignment,
        active.controller.signal,
      ).catch((error) => {
        callbacks.failFatal(
          error instanceof Error
            ? error.message
            : "ASSIGNMENT_EXECUTION_FAILED",
        );
      });
    } catch (error) {
      if (state.stopping || state.draining || claimController.signal.aborted) {
        return;
      }
      state.lastFailure = error instanceof Error
        ? error.message
        : "CLAIM_FAILED";
      if (
        error instanceof WorkerRequestError &&
        !isTransientControlPlaneFailure(error)
      ) {
        callbacks.failFatal(state.lastFailure);
        return;
      }
      if (error instanceof WorkerRequestError) {
        logControlPlaneRetry(
          "claim",
          error,
          state.config.claimBackoffBaseMs,
        );
      }
      await state.sleep(
        state.config.claimBackoffBaseMs,
        state.lifecycleController.signal,
      );
    } finally {
      if (state.inFlightClaimController === claimController) {
        state.inFlightClaimController = null;
      }
    }
  }
}

export async function runLeaseRenewalLoop(
  state: SupervisorState,
  active: ActiveAssignment,
  callbacks: Pick<ClaimCallbacks, "releaseAttempt" | "failFatal">,
): Promise<void> {
  let hasRenewed = false;
  while (
    !state.stopping &&
    state.active.get(active.assignment.attemptId) === active &&
    !active.renewalController.signal.aborted
  ) {
    const remaining = active.leaseDeadline - performance.now();
    if (remaining <= 0) {
      await callbacks.releaseAttempt(
        active.assignment.attemptId,
        "LEASE_EXPIRED",
      );
      return;
    }
    const leaseCadence = Math.max(100, Math.floor(remaining / 3));
    const renewalTarget = hasRenewed ? leaseCadence : Math.min(
      leaseCadence,
      Math.max(100, state.config.heartbeatIntervalMs),
    );
    const renewalDelay = Math.min(
      renewalTarget,
      Math.max(0, Math.floor(remaining - 100)),
    );
    await state.sleep(
      renewalDelay,
      active.renewalController.signal,
    );
    if (
      state.stopping ||
      active.renewalController.signal.aborted ||
      state.active.get(active.assignment.attemptId) !== active
    ) return;
    if (!leaseValid(active)) {
      await callbacks.releaseAttempt(
        active.assignment.attemptId,
        "LEASE_EXPIRED",
      );
      return;
    }
    try {
      if (!active.renewalKey) {
        const renewalKey = crypto.randomUUID();
        state.registration = await state.registrationStore
          .savePendingRenewalKey(
            active.assignment.attemptId,
            renewalKey,
          );
        active.renewalKey = renewalKey;
      }
      const requestStartedAt = performance.now();
      const response = await state.client.renewLease(
        active.assignment.attemptId,
        {
          leaseToken: active.assignment.leaseToken,
          fence: active.assignment.fence,
          leaseSeconds: active.leaseSeconds,
          workerSessionId: state.processSessionId,
          workerSessionGeneration: state.processSessionGeneration,
        },
        active.renewalController.signal,
        active.renewalKey,
      );
      if (!canPublishActiveAssignment(state, active)) return;
      const requestFinishedAt = performance.now();
      const reconciliation = reconcileLeaseResponse({
        active,
        response,
        workerSessionId: state.processSessionId,
        workerSessionGeneration: state.processSessionGeneration,
        authoritativeServerTimeMs: state.latestAuthoritativeServerTimeMs,
        authoritativeObservedAtMs:
          state.latestAuthoritativeServerTimeObservedAtMs,
        requestStartedAt,
        requestFinishedAt,
      });
      if (reconciliation.status === "release") {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          reconciliation.reason,
        );
        return;
      }
      state.registration = await state.registrationStore.updateActiveAssignment(
        active.assignment.attemptId,
        { assignment: active.assignment, renewalKey: undefined },
      );
      if (!canPublishActiveAssignment(state, active)) return;
      const authority = publicationAuthorityForAssignment(
        active.assignment,
        state.processSessionId,
        state.processSessionGeneration,
        active.leaseDeadline,
      );
      if (!authority) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "RENEWED_ASSIGNMENT_AUTHORITY_INVALID",
        );
        return;
      }
      state.publicationAuthorities.set(
        active.assignment.attemptId,
        authority,
      );
      active.renewalKey = undefined;
      hasRenewed = true;
    } catch (error) {
      if (active.renewalController.signal.aborted || state.stopping) return;
      if (isAlreadyTerminal(error)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "ALREADY_TERMINAL",
        );
        return;
      }
      if (isLeaseLoss(error)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          error.code,
        );
        return;
      }
      if (!isTransientControlPlaneFailure(error)) {
        callbacks.failFatal(
          error instanceof Error ? error.message : "LEASE_RENEWAL_FAILED",
        );
        return;
      }
      if (!leaseValid(active)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "LEASE_EXPIRED",
        );
        return;
      }
      const retryRemaining = active.leaseDeadline - performance.now();
      if (retryRemaining <= 100) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "LEASE_EXPIRED",
        );
        return;
      }
      const retryCadence = Math.max(100, Math.floor(retryRemaining / 3));
      const retryDelay = Math.max(
        1,
        Math.min(retryCadence, Math.floor(retryRemaining - 100)),
      );
      logControlPlaneRetry("lease_renewal", error, retryDelay);
      await state.sleep(retryDelay, active.renewalController.signal);
    }
  }
}
