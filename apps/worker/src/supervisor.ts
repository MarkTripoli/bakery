import { syncAdmissionPause } from "./control-state.ts";
import {
  disabledMonitoring,
  type RuntimeMonitoring,
} from "@bakery/config/sentry-deno";
import type { WorkerConfig } from "./config.ts";
import { WorkerApiClient, WorkerRequestError } from "./client.ts";
import { boundedNativeDiagnostic, type WorkerExecutor } from "./executor.ts";
import type { PreparedSecretInvoker } from "./prepared-secret-invoker.ts";
import type { SkillMaterializer } from "./skill-materializer.ts";
import { ensureRegistration, RegistrationStore } from "./registration.ts";
import { EventSpool } from "./spool.ts";
import {
  createSupervisorState,
  type SupervisorState,
} from "./supervisor-state.ts";
import { withControlPlane as serializeControlPlane } from "./supervisor-control-plane.ts";
import {
  type ActiveAssignment,
  canPublishActiveAssignment,
  defaultSleep,
  leaseDeadline,
  leaseDeadlineFromAuthoritativeServerTime,
  leaseValid,
  nowIso,
  proposedSessionGeneration,
  type Sleep,
} from "./supervisor-support.ts";
import {
  publicationAuthorityForAssignment,
  reconcileSkillMaterializationOwner,
  recoverReleaseMarkers,
  restoreActiveAssignments,
} from "./supervisor-recovery.ts";
import {
  activeAttemptIds,
  commandOutcomeInputs,
  type HeartbeatCallbacks,
  runHeartbeatLoop,
} from "./supervisor-heartbeat.ts";
import { runClaimLoop, runLeaseRenewalLoop } from "./supervisor-claims.ts";
import {
  executeAssignment as runAssignment,
  flushOnce as flushSpoolOnce,
  releaseAttempt as releaseAssignment,
  retryPendingTerminationCleanup,
  runFlushLoop,
  type StandaloneReplayOptions,
  unwrapFlushAttemptError,
} from "./supervisor-execution.ts";
import type { WorkerShutdownIdentity } from "./shutdown-receipt.ts";
import type { JobAssignment } from "./types.ts";

export type { Sleep } from "./supervisor-support.ts";
function hasPendingExecution(state: SupervisorState): boolean {
  return [...state.active.values()].some((active) =>
    active.executionStarted &&
    active.executionSettled !== true &&
    !state.terminationEvidence.has(active.assignment.attemptId)
  );
}

export class WorkerShutdownQuiescenceError extends Error {
  constructor(readonly quiescence: Promise<void>) {
    super("WORKER_SHUTDOWN_QUIESCENCE_TIMEOUT");
    this.name = "WorkerShutdownQuiescenceError";
  }
}

export class WorkerSupervisor {
  private readonly state: SupervisorState;
  private readonly monitoring: RuntimeMonitoring;
  private executionError: Error | undefined;

  constructor(options: {
    config: WorkerConfig;
    client: WorkerApiClient;
    registrationStore: RegistrationStore;
    spool: EventSpool;
    executor?: WorkerExecutor;
    preparedSecretInvoker?: PreparedSecretInvoker;
    skillMaterializer?: Pick<SkillMaterializer, "prepare" | "recover">;
    sleep?: Sleep;
    monotonicNow?: () => number;
    monitoring?: RuntimeMonitoring;
  }) {
    this.monitoring = options.monitoring ?? disabledMonitoring;
    this.state = createSupervisorState({
      ...options,
      sleep: options.sleep ?? defaultSleep,
    });
  }

  get stopReason(): string | null {
    return this.state.lastFailure;
  }

  get fatalReason(): string | null {
    return this.state.fatalFailure ? this.state.lastFailure : null;
  }

  get fatalError(): Error | undefined {
    return this.executionError;
  }

  get shutdownIdentity(): WorkerShutdownIdentity | null {
    const state = this.state;
    const registration = state.registration;
    const generation = state.processSessionGeneration;
    if (
      !state.processSessionAcquired ||
      !registration?.workerHostId ||
      registration.workerSessionId !== state.processSessionId ||
      String(registration.workerSessionGeneration) !== generation
    ) return null;
    return {
      workerHostId: registration.workerHostId,
      workerSessionId: state.processSessionId,
      workerSessionGeneration: generation,
    };
  }

  get isDraining(): boolean {
    return this.state.draining;
  }

  get isLifecycleActive(): boolean {
    const state = this.state;
    return state.stopPromise !== null ||
      state.standaloneReplayInProgress ||
      state.processSessionAcquired ||
      state.freshHeartbeatReady;
  }

  requestStop(reason = "STOP_REQUESTED"): void {
    const state = this.state;
    state.lastFailure ||= reason;
    state.stopping = true;
    this.cancelAbandonmentTimers();
    state.lifecycleController.abort();
    if (state.draining) {
      state.inFlightClaimController?.abort();
      state.controlPlane.abortController?.abort();
    }
    state.client.abort();
    state.flushAbortController?.abort();
    for (const active of state.active.values()) {
      active.controller.abort();
      active.renewalController.abort();
    }
    this.markSessionReady();
    state.stopResolver?.();
  }

  private cancelAbandonmentTimers(): void {
    const state = this.state;
    for (const timer of state.abandonmentTimers) clearTimeout(timer);
    state.abandonmentTimers.clear();
    for (const active of state.active.values()) {
      active.abandonmentTimer = undefined;
    }
  }

  private async awaitShutdownTasks(): Promise<void> {
    const state = this.state;
    const quiescence = (async () => {
      while (true) {
        const controlPlaneTail = state.controlPlane.tail;
        const drainPromise = state.drainPromise;
        await Promise.allSettled([
          controlPlaneTail,
          ...(drainPromise ? [drainPromise] : []),
          ...state.controlPlane.inFlight,
          ...state.executionTasks,
          ...state.abandonmentTasks,
          ...state.renewalTasks,
        ]);
        if (
          controlPlaneTail === state.controlPlane.tail &&
          drainPromise === state.drainPromise &&
          state.controlPlane.inFlight.size === 0 &&
          state.executionTasks.size === 0 &&
          state.abandonmentTasks.size === 0 &&
          state.renewalTasks.size === 0
        ) return;
      }
    })();
    let timer: number | undefined;
    const settled = await Promise.race([
      quiescence.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          state.config.drainTimeoutMs,
        ) as unknown as number;
      }),
    ]);
    clearTimeout(timer);
    if (!settled) throw new WorkerShutdownQuiescenceError(quiescence);
    await this.persistCleanQuiescence();
  }
  private async persistCleanQuiescence(): Promise<void> {
    const state = this.state;
    if (state.fatalFailure || !state.registration) return;
    const terminalAttempts = new Set(
      state.spool.records()
        .filter((record) => record.kind === "result")
        .map((record) => record.attemptId),
    );
    for (const [attemptId, active] of state.active) {
      const entry = state.registration.activeAssignments?.[attemptId];
      if (
        !entry ||
        !active.executionStarted ||
        active.executionSettled !== true ||
        !active.cleanCancellationEligible ||
        active.publicationRevoked === true ||
        BigInt(entry.nextLocalSeq) <= 2n ||
        entry.terminalAcked === true ||
        terminalAttempts.has(attemptId) ||
        state.terminationEvidence.has(attemptId) ||
        state.serverTerminalObservations.has(attemptId)
      ) continue;
      state.registration = await state.registrationStore
        .updateActiveAssignment(attemptId, { cleanQuiescence: true });
    }
  }

  private markSessionReady(): void {
    const state = this.state;
    if (state.sessionReadyResolved) return;
    state.sessionReadyResolved = true;
    state.sessionReadyResolver();
  }

  private failFatal(reason: string): void {
    const state = this.state;
    state.lastFailure ||= reason;
    state.fatalFailure = true;
    state.draining = true;
    if (state.stopping || state.drainPromise) return;
    void this.drain().catch((error) => {
      this.requestStop(error instanceof Error ? error.message : reason);
    });
  }
  private reportSupervisorFault(error: unknown): void {
    const diagnostic = error instanceof WorkerRequestError
      ? error.diagnostic ?? `${error.code}:${error.status ?? "unknown"}`
      : error instanceof Error
      ? error.message
      : "SUPERVISOR_FAULT";
    const bounded = boundedNativeDiagnostic(diagnostic);
    const state = this.state;
    state.lastFailure ||= `WORKER_SUPERVISOR_FAULT:${bounded}`;
    if (state.draining) state.drainFaulted = true;
    this.monitoring.capture(error);
    console.error(JSON.stringify({
      component: "worker-supervisor",
      event: "fault",
      detail: bounded,
    }));
  }

  private withControlPlane<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return serializeControlPlane(
      this.state.controlPlane,
      this.state.lifecycleController.signal,
      work,
      signal,
    );
  }

  async drain(): Promise<void> {
    const state = this.state;
    if (state.drainPromise) return await state.drainPromise;
    const promise = this.drainInternal();
    state.drainPromise = promise;
    await promise;
  }

  private async drainInternal(): Promise<void> {
    const state = this.state;
    if (state.stopping) return;
    const deadline = performance.now() + state.config.drainTimeoutMs;
    state.draining = true;
    for (const active of state.active.values()) {
      active.controller.abort();
      active.renewalController.abort();
    }
    const deadlineController = new AbortController();
    const timer = setTimeout(() => {
      state.inFlightClaimController?.abort();
      state.controlPlane.abortController?.abort();
      deadlineController.abort();
      state.flushAbortController?.abort();
      this.requestStop("DRAIN_DEADLINE");
    }, Math.max(0, deadline - performance.now()));
    try {
      try {
        await this.withControlPlane(async (signal) => {
          for (const active of state.active.values()) {
            active.controller.abort();
            active.renewalController.abort();
          }
          const registration = state.registration;
          if (registration?.workerHostId && performance.now() < deadline) {
            try {
              await state.client.heartbeat({
                workerHostId: registration.workerHostId,
                observedAt: nowIso(),
                load: Math.min(1, state.active.size / state.config.slots),
                activeAttemptIds: activeAttemptIds(state),
                workerSessionId: state.processSessionId,
                workerSessionGeneration: state.processSessionGeneration,
                ...commandOutcomeInputs(state),
              }, signal);
            } catch {
              // Shutdown never waits for a control-plane acknowledgement.
            }
          }
        }, deadlineController.signal);
      } catch (error) {
        if (!deadlineController.signal.aborted) throw error;
      }
      while (
        performance.now() < deadline &&
        !state.drainFaulted &&
        (state.spool.peek() !== null || hasPendingExecution(state))
      ) {
        try {
          if (
            (state.processSessionAcquired || state.stopPromise === null) &&
            state.spool.peek() !== null
          ) {
            const progressed = await this.flushOnce(
              deadlineController.signal,
            );
            if (!progressed) {
              const executionPending = hasPendingExecution(state);
              if (!executionPending) break;
              await state.sleep(10, deadlineController.signal);
            }
          } else {
            await state.sleep(10, deadlineController.signal);
          }
        } catch (error) {
          if (
            error instanceof WorkerRequestError && error.retryable &&
            !deadlineController.signal.aborted
          ) {
            await state.sleep(
              Math.min(250, Math.max(25, deadline - performance.now())),
              deadlineController.signal,
            );
            continue;
          }
          this.reportSupervisorFault(error);
          break;
        }
      }
    } finally {
      deadlineController.abort();
      try {
        await this.quarantineUnsettledExecutions();
      } finally {
        clearTimeout(timer);
        this.requestStop("DRAINED");
      }
    }
  }

  async run(): Promise<void> {
    const state = this.state;
    if (state.standaloneReplayInProgress) {
      throw new Error("WORKER_REPLAY_LIFECYCLE_ACTIVE");
    }
    state.stopPromise = new Promise<void>((resolve) => {
      state.stopResolver = resolve;
    });
    try {
      if (state.stopping) return;
      state.registration = await ensureRegistration(
        state.config,
        state.registrationStore,
        state.client,
      );
      state.registration = await state.registrationStore
        .reconcileCapacityPause();
      state.processSessionGeneration = proposedSessionGeneration(
        state.registration.workerSessionGeneration,
      );
      state.pendingHeartbeat = state.registration.pendingHeartbeat
        ? structuredClone(state.registration.pendingHeartbeat)
        : null;
      const legacyOperatorPaused =
        state.registration.admissionPaused === true &&
        state.registration.capacityPaused !== true;
      state.controlState.operatorPaused = state.registration.operatorPaused ??
        legacyOperatorPaused;
      state.controlState.capacityPaused = state.registration.capacityPaused ===
        true;
      syncAdmissionPause(state.controlState);
      state.terminationEvidence = new Map(
        Object.entries(state.registration.terminationEvidence ?? {}),
      );
      if (state.terminationEvidence.size > 0) {
        console.warn(JSON.stringify({
          component: "worker-supervisor",
          event: "termination_evidence_restored",
          count: state.terminationEvidence.size,
        }));
      }
      state.registration = await state.registrationStore
        .prunePendingRenewalKeys();
      state.registration = await recoverReleaseMarkers({
        registration: state.registration,
        registrationStore: state.registrationStore,
        spool: state.spool,
        active: state.active,
        authorityFor: () => null,
        leaseDeadlineFor: () => performance.now(),
      });
      for (
        const [commandId, status] of Object.entries(
          state.registration.commandOutcomes ?? {},
        )
      ) {
        state.commandOutcomes.set(commandId, status);
      }
      const releasedBeforeSession = await this
        .quarantineUnquiescedStartedAttempts();
      if (releasedBeforeSession === null || state.stopping) return;
      const staleHeartbeatAttempts = state.pendingHeartbeat?.body
        .activeAttemptIds;
      state.heartbeatImmediately = releasedBeforeSession.some((attemptId) =>
        staleHeartbeatAttempts?.includes(attemptId) === true
      );
      const heartbeatPromise = this.heartbeatLoop();
      await state.sessionReadyPromise;
      if (state.stopping) {
        await heartbeatPromise;
        return;
      }
      await Promise.all([
        heartbeatPromise,
        this.claimLoop(),
        this.flushLoop(),
        state.stopPromise,
      ]);
    } finally {
      if (!state.stopping) {
        this.requestStop(state.lastFailure ?? "SUPERVISOR_RUN_EXITED");
      }
      await this.awaitShutdownTasks();
    }
  }

  private heartbeatLoop(): Promise<void> {
    const callbacks: HeartbeatCallbacks = {
      withControlPlane: (work) => this.withControlPlane(work),
      releaseAttempt: (attemptId, reason, options) =>
        this.releaseAttempt(attemptId, reason, options),
      restoreRestoredAssignments: () => this.prepareRestoredAssignments(),
      startRestoredLeaseRenewals: () => this.startRestoredLeaseRenewals(),
      resumeRestoredAssignments: () => this.resumeRestoredAssignments(),
      retryPendingCleanupEvidence: () =>
        retryPendingTerminationCleanup(this.state),
      markSessionReady: () => this.markSessionReady(),
      failFatal: (reason) => this.failFatal(reason),
    };
    return runHeartbeatLoop(this.state, callbacks);
  }

  /**
   * Releases every persisted started attempt that lacks durable clean
   * quiescence as TERMINATION_UNKNOWN. Runs before the first heartbeat so the
   * restarted worker never reports a dead attempt as live: the first heartbeat
   * body omits it and the server quarantines it in the transaction that opens
   * the new session. Returns the released attempt ids, or null when a release
   * did not complete (the worker is then failing fatally).
   */
  private async quarantineUnquiescedStartedAttempts(): Promise<
    string[] | null
  > {
    const state = this.state;
    if (!state.registration) return [];
    const released: string[] = [];
    const terminalAttempts = new Set(
      state.spool.records()
        .filter((record) => record.kind === "result")
        .map((record) => record.attemptId),
    );
    for (
      const [attemptId, entry] of Object.entries(
        state.registration.activeAssignments ?? {},
      )
    ) {
      if (
        state.active.has(attemptId) ||
        BigInt(entry.nextLocalSeq) <= 2n ||
        entry.terminalAcked === true ||
        entry.cleanQuiescence === true ||
        terminalAttempts.has(attemptId)
      ) continue;
      // nextLocalSeq advances past job.started before executor invocation.
      // Only durable clean quiescence permits resuming this started attempt.
      await this.releaseAttempt(
        attemptId,
        "TERMINATION_UNKNOWN",
        { discardJournal: true },
      );
      if (state.registration?.activeAssignments?.[attemptId]) {
        this.failFatal("WORKER_STARTED_ATTEMPT_QUARANTINE_INCOMPLETE");
        return null;
      }
      released.push(attemptId);
    }
    return released;
  }

  private async prepareRestoredAssignments(): Promise<void> {
    const state = this.state;
    if (state.stopping || state.draining || !state.processSessionAcquired) {
      return;
    }
    if (!state.registration) return;
    if (state.skillMaterializer && !state.skillRecoveryComplete) {
      await state.skillMaterializer.recover(
        (owner) =>
          Promise.resolve(reconcileSkillMaterializationOwner({
            owner,
            registration: state.registration,
            terminationEvidence: state.terminationEvidence,
            processSessionAcquired: state.processSessionAcquired,
            healthy: state.healthy,
          })),
        state.lifecycleController.signal,
      );
      state.skillRecoveryComplete = true;
    }
    const restoredLeaseDeadline = (
      assignment: JobAssignment,
    ): number => {
      const now = performance.now();
      if (
        state.latestAuthoritativeServerTimeMs !== null &&
        state.latestAuthoritativeServerTimeObservedAtMs !== null
      ) {
        return leaseDeadlineFromAuthoritativeServerTime(
          assignment.leaseExpiresAt,
          state.latestAuthoritativeServerTimeMs,
          state.latestAuthoritativeServerTimeObservedAtMs,
          now,
        );
      }
      return leaseDeadline(
        assignment.serverTime ?? nowIso(),
        assignment.leaseExpiresAt,
        now,
        now,
      );
    };
    if (await this.quarantineUnquiescedStartedAttempts() === null) return;
    await restoreActiveAssignments({
      registration: state.registration,
      spool: state.spool,
      active: state.active,
      registrationStore: state.registrationStore,
      authorityFor: (attemptId, assignment) =>
        state.publicationAuthorities.get(attemptId) ??
          publicationAuthorityForAssignment(
            assignment,
            state.processSessionId,
            state.processSessionGeneration,
            restoredLeaseDeadline(assignment),
          ),
      leaseDeadlineFor: (_attemptId, assignment) =>
        restoredLeaseDeadline(assignment),
    });
    for (const active of state.active.values()) {
      const attemptId = active.assignment.attemptId;
      if (!canPublishActiveAssignment(state, active)) continue;
      const authority = state.publicationAuthorities.get(attemptId) ??
        publicationAuthorityForAssignment(
          active.assignment,
          state.processSessionId,
          state.processSessionGeneration,
          restoredLeaseDeadline(active.assignment),
        );
      if (authority) state.publicationAuthorities.set(attemptId, authority);
    }
    for (const active of [...state.active.values()]) {
      if (
        active.executionStarted ||
        active.executionSettled === false
      ) continue;
      if (state.terminationEvidence.has(active.assignment.attemptId)) {
        await this.releaseAttempt(
          active.assignment.attemptId,
          "TERMINATION_EVIDENCE_RECOVERY",
          { discardJournal: true },
        );
      }
    }
  }

  private startRestoredLeaseRenewals(): void {
    const state = this.state;
    for (const active of state.active.values()) {
      if (
        !active.restored || active.executionStarted ||
        active.controller.signal.aborted
      ) continue;
      this.startLeaseRenewal(active);
    }
  }

  private startLeaseRenewal(active: ActiveAssignment): void {
    if (active.renewalLoopStarted) return;
    active.renewalLoopStarted = true;
    const state = this.state;
    const task = runLeaseRenewalLoop(state, active, {
      releaseAttempt: (attemptId, reason) =>
        this.releaseAttempt(attemptId, reason),
      failFatal: (reason) => this.failFatal(reason),
    }).catch((error) => {
      this.failFatal(
        error instanceof Error ? error.message : "LEASE_RENEWAL_FAILED",
      );
    });
    state.renewalTasks.add(task);
    void task.then(
      () => state.renewalTasks.delete(task),
      () => state.renewalTasks.delete(task),
    );
  }

  private async resumeRestoredAssignments(): Promise<void> {
    const state = this.state;
    if (
      !state.processSessionAcquired || state.stopping || state.draining ||
      state.controlState.admissionPaused
    ) return;
    if (!state.registration) return;
    for (const active of [...state.active.values()]) {
      if (!active.restored || active.executionStarted) continue;
      if (state.terminationEvidence.has(active.assignment.attemptId)) {
        await this.releaseAttempt(
          active.assignment.attemptId,
          "TERMINATION_EVIDENCE_RECOVERY",
          { discardJournal: true },
        );
        continue;
      }
      if (active.controller.signal.aborted) {
        await this.releaseAttempt(
          active.assignment.attemptId,
          "CONTROL_COMMAND_ABORTED",
          { discardJournal: true },
        );
        continue;
      }
      if (
        active.terminalAcked &&
        !state.spool.records().some((record) =>
          record.attemptId === active.assignment.attemptId &&
          record.kind === "result"
        )
      ) {
        await this.releaseAttempt(active.assignment.attemptId, "RESULT_ACKED");
        continue;
      }
      active.restored = false;
      if (!leaseValid(active)) {
        await this.releaseAttempt(active.assignment.attemptId, "LEASE_EXPIRED");
        continue;
      }
      const attemptId = active.assignment.attemptId;
      if (
        state.registration.activeAssignments?.[attemptId]?.cleanQuiescence ===
          true
      ) {
        const registration = await state.registrationStore
          .updateActiveAssignment(attemptId, { cleanQuiescence: false });
        state.registration = registration;
        const persistedEntry = registration.activeAssignments?.[attemptId];
        if (
          !persistedEntry ||
          persistedEntry.assignment.leaseToken !==
            active.assignment.leaseToken ||
          persistedEntry.assignment.fence !== active.assignment.fence ||
          persistedEntry.cleanQuiescence !== false
        ) {
          active.controller.abort();
          active.renewalController.abort();
          state.active.delete(attemptId);
          state.publicationAuthorities.delete(attemptId);
          continue;
        }
      }
      active.executionStarted = true;
      void this.executeAssignment(
        active.assignment,
        active.controller.signal,
      ).catch((error) => {
        this.failFatal(
          error instanceof Error
            ? error.message
            : "ASSIGNMENT_EXECUTION_FAILED",
        );
      });
    }
  }

  private claimLoop(): Promise<void> {
    return runClaimLoop(this.state, {
      withControlPlane: (work, signal) => this.withControlPlane(work, signal),
      releaseAttempt: (attemptId, reason, options) =>
        this.releaseAttempt(attemptId, reason, options),
      executeAssignment: (assignment, signal) =>
        this.executeAssignment(assignment, signal),
      failFatal: (reason) => this.failFatal(reason),
    });
  }

  private executeAssignment(
    assignment: JobAssignment,
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.state;
    const task = this.monitoring.span(
      "queue.process",
      () =>
        runAssignment(state, assignment, signal, {
          reportError: (error) => {
            if (error instanceof Error) this.executionError = error;
            this.monitoring.capture(error);
          },
          reportSupervisorFault: (error) => this.reportSupervisorFault(error),
          failFatal: (reason) => this.failFatal(reason),
          startLeaseRenewal: (active) => this.startLeaseRenewal(active),
        }, (attemptId, reason, options) =>
          this.releaseAttempt(
            attemptId,
            reason,
            options,
          )),
    );
    state.executionTasks.add(task);
    void task.then(
      () => state.executionTasks.delete(task),
      () => state.executionTasks.delete(task),
    );
    return task;
  }

  private async quarantineUnsettledExecutions(): Promise<void> {
    const unsettled = [...this.state.active.values()].filter((active) =>
      active.executionStarted && active.executionSettled !== true &&
      active.boundaryFailure !== true
    );
    for (const active of unsettled) {
      await this.releaseAttempt(
        active.assignment.attemptId,
        "TERMINATION_UNKNOWN",
        { discardJournal: true },
      );
    }
  }

  private async releaseAttempt(
    attemptId: string,
    reason: string,
    options: { discardJournal?: boolean } = {},
  ): Promise<void> {
    await releaseAssignment(
      this.state,
      attemptId,
      reason,
      options,
      (failure) => this.failFatal(failure),
    );
  }

  private flushLoop(): Promise<void> {
    return runFlushLoop(
      this.state,
      (signal) => this.flushOnce(signal),
      (reason) => this.failFatal(reason),
      (error) => this.reportSupervisorFault(error),
    );
  }

  async flushOnce(signal?: AbortSignal): Promise<boolean> {
    return await flushSpoolOnce(
      this.state,
      signal,
      (reason) => this.failFatal(reason),
      (error) => this.reportSupervisorFault(error),
    );
  }

  /**
   * Replay durable spool records for a recovery fixture before `run()`.
   *
   * This recovery-only seam requires a pristine supervisor lifecycle.
   * `discardUnregisteredLeaseLoss` is also recovery-fixture-only and permits
   * deleting an unregistered lease-loss record with no durable assignment.
   */
  async replayStandalone(
    signal?: AbortSignal,
    options: StandaloneReplayOptions = {},
  ): Promise<boolean> {
    const state = this.state;
    if (this.isLifecycleActive) {
      throw new Error("WORKER_REPLAY_LIFECYCLE_ACTIVE");
    }
    state.standaloneReplayInProgress = true;
    try {
      if (state.registration === null) {
        state.registration = await state.registrationStore.load();
      }
      return await flushSpoolOnce(
        state,
        signal,
        (reason) => this.failFatal(reason),
        (error) => this.reportSupervisorFault(error),
        {
          standaloneReplay: true,
          discardUnregisteredLeaseLoss: options.discardUnregisteredLeaseLoss,
        },
      );
    } catch (error) {
      throw unwrapFlushAttemptError(error);
    } finally {
      state.standaloneReplayInProgress = false;
    }
  }
}

export function createWorkerSupervisor(
  options: ConstructorParameters<typeof WorkerSupervisor>[0],
): WorkerSupervisor {
  return new WorkerSupervisor(options);
}
