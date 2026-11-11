import { assert, assertEquals, assertRejects } from "@std/assert";
import { MAX_TERMINATION_EVIDENCE } from "../../apps/worker/src/control-state.ts";
import type { ExecutionOutcome } from "../../apps/worker/src/executor.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import { RegistrationStore } from "../../apps/worker/src/registration-store.ts";
import {
  WorkerSupervisor as ProductionWorkerSupervisor,
} from "../../apps/worker/src/supervisor.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import type { Sleep } from "../../apps/worker/src/supervisor-support.ts";
import {
  ackResponse,
  fastSleep,
  heartbeatResponse,
  legacyLeaseRenewalResponse,
  localAssignment,
  nonmodelAssignment,
  observeRun,
  protocolEmptyResponse,
  protocolResponse,
  RecoveryWorkerApiClient,
  supervisorConfig,
  waitForCondition,
} from "../helpers/worker-execution/recovery-support.ts";
import {
  reconcileServerTruth,
  recoverReleaseMarkers,
} from "../../apps/worker/src/supervisor-recovery.ts";
Deno.test(
  "legacy lease adapter preserves non-2xx responses",
  async () => {
    const assignment = localAssignment();
    const body = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      leaseSeconds: 45,
      workerSessionId: assignment.workerSessionId ?? crypto.randomUUID(),
      workerSessionGeneration: assignment.workerSessionGeneration ?? "1",
    };
    let requestCount = 0;
    const client = new RecoveryWorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: () => {
        requestCount += 1;
        return Promise.resolve(
          requestCount === 1
            ? new Response(JSON.stringify({ code: "LEASE_REJECTED" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            })
            : legacyLeaseRenewalResponse({}, { status: 200 }),
        );
      },
    });

    await assertRejects(
      () =>
        client.renewLease(
          assignment.attemptId,
          body,
          undefined,
          crypto.randomUUID(),
        ),
      WorkerRequestError,
    );
    const response = await client.renewLease(
      assignment.attemptId,
      body,
      undefined,
      crypto.randomUUID(),
    );
    assertEquals(response.value.attemptId, assignment.attemptId);
    assertEquals(response.value.fence, assignment.fence);
  },
);
Deno.test("recovery releases stale journals and preserves held replay-safe work", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-release-recovery-",
  });
  try {
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const staleAttemptId = crypto.randomUUID();
    const heldAttemptId = crypto.randomUUID();
    const canceledAttemptId = crypto.randomUUID();
    const assignment = {
      leaseToken: "lease-token",
      fence: "1",
    };
    await registrationStore.saveRegistered("credential", {
      workerHostId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    await registrationStore.saveReleaseMarker(
      staleAttemptId,
      "WORKER_STOP",
    );
    await registrationStore.saveReleaseMarker(
      heldAttemptId,
      "HEARTBEAT_NOT_RECONCILED",
    );
    await registrationStore.saveReleaseMarker(
      canceledAttemptId,
      "HEARTBEAT_NOT_RECONCILED",
    );
    await spool.enqueueResult({
      attemptId: staleAttemptId,
      ...assignment,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "completed",
      result: { stale: true },
    });
    await spool.enqueueResult({
      attemptId: heldAttemptId,
      ...assignment,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "completed",
      result: { recovered: true },
    });
    await spool.enqueueResult({
      attemptId: canceledAttemptId,
      ...assignment,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "canceled",
      cancellation: { processExited: true },
    });
    const registration = await registrationStore.load();
    if (!registration) throw new Error("REGISTRATION_NOT_PERSISTED");
    const recovered = await recoverReleaseMarkers({
      registration,
      registrationStore,
      spool,
      active: new Map(),
      authorityFor: () => null,
      leaseDeadlineFor: () => 0,
    });
    assertEquals(
      recovered.releaseMarkers?.[heldAttemptId]?.reason,
      "HEARTBEAT_NOT_RECONCILED",
    );
    assertEquals(recovered.releaseMarkers?.[staleAttemptId], undefined);
    assertEquals(spool.attemptIds(), [heldAttemptId]);
    assertEquals(spool.hasReplaySafeRecord(heldAttemptId), true);
    assertEquals(spool.hasReplaySafeRecord(canceledAttemptId), false);
    assertEquals(recovered.releaseMarkers?.[canceledAttemptId], undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("recovery discards attempts absent from server truth", () => {
  assertEquals(
    reconcileServerTruth(
      ["admitted", "missing"],
      ["admitted", "orphan"],
      ["admitted", "foreign"],
    ),
    {
      discardedAttemptIds: ["missing", "orphan"],
    },
  );
});
type FetchPlan = {
  heartbeat: (count: number) => Response;
  /** Runs before the heartbeat response is returned, with the request body. */
  onHeartbeat?: (
    count: number,
    body: { activeAttemptIds?: string[] },
  ) => void | Promise<void>;
  /** Replaces the instant sleep, for tests that record wait durations. */
  sleep?: Sleep;
  onResult?: () => void;
  eventResponse?: (init?: RequestInit) => Response | Promise<Response>;
  resultResponse?: (init?: RequestInit) => Response | Promise<Response>;
  /** Receives the request's abort signal, for a response that never arrives. */
  claimResponse?: (signal?: AbortSignal) => Response | Promise<Response>;
};

type TestExecutor = {
  readonly supportedActions?: readonly string[];
  execute: (
    assignment: JobAssignment,
    signal: AbortSignal,
  ) => Promise<ExecutionOutcome>;
};

class DrainControlledSupervisor extends ProductionWorkerSupervisor {
  private runPublisherEnabled = true;
  private runLifecycleSignal: AbortSignal | undefined;
  drainFlushes = 0;

  disableRunPublisher(): void {
    this.runPublisherEnabled = false;
  }

  override async flushOnce(signal?: AbortSignal): Promise<boolean> {
    if (!this.isDraining) {
      this.runLifecycleSignal = signal;
      if (!this.runPublisherEnabled) return false;
      return await super.flushOnce(signal);
    }
    if (signal === this.runLifecycleSignal) return false;
    this.drainFlushes += 1;
    return await super.flushOnce(signal);
  }
}

/**
 * Fails a wait that never ends. The default covers a supervisor's start (its
 * registration and journal writes, behind one lock), which took more than the
 * 5 s it had on a loaded host; only a stuck start should reach it.
 */
async function waitForPromise<T>(
  promise: Promise<T>,
  code: string,
  timeoutMs = 30_000,
): Promise<T> {
  let timer = setTimeout(() => undefined, 0);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${code}_TIMEOUT`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A response that never arrives: the request fails only when it is aborted. */
function neverAnswered(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abort = () =>
      reject(new DOMException("The operation was aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function createSeededSupervisor(
  directory: string,
  assignment: JobAssignment | JobAssignment[],
  fetchPlan: FetchPlan,
  executor: TestExecutor,
  drainTimeoutMs: number,
  seedAssignment = true,
  seedNextLocalSeq = "3",
  seedAckedLocalSeq = "2",
) {
  const sourceAssignments = Array.isArray(assignment)
    ? assignment
    : [assignment];
  const workerHostId = sourceAssignments[0].workerHostId;
  const assignments = sourceAssignments.map((current) => ({
    ...current,
    workerHostId,
    workerSessionId: workerHostId,
    workerSessionGeneration: "1",
  }));
  const registrationStore = new RegistrationStore(
    `${directory}/registration.json`,
  );
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 20,
    maxBytes: 20_000,
  });
  if (seedAssignment) {
    await registrationStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: workerHostId,
      workerSessionGeneration: "1",
    });
    for (const current of assignments) {
      await registrationStore.saveActiveAssignment({
        assignment: current,
        nextLocalSeq: seedNextLocalSeq,
        ackedLocalSeq: seedAckedLocalSeq,
      });
    }
  }
  let claimCount = 0;
  let heartbeatCount = 0;
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    fetcher: (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/worker/heartbeat") {
        heartbeatCount += 1;
        const count = heartbeatCount;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          activeAttemptIds?: string[];
        };
        return Promise.resolve(fetchPlan.onHeartbeat?.(count, body)).then(() =>
          fetchPlan.heartbeat(count)
        );
      }
      if (pathname.endsWith("/lease-renewals")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          fence?: string;
        };
        return Promise.resolve(
          protocolResponse({
            attemptId: pathname.split("/").at(-2),
            fence: body.fence ?? "1",
            leaseExpiresAt: new Date(Date.now() + 45_000).toISOString(),
            status: "active",
            leaseDurationSeconds: 45,
            serverTime: new Date().toISOString(),
          }),
        );
      }
      if (pathname.endsWith("/events")) {
        fetchPlan.onResult?.();
        return Promise.resolve(
          fetchPlan.eventResponse?.(init) ?? ackResponse(init),
        );
      }
      if (
        assignments.some((current) =>
          pathname === `/v1/worker/attempts/${current.attemptId}/result`
        )
      ) {
        fetchPlan.onResult?.();
        return Promise.resolve(
          fetchPlan.resultResponse?.(init) ?? ackResponse(init),
        );
      }
      if (pathname === "/v1/worker/claims") {
        claimCount += 1;
        return Promise.resolve(
          fetchPlan.claimResponse?.(init?.signal ?? undefined) ??
            protocolEmptyResponse({ status: 204 }),
        );
      }
      return Promise.resolve(protocolEmptyResponse({ status: 204 }));
    },
  });
  const supervisor = new DrainControlledSupervisor({
    config: {
      ...supervisorConfig(directory),
      slots: assignments.length,
      drainTimeoutMs,
    },
    client,
    registrationStore,
    spool,
    executor,
    sleep: fetchPlan.sleep ?? fastSleep,
  });
  return {
    heartbeatCount: () => heartbeatCount,
    claimCount: () => claimCount,
    registrationStore,
    spool,
    supervisor,
  };
}

Deno.test("explicit unreconciled heartbeat rejects a running attempt", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-running-heartbeat-rejection-",
  });
  const assignment = localAssignment();
  let executeCalls = 0;
  let resultCalls = 0;
  try {
    const seeded = await createSeededSupervisor(
      directory,
      assignment,
      {
        heartbeat: (count) =>
          heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            assignment.workerHostId,
            "1",
            count === 1 || executeCalls === 0 ? [assignment.attemptId] : [],
          ),
        resultResponse: (init) => {
          resultCalls += 1;
          return ackResponse(init);
        },
      },
      {
        execute: async (_assignment, signal) => {
          executeCalls += 1;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            status: "canceled",
            cancellation: {
              processExited: false,
              cleanupStatus: "pending",
            },
          };
        },
      },
      // The budget is both the drain deadline and the time run() allows the
      // work left when it fires, which includes the drain's own release of the
      // aborted attempt. Those are fsynced writes behind one lock, and they
      // took seconds on a loaded host. The scenario does not depend on the
      // deadline: the attempt is already quarantined, so the drain ends when
      // its writes do.
      30_000,
      true,
      "2",
      "1",
    );
    const run = observeRun(seeded.supervisor.run());
    await waitForCondition(
      () => executeCalls === 1 || seeded.supervisor.fatalReason !== null,
      "RUNNING_EXECUTION",
    );
    assertEquals(seeded.supervisor.fatalReason, null);
    await waitForCondition(async () => {
      const registration = await seeded.registrationStore.load();
      return registration?.terminationEvidence?.[assignment.attemptId]
        ?.status === "unknown";
    }, "UNRECONCILED_TERMINATION_EVIDENCE");
    await seeded.supervisor.drain();
    await run;
    const registration = await seeded.registrationStore.load();
    assertEquals(
      registration?.activeAssignments?.[assignment.attemptId],
      undefined,
    );
    assertEquals(
      registration?.terminationEvidence?.[assignment.attemptId]?.status,
      "unknown",
    );
    assertEquals(resultCalls, 0);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test(
  "restart quarantines a started attempt after quarantine persistence fails",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-started-attempt-restart-",
    });
    const assignment = localAssignment();
    let executeCalls = 0;
    let quarantineFailures = 0;
    try {
      const seeded = await createSeededSupervisor(
        directory,
        assignment,
        {
          heartbeat: () =>
            heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              assignment.workerHostId,
              "1",
              [assignment.attemptId],
            ),
        },
        {
          execute: () => {
            executeCalls += 1;
            return Promise.resolve({
              status: "canceled" as const,
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            });
          },
        },
        100,
        true,
        "3",
        "2",
      );
      const saveTerminationEvidence = seeded.registrationStore
        .saveTerminationEvidence.bind(seeded.registrationStore);
      seeded.registrationStore.saveTerminationEvidence = async (
        attemptId,
        evidence,
      ) => {
        quarantineFailures += 1;
        if (quarantineFailures <= 2) {
          throw new Error("INJECTED_QUARANTINE_PERSISTENCE_FAILURE");
        }
        return await saveTerminationEvidence(attemptId, evidence);
      };

      await assertRejects(
        () =>
          seeded.registrationStore.saveTerminationEvidence(
            assignment.attemptId,
            {
              status: "unknown",
              observedAt: new Date().toISOString(),
            },
          ),
        Error,
      );
      assertEquals(
        (await seeded.registrationStore.load())?.terminationEvidence?.[
          assignment.attemptId
        ],
        undefined,
      );
      // nextLocalSeq past job.started is the durable marker left by a crashed
      // worker whose quarantine evidence write did not persist.
      const run = observeRun(seeded.supervisor.run());
      await waitForCondition(async () => {
        const registration = await seeded.registrationStore.load();
        return quarantineFailures >= 3 &&
          registration?.activeAssignments?.[assignment.attemptId] ===
            undefined;
      }, "STARTED_ATTEMPT_QUARANTINE_RECOVERY");
      await seeded.supervisor.drain();
      await run;

      const registration = await seeded.registrationStore.load();
      assertEquals(executeCalls, 0);
      assertEquals(
        registration?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );
      assertEquals(
        registration?.activeAssignments?.[assignment.attemptId],
        undefined,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "restart releases a started attempt as TERMINATION_UNKNOWN before its first heartbeat",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue428-release-before-heartbeat-",
    });
    const assignment = localAssignment();
    let executeCalls = 0;
    const firstBody: { activeAttemptIds?: string[] }[] = [];
    let atFirstHeartbeat: {
      evidenceStatus?: string;
      hasActiveAssignment: boolean;
    } | undefined;
    const ref: {
      seeded?: Awaited<ReturnType<typeof createSeededSupervisor>>;
    } = {};
    try {
      const seeded = await createSeededSupervisor(
        directory,
        assignment,
        {
          heartbeat: () =>
            heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              assignment.workerHostId,
              "1",
              [],
            ),
          onHeartbeat: async (count, body) => {
            if (count !== 1) return;
            firstBody.push(body);
            const registration = await ref.seeded?.registrationStore.load();
            atFirstHeartbeat = {
              evidenceStatus: registration?.terminationEvidence
                ?.[assignment.attemptId]
                ?.status,
              hasActiveAssignment:
                registration?.activeAssignments?.[assignment.attemptId] !==
                  undefined,
            };
            ref.seeded?.supervisor.requestStop("TEST_COMPLETE");
          },
        },
        {
          execute: () => {
            executeCalls += 1;
            return Promise.reject(new Error("MUST_NOT_EXECUTE"));
          },
        },
        100,
        true,
        "3",
        "2",
      );
      ref.seeded = seeded;
      await seeded.supervisor.run();

      assertEquals(firstBody.length, 1);
      assertEquals(
        firstBody[0].activeAttemptIds?.includes(assignment.attemptId),
        false,
      );
      assertEquals(atFirstHeartbeat, {
        evidenceStatus: "unknown",
        hasActiveAssignment: false,
      });
      assertEquals(executeCalls, 0);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "a restored pending heartbeat listing a released attempt is followed by an immediate heartbeat",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue428-stale-pending-heartbeat-",
    });
    const assignment = localAssignment();
    const bodies: { activeAttemptIds?: string[] }[] = [];
    const sleeps: number[] = [];
    let sleepsBeforeSecondHeartbeat: number[] = [];
    const ref: {
      seeded?: Awaited<ReturnType<typeof createSeededSupervisor>>;
    } = {};
    try {
      const seeded = await createSeededSupervisor(
        directory,
        assignment,
        {
          heartbeat: () =>
            heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              assignment.workerHostId,
              "1",
              [],
            ),
          onHeartbeat: (count, body) => {
            bodies.push(body);
            if (count === 2) {
              sleepsBeforeSecondHeartbeat = [...sleeps];
              ref.seeded?.supervisor.requestStop("TEST_COMPLETE");
            }
          },
          sleep: (milliseconds, signal) => {
            sleeps.push(milliseconds);
            return fastSleep(milliseconds, signal);
          },
        },
        {
          execute: () => Promise.reject(new Error("MUST_NOT_EXECUTE")),
        },
        100,
        true,
        "3",
        "2",
      );
      ref.seeded = seeded;
      // The killed process left a pending heartbeat the server never committed.
      await seeded.registrationStore.savePendingHeartbeat({
        idempotencyKey: crypto.randomUUID(),
        body: {
          workerHostId: assignment.workerHostId,
          observedAt: new Date().toISOString(),
          load: 1,
          activeAttemptIds: [assignment.attemptId],
          workerSessionId: assignment.workerHostId,
          workerSessionGeneration: "2",
          ackCommandIds: [],
          rejectedCommandIds: [],
        },
      });
      await seeded.supervisor.run();

      assertEquals(bodies.length >= 2, true);
      // The stale body is replayed unchanged, then a fresh body follows at once.
      assertEquals(bodies[0].activeAttemptIds, [assignment.attemptId]);
      assertEquals(
        bodies[1].activeAttemptIds?.includes(assignment.attemptId),
        false,
      );
      assertEquals(sleepsBeforeSecondHeartbeat.includes(0), true);
      assertEquals(
        sleepsBeforeSecondHeartbeat.includes(
          supervisorConfig(directory).heartbeatIntervalMs,
        ),
        false,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "aborted executor rejection remains quarantined across restart",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-clean-quiescence-restart-",
    });
    const assignment = localAssignment();
    const executorStarted = Promise.withResolvers<void>();
    const fetchPlan = {
      heartbeat: () =>
        heartbeatResponse(
          assignment.workerHostId,
          [],
          [],
          assignment.workerHostId,
          "1",
          [assignment.attemptId],
        ),
    };
    const first = await createSeededSupervisor(
      directory,
      assignment,
      fetchPlan,
      {
        execute: (_assignment, signal) => {
          executorStarted.resolve();
          return new Promise<ExecutionOutcome>((_resolve, reject) => {
            const rejectCanceled = () => reject(new Error("EXECUTOR_ABORTED"));
            if (signal.aborted) {
              rejectCanceled();
            } else {
              signal.addEventListener("abort", rejectCanceled, { once: true });
            }
          });
        },
      },
      1_000,
      true,
      "2",
      "1",
    );
    let firstRun: Promise<void> | undefined;
    let restarted: {
      registrationStore: RegistrationStore;
      supervisor: ProductionWorkerSupervisor;
    } | null = null;
    let restartedRun: Promise<void> | undefined;
    let resumedExecutions = 0;
    try {
      firstRun = observeRun(first.supervisor.run());
      await waitForPromise(executorStarted.promise, "CLEAN_QUIESCENCE_START");
      assertEquals(
        (await first.registrationStore.load())?.activeAssignments?.[
          assignment.attemptId
        ]?.cleanQuiescence,
        undefined,
      );
      first.supervisor.requestStop("TEST_CLEAN_QUIESCENCE");
      await firstRun;
      firstRun = undefined;
      assertEquals(first.supervisor.fatalReason, null);
      assertEquals(
        (await first.registrationStore.load())?.activeAssignments?.[
          assignment.attemptId
        ]?.cleanQuiescence,
        undefined,
      );

      restarted = await createSeededSupervisor(
        directory,
        assignment,
        fetchPlan,
        {
          execute: () => {
            resumedExecutions += 1;
            return Promise.resolve({
              status: "canceled" as const,
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            });
          },
        },
        1_000,
        false,
      );
      restartedRun = observeRun(restarted.supervisor.run());
      await waitForCondition(
        async () => {
          const registration = await restarted!.registrationStore.load();
          // Evidence is persisted before release completes. Observe retirement,
          // not the intermediate quarantine write, before checking final state.
          return registration?.terminationEvidence?.[assignment.attemptId]
                ?.status === "unknown" &&
            registration?.activeAssignments?.[assignment.attemptId] ===
              undefined;
        },
        "UNPROVEN_TERMINATION_QUARANTINE",
      );
      const recovered = await restarted.registrationStore.load();
      assertEquals(
        recovered?.activeAssignments?.[assignment.attemptId],
        undefined,
      );
      assertEquals(resumedExecutions, 0);
      restarted.supervisor.requestStop("TEST_NO_RESUME");
      await restartedRun;
      restartedRun = undefined;
      assertEquals(restarted.supervisor.fatalReason, null);
      assertEquals(
        (await restarted.registrationStore.load())?.activeAssignments?.[
          assignment.attemptId
        ],
        undefined,
      );
    } finally {
      first.supervisor.requestStop("TEST_CLEANUP");
      await firstRun?.catch(() => undefined);
      if (restarted) {
        restarted.supervisor.requestStop("TEST_CLEANUP");
        await restartedRun?.catch(() => undefined);
      }
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "explicit termination proof permits clean quiescence marker",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-proven-clean-quiescence-",
    });
    const assignment = localAssignment();
    const executorStarted = Promise.withResolvers<void>();
    const fetchPlan = {
      heartbeat: () =>
        heartbeatResponse(
          assignment.workerHostId,
          [],
          [],
          assignment.workerHostId,
          "1",
          [assignment.attemptId],
        ),
    };
    const first = await createSeededSupervisor(
      directory,
      assignment,
      fetchPlan,
      {
        execute: (_assignment, signal) => {
          executorStarted.resolve();
          return new Promise<ExecutionOutcome>((resolve) => {
            const finish = () =>
              resolve({
                status: "canceled",
                cancellation: {
                  processExited: true,
                  cleanupStatus: "complete",
                  terminationStatus: "confirmed",
                  exitedAt: new Date().toISOString(),
                },
              });
            if (signal.aborted) {
              finish();
            } else {
              signal.addEventListener("abort", finish, { once: true });
            }
          });
        },
      },
      1_000,
      true,
      "2",
      "1",
    );
    let run: Promise<void> | undefined;
    try {
      run = observeRun(first.supervisor.run());
      await waitForPromise(executorStarted.promise, "PROVEN_CLEAN_START");
      first.supervisor.requestStop("TEST_PROVEN_CLEAN");
      await run;
      run = undefined;
      const registration = await first.registrationStore.load();
      assertEquals(
        registration?.activeAssignments?.[assignment.attemptId]
          ?.cleanQuiescence,
        true,
      );
      assertEquals(
        registration?.terminationEvidence?.[assignment.attemptId],
        undefined,
      );
    } finally {
      first.supervisor.requestStop("TEST_CLEANUP");
      await run?.catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "settled completion during drain is quarantined across restart",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-drain-settled-outcome-",
    });
    const assignment = localAssignment();
    const executorStarted = Promise.withResolvers<void>();
    const drainObserved = Promise.withResolvers<void>();
    const completeEffect = Promise.withResolvers<void>();
    let executions = 0;
    let completedEffects = 0;
    const fetchPlan = {
      heartbeat: () =>
        heartbeatResponse(
          assignment.workerHostId,
          [],
          [],
          assignment.workerHostId,
          "1",
          [assignment.attemptId],
        ),
    };
    const first = await createSeededSupervisor(
      directory,
      assignment,
      fetchPlan,
      {
        execute: async (_assignment, signal) => {
          executions += 1;
          executorStarted.resolve();
          if (signal.aborted) {
            drainObserved.resolve();
          } else {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
            drainObserved.resolve();
          }
          await completeEffect.promise;
          completedEffects += 1;
          return {
            status: "completed",
            result: {
              headSha: "head",
              baseSha: "base",
              sessionId: "session",
              artifacts: [],
            },
          };
        },
      },
      // The budget is both the drain deadline and the time run() allows the
      // work left when it fires. The settled completion is persisted by
      // fsynced writes behind one lock, which outlasted 2 s on a loaded host
      // (the evidence-capacity variant, once in 20 whole-file runs under 6 CPU
      // hogs) and with every fsync delayed by 250 to 500 ms. The scenario does
      // not depend on the deadline: the effect completes right after the
      // drain starts.
      30_000,
      true,
      "2",
      "1",
    );
    let firstRun: Promise<void> | undefined;
    let firstDrain: Promise<void> | undefined;
    let restarted: {
      claimCount: () => number;
      registrationStore: RegistrationStore;
      supervisor: DrainControlledSupervisor;
    } | null = null;
    let restartedRun: Promise<void> | undefined;
    let restartedExecutions = 0;
    try {
      firstRun = observeRun(first.supervisor.run());
      await waitForPromise(
        executorStarted.promise,
        "SETTLED_OUTCOME_EXECUTOR_START",
      );
      firstDrain = first.supervisor.drain();
      await waitForPromise(
        drainObserved.promise,
        "SETTLED_OUTCOME_DRAIN_START",
      );
      assertEquals(completedEffects, 0);
      completeEffect.resolve();
      await firstDrain;
      firstDrain = undefined;
      await firstRun;
      firstRun = undefined;
      assertEquals(completedEffects, 1);

      const registration = await first.registrationStore.load();
      assertEquals(executions, 1);
      assertEquals(
        registration?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );
      assertEquals(
        registration?.activeAssignments?.[assignment.attemptId],
        undefined,
      );
      assertEquals(first.spool.attemptIds(), []);

      restarted = await createSeededSupervisor(
        directory,
        assignment,
        fetchPlan,
        {
          execute: () => {
            restartedExecutions += 1;
            return Promise.resolve({
              status: "canceled",
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            });
          },
        },
        1_000,
        false,
      );
      restartedRun = observeRun(restarted.supervisor.run());
      await waitForCondition(
        () => restarted!.claimCount() > 0,
        "SETTLED_OUTCOME_RESTART_READY",
      );
      restarted.supervisor.requestStop("TEST_SETTLED_OUTCOME_RECOVERED");
      await restartedRun;
      restartedRun = undefined;

      const recovered = await restarted.registrationStore.load();
      assertEquals(restartedExecutions, 0);
      assertEquals(
        recovered?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );
      assertEquals(
        recovered?.activeAssignments?.[assignment.attemptId],
        undefined,
      );
    } finally {
      completeEffect.resolve();
      first.supervisor.requestStop("TEST_CLEANUP");
      await firstDrain?.catch(() => undefined);
      await firstRun?.catch(() => undefined);
      if (restarted) {
        restarted.supervisor.requestStop("TEST_CLEANUP");
        await restartedRun?.catch(() => undefined);
      }
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "settled completion at termination evidence capacity cannot resume after restart",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-drain-evidence-capacity-",
    });
    const assignment = localAssignment();
    const executorStarted = Promise.withResolvers<void>();
    const drainObserved = Promise.withResolvers<void>();
    const completeEffect = Promise.withResolvers<void>();
    const evidenceAttemptIds = Array.from(
      { length: MAX_TERMINATION_EVIDENCE },
      () => crypto.randomUUID(),
    );
    let executions = 0;
    let completedEffects = 0;
    const fetchPlan = {
      heartbeat: () =>
        heartbeatResponse(
          assignment.workerHostId,
          [],
          [],
          assignment.workerHostId,
          "1",
          [assignment.attemptId],
        ),
    };
    const first = await createSeededSupervisor(
      directory,
      assignment,
      fetchPlan,
      {
        execute: async (_assignment, signal) => {
          executions += 1;
          executorStarted.resolve();
          if (signal.aborted) {
            drainObserved.resolve();
          } else {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
            drainObserved.resolve();
          }
          await completeEffect.promise;
          completedEffects += 1;
          return {
            status: "completed",
            result: {
              headSha: "head",
              baseSha: "base",
              sessionId: "session",
              artifacts: [],
            },
          };
        },
      },
      // The budget is both the drain deadline and the time run() allows the
      // work left when it fires. The settled completion is persisted by
      // fsynced writes behind one lock, which outlasted 2 s on a loaded host
      // (the evidence-capacity variant, once in 20 whole-file runs under 6 CPU
      // hogs) and with every fsync delayed by 250 to 500 ms. The scenario does
      // not depend on the deadline: the effect completes right after the
      // drain starts.
      30_000,
      true,
      "2",
      "1",
    );
    let firstRun: Promise<void> | undefined;
    let firstDrain: Promise<void> | undefined;
    let restarted: {
      claimCount: () => number;
      registrationStore: RegistrationStore;
      supervisor: DrainControlledSupervisor;
    } | null = null;
    let restartedRun: Promise<void> | undefined;
    let restartedExecutions = 0;
    try {
      firstRun = observeRun(first.supervisor.run());
      await waitForPromise(
        executorStarted.promise,
        "EVIDENCE_CAPACITY_EXECUTOR_START",
      );
      for (const attemptId of evidenceAttemptIds) {
        await first.registrationStore.saveTerminationEvidence(attemptId, {
          status: "unknown",
          observedAt: new Date().toISOString(),
        });
      }

      firstDrain = first.supervisor.drain();
      await waitForPromise(
        drainObserved.promise,
        "EVIDENCE_CAPACITY_DRAIN_START",
      );
      completeEffect.resolve();
      await firstDrain;
      firstDrain = undefined;
      await firstRun;
      firstRun = undefined;

      const quarantined = await first.registrationStore.load();
      assertEquals(executions, 1);
      assertEquals(completedEffects, 1);
      assertEquals(
        Object.keys(quarantined?.terminationEvidence ?? {}).length,
        MAX_TERMINATION_EVIDENCE,
      );
      assertEquals(
        quarantined?.terminationEvidence?.[assignment.attemptId],
        undefined,
      );
      assertEquals(
        quarantined?.activeAssignments?.[assignment.attemptId]?.cleanQuiescence,
        undefined,
      );
      assertEquals(
        quarantined?.activeAssignments?.[assignment.attemptId] !== undefined,
        true,
      );
      assertEquals(quarantined?.capacityPaused, true);

      for (const attemptId of evidenceAttemptIds) {
        await first.registrationStore.clearTerminationEvidence(attemptId);
      }
      assertEquals(
        (await first.registrationStore.load())?.capacityPaused,
        false,
      );

      restarted = await createSeededSupervisor(
        directory,
        assignment,
        fetchPlan,
        {
          execute: () => {
            restartedExecutions += 1;
            return Promise.resolve({
              status: "canceled",
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            });
          },
        },
        1_000,
        false,
      );
      restartedRun = observeRun(restarted.supervisor.run());
      await waitForCondition(
        () => restarted!.claimCount() > 0,
        "EVIDENCE_CAPACITY_RESTART_READY",
      );
      restarted.supervisor.requestStop("TEST_EVIDENCE_CAPACITY_RECOVERED");
      await restartedRun;
      restartedRun = undefined;

      const recovered = await restarted.registrationStore.load();
      assertEquals(restartedExecutions, 0);
      assertEquals(
        recovered?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );
      assertEquals(
        recovered?.activeAssignments?.[assignment.attemptId],
        undefined,
      );
    } finally {
      completeEffect.resolve();
      first.supervisor.requestStop("TEST_CLEANUP");
      await firstDrain?.catch(() => undefined);
      await firstRun?.catch(() => undefined);
      if (restarted) {
        restarted.supervisor.requestStop("TEST_CLEANUP");
        await restartedRun?.catch(() => undefined);
      }
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "drain quarantines every unsettled attempt before nonretryable flush stop",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-drain-error-quarantine-",
    });
    const assignments = [nonmodelAssignment(), nonmodelAssignment()];
    // The drain must end long before its deadline: the bound is a quarter of
    // it. The deadline is far enough away that the drain's fsynced writes,
    // which took seconds on a loaded host, still fit well inside the bound.
    const drainTimeoutMs = 60_000;
    const earlyExitBoundMs = drainTimeoutMs / 4;
    let executeCalls = 0;
    let reopenedExecuteCalls = 0;
    let holdMalformedPublication = false;
    let drainRequested = false;
    const drainEntered = Promise.withResolvers<void>();
    const secondPublication = Promise.withResolvers<void>();
    const malformedAck = Promise.withResolvers<void>();
    const releaseExecutions: Array<() => void> = [];
    try {
      const seeded = await createSeededSupervisor(
        directory,
        assignments,
        {
          heartbeat: () => {
            if (drainRequested) drainEntered.resolve();
            return heartbeatResponse(
              assignments[0].workerHostId,
              [],
              [],
              assignments[0].workerHostId,
              "1",
              assignments.map((current) => current.attemptId),
            );
          },
          eventResponse: async (init) => {
            if (holdMalformedPublication) {
              await waitForPromise(drainEntered.promise, "DRAIN_HEARTBEAT");
              holdMalformedPublication = false;
              secondPublication.resolve();
              await waitForPromise(malformedAck.promise, "MALFORMED_ACK");
              return protocolResponse({}, { status: 200 });
            }
            return ackResponse(init);
          },
        },
        {
          supportedActions: ["quality.check"],
          execute: async () => {
            executeCalls += 1;
            await new Promise<void>((resolve) => {
              releaseExecutions.push(resolve);
            });
            return {
              status: "canceled",
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            };
          },
        },
        drainTimeoutMs,
        true,
        "1",
        "0",
      );
      const run = observeRun(seeded.supervisor.run());
      await waitForCondition(
        () => executeCalls === 2 || seeded.supervisor.fatalReason !== null,
        "RUNNING_EXECUTIONS",
      );
      assertEquals(seeded.supervisor.fatalReason, null);
      seeded.supervisor.disableRunPublisher();
      drainRequested = true;
      const drainStartedAt = performance.now();
      const drain = seeded.supervisor.drain();
      await waitForPromise(drainEntered.promise, "DRAIN_HEARTBEAT");
      holdMalformedPublication = true;
      await seeded.spool.enqueueEvent({
        attemptId: assignments[1].attemptId,
        leaseToken: assignments[1].leaseToken,
        fence: assignments[1].fence,
        localSeq: "3",
        eventId: crypto.randomUUID(),
        eventType: "test.pending",
        payload: {},
      });
      await waitForPromise(secondPublication.promise, "DRAIN_PUBLICATION");
      malformedAck.resolve();
      await waitForPromise(
        drain,
        "DRAIN_NONRETRYABLE_EXIT",
        drainTimeoutMs * 2,
      );
      const drainElapsedMs = performance.now() - drainStartedAt;
      assert(drainElapsedMs < earlyExitBoundMs);
      assertEquals(seeded.supervisor.drainFlushes > 0, true);
      assertEquals(seeded.supervisor.fatalReason, null);
      for (const release of releaseExecutions) release();
      await run;
      const afterDrain = await seeded.registrationStore.load();
      assertEquals(seeded.spool.records(), []);
      for (const assignment of assignments) {
        assertEquals(
          afterDrain?.activeAssignments?.[assignment.attemptId],
          undefined,
        );
        assertEquals(
          afterDrain?.terminationEvidence?.[assignment.attemptId]?.status,
          "unknown",
        );
      }

      // The first claim answers with a quarantined attempt, which the reopened
      // supervisor commits and releases unexecuted. The second never answers, so
      // the drain starts with that first claim's registration writes finished
      // and only a request its deadline aborts in flight. A drain that lands
      // mid-write leaves the 25 ms quiescence budget racing those fsyncs.
      let reopenedClaims = 0;
      const reopened = await createSeededSupervisor(
        directory,
        assignments,
        {
          heartbeat: () =>
            heartbeatResponse(
              assignments[0].workerHostId,
              [],
              [],
              assignments[0].workerHostId,
              "1",
              assignments.map((current) => current.attemptId),
            ),
          claimResponse: (signal) => {
            reopenedClaims += 1;
            return reopenedClaims === 1
              ? protocolResponse(assignments[0])
              : neverAnswered(signal);
          },
        },
        {
          supportedActions: ["quality.check"],
          execute: () => {
            reopenedExecuteCalls += 1;
            return Promise.reject(new Error("REOPENED_EXECUTION"));
          },
        },
        25,
        false,
      );
      const reopenedRun = observeRun(reopened.supervisor.run());
      await waitForCondition(
        () => reopened.heartbeatCount() >= 1 && reopened.claimCount() >= 2,
        "REOPENED_ADMISSION",
      );
      await reopened.supervisor.drain();
      await reopenedRun;

      const reopenedRegistration = await reopened.registrationStore.load();
      for (const assignment of assignments) {
        assertEquals(
          reopenedRegistration?.activeAssignments?.[assignment.attemptId],
          undefined,
        );
        assert(
          reopenedRegistration?.terminationEvidence?.[assignment.attemptId],
        );
      }
      assertEquals(reopenedExecuteCalls, 0);
    } finally {
      for (const release of releaseExecutions) release();
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "standalone event replay preserves durable progress for normal restart",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-standalone-event-replay-",
    });
    const assignment = localAssignment();
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    try {
      await registrationStore.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      await registrationStore.saveActiveAssignment({
        assignment,
        nextLocalSeq: "2",
        ackedLocalSeq: "0",
      });
      await spool.enqueueEvent({
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        eventId: crypto.randomUUID(),
        eventType: "job.accepted",
        payload: { acceptedAt: new Date().toISOString() },
      });

      const replayClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
      });
      const replaySupervisor = new ProductionWorkerSupervisor({
        config: supervisorConfig(directory),
        client: replayClient,
        registrationStore,
        spool,
        sleep: fastSleep,
      });
      assertEquals(await replaySupervisor.replayStandalone(), true);
      assertEquals(
        (await registrationStore.load())?.activeAssignments?.[
          assignment.attemptId
        ],
        {
          assignment,
          nextLocalSeq: "2",
          ackedLocalSeq: "1",
        },
      );
      assertEquals(spool.records(), []);
      assertEquals(
        (await registrationStore.load())?.workerHostId,
        assignment.workerHostId,
      );
      assertEquals(spool.journalState(assignment.attemptId), {
        nextLocalSeq: "2",
        ackedLocalSeq: "1",
      });

      let restartExecutions = 0;
      const restartClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (input, init) => {
          const pathname = new URL(String(input)).pathname;
          if (pathname === "/v1/worker/heartbeat") {
            return Promise.resolve(
              heartbeatResponse(
                assignment.workerHostId,
                [],
                [],
                assignment.workerHostId,
                "1",
                [assignment.attemptId],
              ),
            );
          }
          if (pathname.endsWith("/lease-renewals")) {
            return Promise.resolve(
              protocolResponse({
                attemptId: assignment.attemptId,
                fence: assignment.fence,
                leaseExpiresAt: new Date(Date.now() + 45_000).toISOString(),
                status: "active",
                leaseDurationSeconds: 45,
                serverTime: new Date().toISOString(),
              }),
            );
          }
          if (
            pathname.endsWith("/events") ||
            pathname.endsWith("/result")
          ) {
            return Promise.resolve(ackResponse(init));
          }
          if (pathname === "/v1/worker/claims") {
            return Promise.resolve(protocolEmptyResponse({ status: 204 }));
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const restartedSpool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      const restarted = new ProductionWorkerSupervisor({
        config: supervisorConfig(directory),
        client: restartClient,
        registrationStore: new RegistrationStore(
          `${directory}/registration.json`,
        ),
        spool: restartedSpool,
        executor: {
          supportedActions: ["harness.implement"],
          execute: () => {
            restartExecutions += 1;
            queueMicrotask(() => restarted.requestStop("TEST_COMPLETE"));
            return Promise.resolve({
              status: "canceled",
              cancellation: {
                processExited: false,
                cleanupStatus: "pending",
              },
            });
          },
        },

        sleep: fastSleep,
      });
      await restarted.run();
      assertEquals(restarted.fatalReason, null);
      assertEquals(restartExecutions, 1);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test(
  "standalone replay rejects an active supervisor lifecycle",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-standalone-lifecycle-",
    });
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await registrationStore.saveRegistered("credential", {
      workerHostId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    let heartbeatCount = 0;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (input, _init) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/v1/worker/heartbeat") {
          heartbeatCount += 1;
          return Promise.resolve(
            heartbeatResponse(crypto.randomUUID(), [], [], crypto.randomUUID()),
          );
        }
        if (pathname === "/v1/worker/claims") {
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        }
        return Promise.resolve(protocolEmptyResponse({ status: 204 }));
      },
    });
    const supervisor = new ProductionWorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore,
      spool,
      sleep: fastSleep,
    });
    try {
      const run = observeRun(supervisor.run());
      await waitForCondition(() => heartbeatCount >= 1, "ACTIVE_HEARTBEAT");
      await assertRejects(
        () => supervisor.replayStandalone(),
        Error,
        "WORKER_REPLAY_LIFECYCLE_ACTIVE",
      );
      supervisor.requestStop("TEST_COMPLETE");
      await run;
    } finally {
      supervisor.requestStop("TEST_CLEANUP");
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test(
  "standalone replay reserves lifecycle before run",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-standalone-replay-reservation-",
    });
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const workerHostId = crypto.randomUUID();
    await registrationStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const supervisor = new ProductionWorkerSupervisor({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: () => Promise.resolve(protocolEmptyResponse({ status: 204 })),
      }),
      registrationStore,
      spool,
      sleep: fastSleep,
    });
    try {
      const replay = supervisor.replayStandalone();
      await assertRejects(
        () => supervisor.run(),
        Error,
        "WORKER_REPLAY_LIFECYCLE_ACTIVE",
      );
      assertEquals(await replay, false);
      assertEquals(
        (await registrationStore.load())?.workerHostId,
        workerHostId,
      );
    } finally {
      supervisor.requestStop("TEST_CLEANUP");
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
