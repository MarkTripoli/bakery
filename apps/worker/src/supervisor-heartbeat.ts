import { refreshReadiness } from "./supervisor-readiness.ts";
import {
  applyControlAction,
  isWorkerControlAction,
  mergeTerminationEvidence,
  syncAdmissionPause,
  TerminationEvidenceCapacityError,
} from "./control-state.ts";
import {
  publicationAuthorityForAssignment,
  reconcileServerTruth,
} from "./supervisor-recovery.ts";
import type {
  WorkerCommand,
  WorkerCommandOutcomeStatus,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResult,
  WorkerHeartbeatResultWithReconciliation,
} from "./types.ts";
import {
  type ActiveAssignment,
  canPublishActiveAssignment,
  isAlreadyTerminal,
  isLeaseLoss,
  isTransientControlPlaneFailure,
  leaseDeadline,
  leaseDeadlineFromAuthoritativeServerTime,
  logControlPlaneRetry,
  MAX_ACTIVE_ATTEMPTS,
  MAX_COMMAND_ACKS,
  nowIso,
  type PendingHeartbeat,
  reconcileLeaseResponse,
  requireWorkerSessionTiming,
} from "./supervisor-support.ts";
import type { SupervisorState } from "./supervisor-state.ts";

export type HeartbeatCallbacks = {
  withControlPlane: <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  releaseAttempt: (
    attemptId: string,
    reason: string,
    options?: { discardJournal?: boolean },
  ) => Promise<void>;
  restoreRestoredAssignments: () => Promise<void>;
  startRestoredLeaseRenewals: () => void;
  resumeRestoredAssignments: () => Promise<void>;
  retryPendingCleanupEvidence: () => Promise<void>;
  markSessionReady: () => void;
  failFatal: (reason: string) => void;
};

function terminationLog(
  event: string,
  details: Record<string, string | number | boolean | undefined> = {},
): void {
  console.warn(JSON.stringify({
    component: "worker-supervisor",
    event,
    ...details,
  }));
}

function clearScheduledAbandonmentTimer(
  state: SupervisorState,
  active: ActiveAssignment,
): void {
  const timer = active.abandonmentTimer;
  if (timer === undefined) return;
  clearTimeout(timer);
  state.abandonmentTimers.delete(timer);
  active.abandonmentTimer = undefined;
}

function scheduleBoundedAbandonment(
  state: SupervisorState,
  active: ActiveAssignment,
  callbacks: HeartbeatCallbacks,
): void {
  clearScheduledAbandonmentTimer(state, active);
  if (state.stopping) return;
  const timer = setTimeout(() => {
    state.abandonmentTimers.delete(timer);
    if (active.abandonmentTimer === timer) {
      active.abandonmentTimer = undefined;
    }
    if (
      state.stopping ||
      state.active.get(active.assignment.attemptId) !== active
    ) return;
    const task = (async () => {
      try {
        const incoming = {
          status: "unknown" as const,
          observedAt: nowIso(),
          fence: String(active.assignment.fence),
        };
        const existing = state.terminationEvidence.get(
          active.assignment.attemptId,
        );
        const evidence = mergeTerminationEvidence(existing, incoming);
        state.registration = await state.registrationStore
          .saveTerminationEvidence(active.assignment.attemptId, evidence);
        state.terminationEvidence = new Map(
          Object.entries(state.registration.terminationEvidence ?? {}),
        );
        const persistedEvidence = state.registration.terminationEvidence?.[
          active.assignment.attemptId
        ];
        if (!persistedEvidence) {
          throw new Error("WORKER_TERMINATION_EVIDENCE_SAVE_MISSING");
        }
        terminationLog("termination_abandoned", {
          attemptId: active.assignment.attemptId,
          graceMs: state.config.terminationGraceMs,
        });
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "TERMINATION_UNKNOWN",
          { discardJournal: true },
        );
      } catch (error) {
        if (error instanceof TerminationEvidenceCapacityError) {
          state.controlState.capacityPaused = true;
          syncAdmissionPause(state.controlState);
          try {
            state.registration = await state.registrationStore
              .setCapacityPaused(true);
          } catch (error) {
            callbacks.failFatal(
              error instanceof Error
                ? error.message
                : "TERMINATION_EVIDENCE_CAPACITY_PAUSE_FAILED",
            );
          }
          terminationLog("termination_evidence_capacity_exhausted", {
            attemptId: active.assignment.attemptId,
            admissionPaused: state.controlState.admissionPaused,
          });
          return;
        }
        callbacks.failFatal(
          error instanceof Error
            ? error.message
            : "TERMINATION_ABANDONMENT_FAILED",
        );
      }
    })();
    state.abandonmentTasks.add(task);
    void task.then(
      () => state.abandonmentTasks.delete(task),
      () => state.abandonmentTasks.delete(task),
    );
  }, state.config.terminationGraceMs) as unknown as number;
  active.abandonmentTimer = timer;
  state.abandonmentTimers.add(timer);
}

export function activeAttemptIds(state: SupervisorState): string[] {
  const ids = new Set<string>();
  for (const attemptId of state.active.keys()) ids.add(attemptId);
  for (
    const attemptId of Object.keys(state.registration?.activeAssignments ?? {})
  ) {
    if (ids.size >= MAX_ACTIVE_ATTEMPTS) break;
    ids.add(attemptId);
  }
  for (const attemptId of state.spool.attemptIds()) {
    if (ids.size >= MAX_ACTIVE_ATTEMPTS) break;
    ids.add(attemptId);
  }
  return [...ids].slice(0, MAX_ACTIVE_ATTEMPTS);
}

export function commandOutcomeInputs(state: SupervisorState): {
  ackCommandIds: string[];
  rejectedCommandIds: string[];
} {
  const ackCommandIds: string[] = [];
  const rejectedCommandIds: string[] = [];
  for (const [commandId, status] of state.commandOutcomes.entries()) {
    if (status === "acknowledged") {
      if (ackCommandIds.length < MAX_COMMAND_ACKS) {
        ackCommandIds.push(commandId);
      }
    } else if (rejectedCommandIds.length < MAX_COMMAND_ACKS) {
      rejectedCommandIds.push(commandId);
    }
  }
  return { ackCommandIds, rejectedCommandIds };
}

function createHeartbeatRequest(state: SupervisorState): PendingHeartbeat {
  const registration = state.registration;
  if (!registration?.workerHostId) throw new Error("WORKER_NOT_REGISTERED");
  const body: WorkerHeartbeatRequest = {
    workerHostId: registration.workerHostId,
    observedAt: nowIso(),
    load: Math.min(1, state.active.size / state.config.slots),
    activeAttemptIds: activeAttemptIds(state),
    ...(registration.pendingClaimKey
      ? { pendingClaimKey: registration.pendingClaimKey }
      : {}),
    workerSessionId: state.processSessionId,
    workerSessionGeneration: state.processSessionGeneration,
    ...(state.config.adapterCapabilities
      ? { adapterCapabilities: [...state.config.adapterCapabilities] }
      : {}),
    ...commandOutcomeInputs(state),
  };
  return { idempotencyKey: crypto.randomUUID(), body };
}

async function applyHeartbeatSession(
  state: SupervisorState,
  result: WorkerHeartbeatResultWithReconciliation,
  requestActiveAttemptIds: readonly string[],
  requestStartedAt: number,
  requestFinishedAt: number,
  replayed: boolean,
  callbacks: HeartbeatCallbacks,
): Promise<void> {
  const timing = requireWorkerSessionTiming(result);
  if (result.status === "accepted" && !replayed) {
    const serverTimeMs = Date.parse(timing.serverTime);
    if (
      Number.isFinite(serverTimeMs) &&
      (state.latestAuthoritativeServerTimeMs === null ||
        serverTimeMs > state.latestAuthoritativeServerTimeMs)
    ) {
      state.latestAuthoritativeServerTimeMs = serverTimeMs;
      state.latestAuthoritativeServerTimeObservedAtMs = requestStartedAt;
    }
  }
  const reconciledAttemptIds = result.status === "accepted"
    ? new Set<string>(
      (Array.isArray(result.reconciledAttemptIds)
        ? result.reconciledAttemptIds
        : []).filter((attemptId): attemptId is string =>
          typeof attemptId === "string"
        ),
    )
    : null;

  if (!replayed) state.processSessionId = timing.workerSessionId;
  state.processSessionGeneration = timing.workerSessionGeneration;
  state.processSessionAcquired = result.status === "accepted";
  state.registration = await state.registrationStore
    .saveSessionAndClearPendingHeartbeat(
      timing.workerSessionId,
      timing.workerSessionGeneration,
    );
  if (reconciledAttemptIds !== null) {
    const reconciliation = reconcileServerTruth(
      state.active.keys(),
      state.spool.attemptIds(),
      reconciledAttemptIds,
    );
    const requestedAttemptIds = new Set(requestActiveAttemptIds);
    const registeredAttemptIds = Object.keys(
      state.registration?.activeAssignments ?? {},
    );
    for (const attemptId of registeredAttemptIds) {
      if (
        requestedAttemptIds.has(attemptId) &&
        !reconciledAttemptIds.has(attemptId)
      ) {
        await callbacks.releaseAttempt(
          attemptId,
          "HEARTBEAT_NOT_RECONCILED",
          { discardJournal: true },
        );
      }
    }
    for (const active of [...state.active.values()]) {
      if (
        active.restored &&
        !reconciledAttemptIds.has(active.assignment.attemptId)
      ) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "HEARTBEAT_NOT_RECONCILED",
          { discardJournal: true },
        );
      }
    }
    for (const attemptId of reconciliation.discardedAttemptIds) {
      if (
        !state.active.has(attemptId) &&
        !(
          state.registration?.releaseMarkers?.[attemptId]?.reason ===
            "HEARTBEAT_NOT_RECONCILED" &&
          state.spool.hasReplaySafeRecord(attemptId)
        )
      ) {
        await state.spool.discardAttempt(attemptId);
      }
    }
    state.registration = await state.registrationStore.rebindActiveAssignments(
      timing.workerSessionId,
      timing.workerSessionGeneration,
      reconciledAttemptIds,
    );
  }
  const executionAuthorities = result.status === "accepted"
    ? new Map(
      [...state.publicationAuthorities].filter(([attemptId]) => {
        const active = state.active.get(attemptId);
        return active?.executionStarted &&
          !active.restored &&
          !active.publicationRevoked &&
          !state.terminationEvidence.has(attemptId) &&
          !state.serverTerminalObservations.has(attemptId) &&
          (reconciledAttemptIds === null ||
            reconciledAttemptIds.has(attemptId));
      }),
    )
    : new Map();
  state.publicationAuthorities.clear();
  for (const active of state.active.values()) {
    active.assignment = {
      ...active.assignment,
      workerSessionId: timing.workerSessionId,
      workerSessionGeneration: timing.workerSessionGeneration,
    };
    if (
      active.restored && !active.renewalKey &&
      reconciledAttemptIds?.has(active.assignment.attemptId)
    ) {
      active.leaseDeadline = replayed
        ? leaseDeadlineFromAuthoritativeServerTime(
          active.assignment.leaseExpiresAt,
          state.latestAuthoritativeServerTimeMs,
          state.latestAuthoritativeServerTimeObservedAtMs,
          requestStartedAt,
        )
        : leaseDeadline(
          timing.serverTime,
          active.assignment.leaseExpiresAt,
          requestStartedAt,
          requestFinishedAt,
        );
    }
  }
  for (const [attemptId, authority] of executionAuthorities) {
    const active = state.active.get(attemptId);
    if (
      !active?.executionStarted ||
      active.restored ||
      active.publicationRevoked ||
      state.terminationEvidence.has(attemptId) ||
      state.serverTerminalObservations.has(attemptId)
    ) continue;
    state.publicationAuthorities.set(attemptId, {
      ...authority,
      workerSessionId: timing.workerSessionId,
      workerSessionGeneration: timing.workerSessionGeneration,
    });
  }
  if (reconciledAttemptIds !== null) {
    for (const attemptId of reconciledAttemptIds) {
      const entry = state.registration?.activeAssignments?.[attemptId];
      if (!entry) continue;
      const active = state.active.get(attemptId);
      if (
        !active ||
        active.executionStarted ||
        !canPublishActiveAssignment(state, active)
      ) continue;
      const authority = publicationAuthorityForAssignment(
        entry.assignment,
        timing.workerSessionId,
        timing.workerSessionGeneration,
        active.leaseDeadline ??
          leaseDeadline(
            timing.serverTime,
            entry.assignment.leaseExpiresAt,
            requestStartedAt,
            requestFinishedAt,
          ),
      );
      if (authority) state.publicationAuthorities.set(attemptId, authority);
    }
  }
}

async function replayPendingRenewals(
  state: SupervisorState,
  callbacks: HeartbeatCallbacks,
): Promise<boolean> {
  for (const active of state.active.values()) {
    if (!active.restored || !active.renewalKey) continue;
    try {
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
      if (!canPublishActiveAssignment(state, active)) return false;
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
        continue;
      }
      state.registration = await state.registrationStore.updateActiveAssignment(
        active.assignment.attemptId,
        { assignment: active.assignment, renewalKey: undefined },
      );
      if (!canPublishActiveAssignment(state, active)) return false;
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
        continue;
      }
      state.publicationAuthorities.set(
        active.assignment.attemptId,
        authority,
      );
      active.renewalKey = undefined;
    } catch (error) {
      if (active.renewalController.signal.aborted || state.stopping) {
        return false;
      }
      if (isAlreadyTerminal(error)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          "ALREADY_TERMINAL",
        );
        continue;
      }
      if (isLeaseLoss(error)) {
        await callbacks.releaseAttempt(
          active.assignment.attemptId,
          error.code,
        );
        continue;
      }
      if (isTransientControlPlaneFailure(error)) return false;
      throw error;
    }
  }
  return true;
}

async function applyCommandAcks(
  state: SupervisorState,
  acknowledgements: WorkerHeartbeatResult["commandAcks"],
): Promise<void> {
  if (!state.registration) return;
  for (const acknowledgement of acknowledgements) {
    if (!state.commandOutcomes.has(acknowledgement.commandId)) continue;
    state.commandOutcomes.delete(acknowledgement.commandId);
    state.controlState.acknowledgements.delete(acknowledgement.commandId);
    state.registration = await state.registrationStore.clearCommandOutcome(
      acknowledgement.commandId,
    );
  }
}

type ParsedControlCommand = {
  action: string;
  workerScoped: boolean;
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  fence: string;
  messageId?: string;
  body?: string;
};

function commandControlAction(
  command: WorkerCommand,
): ParsedControlCommand | null {
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const keys = Object.keys(payload);
  const allowed: Record<string, true> = {
    controlAction: true,
    controlScope: true,
    reason: true,
    workerHostId: true,
    workerSessionId: true,
    workerSessionGeneration: true,
    fence: true,
    messageId: true,
    body: true,
  };
  if (
    keys.some((key) => allowed[key] !== true) ||
    typeof payload.controlAction !== "string"
  ) return null;
  const controlAction = payload.controlAction;
  const validAction = command.commandType === "cancel"
    ? controlAction === "cancel"
    : command.commandType === "steer"
    ? controlAction === "pause" || controlAction === "interrupt" ||
      controlAction === "steer_message"
    : command.commandType === "follow_up" &&
      (controlAction === "resume" || controlAction === "follow_up_message");
  if (!validAction) return null;
  const messageAction = controlAction === "steer_message" ||
    controlAction === "follow_up_message";
  if (
    messageAction !== (payload.messageId !== undefined) ||
    messageAction !== (payload.body !== undefined) ||
    (messageAction &&
      (typeof payload.messageId !== "string" ||
        typeof payload.body !== "string"))
  ) return null;
  const expectedScope = controlAction === "resume" ? "worker" : "attempt";
  if (payload.controlScope !== expectedScope) return null;
  if (
    typeof payload.workerHostId !== "string" ||
    payload.workerHostId.length === 0 ||
    typeof payload.workerSessionId !== "string" ||
    payload.workerSessionId.length === 0 ||
    typeof payload.workerSessionGeneration !== "string" ||
    payload.workerSessionGeneration.length === 0 ||
    typeof payload.fence !== "string" ||
    payload.fence.length === 0
  ) return null;
  if (
    payload.reason !== undefined &&
    typeof payload.reason !== "string"
  ) return null;
  return {
    action: controlAction,
    workerScoped: controlAction === "resume",
    workerHostId: payload.workerHostId,
    workerSessionId: payload.workerSessionId,
    workerSessionGeneration: payload.workerSessionGeneration,
    fence: payload.fence,
    ...(messageAction
      ? { messageId: payload.messageId as string, body: payload.body as string }
      : {}),
  };
}

async function savePendingTerminationEvidence(
  state: SupervisorState,
  attemptId: string,
): Promise<void> {
  const existing = state.terminationEvidence.get(attemptId);
  const assignment = state.active.get(attemptId)?.assignment ??
    state.registration?.activeAssignments?.[attemptId]?.assignment;
  const incoming = {
    status: "unknown" as const,
    observedAt: nowIso(),
    ...(assignment ? { fence: String(assignment.fence) } : {}),
  };
  const evidence = mergeTerminationEvidence(existing, incoming);
  try {
    state.registration = await state.registrationStore
      .saveTerminationEvidence(attemptId, evidence);
    state.terminationEvidence = new Map(
      Object.entries(state.registration.terminationEvidence ?? {}),
    );
    const persistedEvidence = state.registration.terminationEvidence
      ?.[attemptId];
    if (!persistedEvidence) {
      throw new Error("WORKER_TERMINATION_EVIDENCE_SAVE_MISSING");
    }
  } catch (error) {
    if (!(error instanceof TerminationEvidenceCapacityError)) throw error;
    state.controlState.capacityPaused = true;
    syncAdmissionPause(state.controlState);
    state.registration = await state.registrationStore
      .setCapacityPaused(true);
    terminationLog("termination_evidence_capacity_exhausted", {
      attemptId,
      admissionPaused: state.controlState.admissionPaused,
    });
  }
}
function commandTargetsCurrentWorker(
  state: SupervisorState,
  command: ParsedControlCommand,
  action: string,
  attemptId: string,
): boolean {
  if (
    !state.registration?.workerHostId ||
    command.workerHostId !== state.registration.workerHostId ||
    command.workerSessionId !== state.processSessionId ||
    command.workerSessionGeneration !== String(state.processSessionGeneration)
  ) return false;
  if (command.workerScoped) return action === "resume";
  const entry = state.registration.activeAssignments?.[attemptId];
  const active = state.active.get(attemptId);
  const assignment = active?.assignment ?? entry?.assignment;
  if (assignment) {
    return command.fence === String(assignment.fence) && action !== "resume";
  }
  const evidence = state.terminationEvidence.get(attemptId);
  return action === "cancel" && evidence?.fence === command.fence;
}

async function handleCommands(
  state: SupervisorState,
  commands: WorkerCommand[],
  callbacks: HeartbeatCallbacks,
  freshHeartbeat: boolean,
): Promise<void> {
  if (!state.registration) throw new Error("WORKER_NOT_REGISTERED");
  for (const commandId of state.commandOutcomes.keys()) {
    if (!state.registration.commandOutcomes?.[commandId]) {
      state.commandOutcomes.delete(commandId);
      state.controlState.acknowledgements.delete(commandId);
    }
  }
  for (const command of commands) {
    if (state.commandOutcomes.has(command.id)) continue;
    if (
      state.commandOutcomes.size >= MAX_COMMAND_ACKS ||
      state.controlState.acknowledgements.size >= MAX_COMMAND_ACKS
    ) {
      callbacks.failFatal("WORKER_COMMAND_ACK_CAPACITY_EXCEEDED");
      return;
    }
    const parsed = commandControlAction(command);
    const action = parsed?.action;
    const hasActive = state.active.has(command.attemptId);
    const hasPersisted = Boolean(
      state.registration.activeAssignments?.[command.attemptId],
    );
    const isTermination = action === "cancel" || action === "interrupt";
    const targetsWorker = parsed !== null && action !== undefined &&
      commandTargetsCurrentWorker(state, parsed, action, command.attemptId);
    const targetExists = hasActive || hasPersisted;
    const terminalCancellation = isTermination && action === "cancel" &&
      targetsWorker && !targetExists;
    const messageDelivery = action === "steer_message" ||
      action === "follow_up_message";
    let messageAcknowledged = false;
    if (
      messageDelivery && targetsWorker && targetExists && parsed?.messageId &&
      parsed.body !== undefined
    ) {
      const active = state.active.get(command.attemptId);
      const disposition = active && state.executor?.control
        ? await state.executor.control(
          active.assignment,
          action as "steer_message" | "follow_up_message",
          parsed.messageId,
          parsed.body,
        )
        : "rejected";
      messageAcknowledged = disposition === "accepted";
    }
    const transition = messageDelivery
      ? {
        // A steering message is acknowledged only after the selected adapter
        // accepts it; unsupported and stale commands remain rejected.
        acknowledged: messageAcknowledged,
        mode: state.controlState.mode,
      }
      : parsed !== null &&
          action !== undefined &&
          isWorkerControlAction(action) &&
          targetsWorker &&
          (targetExists || (action === "resume" && parsed.workerScoped) ||
            terminalCancellation)
      ? applyControlAction(state.controlState, command.id, action, {
        active: targetExists,
        terminallyCanceled: terminalCancellation,
        workerScoped: parsed.workerScoped,
        freshHeartbeat,
      })
      : { acknowledged: false, mode: state.controlState.mode };
    if (transition.acknowledged && isTermination) {
      const active = state.active.get(command.attemptId);
      state.publicationAuthorities.delete(command.attemptId);
      if (active) active.publicationRevoked = true;
      await savePendingTerminationEvidence(state, command.attemptId);
      if (active) {
        active.controller.abort();
        active.renewalController.abort();
        scheduleBoundedAbandonment(state, active, callbacks);
      } else if (hasPersisted) {
        await callbacks.releaseAttempt(
          command.attemptId,
          "CONTROL_COMMAND_ABORTED",
          { discardJournal: true },
        );
      }
    }
    const status: WorkerCommandOutcomeStatus = transition.acknowledged
      ? "acknowledged"
      : "rejected";
    state.commandOutcomes.set(command.id, status);
    state.registration = await state.registrationStore.saveCommandOutcome(
      command.id,
      status,
      {
        admissionPaused: state.controlState.admissionPaused,
        operatorPaused: state.controlState.operatorPaused,
        capacityPaused: state.controlState.capacityPaused,
      },
    );
  }
}

export async function runHeartbeatLoop(
  state: SupervisorState,
  callbacks: HeartbeatCallbacks,
): Promise<void> {
  let retryDelay = state.config.claimBackoffBaseMs;
  while (!state.stopping) {
    try {
      const response = await callbacks.withControlPlane(async (signal) => {
        const requestStartedAt = performance.now();
        let pending = state.pendingHeartbeat;
        if (!pending) {
          pending = createHeartbeatRequest(state);
          state.registration = await state.registrationStore
            .savePendingHeartbeat(
              pending,
            );
          state.pendingHeartbeat = pending;
        }
        const response = await state.client.heartbeat(
          pending.body,
          signal,
          pending.idempotencyKey,
        );
        const requestFinishedAt = performance.now();
        const result = {
          result: response.value as WorkerHeartbeatResultWithReconciliation,
          // A body restored from a killed process names that process's session.
          // The server answers one it never committed as a first beat from the
          // host's current session; handle it as a replay (the next heartbeat
          // takes the session over) so this process never adopts the answer.
          replayed: response.replayed ||
            pending.body.workerSessionId !== state.processSessionId,
        };
        await applyHeartbeatSession(
          state,
          result.result,
          pending.body.activeAttemptIds ?? [],
          requestStartedAt,
          requestFinishedAt,
          result.replayed,
          callbacks,
        );
        state.pendingHeartbeat = null;
        await applyCommandAcks(state, result.result.commandAcks);
        await callbacks.retryPendingCleanupEvidence();
        state.healthy = result.result.status === "accepted";
        state.freshHeartbeatReady = false;
        if (!state.healthy) {
          state.draining = true;
        }
        if (!result.replayed) {
          await callbacks.restoreRestoredAssignments();
          await handleCommands(
            state,
            result.result.pendingCommands,
            callbacks,
            state.healthy,
          );
          if (state.healthy) {
            const renewalsReady = await replayPendingRenewals(
              state,
              callbacks,
            );
            if (renewalsReady) {
              callbacks.startRestoredLeaseRenewals();
              await callbacks.resumeRestoredAssignments();
              state.freshHeartbeatReady = true;
            }
          }
          callbacks.markSessionReady();
          if (state.healthy) {
            await refreshReadiness(state, {
              inventoryRevision: result.result.inventoryRevision,
              replayed: result.replayed,
            }, signal);
          }
        }
        return result;
      });
      retryDelay = state.config.claimBackoffBaseMs;
      const heartbeatNow = response.replayed || state.heartbeatImmediately;
      state.heartbeatImmediately = false;
      await state.sleep(
        heartbeatNow ? 0 : state.config.heartbeatIntervalMs,
        state.lifecycleController.signal,
      );
    } catch (error) {
      if (state.stopping || state.draining) return;
      state.healthy = false;
      state.freshHeartbeatReady = false;
      state.lastFailure = error instanceof Error
        ? error.message
        : "HEARTBEAT_FAILED";
      if (!isTransientControlPlaneFailure(error)) {
        callbacks.failFatal(state.lastFailure);
        return;
      }
      logControlPlaneRetry("heartbeat", error, retryDelay);
      await state.sleep(retryDelay, state.lifecycleController.signal);
      retryDelay = Math.min(state.config.claimBackoffMaxMs, retryDelay * 2);
    }
  }
}
