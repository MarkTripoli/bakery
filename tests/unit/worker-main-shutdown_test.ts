import { assertEquals } from "@std/assert";
import { main } from "../../apps/worker/src/main.ts";
import { createDeterministicExecutor } from "../../apps/worker/src/executor.ts";
import { acquireStateLock } from "../../apps/worker/src/storage.ts";
import type { SupervisorState } from "../../apps/worker/src/supervisor-state.ts";
import type { ActiveAssignment } from "../../apps/worker/src/supervisor-support.ts";
import { WorkerShutdownQuiescenceError } from "../../apps/worker/src/supervisor.ts";
import {
  localAssignment,
  protocolResponse,
  RegistrationStore,
  supervisorConfig,
  WorkerApiClient,
} from "../helpers/worker-execution/recovery-support.ts";

function track(tasks: Set<Promise<void>>, task: Promise<void>): void {
  tasks.add(task);
  void task.then(
    () => tasks.delete(task),
    () => tasks.delete(task),
  );
}

async function assertWorkerStateLockHeld(path: string): Promise<void> {
  const lock = await acquireStateLock(path).catch((error) => {
    if (error instanceof Error && error.message === "WORKER_STATE_LOCKED") {
      return null;
    }
    throw error;
  });
  if (lock === null) return;
  await lock.release();
  throw new Error("WORKER_STATE_LOCK_RELEASED_BEFORE_QUIESCENCE");
}

/**
 * Detects a regression that never reaches a state the test waits on. It is not
 * a bound on the supervisor: the waits it guards are on states the test reaches
 * itself (a held write, a queued write, a quarantine retry, the quiescence
 * timer being armed, the quiescence failure), and the time they take is the
 * host's startup and I/O under load, which no fixed number can bound. A
 * regression fails here by name instead of hanging the lane.
 */
const HANG_DETECTOR_MS = 30_000;

async function reached<T>(
  state: Promise<T>,
  name: string | (() => string),
): Promise<T> {
  let id: number | undefined;
  try {
    return await Promise.race([
      state,
      new Promise<never>((_, reject) => {
        id = setTimeout(
          () => reject(new Error(typeof name === "function" ? name() : name)),
          HANG_DETECTOR_MS,
        ) as unknown as number;
      }),
    ]);
  } finally {
    clearTimeout(id);
  }
}

/** "settled" when `promise` has settled by the next macrotask, else "pending". */
async function settledState(promise: Promise<unknown>): Promise<string> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return settled ? "settled" : "pending";
}

/**
 * Takes the one timer whose delay `match` accepts instead of scheduling it, so
 * the test fires it. Shutdown quiescence is bounded by a single
 * `setTimeout(drainTimeoutMs)`; the wall time around it (startup, fsynced
 * writes) is the host's, so a test proves the bound by the timer that is armed
 * and fires, not by a clock. Every other timer passes through, and the capture
 * restores `setTimeout` as soon as it has the timer.
 */
function captureTimer(match: (delay: number) => boolean): {
  fire: Promise<() => void>;
  restore: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const fire = Promise.withResolvers<() => void>();
  const restore = () => {
    globalThis.setTimeout = realSetTimeout;
  };
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === "function" && delay !== undefined && match(delay)) {
      restore();
      fire.resolve(() => handler(...args));
      // An id for the caller's clearTimeout; nothing is scheduled.
      const id = realSetTimeout(() => undefined, 0);
      clearTimeout(id);
      return id;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  return { fire: fire.promise, restore };
}

Deno.test("main holds its state lock until shutdown tasks quiesce", async () => {
  const stateDir = await Deno.makeTempDir();
  // A budget no other timer of the run shares, so the quiescence timer is the
  // only one captured. No drain deadline runs in this test.
  const config = { ...supervisorConfig(stateDir), drainTimeoutMs: 20_011 };
  const quiescenceTimer = captureTimer((delay) =>
    delay === config.drainTimeoutMs
  );
  const execution = Promise.withResolvers<void>();
  const abandonment = Promise.withResolvers<void>();
  const shutdownTimedOut = Promise.withResolvers<unknown>();
  let failure: Promise<unknown> | undefined;
  const lockPath = `${stateDir}/.worker.lock`;

  try {
    failure = main({
      config,
      executor: createDeterministicExecutor(),
      onSupervisor(supervisor) {
        const internal = supervisor as unknown as {
          state: SupervisorState;
          run: () => Promise<void>;
        };
        track(internal.state.executionTasks, execution.promise);
        track(internal.state.abandonmentTasks, abandonment.promise);

        const run = supervisor.run.bind(supervisor);
        internal.run = async () => {
          try {
            await run();
          } catch (error) {
            shutdownTimedOut.resolve(error);
            throw error;
          }
        };
        supervisor.requestStop("TEST_SHUTDOWN");
      },
    }).then(
      () => {
        throw new Error("WORKER_MAIN_SHUTDOWN_SUCCEEDED_UNEXPECTEDLY");
      },
      (error) => error,
    );

    // Quiescence is bounded by one timer of exactly drainTimeoutMs, armed once
    // the stopped run drains its tracked tasks. Reaching it is a wait on state.
    const fireQuiescenceTimer = await reached(
      quiescenceTimer.fire,
      "WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED",
    );
    // Until that timer fires the supervisor waits for the two tasks that never
    // settle, and they are still pending when it gives up.
    assertEquals(await settledState(shutdownTimedOut.promise), "pending");
    fireQuiescenceTimer();
    const shutdownError = await reached(
      shutdownTimedOut.promise,
      "WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED",
    );
    if (!(shutdownError instanceof WorkerShutdownQuiescenceError)) {
      throw new Error("WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED");
    }

    await assertWorkerStateLockHeld(lockPath);

    abandonment.resolve();
    await assertWorkerStateLockHeld(lockPath);

    execution.resolve();
    const mainError = await failure;
    if (!(mainError instanceof WorkerShutdownQuiescenceError)) {
      throw new Error("WORKER_MAIN_DROPPED_SHUTDOWN_FAILURE");
    }
    assertEquals(mainError.message, shutdownError.message);

    const replacementLock = await acquireStateLock(lockPath);
    await replacementLock.release();
  } finally {
    quiescenceTimer.restore();
    abandonment.resolve();
    execution.resolve();
    await failure?.catch(() => undefined);
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test(
  "main completes a graceful drain before its deadline",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const config = { ...supervisorConfig(stateDir), drainTimeoutMs: 500 };
    let drainPromise: Promise<void> | undefined;

    try {
      await main({
        config,
        executor: createDeterministicExecutor(),
        onSupervisor(supervisor) {
          drainPromise = supervisor.drain();
          supervisor.requestStop("TEST_GRACEFUL_DRAIN");
        },
      });
      await drainPromise;

      const replacementLock = await acquireStateLock(
        `${stateDir}/.worker.lock`,
      );
      await replacementLock.release();
    } finally {
      await drainPromise?.catch(() => undefined);
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "main holds its state lock through drain quarantine writes",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const config = { ...supervisorConfig(stateDir), drainTimeoutMs: 37 };
    const assignment = localAssignment();
    const registrationLockPath = `${config.registrationPath}.lock`;
    const stateLockPath = `${stateDir}/.worker.lock`;
    const execution = Promise.withResolvers<void>();
    const quarantineWriteHeld = Promise.withResolvers<void>();
    const quarantineRetried = Promise.withResolvers<void>();
    const releaseQuarantineWrite = Promise.withResolvers<void>();
    const shutdownTimedOut = Promise.withResolvers<unknown>();
    const supervisorRunSettled = Promise.withResolvers<void>();
    let allowQuarantinePersistence = false;
    let quarantineFailures = 0;
    let holdQuarantineWrite = false;
    let active: ActiveAssignment | undefined;
    let supervisorState: SupervisorState | undefined;
    // The quiescence wait arms exactly one timer of drainTimeoutMs after the run
    // has stopped; the drain deadline's own timer is armed before the stop and
    // keeps running for real, so only the quiescence timer is taken.
    const quiescenceTimer = captureTimer((delay) =>
      delay === config.drainTimeoutMs && supervisorState?.stopping === true
    );
    let stopSupervisor: (() => void) | undefined;
    let failure: Promise<unknown> | undefined;
    let drainPromise: Promise<void> | undefined;

    const registrationStore = new RegistrationStore(
      config.registrationPath,
      {
        acquireStateLock: async (path) => {
          const lock = await acquireStateLock(path);
          if (holdQuarantineWrite && path === registrationLockPath) {
            holdQuarantineWrite = false;
            quarantineWriteHeld.resolve();
            await releaseQuarantineWrite.promise;
          }
          return lock;
        },
      },
    );
    const saveTerminationEvidence = registrationStore.saveTerminationEvidence
      .bind(registrationStore);
    registrationStore.saveTerminationEvidence = async (
      attemptId,
      evidence,
    ) => {
      if (!allowQuarantinePersistence) {
        quarantineFailures += 1;
        quarantineWriteHeld.resolve();
        if (quarantineFailures >= 2) quarantineRetried.resolve();
        throw new Error("INJECTED_QUARANTINE_PERSISTENCE_FAILURE");
      }
      holdQuarantineWrite = true;
      return await saveTerminationEvidence(attemptId, evidence);
    };

    try {
      await registrationStore.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
      });
      await registrationStore.saveActiveAssignment({
        assignment,
        nextLocalSeq: "3",
        ackedLocalSeq: "2",
      });

      failure = main({
        config,
        executor: createDeterministicExecutor(),
        registrationStore,
        onSupervisor(supervisor) {
          const internal = supervisor as unknown as {
            state: SupervisorState;
            run: () => Promise<void>;
          };
          supervisorState = internal.state;
          const liveActive: ActiveAssignment = {
            assignment,
            controller: new AbortController(),
            renewalController: new AbortController(),
            leaseSeconds: 45,
            leaseDeadline: performance.now() + 60_000,
            renewalKey: "drain-quarantine-key",
            renewalLoopStarted: false,
            terminalAcked: false,
            executionStarted: true,
            executionSettled: false,
            restored: false,
          };
          active = liveActive;
          internal.state.active.set(assignment.attemptId, liveActive);
          track(internal.state.executionTasks, execution.promise);

          const run = supervisor.run.bind(supervisor);
          internal.run = async () => {
            try {
              await run();
            } catch (error) {
              shutdownTimedOut.resolve(error);
              throw error;
            } finally {
              supervisorRunSettled.resolve();
            }
          };
          stopSupervisor = () => supervisor.requestStop("TEST_SHUTDOWN");
          drainPromise = supervisor.drain();
          void drainPromise.catch(() => undefined);
        },
      }).then(
        () => {
          throw new Error("WORKER_MAIN_SHUTDOWN_SUCCEEDED_UNEXPECTEDLY");
        },
        (error) => error,
      );

      let quarantineTimeout: number | undefined;
      const quarantineWait = await Promise.race([
        quarantineWriteHeld.promise.then(() => ({ held: true as const })),
        new Promise<{ timeout: true }>((resolve) => {
          quarantineTimeout = setTimeout(
            () => resolve({ timeout: true }),
            HANG_DETECTOR_MS,
          ) as unknown as number;
        }),
      ]);
      clearTimeout(quarantineTimeout);
      if (!("held" in quarantineWait)) {
        throw new Error("DRAIN_QUARANTINE_WRITE_NOT_HELD");
      }

      // The drain keeps retrying the quarantine write while the run waits out
      // its quiescence: wait for the retry as state, not for a clock to pass.
      await reached(quarantineRetried.promise, "DRAIN_QUARANTINE_NOT_RETRIED");

      // Quiescence is bounded by one timer of exactly drainTimeoutMs, armed once
      // the stopped run drains its tracked tasks. Reaching it is a wait on state.
      const fireQuiescenceTimer = await reached(
        quiescenceTimer.fire,
        () =>
          `WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED:${
            JSON.stringify({ stopping: supervisorState?.stopping })
          }`,
      );
      // Until it fires, the unsettled execution keeps the supervisor waiting.
      assertEquals(await settledState(shutdownTimedOut.promise), "pending");
      fireQuiescenceTimer();
      const timeout = await reached(
        Promise.race([
          shutdownTimedOut.promise.then((error) => ({ error })),
          supervisorRunSettled.promise.then(() => ({
            runSettled: true as const,
          })),
        ]),
        "WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED",
      );
      if (!("error" in timeout)) {
        throw new Error("WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED:run settled");
      }
      const shutdownError = timeout.error;
      if (!(shutdownError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED");
      }
      assertEquals(quarantineFailures >= 2, true);
      if (!supervisorState?.stopping || !active) {
        throw new Error("DRAIN_DID_NOT_STOP_BEFORE_EXECUTOR_SETTLED");
      }

      active.executionSettled = true;
      execution.resolve();
      await execution.promise;
      await assertWorkerStateLockHeld(stateLockPath);

      allowQuarantinePersistence = true;
      releaseQuarantineWrite.resolve();
      await drainPromise;
      const mainError = await failure;
      if (!(mainError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_MAIN_DROPPED_SHUTDOWN_FAILURE");
      }
      assertEquals(mainError.message, shutdownError.message);
      const evidence = (await registrationStore.load())
        ?.terminationEvidence?.[assignment.attemptId];
      assertEquals(evidence?.status, "unknown");
      assertEquals(evidence?.observedExitAt, undefined);
      assertEquals(evidence?.cleanupComplete, undefined);

      const replacementLock = await acquireStateLock(stateLockPath);
      await replacementLock.release();
    } finally {
      quiescenceTimer.restore();
      stopSupervisor?.();
      if (active) active.executionSettled = true;
      execution.resolve();
      allowQuarantinePersistence = true;
      releaseQuarantineWrite.resolve();
      await drainPromise?.catch(() => undefined);
      await failure?.catch(() => undefined);
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "main holds its state lock for paused restored lease renewal writes",
  async () => {
    const stateDir = await Deno.makeTempDir();
    // A budget no other timer of the run shares, so the quiescence timer is the
    // only one captured. No drain deadline runs in this test.
    const config = { ...supervisorConfig(stateDir), drainTimeoutMs: 20_013 };
    const quiescenceTimer = captureTimer((delay) =>
      delay === config.drainTimeoutMs
    );
    const assignment = localAssignment();
    const registrationLockPath = `${config.registrationPath}.lock`;
    const stateLockPath = `${stateDir}/.worker.lock`;
    const renewalWriteHeld = Promise.withResolvers<void>();
    const releaseRenewalWrite = Promise.withResolvers<void>();
    const shutdownTimedOut = Promise.withResolvers<unknown>();
    const supervisorRunSettled = Promise.withResolvers<void>();
    let holdUpdateActiveAssignment = false;
    let supervisorState: SupervisorState | undefined;
    let stopSupervisor: (() => void) | undefined;
    let failure: Promise<unknown> | undefined;

    const registrationStore = new RegistrationStore(config.registrationPath, {
      acquireStateLock: async (path) => {
        const lock = await acquireStateLock(path);
        if (
          holdUpdateActiveAssignment && path === registrationLockPath
        ) {
          holdUpdateActiveAssignment = false;
          renewalWriteHeld.resolve();
          await releaseRenewalWrite.promise;
        }
        return lock;
      },
    });
    const updateActiveAssignment = registrationStore.updateActiveAssignment
      .bind(registrationStore);
    registrationStore.updateActiveAssignment = async (attemptId, patch) => {
      holdUpdateActiveAssignment = true;
      return await updateActiveAssignment(attemptId, patch);
    };

    const client = new WorkerApiClient({
      baseUrl: config.serverUrl,
      credential: "credential",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (!path.endsWith("/lease-renewals")) {
          throw new Error(`UNEXPECTED_WORKER_REQUEST:${path}`);
        }
        return Promise.resolve(protocolResponse({
          attemptId: assignment.attemptId,
          fence: assignment.fence,
          status: "active",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          leaseDurationSeconds: 45,
          serverTime: new Date().toISOString(),
        }));
      },
    });

    try {
      await registrationStore.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
      });
      await registrationStore.saveCommandOutcome(
        crypto.randomUUID(),
        "acknowledged",
        { admissionPaused: true },
      );
      await registrationStore.saveActiveAssignment({
        assignment,
        nextLocalSeq: "2",
        ackedLocalSeq: "1",
      });

      failure = main({
        config,
        executor: createDeterministicExecutor(),
        client,
        registrationStore,
        onSupervisor(supervisor) {
          stopSupervisor = () => supervisor.requestStop("TEST_SHUTDOWN");
          const internal = supervisor as unknown as {
            state: SupervisorState;
            run: () => Promise<void>;
            startLeaseRenewal(active: ActiveAssignment): void;
            awaitShutdownTasks(): Promise<void>;
          };
          supervisorState = internal.state;
          internal.run = async () => {
            try {
              const state = internal.state;
              const registration = await registrationStore.load();
              if (!registration) {
                throw new Error("TEST_WORKER_REGISTRATION_MISSING");
              }
              state.registration = registration;
              state.processSessionId =
                `renewal-session-${assignment.attemptId}`;
              state.processSessionGeneration = "2";
              state.processSessionAcquired = true;
              state.latestAuthoritativeServerTimeMs = Date.now();
              state.latestAuthoritativeServerTimeObservedAtMs = performance
                .now();
              state.controlState.admissionPaused = true;
              state.sleep = () => Promise.resolve();
              const active: ActiveAssignment = {
                assignment: {
                  ...assignment,
                  workerSessionId: state.processSessionId,
                  workerSessionGeneration: state.processSessionGeneration,
                },
                controller: new AbortController(),
                renewalController: new AbortController(),
                leaseSeconds: 45,
                leaseDeadline: performance.now() + 60_000,
                renewalKey: "restored-renewal-key",
                renewalLoopStarted: false,
                terminalAcked: false,
                executionStarted: false,
                restored: true,
              };
              state.active.set(assignment.attemptId, active);
              internal.startLeaseRenewal(active);
              const renewalTask = state.renewalTasks.values().next().value;
              if (!renewalTask) {
                throw new Error("RESTORED_RENEWAL_TASK_NOT_TRACKED");
              }
              await Promise.race([
                renewalWriteHeld.promise,
                renewalTask.then(() => {
                  throw new Error("RESTORED_RENEWAL_WRITE_NOT_REACHED");
                }),
              ]);
              supervisor.requestStop("TEST_SHUTDOWN");
              await internal.awaitShutdownTasks();
            } catch (error) {
              shutdownTimedOut.resolve(error);
              throw error;
            } finally {
              supervisorRunSettled.resolve();
            }
          };
        },
      }).then(
        () => {
          throw new Error("WORKER_MAIN_SHUTDOWN_SUCCEEDED_UNEXPECTEDLY");
        },
        (error) => error,
      );

      let writeTimeout: number | undefined;
      const writeWait = await Promise.race([
        renewalWriteHeld.promise.then(() => ({ held: true as const })),
        shutdownTimedOut.promise.then((error) => ({ error })),
        new Promise<{ timeout: true }>((resolve) => {
          writeTimeout = setTimeout(
            () => resolve({ timeout: true }),
            HANG_DETECTOR_MS,
          ) as unknown as number;
        }),
      ]);
      clearTimeout(writeTimeout);
      if ("error" in writeWait) {
        throw new Error(`RESTORED_RENEWAL_FAILED:${String(writeWait.error)}`);
      }
      if (!("held" in writeWait)) {
        throw new Error("RESTORED_RENEWAL_WRITE_NOT_HELD");
      }

      const active = supervisorState?.active.get(assignment.attemptId);
      assertEquals(supervisorState?.registration?.admissionPaused, true);
      assertEquals(active?.restored, true);
      assertEquals(active?.executionStarted, false);
      assertEquals(supervisorState?.renewalTasks.size, 1);
      stopSupervisor?.();

      // Quiescence is bounded by one timer of exactly drainTimeoutMs, armed once
      // the stopped run drains its tracked tasks. Reaching it is a wait on state.
      const fireQuiescenceTimer = await reached(
        quiescenceTimer.fire,
        () =>
          `WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED:${
            JSON.stringify({
              stopping: supervisorState?.stopping,
              renewalTasks: supervisorState?.renewalTasks.size,
            })
          }`,
      );
      // Until it fires, the paused renewal write keeps the supervisor waiting.
      assertEquals(await settledState(shutdownTimedOut.promise), "pending");
      assertEquals(supervisorState?.renewalTasks.size, 1);
      fireQuiescenceTimer();
      const timeout = await reached(
        Promise.race([
          shutdownTimedOut.promise.then((error) => ({ error })),
          supervisorRunSettled.promise.then(() => ({
            runSettled: true as const,
          })),
        ]),
        "WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED",
      );
      if (!("error" in timeout)) {
        throw new Error("WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED:run settled");
      }
      const shutdownError = timeout.error;
      if (!(shutdownError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED");
      }

      await assertWorkerStateLockHeld(stateLockPath);
      releaseRenewalWrite.resolve();

      const mainError = await failure;
      if (!(mainError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_MAIN_DROPPED_SHUTDOWN_FAILURE");
      }
      assertEquals(mainError.message, shutdownError.message);
      assertEquals(
        (await registrationStore.load())?.activeAssignments?.[
          assignment.attemptId
        ]?.renewalKey,
        undefined,
      );

      const replacementLock = await acquireStateLock(stateLockPath);
      await replacementLock.release();
    } finally {
      quiescenceTimer.restore();
      stopSupervisor?.();
      releaseRenewalWrite.resolve();
      await failure?.catch(() => undefined);
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "main holds its state lock while heartbeat registration blocks quarantine",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const config = { ...supervisorConfig(stateDir), drainTimeoutMs: 41 };
    const assignment = localAssignment();
    const workerHostId = assignment.workerHostId;
    const sessionId = assignment.workerSessionId;
    const registrationLockPath = `${config.registrationPath}.lock`;
    const stateLockPath = `${stateDir}/.worker.lock`;
    const registrationWriteHeld = Promise.withResolvers<void>();
    const releaseRegistrationWrite = Promise.withResolvers<void>();
    const shutdownTimedOut = Promise.withResolvers<unknown>();
    const supervisorRunSettled = Promise.withResolvers<void>();
    const execution = Promise.withResolvers<void>();
    const quarantineWriteQueued = Promise.withResolvers<void>();
    let holdHeartbeatRegistrationWrite = false;
    let heartbeatSessionId: string | undefined;
    let heartbeatSessionGeneration: string | undefined;
    let queuedControlPlaneStarted = false;
    let queuedControlPlaneAbort: AbortController | undefined;
    let activeAttempt: ActiveAssignment | undefined;
    let supervisorState: SupervisorState | undefined;
    // The quiescence wait arms exactly one timer of drainTimeoutMs after the run
    // has stopped; the drain deadline's own timer is armed before the stop and
    // keeps running for real, so only the quiescence timer is taken.
    const quiescenceTimer = captureTimer((delay) =>
      delay === config.drainTimeoutMs && supervisorState?.stopping === true
    );
    let stopSupervisor: (() => void) | undefined;
    let failure: Promise<unknown> | undefined;
    let drainPromise: Promise<void> | undefined;

    const registrationStore = new RegistrationStore(
      config.registrationPath,
      {
        acquireStateLock: async (path) => {
          const lock = await acquireStateLock(path);
          if (
            holdHeartbeatRegistrationWrite && path === registrationLockPath
          ) {
            holdHeartbeatRegistrationWrite = false;
            registrationWriteHeld.resolve();
            await releaseRegistrationWrite.promise;
          }
          return lock;
        },
      },
    );
    const saveTerminationEvidence = registrationStore.saveTerminationEvidence
      .bind(registrationStore);
    registrationStore.saveTerminationEvidence = async (
      attemptId,
      evidence,
    ) => {
      quarantineWriteQueued.resolve();
      return await saveTerminationEvidence(attemptId, evidence);
    };
    const saveSessionAndClearPendingHeartbeat = registrationStore
      .saveSessionAndClearPendingHeartbeat.bind(registrationStore);
    registrationStore.saveSessionAndClearPendingHeartbeat = async (
      workerSessionId,
      workerSessionGeneration,
    ) => {
      holdHeartbeatRegistrationWrite = true;
      return await saveSessionAndClearPendingHeartbeat(
        workerSessionId,
        workerSessionGeneration,
      );
    };
    const client = new WorkerApiClient({
      baseUrl: config.serverUrl,
      credential: "credential",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (!path.endsWith("/heartbeat")) {
          throw new Error(`UNEXPECTED_WORKER_REQUEST:${path}`);
        }
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          workerSessionId: string;
          workerSessionGeneration: string;
        };
        heartbeatSessionId = request.workerSessionId;
        heartbeatSessionGeneration = request.workerSessionGeneration;
        return Promise.resolve(protocolResponse({
          workerHostId,
          status: "accepted",
          receivedAt: new Date().toISOString(),
          pendingCommands: [],
          commandAcks: [],
          workerSessionId: request.workerSessionId,
          workerSessionGeneration: request.workerSessionGeneration,
          reconciledAttemptIds: [assignment.attemptId],
          serverTime: new Date().toISOString(),
          inventoryRevision: 1,
        }));
      },
    });

    try {
      await registrationStore.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: sessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
      });
      await registrationStore.saveActiveAssignment({
        assignment,
        nextLocalSeq: "2",
        ackedLocalSeq: "1",
      });

      failure = main({
        config,
        executor: createDeterministicExecutor(),
        client,
        registrationStore,
        onSupervisor(supervisor) {
          const internal = supervisor as unknown as {
            state: SupervisorState;
            run: () => Promise<void>;
            withControlPlane: <T>(
              work: (signal: AbortSignal) => Promise<T>,
              signal?: AbortSignal,
            ) => Promise<T>;
          };
          const liveActive: ActiveAssignment = {
            assignment,
            controller: new AbortController(),
            renewalController: new AbortController(),
            leaseSeconds: 45,
            leaseDeadline: performance.now() + 60_000,
            renewalKey: "heartbeat-drain-quarantine-key",
            renewalLoopStarted: false,
            terminalAcked: false,
            executionStarted: true,
            executionSettled: false,
            restored: false,
          };
          activeAttempt = liveActive;
          internal.state.active.set(assignment.attemptId, liveActive);
          supervisorState = internal.state;
          track(internal.state.executionTasks, execution.promise);
          const run = supervisor.run.bind(supervisor);
          internal.run = async () => {
            try {
              await run();
            } catch (error) {
              shutdownTimedOut.resolve(error);
              throw error;
            } finally {
              supervisorRunSettled.resolve();
            }
          };
          stopSupervisor = () => supervisor.requestStop("TEST_SHUTDOWN");

          void registrationWriteHeld.promise.then(() => {
            queuedControlPlaneAbort = new AbortController();
            void internal.withControlPlane(() => {
              queuedControlPlaneStarted = true;
              return Promise.resolve();
            }, queuedControlPlaneAbort.signal).catch(() => undefined);
            drainPromise = supervisor.drain();
            void drainPromise.catch(() => undefined);
          });
        },
      }).then(
        () => {
          throw new Error("WORKER_MAIN_SHUTDOWN_SUCCEEDED_UNEXPECTEDLY");
        },
        (error) => error,
      );

      let writeTimeout: number | undefined;
      const writeWait = await Promise.race([
        registrationWriteHeld.promise.then(() => ({ held: true as const })),
        shutdownTimedOut.promise.then((error) => ({ error })),
        supervisorRunSettled.promise.then(() => ({
          runSettled: true as const,
        })),
        new Promise<{ timeout: true }>((resolve) => {
          writeTimeout = setTimeout(
            () => resolve({ timeout: true }),
            HANG_DETECTOR_MS,
          ) as unknown as number;
        }),
      ]);
      clearTimeout(writeTimeout);
      if (!("held" in writeWait)) {
        throw new Error(
          `HEARTBEAT_REGISTRATION_WRITE_NOT_HELD:${
            "error" in writeWait ? String(writeWait.error) : "timeout"
          }`,
        );
      }

      let quarantineTimeout: number | undefined;
      const quarantineWait = await Promise.race([
        quarantineWriteQueued.promise.then(() => ({ queued: true as const })),
        shutdownTimedOut.promise.then((error) => ({ error })),
        supervisorRunSettled.promise.then(() => ({
          runSettled: true as const,
        })),
        new Promise<{ timeout: true }>((resolve) => {
          quarantineTimeout = setTimeout(
            () => resolve({ timeout: true }),
            HANG_DETECTOR_MS,
          ) as unknown as number;
        }),
      ]);
      clearTimeout(quarantineTimeout);
      if (!("queued" in quarantineWait)) {
        throw new Error(
          `DRAIN_QUARANTINE_WRITE_NOT_QUEUED:${
            "error" in quarantineWait
              ? String(quarantineWait.error)
              : "run settled or timeout"
          }`,
        );
      }

      // Quiescence is bounded by one timer of exactly drainTimeoutMs, armed once
      // the stopped run drains its tracked tasks. Reaching it is a wait on state.
      const fireQuiescenceTimer = await reached(
        quiescenceTimer.fire,
        () =>
          `WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED:${
            JSON.stringify({ stopping: supervisorState?.stopping })
          }`,
      );
      // Until it fires, the unsettled execution keeps the supervisor waiting.
      assertEquals(await settledState(shutdownTimedOut.promise), "pending");
      fireQuiescenceTimer();
      const timeout = await reached(
        Promise.race([
          shutdownTimedOut.promise.then((error) => ({ error })),
          supervisorRunSettled.promise.then(() => ({
            runSettled: true as const,
          })),
        ]),
        "WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED",
      );
      if (!("error" in timeout)) {
        throw new Error("WORKER_SHUTDOWN_QUIESCENCE_NOT_BOUNDED:run settled");
      }
      const shutdownError = timeout.error;
      if (!(shutdownError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_SHUTDOWN_DID_NOT_FAIL_CLOSED");
      }
      if (!supervisorState?.stopping || !activeAttempt) {
        throw new Error("DRAIN_DEADLINE_DID_NOT_STOP_RUN");
      }

      assertEquals(queuedControlPlaneStarted, false);
      await assertWorkerStateLockHeld(stateLockPath);
      queuedControlPlaneAbort?.abort();
      activeAttempt.executionSettled = true;
      execution.resolve();
      await execution.promise;
      await assertWorkerStateLockHeld(stateLockPath);
      releaseRegistrationWrite.resolve();
      await drainPromise;

      const mainError = await failure;
      if (!(mainError instanceof WorkerShutdownQuiescenceError)) {
        throw new Error("WORKER_MAIN_DROPPED_SHUTDOWN_FAILURE");
      }
      assertEquals(mainError.message, shutdownError.message);
      const registration = await registrationStore.load();
      assertEquals(registration?.workerSessionId, heartbeatSessionId);
      assertEquals(
        registration?.workerSessionGeneration,
        heartbeatSessionGeneration,
      );
      assertEquals(registration?.pendingHeartbeat, undefined);
      assertEquals(
        registration?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );

      const replacementLock = await acquireStateLock(stateLockPath);
      await replacementLock.release();
    } finally {
      quiescenceTimer.restore();
      stopSupervisor?.();
      queuedControlPlaneAbort?.abort();
      releaseRegistrationWrite.resolve();
      execution.resolve();
      await drainPromise?.catch(() => undefined);
      await failure?.catch(() => undefined);
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);
