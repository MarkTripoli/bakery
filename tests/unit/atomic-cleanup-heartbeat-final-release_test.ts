import { assert, assertEquals } from "@std/assert";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { withControlPlane } from "../../apps/worker/src/supervisor-control-plane.ts";
import {
  executeAssignment,
  releaseAttempt,
  retryPendingTerminationCleanup,
} from "../../apps/worker/src/supervisor-execution.ts";
import { runHeartbeatLoop } from "../../apps/worker/src/supervisor-heartbeat.ts";
import { createSupervisorState } from "../../apps/worker/src/supervisor-state.ts";
import type { ActiveAssignment } from "../../apps/worker/src/supervisor-support.ts";
import {
  heartbeatResponse,
  localAssignment,
  protocolResponse,
  supervisorConfig,
  waitForCondition,
} from "../helpers/worker-execution/recovery-support.ts";

// Keep the production control-plane queue. A direct work(signal) callback would
// manufacture an interleaving that the production supervisor does not allow.
for (
  const barrier of ["before-clear", "after-clear", "before-release"] as const
) {
  Deno.test(`exact cleanup survives omitted heartbeat at ${barrier}`, async () => {
    const directory = await Deno.makeTempDir({
      prefix: "atomic-cleanup-repro-",
    });
    let barrierReached = false;
    const resume = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    let execution: Promise<void> | undefined;
    let heartbeat: Promise<void> | undefined;
    const warning = console.warn;
    const quarantines: string[] = [];
    try {
      const assignment = localAssignment();
      const attemptId = assignment.attemptId;
      const sessionId = assignment.workerSessionId!;
      const generation = String(assignment.workerSessionGeneration);
      const exitedAt = new Date().toISOString();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("fixture-credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: sessionId,
        workerSessionGeneration: generation,
      });
      await store.saveActiveAssignment({
        assignment,
        nextLocalSeq: "3",
        ackedLocalSeq: "2",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      });
      await spool.restoreJournalState(attemptId, "3", "2");
      let cleanupRequests = 0;
      let heartbeatRequests = 0;
      let requestedAttemptIds: unknown;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "fixture-credential",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body));
          if (path === `/v1/worker/attempts/${attemptId}/cleanup`) {
            cleanupRequests++;
            assertEquals(body, {
              fence: String(assignment.fence),
              workerSessionId: sessionId,
              workerSessionGeneration: generation,
              observedByWorkerSessionId: sessionId,
              observedByWorkerSessionGeneration: generation,
              exitedAt,
            });
            return Promise.resolve(protocolResponse({
              attemptId,
              status: "canceled",
              cancellation: {
                processExited: true,
                cleanupStatus: "complete",
                terminationStatus: "confirmed",
                exitedAt,
                cleanupObserver: {
                  observedBy: {
                    workerSessionId: sessionId,
                    workerSessionGeneration: generation,
                  },
                  attestedBy: {
                    workerSessionId: sessionId,
                    workerSessionGeneration: generation,
                  },
                },
              },
            }));
          }
          if (path === "/v1/worker/heartbeat") {
            heartbeatRequests++;
            requestedAttemptIds = body.activeAttemptIds;
            return Promise.resolve(heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              sessionId,
              generation,
              [],
            ));
          }
          throw new Error(`UNEXPECTED_REQUEST:${path}`);
        },
      });
      const active: ActiveAssignment = {
        assignment,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: performance.now() + 60_000,
        renewalKey: undefined,
        renewalLoopStarted: false,
        terminalAcked: false,
        executionStarted: true,
        restored: false,
      };
      const state = createSupervisorState({
        config: supervisorConfig(directory),
        client,
        registrationStore: store,
        spool,
        executor: {
          execute: () => {
            active.controller.abort();
            return Promise.resolve({
              status: "canceled" as const,
              cancellation: {
                processExited: true,
                exitedAt,
                cleanupStatus: "complete",
                terminationStatus: "confirmed",
              },
            });
          },
        },
        sleep: () => {
          state.stopping = true;
          return Promise.resolve();
        },
      });
      state.registration = await store.load();
      state.processSessionId = sessionId;
      state.processSessionGeneration = generation;
      state.active.set(attemptId, active);
      // Exercise an authentic retained request containing the attempt as well
      // as fresh requests constructed after retirement. All IDs are UUIDs.
      if (barrier === "before-release") {
        state.pendingHeartbeat = {
          idempotencyKey: crypto.randomUUID(),
          body: {
            workerHostId: assignment.workerHostId,
            observedAt: new Date().toISOString(),
            load: 1,
            activeAttemptIds: [attemptId],
            workerSessionId: sessionId,
            workerSessionGeneration: generation,
            ackCommandIds: [crypto.randomUUID()],
            rejectedCommandIds: [],
          },
        };
        await store.savePendingHeartbeat(state.pendingHeartbeat);
      }
      console.warn = (...args: unknown[]) => {
        const text = String(args[0]);
        if (
          text.includes('"event":"termination_quarantined"') &&
          text.includes(attemptId)
        ) {
          quarantines.push(text);
        }
        warning(...args);
      };
      const originalclearTerminationEvidence = store.clearTerminationEvidence
        .bind(store);
      store.clearTerminationEvidence = async (id) => {
        assertEquals(cleanupRequests, 1);
        if (barrier === "before-clear") {
          barrierReached = true;
          await resume.promise;
        }
        const registration = await originalclearTerminationEvidence(id);
        if (barrier === "after-clear") {
          barrierReached = true;
          await resume.promise;
        }
        return registration;
      };
      const originalCompleteRelease = store.completeRelease.bind(store);
      store.completeRelease = async (id) => {
        if (barrier === "before-release") {
          barrierReached = true;
          await resume.promise;
        }
        return await originalCompleteRelease(id);
      };
      const reasons: string[] = [];
      const fatal: string[] = [];
      const release = async (
        id: string,
        reason: string,
        options?: { discardJournal?: boolean },
      ) => {
        reasons.push(reason);
        await releaseAttempt(state, id, reason, options);
      };
      execution = executeAssignment(
        state,
        assignment,
        active.controller.signal,
        {
          failFatal: (reason) => fatal.push(reason),
          startLeaseRenewal: () => {},
        },
        release,
      );
      await waitForCondition(
        () => barrierReached,
        `BARRIER_NOT_REACHED:${barrier}`,
      );
      assert((await store.load())?.activeAssignments?.[attemptId]);
      heartbeat = runHeartbeatLoop(state, {
        withControlPlane: (work) => {
          const task = withControlPlane(
            state.controlPlane,
            state.lifecycleController.signal,
            work,
          );
          queued.resolve();
          return task;
        },
        releaseAttempt: release,
        restoreRestoredAssignments: async () => {},
        startRestoredLeaseRenewals: () => {},
        resumeRestoredAssignments: async () => {},
        retryPendingCleanupEvidence: () =>
          retryPendingTerminationCleanup(state),
        markSessionReady: () => {},
        failFatal: (reason) => fatal.push(reason),
      });
      await queued.promise;
      resume.resolve();
      await Promise.all([execution, heartbeat]);
      // Check after final release, not while the barrier is still held.
      const persisted = await store.load();
      assertEquals(fatal, []);
      assertEquals(cleanupRequests, 1);
      assertEquals(heartbeatRequests, 1);
      assertEquals(reasons, ["CLEANUP_CONFIRMED"]);
      assertEquals(quarantines, []);
      assertEquals(
        requestedAttemptIds,
        barrier === "before-release" ? [attemptId] : [],
      );
      assertEquals(persisted?.activeAssignments?.[attemptId], undefined);
      assertEquals(persisted?.terminationEvidence?.[attemptId], undefined);
      assertEquals(persisted?.releaseMarkers?.[attemptId], undefined);
      assertEquals(persisted?.pendingRenewalKeys?.[attemptId], undefined);
      assertEquals(state.active.has(attemptId), false);
      assertEquals(state.terminationEvidence.has(attemptId), false);
      assertEquals(spool.records(), []);
    } finally {
      resume.resolve();
      await Promise.allSettled(
        [execution, heartbeat].filter((task) => task !== undefined),
      );
      console.warn = warning;
      await Deno.remove(directory, { recursive: true });
    }
  });
}

// Negative responses pass through the real HTTP parser, queue and durable store.
// The retained heartbeat is authentic: constructed while the attempt was active.
for (
  const proof of [
    "absent",
    "failed",
    "malformed",
    "wrong-attempt",
    "wrong-status",
    "unproven-exit",
    "incomplete",
    "unconfirmed",
    "stale-exit",
    "replaced-observer",
    "replaced-generation",
    "stale-fence",
  ] as const
) {
  Deno.test(`rejected ${proof} cleanup retains durable quarantine after omitted heartbeat`, async () => {
    const directory = await Deno.makeTempDir({ prefix: "negative-cleanup-" });
    const resume = Promise.withResolvers<void>();
    let entered = false;
    const queued = Promise.withResolvers<void>();
    let execution: Promise<void> | undefined;
    let heartbeat: Promise<void> | undefined;
    try {
      const assignment = localAssignment();
      const attemptId = assignment.attemptId;
      const sessionId = assignment.workerSessionId!;
      const generation = String(assignment.workerSessionGeneration);
      const exitedAt = new Date().toISOString();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("fixture-credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: sessionId,
        workerSessionGeneration: generation,
      });
      await store.saveActiveAssignment({
        assignment,
        nextLocalSeq: "3",
        ackedLocalSeq: "2",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      });
      await spool.restoreJournalState(attemptId, "3", "2");
      let cleanupRequests = 0;
      let heartbeatRequests = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "fixture-credential",
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body));
          if (path.endsWith("/cleanup")) {
            cleanupRequests++;
            assertEquals(body, {
              fence: String(assignment.fence),
              workerSessionId: sessionId,
              workerSessionGeneration: generation,
              observedByWorkerSessionId: sessionId,
              observedByWorkerSessionGeneration: generation,
              exitedAt,
            });
            if (cleanupRequests === 1) {
              entered = true;
              await resume.promise;
            }
            if (proof === "failed") {
              return protocolResponse({ code: "SERVICE_UNAVAILABLE" }, {
                status: 503,
              });
            }
            // Fence authority is checked by the server, not a fabricated local CAS.
            if (proof === "stale-fence") {
              return protocolResponse({ code: "STATE_CONFLICT" }, {
                status: 409,
              });
            }
            if (proof === "malformed") return protocolResponse({});
            return protocolResponse({
              attemptId: proof === "wrong-attempt"
                ? crypto.randomUUID()
                : attemptId,
              status: proof === "wrong-status" ? "running" : "canceled",
              cancellation: {
                processExited: proof !== "unproven-exit",
                cleanupStatus: proof === "incomplete" ? "pending" : "complete",
                terminationStatus: proof === "unconfirmed"
                  ? "unknown"
                  : "confirmed",
                exitedAt: proof === "stale-exit"
                  ? new Date(0).toISOString()
                  : exitedAt,
                cleanupObserver: {
                  observedBy: {
                    workerSessionId: proof === "replaced-observer"
                      ? crypto.randomUUID()
                      : sessionId,
                    workerSessionGeneration: proof === "replaced-generation"
                      ? String(BigInt(generation) + 1n)
                      : generation,
                  },
                },
              },
            });
          }
          if (path === "/v1/worker/heartbeat") {
            heartbeatRequests++;
            assertEquals(body.activeAttemptIds, [attemptId]);
            return heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              sessionId,
              generation,
              [],
            );
          }
          throw new Error("UNEXPECTED_NEGATIVE_REQUEST");
        },
      });
      const active: ActiveAssignment = {
        assignment,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: performance.now() + 60_000,
        renewalKey: undefined,
        renewalLoopStarted: false,
        terminalAcked: false,
        executionStarted: true,
        restored: false,
      };
      const state = createSupervisorState({
        config: supervisorConfig(directory),
        client,
        registrationStore: store,
        spool,
        executor: {
          execute: async () => {
            active.controller.abort();
            if (proof === "absent") {
              entered = true;
              await resume.promise;
            }
            return {
              status: "canceled",
              cancellation: {
                processExited: proof !== "absent",
                exitedAt: proof === "absent" ? null : exitedAt,
                cleanupStatus: proof === "absent" ? "pending" : "complete",
                terminationStatus: proof === "absent" ? "unknown" : "confirmed",
              },
            };
          },
        },
        sleep: () => {
          state.stopping = true;
          return Promise.resolve();
        },
      });
      state.registration = await store.load();
      state.processSessionId = sessionId;
      state.processSessionGeneration = generation;
      state.active.set(attemptId, active);
      state.pendingHeartbeat = {
        idempotencyKey: crypto.randomUUID(),
        body: {
          workerHostId: assignment.workerHostId,
          observedAt: new Date().toISOString(),
          load: 1,
          activeAttemptIds: [attemptId],
          workerSessionId: sessionId,
          workerSessionGeneration: generation,
          ackCommandIds: [],
          rejectedCommandIds: [],
        },
      };
      await store.savePendingHeartbeat(state.pendingHeartbeat);
      const reasons: string[] = [];
      const fatal: string[] = [];
      const release = async (
        id: string,
        reason: string,
        options?: { discardJournal?: boolean },
      ) => {
        reasons.push(reason);
        await releaseAttempt(state, id, reason, options);
      };
      execution = executeAssignment(
        state,
        assignment,
        active.controller.signal,
        {
          failFatal: (reason) => fatal.push(reason),
          startLeaseRenewal: () => {},
        },
        release,
      );
      await waitForCondition(() => entered, "NEGATIVE_CLEANUP_NOT_REACHED");
      if (proof === "absent") {
        // No cleanup confirmation owns the queue in this case. Finish unknown
        // retirement before exercising the retained omitted response.
        resume.resolve();
        await execution;
      }
      heartbeat = runHeartbeatLoop(state, {
        withControlPlane: (work) => {
          const task = withControlPlane(
            state.controlPlane,
            state.lifecycleController.signal,
            work,
          );
          queued.resolve();
          return task;
        },
        releaseAttempt: release,
        restoreRestoredAssignments: async () => {},
        startRestoredLeaseRenewals: () => {},
        resumeRestoredAssignments: async () => {},
        retryPendingCleanupEvidence: () =>
          retryPendingTerminationCleanup(state),
        markSessionReady: () => {},
        failFatal: (reason) => fatal.push(reason),
      });
      await queued.promise;
      resume.resolve();
      await Promise.all([execution, heartbeat]);
      // Reopen independently; in-memory maps do not establish durable quarantine.
      const persisted = await new RegistrationStore(
        `${directory}/registration.json`,
      ).load();
      assertEquals(fatal, []);
      assertEquals(heartbeatRequests, 1);
      assertEquals(cleanupRequests, proof === "absent" ? 0 : 2);
      assertEquals(reasons.includes("CLEANUP_CONFIRMED"), false);
      assert(persisted?.terminationEvidence?.[attemptId]);
      assertEquals(persisted.terminationEvidence[attemptId].status, "pending");
      if (proof === "absent") {
        assertEquals(
          persisted.terminationEvidence[attemptId].cleanupComplete,
          undefined,
        );
        assertEquals(
          persisted.terminationEvidence[attemptId].observedExitAt,
          undefined,
        );
      } else {
        assertEquals(
          persisted.terminationEvidence[attemptId].observedExitAt,
          exitedAt,
        );
        assertEquals(persisted.terminationEvidence[attemptId].observedBy, {
          workerSessionId: sessionId,
          workerSessionGeneration: generation,
        });
      }
      assertEquals(persisted.activeAssignments?.[attemptId], undefined);
      assertEquals(persisted.releaseMarkers?.[attemptId], undefined);
      assertEquals(state.active.has(attemptId), false);
      assertEquals(spool.records(), []);
    } finally {
      resume.resolve();
      await Promise.allSettled(
        [execution, heartbeat].filter((task) => task !== undefined),
      );
      await Deno.remove(directory, { recursive: true });
    }
  });
}

// A restarted process acquires its session through heartbeat before retrying
// persisted old-owner evidence. No off-queue mutation during confirmation.
Deno.test("restarted session owner cannot confirm stale durable cleanup", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "replaced-cleanup-owner-",
  });
  try {
    const assignment = localAssignment();
    const attemptId = assignment.attemptId;
    const observerSession = assignment.workerSessionId!;
    const observerGeneration = String(assignment.workerSessionGeneration);
    const currentSession = crypto.randomUUID();
    const currentGeneration = String(BigInt(observerGeneration) + 1n);
    const exitedAt = new Date().toISOString();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("fixture-credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: observerSession,
      workerSessionGeneration: observerGeneration,
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
    });
    const evidence = {
      status: "pending" as const,
      observedAt: exitedAt,
      observedExitAt: exitedAt,
      cleanupComplete: true,
      fence: String(assignment.fence),
      observedBy: {
        workerSessionId: observerSession,
        workerSessionGeneration: observerGeneration,
      },
    };
    await store.saveTerminationEvidence(attemptId, evidence);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    let cleanupRequests = 0;
    let heartbeatRequests = 0;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "fixture-credential",
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body));
        if (path === "/v1/worker/heartbeat") {
          heartbeatRequests++;
          assertEquals(body.workerSessionId, currentSession);
          return heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            currentSession,
            currentGeneration,
            [],
          );
        }
        if (path.endsWith("/cleanup")) {
          cleanupRequests++;
          // The heartbeat has already persisted the replacement attester.
          const persisted = await new RegistrationStore(
            `${directory}/registration.json`,
          ).load();
          assertEquals(persisted?.workerSessionId, currentSession);
          assertEquals(persisted?.workerSessionGeneration, currentGeneration);
          assertEquals(body, {
            fence: String(assignment.fence),
            workerSessionId: currentSession,
            workerSessionGeneration: currentGeneration,
            observedByWorkerSessionId: observerSession,
            observedByWorkerSessionGeneration: observerGeneration,
            exitedAt,
          });
          // Server authority rejects old observer ownership or superseded
          // fence. This fixture is not live database/session acceptance.
          return protocolResponse({ code: "STATE_CONFLICT" }, {
            status: 409,
          });
        }
        throw new Error("UNEXPECTED_REPLACED_OWNER_REQUEST");
      },
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => {
        state.stopping = true;
        return Promise.resolve();
      },
    });
    state.registration = await store.load();
    state.terminationEvidence.set(attemptId, evidence);
    state.processSessionId = currentSession;
    state.processSessionGeneration = "0";
    const reasons: string[] = [];
    const fatal: string[] = [];
    await runHeartbeatLoop(state, {
      withControlPlane: (work) =>
        withControlPlane(
          state.controlPlane,
          state.lifecycleController.signal,
          work,
        ),
      releaseAttempt: async (id, reason, options) => {
        reasons.push(reason);
        await releaseAttempt(state, id, reason, options);
      },
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {},
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: () => retryPendingTerminationCleanup(state),
      markSessionReady: () => {},
      failFatal: (reason) => fatal.push(reason),
    });
    const persisted = await new RegistrationStore(
      `${directory}/registration.json`,
    ).load();
    assertEquals(heartbeatRequests, 1);
    assertEquals(cleanupRequests, 1);
    assertEquals(fatal, []);
    assertEquals(reasons.includes("CLEANUP_CONFIRMED"), false);
    assertEquals(persisted?.terminationEvidence?.[attemptId], evidence);
    assertEquals(persisted?.workerSessionId, currentSession);
    assertEquals(persisted?.workerSessionGeneration, currentGeneration);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// The heartbeat retry confirms any complete evidence it finds. A tick that
// already holds the control plane as an execution saves its evidence must leave
// the confirmation to that execution, queued behind it, or the same cleanup is
// posted twice.
Deno.test("a heartbeat tick holding the control plane leaves an unsettled execution to confirm its own cleanup once", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "cleanup-single-flight-",
  });
  const heartbeatParked = Promise.withResolvers<void>();
  const releaseHeartbeat = Promise.withResolvers<void>();
  const evidenceSaved = Promise.withResolvers<void>();
  let execution: Promise<void> | undefined;
  let heartbeat: Promise<void> | undefined;
  try {
    const assignment = localAssignment();
    const attemptId = assignment.attemptId;
    const sessionId = assignment.workerSessionId!;
    const generation = String(assignment.workerSessionGeneration);
    const exitedAt = new Date().toISOString();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("fixture-credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: sessionId,
      workerSessionGeneration: generation,
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    await spool.restoreJournalState(attemptId, "3", "2");
    let cleanupRequests = 0;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "fixture-credential",
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === `/v1/worker/attempts/${attemptId}/cleanup`) {
          cleanupRequests++;
          return protocolResponse({
            attemptId,
            status: "canceled",
            cancellation: {
              processExited: true,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
              exitedAt,
              cleanupObserver: {
                observedBy: {
                  workerSessionId: sessionId,
                  workerSessionGeneration: generation,
                },
                attestedBy: {
                  workerSessionId: sessionId,
                  workerSessionGeneration: generation,
                },
              },
            },
          });
        }
        if (path === "/v1/worker/heartbeat") {
          heartbeatParked.resolve();
          await releaseHeartbeat.promise;
          return heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            sessionId,
            generation,
            [attemptId],
          );
        }
        throw new Error(`UNEXPECTED_REQUEST:${path}`);
      },
    });
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      restored: false,
    };
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () => {
          active.controller.abort();
          return Promise.resolve({
            status: "canceled" as const,
            cancellation: {
              processExited: true,
              exitedAt,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
            },
          });
        },
      },
      sleep: () => {
        state.stopping = true;
        return Promise.resolve();
      },
    });
    state.registration = await store.load();
    state.processSessionId = sessionId;
    state.processSessionGeneration = generation;
    state.active.set(attemptId, active);
    // The execution queues its confirmation right after this save returns.
    let tailAtSave: Promise<void> | undefined;
    const saveTerminationEvidence = store.saveTerminationEvidence.bind(store);
    store.saveTerminationEvidence = async (id, evidence) => {
      const registration = await saveTerminationEvidence(id, evidence);
      tailAtSave = state.controlPlane.tail;
      evidenceSaved.resolve();
      return registration;
    };
    const reasons: string[] = [];
    const fatal: string[] = [];
    const release = async (
      id: string,
      reason: string,
      options?: { discardJournal?: boolean },
    ) => {
      reasons.push(reason);
      await releaseAttempt(state, id, reason, options);
    };
    // The tick takes the control plane first and parks on its heartbeat.
    heartbeat = runHeartbeatLoop(state, {
      withControlPlane: (work) =>
        withControlPlane(
          state.controlPlane,
          state.lifecycleController.signal,
          work,
        ),
      releaseAttempt: release,
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {},
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: () => retryPendingTerminationCleanup(state),
      markSessionReady: () => {},
      failFatal: (reason) => fatal.push(reason),
    });
    await heartbeatParked.promise;
    execution = executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => fatal.push(reason),
        startLeaseRenewal: () => {},
      },
      release,
    );
    // The execution has saved its evidence and queued behind the tick.
    await evidenceSaved.promise;
    await waitForCondition(
      () => state.controlPlane.tail !== tailAtSave,
      "EXECUTION_NOT_QUEUED_BEHIND_HEARTBEAT",
    );
    releaseHeartbeat.resolve();
    await Promise.all([execution, heartbeat]);
    const persisted = await store.load();
    assertEquals(fatal, []);
    assertEquals(cleanupRequests, 1);
    assertEquals(reasons, ["CLEANUP_CONFIRMED"]);
    assertEquals(persisted?.activeAssignments?.[attemptId], undefined);
    assertEquals(persisted?.terminationEvidence?.[attemptId], undefined);
    assertEquals(persisted?.releaseMarkers?.[attemptId], undefined);
    assertEquals(state.active.has(attemptId), false);
    assertEquals(state.terminationEvidence.has(attemptId), false);
  } finally {
    releaseHeartbeat.resolve();
    await Promise.allSettled(
      [execution, heartbeat].filter((task) => task !== undefined),
    );
    await Deno.remove(directory, { recursive: true });
  }
});
