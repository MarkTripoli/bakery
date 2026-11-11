import {
  checkOutput,
  observation,
} from "../deterministic-checks/observations.ts";
import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  assertRejects,
  assertThrows,
  EventSpool,
  WorkerApiClient,
  WorkerRequestError,
  WorkerSupervisor,
  RegistrationStore,
  ackResponse,
  legacyLeaseRenewalResponse,
  fastSleep,
  localAssignment,
  nonmodelAssignment,
  heartbeatResponse,
  observeRun,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
  createDeterministicExecutor,
} = issue39;
const assert: typeof issue39.assert = issue39.assert;
type WorkerSupervisor = issue39.WorkerSupervisorInstance;

// Cases are imported from the issue entrypoint.
Deno.test("restored assignments absent from heartbeat reconciliation are released", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-reconcile-release-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "2",
      ackedLocalSeq: "1",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await spool.restoreJournalState(assignment.attemptId, "2", "1");
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          queueMicrotask(() => supervisor?.requestStop("TEST_COMPLETE"));
          return Promise.resolve(protocolResponse({
            workerHostId: assignment.workerHostId,
            status: "accepted",
            receivedAt: new Date().toISOString(),
            pendingCommands: [],
            commandAcks: [],
            workerSessionId: crypto.randomUUID(),
            workerSessionGeneration: "2",
            serverTime: new Date().toISOString(),
            inventoryRevision: 1,
          }));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: fastSleep,
    });
    await supervisor.run();
    const state = await store.load();
    assertEquals(state?.activeAssignments, undefined);
    assertEquals(state?.releaseMarkers, undefined);
    assertEquals(spool.attemptIds(), []);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("restart restores an empty journal and resumes at the next sequence", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-restart-resume-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
      cleanQuiescence: true,
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    const supervisorRef: { current?: WorkerSupervisor } = {};
    let heartbeatBody: { activeAttemptIds?: string[] } | undefined;
    let resultBody: Record<string, unknown> | undefined;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          heartbeatBody = JSON.parse(String(init?.body)) as {
            activeAttemptIds?: string[];
          };
          return Promise.resolve(heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            assignment.workerSessionId,
            assignment.workerSessionGeneration,
            [assignment.attemptId],
          ));
        }
        if (path.endsWith("/result")) {
          resultBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(ackResponse(init));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () =>
          Promise.resolve({
            status: "completed",
            result: {
              headSha: "head",
              baseSha: "base",
              sessionId: assignment.attemptId,
              artifacts: [],
            },
          }),
      },
      sleep: fastSleep,
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(heartbeatBody?.activeAttemptIds, [assignment.attemptId]);
    assertEquals(resultBody?.localSeq, "3");
    assertEquals(await spool.records(), []);
    assertEquals((await store.load())?.activeAssignments, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("deterministic executor advertises only evidence-safe actions", async () => {
  const executor = createDeterministicExecutor();
  assertEquals(executor.supportedActions, ["harness.implement"]);
  const assignment = localAssignment();
  const outcome = await executor.execute(
    assignment,
    new AbortController().signal,
  );
  assertEquals(outcome.status, "failed");
  if (outcome.status === "failed") {
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "DETERMINISTIC_EVIDENCE_UNAVAILABLE",
    );
  }
  assertThrows(
    () =>
      executor.execute(
        { ...assignment, action: "quality.check" },
        new AbortController().signal,
      ),
    Error,
    "WORKER_ACTION_UNSUPPORTED:quality.check",
  );
});
Deno.test("host mismatch and persistence failures enter fatal bounded shutdown", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-fatal-" });
  try {
    const store = new RegistrationStore(`${directory}/registration.json`);
    const workerHostId = crypto.randomUUID();
    await store.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const assignment = nonmodelAssignment();
    assignment.workerHostId = crypto.randomUUID();
    const mismatchClient = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(heartbeatResponse(workerHostId));
        }
        if (path.endsWith("/claims")) {
          return Promise.resolve(protocolResponse(assignment));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const mismatch = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client: mismatchClient,
      registrationStore: store,
      spool,
      executor: {
        supportedActions: ["quality.check"],
        execute: () =>
          Promise.reject(new Error("HOST_MISMATCH_MUST_NOT_EXECUTE")),
      },
      sleep: fastSleep,
    });
    await mismatch.run();
    assertEquals(mismatch.fatalReason, "ASSIGNMENT_HOST_MISMATCH");

    const persistencePath = `${directory}/persistence-registration.json`;
    const persistenceStore = new RegistrationStore(persistencePath);
    await persistenceStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    let firstPersistenceHeartbeat = true;
    const persistenceClient = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          if (firstPersistenceHeartbeat) {
            firstPersistenceHeartbeat = false;
            await Deno.remove(persistencePath);
            await Deno.mkdir(persistencePath);
          }
          return heartbeatResponse(workerHostId);
        }
        return protocolEmptyResponse({ status: 204 });
      },
    });
    const persistence = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client: persistenceClient,
      registrationStore: persistenceStore,
      spool: await EventSpool.open({
        path: `${directory}/persistence-spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      }),
      executor: createDeterministicExecutor(),
      sleep: fastSleep,
    });
    await persistence.run();
    assertEquals(persistence.fatalReason !== null, true);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("lease validity ignores a skewed host wall clock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-clock-skew-" });
  const originalDateNow = Date.now;
  try {
    Date.now = () => Date.parse("2100-01-01T00:00:00.000Z");
    const assignment = nonmodelAssignment("2099-01-01T00:00:45.000Z");
    assignment.serverTime = "2099-01-01T00:00:00.000Z";
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            assignment.workerSessionId,
            assignment.workerSessionGeneration,
            [assignment.attemptId],
          ));
        }
        if (path.endsWith("/claims")) {
          return Promise.resolve(protocolResponse(assignment));
        }
        if (path.endsWith("/events")) {
          return Promise.resolve(ackResponse(init));
        }
        if (path.endsWith("/lease-renewals")) {
          return Promise.resolve(protocolResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: "2099-01-01T00:00:45.000Z",
            leaseDurationSeconds: 45,
            serverTime: "2099-01-01T00:00:00.000Z",
          }));
        }
        if (path.endsWith("/result")) {
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(ackResponse(init));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () =>
          Promise.resolve({
            status: "completed",
            // Mocked transport result: this case proves lease timing, not check execution.
            result: checkOutput([
              observation({ checkRunId: assignment.attemptId }),
            ], {
              headSha: "head",
              baseSha: "base",
              policyDigest: "a".repeat(64),
            }),
          }),
        supportedActions: ["quality.check"],
      },
      sleep: async (_milliseconds, signal) => {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      },
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(supervisor.stopReason, "TEST_COMPLETE");
    assertEquals(await spool.records(), []);
  } finally {
    Date.now = originalDateNow;
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("request deadlines retry the same persisted claim key", async () => {
  const claimKey = crypto.randomUUID();
  const workerHostId = crypto.randomUUID();
  const sessionFields = {
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  };
  const seenKeys: string[] = [];
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    requestTimeoutMs: 5,
    fetcher: (_input, init) => {
      seenKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const body = {
    claimKey,
    workerHostId,
    capabilities: ["git"],
    ...sessionFields,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertRejects(
      () => client.claim(body),
      WorkerRequestError,
      "WORKER_REQUEST_DEADLINE",
    );
  }
  assertEquals(seenKeys, [claimKey, claimKey]);
});
Deno.test("fixed and chunked oversized responses are rejected before parsing", async () => {
  const registration = {
    enrollmentToken: "enrollment-token",
    workerCredential: "x".repeat(43),
    name: "oversized-response-worker",
    os: "linux" as const,
    architecture: "x64",
    capabilities: ["git"],
    toolchainVersions: {},
    slots: 1,
  };
  const oversized = "x".repeat(1_048_577);
  const fixed = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    fetcher: () =>
      Promise.resolve(
        new Response(oversized, {
          headers: {
            "content-length": String(oversized.length),
            "X-Bakery-Worker-Protocol-Version": "2",
          },
        }),
      ),
  });
  await assertRejects(
    () => fixed.register(registration, crypto.randomUUID()),
    WorkerRequestError,
    "WORKER_RESPONSE_TOO_LARGE",
  );
  const chunked = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    fetcher: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_576));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          {
            headers: { "X-Bakery-Worker-Protocol-Version": "2" },
          },
        ),
      ),
  });
  await assertRejects(
    () => chunked.register(registration, crypto.randomUUID()),
    WorkerRequestError,
    "WORKER_RESPONSE_TOO_LARGE",
  );
});
Deno.test("worker events reject terminal and regressed batch entries locally", async () => {
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () => Promise.reject(new Error("FETCH_MUST_NOT_RUN")),
  });
  const attemptId = crypto.randomUUID();
  const base = {
    leaseToken: "lease-token",
    fence: "1",
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  };
  await assertRejects(
    () =>
      client.postEvents(attemptId, {
        ...base,
        events: [
          {
            eventId: crypto.randomUUID(),
            localSeq: "2",
            eventType: "job.accepted",
            payload: { acceptedAt: new Date().toISOString() },
          },
          {
            eventId: crypto.randomUUID(),
            localSeq: "1",
            eventType: "job.accepted",
            payload: { acceptedAt: new Date().toISOString() },
          },
        ],
      }, undefined),
    WorkerRequestError,
    "WORKER_EVENT_BATCH_INVALID",
  );
  await assertRejects(
    () =>
      client.postEvents(attemptId, {
        ...base,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.succeeded",
          payload: {},
        }],
      }, undefined),
    WorkerRequestError,
    "WORKER_EVENT_BATCH_INVALID",
  );
});
Deno.test("graceful drain flushes an active cancellation result", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-drain-active-" });
  try {
    const assignment = nonmodelAssignment();
    const workerHostId = assignment.workerHostId;
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    await registrationStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    let claimCount = 0;
    let resultPayload: Record<string, unknown> | undefined;
    const { promise: started, resolve: startedResolve } = Promise.withResolvers<
      void
    >();
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(heartbeatResponse(
            workerHostId,
            [],
            [],
            assignment.workerSessionId,
            assignment.workerSessionGeneration,
            [assignment.attemptId],
          ));
        }
        if (path.endsWith("/claims")) {
          claimCount++;
          return claimCount === 1
            ? Promise.resolve(protocolResponse(assignment))
            : Promise.resolve(protocolEmptyResponse({ status: 204 }));
        }
        if (path.endsWith("/lease-renewals")) {
          return Promise.resolve(legacyLeaseRenewalResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }));
        }
        if (path.endsWith("/result")) {
          resultPayload = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
        }
        return Promise.resolve(ackResponse(init));
      },
    });
    const supervisor = new WorkerSupervisor({
      // The drain must flush the canceled result before its deadline, and that
      // flush is fsynced writes behind the registration lock: the default 1 s
      // lapsed on a loaded host and the result was never posted. The scenario
      // does not depend on the deadline, so the budget only has to fit them.
      config: { ...supervisorConfig(directory), drainTimeoutMs: 30_000 },
      client,
      registrationStore,
      spool,
      executor: {
        supportedActions: ["quality.check"],
        execute: (_assignment, signal) =>
          new Promise((resolve) => {
            const canceled = () =>
              resolve({
                status: "canceled",
                cancellation: {
                  processExited: true,
                  exitedAt: new Date().toISOString(),
                  cleanupStatus: "complete",
                },
              });
            startedResolve();
            if (signal.aborted) canceled();
            else signal.addEventListener("abort", canceled, { once: true });
          }),
      },
      sleep: fastSleep,
    });
    const run = observeRun(supervisor.run());
    await started;
    await supervisor.drain();
    await run;
    assertEquals(resultPayload?.status, "canceled");
    assertEquals(await spool.records(), []);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test(
  "drain serializes an in-flight claim and gates executor start",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-drain-claim-race-",
    });
    try {
      const assignment = nonmodelAssignment(
        new Date(Date.now() + 60_000).toISOString(),
      );
      const workerHostId = assignment.workerHostId;
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      const claimStarted = Promise.withResolvers<void>();
      const claimResponse = Promise.withResolvers<Response>();
      const drainHeartbeatBodies: Array<{ activeAttemptIds?: string[] }> = [];
      let executions = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            const body = JSON.parse(String(init?.body)) as {
              activeAttemptIds?: string[];
            };
            if (body.activeAttemptIds?.includes(assignment.attemptId)) {
              drainHeartbeatBodies.push(body);
            }
            return heartbeatResponse(
              workerHostId,
              [],
              [],
              assignment.workerSessionId,
              assignment.workerSessionGeneration,
            );
          }
          if (path.endsWith("/claims")) {
            claimStarted.resolve();
            return await claimResponse.promise;
          }
          return protocolEmptyResponse({ status: 204 });
        },
      });
      const supervisor = new WorkerSupervisor({
        // The budget is the drain deadline and also the time run() allows the
        // work left when it fires. The claim's commit is an fsynced write
        // behind the registration lock and took more than 100 ms on a loaded
        // host: the deadline then skipped the drain heartbeat asserted below,
        // or run() threw WorkerShutdownQuiescenceError. The scenario does not
        // depend on the deadline: the claim settles right after the drain
        // starts.
        config: { ...supervisorConfig(directory), drainTimeoutMs: 30_000 },
        client,
        registrationStore: store,
        spool,
        executor: {
          supportedActions: ["quality.check"],
          execute: () => {
            executions++;
            return Promise.resolve({
              status: "failed",
              fault: { code: "MUST_NOT_START_DURING_DRAIN" },
            });
          },
        },
        sleep: fastSleep,
      });
      const run = observeRun(supervisor.run());
      await claimStarted.promise;
      const drain = supervisor.drain();
      claimResponse.resolve(protocolResponse(assignment));
      await drain;
      await run;
      assertEquals(executions, 0);
      assertEquals(drainHeartbeatBodies.length, 1);
      assertEquals(
        drainHeartbeatBodies[0].activeAttemptIds,
        [assignment.attemptId],
      );
      assertEquals(
        (await store.load())?.activeAssignments?.[assignment.attemptId]
          ?.assignment.attemptId,
        assignment.attemptId,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test(
  "drain deadline aborts an unreleased claim and preserves its replay key",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-drain-claim-deadline-",
    });
    const claimStarted = Promise.withResolvers<void>();
    const claimResponse = Promise.withResolvers<Response>();
    // The drain deadline is the scenario, so it stays a deadline. After it
    // fires, run() allows the same budget for the work left: the claim only
    // unwinds when this test releases it, after the assertions below, and that
    // release saves the pending claim key, an fsynced write behind the
    // registration lock. At 100 ms that write straddled the budget on a loaded
    // host and run() threw WorkerShutdownQuiescenceError; 5 s still lapsed
    // once in 80 runs, in a window where every test ran ten times slower. The
    // elapsed bounds keep their ratios of the deadline (0.75x and 3.5x); the
    // absolute upper bound grew from 350 ms to 52.5 s. The fake fetcher
    // ignores the abort signal, so the request timeout does not end the claim
    // either way; it keeps its place above the bound (10x the deadline, as 1 s
    // was above 350 ms) so the scenario's timing relations stay as they were.
    const drainTimeoutMs = 15_000;
    const requestTimeoutMs = drainTimeoutMs * 10;
    try {
      const store = new RegistrationStore(`${directory}/registration.json`);
      const workerHostId = crypto.randomUUID();
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      let claimKey: string | undefined;
      let executions = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        requestTimeoutMs,
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            return heartbeatResponse(workerHostId);
          }
          if (path.endsWith("/claims")) {
            const body = JSON.parse(String(init?.body)) as {
              claimKey?: string;
            };
            claimKey = body.claimKey;
            claimStarted.resolve();
            return await claimResponse.promise;
          }
          return protocolEmptyResponse({ status: 204 });
        },
      });
      const supervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(directory),
          requestTimeoutMs,
          drainTimeoutMs,
        },
        client,
        registrationStore: store,
        spool,
        executor: {
          supportedActions: ["harness.implement"],
          execute: () => {
            executions++;
            return Promise.resolve({
              status: "failed",
              fault: { code: "MUST_NOT_START_DURING_DRAIN" },
            });
          },
        },
        sleep: fastSleep,
      });
      const run = observeRun(supervisor.run());
      await claimStarted.promise;
      const startedAt = performance.now();
      const drain = supervisor.drain();
      await drain;
      const elapsed = performance.now() - startedAt;
      assert(
        elapsed >= drainTimeoutMs * 0.75 && elapsed < drainTimeoutMs * 3.5,
        `drain elapsed ${elapsed.toFixed(1)}ms`,
      );
      assertEquals(executions, 0);
      assertEquals((await store.load())?.pendingClaim?.claimKey, claimKey);
      claimResponse.resolve(protocolEmptyResponse({ status: 204 }));
      await run;
    } finally {
      claimResponse.resolve(protocolEmptyResponse({ status: 204 }));
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test("expired replayed assignments retire the saved claim key on restart", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-expired-replay-",
  });
  try {
    const assignment = nonmodelAssignment(
      new Date(Date.now() + 50).toISOString(),
    );
    assignment.serverTime = new Date().toISOString();
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    await registrationStore.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
    });
    await registrationStore.savePendingClaimKey(crypto.randomUUID());
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const claimKeys: string[] = [];
    let executions = 0;
    let claimCount = 0;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(
            heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              assignment.workerSessionId,
              assignment.workerSessionGeneration,
              [assignment.attemptId],
            ),
          );
        }
        if (path.endsWith("/claims")) {
          const body = JSON.parse(String(init?.body)) as { claimKey: string };
          claimKeys.push(body.claimKey);
          claimCount++;
          if (claimCount === 1) {
            const delay = Promise.withResolvers<void>();
            setTimeout(delay.resolve, 150);
            await delay.promise;
            return Promise.resolve(
              protocolResponse(assignment, {
                headers: { "Idempotent-Replayed": "true" },
              }),
            );
          }
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore,
      spool,
      executor: {
        supportedActions: ["quality.check"],
        execute: () => {
          executions++;
          return Promise.resolve({
            status: "failed",
            fault: { code: "MUST_NOT_RUN" },
          });
        },
      },
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    const reopened = await registrationStore.load();
    assertEquals(claimKeys.length, 2);
    assertEquals(claimKeys[0] === claimKeys[1], false);
    assertEquals(reopened?.pendingClaimKey, undefined);
    assertEquals(executions, 0);
    assertEquals(supervisor.isDraining, false);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
