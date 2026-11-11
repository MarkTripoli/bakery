import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  EventSpool,
  WorkerApiClient,
  WorkerSupervisor,
  RegistrationStore,
  ackResponse,
  fastSleep,
  localAssignment,
  nonmodelAssignment,
  heartbeatResponse,
  protocolEmptyResponse,
  protocolResponse,
  recoverySleep,
  supervisorConfig,
  createRecoverySupervisor,
  openRecoveryState,
  createDeterministicExecutor,
  acquireStateLock,
  workerFixtureCapabilities,
} = issue39;
type StateLock = issue39.StateLock;
type WorkerSupervisor = issue39.WorkerSupervisorInstance;

// Cases are imported from the issue entrypoint.
Deno.test(
  "command outcomes survive >25h restart and clear only after server acknowledgement",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-command-replay-",
    });
    try {
      const workerHostId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const registrationPath = `${directory}/registration.json`;
      const { registrationStore, spool } = await openRecoveryState(directory, {
        registrationPath,
        maxRecords: 10,
        maxBytes: 20_000,
      });
      await registrationStore.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      const command = {
        id: commandId,
        attemptId: crypto.randomUUID(),
        messageId: null,
        commandType: "steer",
        payload: { message: "unsupported" },
        status: "delivered",
        createdAt: new Date().toISOString(),
      };
      const firstSupervisorRef: { current?: WorkerSupervisor } = {};
      const firstClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            queueMicrotask(() =>
              firstSupervisorRef.current?.requestStop("TEST_FIRST")
            );
            return Promise.resolve(
              heartbeatResponse(workerHostId, [command]),
            );
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const firstSupervisor = createRecoverySupervisor(directory, {
        client: firstClient,
        registrationStore,
        spool,
        executor: createDeterministicExecutor(),
        sleep: fastSleep,
      });
      firstSupervisorRef.current = firstSupervisor;
      await firstSupervisor.run();
      assertEquals(
        (await registrationStore.load())?.commandOutcomes?.[commandId],
        "rejected",
      );

      const oldTimestamp = new Date(
        Date.now() - 25 * 60 * 60 * 1_000 - 1,
      ).toISOString();
      const staleState = JSON.parse(
        await Deno.readTextFile(registrationPath),
      ) as Record<string, unknown>;
      staleState.commandOutcomeCreatedAt = { [commandId]: oldTimestamp };
      await Deno.writeTextFile(
        registrationPath,
        `${JSON.stringify(staleState)}\n`,
      );

      let replayedWithoutAck: unknown;
      const secondSupervisorRef: { current?: WorkerSupervisor } = {};
      const secondClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            const body = JSON.parse(String(init?.body)) as {
              ackCommandIds?: unknown;
              rejectedCommandIds?: unknown;
            };
            replayedWithoutAck = {
              ackCommandIds: body.ackCommandIds,
              rejectedCommandIds: body.rejectedCommandIds,
            };
            queueMicrotask(() =>
              secondSupervisorRef.current?.requestStop("TEST_SECOND")
            );
            return Promise.resolve(heartbeatResponse(workerHostId));
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const secondSupervisor = createRecoverySupervisor(directory, {
        client: secondClient,
        registrationStore: new RegistrationStore(registrationPath),
        spool,
        executor: createDeterministicExecutor(),
        sleep: fastSleep,
      });
      secondSupervisorRef.current = secondSupervisor;
      await secondSupervisor.run();
      assertEquals(replayedWithoutAck, {
        ackCommandIds: [],
        rejectedCommandIds: [commandId],
      });
      assertEquals(
        (await registrationStore.load())?.commandOutcomes?.[commandId],
        "rejected",
      );

      let replayedWithAck: unknown;
      const thirdSupervisorRef: { current?: WorkerSupervisor } = {};
      const thirdClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            const body = JSON.parse(String(init?.body)) as {
              ackCommandIds?: unknown;
              rejectedCommandIds?: unknown;
            };
            replayedWithAck = {
              ackCommandIds: body.ackCommandIds,
              rejectedCommandIds: body.rejectedCommandIds,
            };
            queueMicrotask(() =>
              thirdSupervisorRef.current?.requestStop("TEST_THIRD")
            );
            return Promise.resolve(heartbeatResponse(
              workerHostId,
              [],
              [{
                commandId,
                status: "rejected",
                acknowledgedAt: new Date().toISOString(),
              }],
            ));
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const thirdSupervisor = createRecoverySupervisor(directory, {
        client: thirdClient,
        registrationStore: new RegistrationStore(registrationPath),
        spool,
        executor: createDeterministicExecutor(),
        sleep: fastSleep,
      });
      thirdSupervisorRef.current = thirdSupervisor;
      await thirdSupervisor.run();
      assertEquals(replayedWithAck, {
        ackCommandIds: [],
        rejectedCommandIds: [commandId],
      });
      assertEquals(
        (await registrationStore.load())?.commandOutcomes,
        undefined,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test("heartbeat active attempt reporting is bounded to the canonical limit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-active-cap-" });
  try {
    const workerHostId = crypto.randomUUID();
    const registrationStore = new RegistrationStore(
      `${directory}/registration.json`,
    );
    await registrationStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 200,
      maxBytes: 200_000,
    });
    for (let index = 0; index < 101; index++) {
      await spool.enqueueEvent({
        attemptId: crypto.randomUUID(),
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        eventType: "job.progress",
        payload: { message: "active", percent: index },
      });
    }
    let heartbeatBody: { activeAttemptIds?: string[] } | undefined;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          heartbeatBody = JSON.parse(String(init?.body)) as {
            activeAttemptIds?: string[];
          };
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(heartbeatResponse(workerHostId));
        }
        return Promise.resolve(ackResponse(init));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore,
      spool,
      executor: createDeterministicExecutor(),
      sleep: fastSleep,
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(heartbeatBody?.activeAttemptIds?.length, 100);
    assertEquals(
      new Set(heartbeatBody?.activeAttemptIds).size,
      heartbeatBody?.activeAttemptIds?.length,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("separate worker stores merge snapshots without dropping state", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-store-lock-" });
  try {
    const spoolPath = `${directory}/spool.json`;
    const first = await EventSpool.open({
      path: spoolPath,
      maxRecords: 10,
      maxBytes: 20_000,
    });
    const second = await EventSpool.open({
      path: spoolPath,
      maxRecords: 10,
      maxBytes: 20_000,
    });
    await Promise.all([
      first.enqueueEvent({
        attemptId: crypto.randomUUID(),
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        eventType: "job.progress",
        payload: { message: "first", percent: 1 },
      }),
      second.enqueueEvent({
        attemptId: crypto.randomUUID(),
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        eventType: "job.progress",
        payload: { message: "second", percent: 2 },
      }),
    ]);
    const reopened = await EventSpool.open({
      path: spoolPath,
      maxRecords: 10,
      maxBytes: 20_000,
    });
    assertEquals(reopened.depth.records, 2);

    const registrationPath = `${directory}/registration.json`;
    const storeA = new RegistrationStore(registrationPath);
    const storeB = new RegistrationStore(registrationPath);
    const workerHostId = crypto.randomUUID();
    await storeA.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const pendingClaimKey = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    await Promise.all([
      storeA.savePendingClaimKey(pendingClaimKey),
      storeB.saveCommandOutcome(commandId, "rejected"),
    ]);
    const state = await new RegistrationStore(registrationPath).load();
    assertEquals(state?.pendingClaimKey, pendingClaimKey);
    assertEquals(state?.commandOutcomes?.[commandId], "rejected");
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("pending claim is reported before replacement-session reconciliation", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-pending-claim-",
  });
  try {
    const workerHostId = crypto.randomUUID();
    const pendingClaimKey = crypto.randomUUID();
    const assignment = nonmodelAssignment();
    assignment.workerHostId = workerHostId;
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    await store.savePendingClaim({
      claimKey: pendingClaimKey,
      workerHostId,
      capabilities: [...workerFixtureCapabilities],
      supportedActions: ["quality.check"],
    });
    assertEquals((await store.load())?.pendingClaimKey, pendingClaimKey);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let heartbeatBody: Record<string, unknown> | undefined;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          if (!heartbeatBody) {
            heartbeatBody = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
          }
          return Promise.resolve(heartbeatResponse(workerHostId));
        }
        if (path.endsWith("/claims")) {
          return Promise.resolve(protocolResponse(assignment));
        }
        if (path.endsWith("/events") || path.endsWith("/result")) {
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(ackResponse(init));
        }
        return Promise.resolve(protocolEmptyResponse({ status: 204 }));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        supportedActions: ["quality.check"],
        execute: () =>
          Promise.resolve({
            status: "failed",
            fault: { code: "TEST_PENDING_CLAIM_REPLAY_COMPLETE" },
          }),
      },
      sleep: fastSleep,
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(heartbeatBody?.pendingClaimKey, pendingClaimKey);
    assertEquals((await store.load())?.pendingClaimKey, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
async function runRenewalRecovery(admissionPaused: boolean): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-pending-renewal-",
  });
  try {
    const assignment = localAssignment(
      new Date(Date.now() - 60_000).toISOString(),
    );
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    if (admissionPaused) {
      await store.saveCommandOutcome(
        crypto.randomUUID(),
        "acknowledged",
        { admissionPaused: true },
      );
    }
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "2",
      ackedLocalSeq: "1",
      renewalKey: "renew-key",
    });
    assertEquals(
      (await store.load())?.pendingRenewalKeys?.[assignment.attemptId],
      "renew-key",
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let renewalCount = 0;
    let heartbeatCount = 0;
    const renewalKeys: string[] = [];
    let claimRequests = 0;
    let executions = 0;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          heartbeatCount++;
          if (admissionPaused && heartbeatCount >= 2) {
            queueMicrotask(() =>
              supervisorRef.current?.requestStop("TEST_COMPLETE")
            );
          }
          return Promise.resolve(heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            assignment.workerSessionId,
            assignment.workerSessionGeneration,
            [assignment.attemptId],
          ));
        }
        if (path.endsWith("/lease-renewals")) {
          renewalCount++;
          renewalKeys.push(
            new Headers(init?.headers).get("Idempotency-Key") ?? "",
          );
          return Promise.resolve(protocolResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            leaseDurationSeconds: 45,
            serverTime: new Date().toISOString(),
          }));
        }
        if (path.endsWith("/claims")) {
          claimRequests++;
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        }
        if (path.endsWith("/events")) {
          return Promise.resolve(ackResponse(init));
        }
        if (path.endsWith("/result")) {
          setTimeout(
            () => supervisorRef.current?.requestStop("TEST_COMPLETE"),
            0,
          );
          return Promise.resolve(ackResponse(init));
        }
        return Promise.resolve(protocolEmptyResponse({ status: 204 }));
      },
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        supportedActions: ["harness.implement"],
        execute: () => {
          executions++;
          return Promise.resolve({
            status: "failed",
            fault: {
              type: "about:blank",
              title: "Worker execution failed",
              status: 500,
              detail: "recovered",
              code: "RECOVERED",
              requestId: crypto.randomUUID(),
              retryable: false,
            },
          });
        },
      },
      sleep: recoverySleep,
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(renewalCount >= 1, true);
    assertEquals(renewalKeys[0], "renew-key");
    assertEquals(executions, admissionPaused ? 0 : 1);
    if (admissionPaused) assertEquals(claimRequests, 0);
    assertEquals((await store.load())?.pendingRenewalKeys, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}
Deno.test("unpaused restart replays expired renewal before executor recovery", () =>
  runRenewalRecovery(false));
Deno.test("paused restart replays expired renewal before executor recovery", () =>
  runRenewalRecovery(true));
Deno.test("terminal result recovery never re-invokes the executor", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-terminal-recovery-",
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
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    await spool.enqueueResult({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "3",
      eventId: crypto.randomUUID(),
      status: "failed",
      fault: {
        type: "about:blank",
        title: "Worker execution failed",
        status: 500,
        detail: "already committed",
        code: "ALREADY_COMMITTED",
        requestId: crypto.randomUUID(),
        retryable: false,
      },
    });
    let executions = 0;
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
        if (path.endsWith("/result")) {
          setTimeout(
            () => supervisorRef.current?.requestStop("TEST_COMPLETE"),
            0,
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
        supportedActions: ["harness.implement"],
        execute: () => {
          executions++;
          return Promise.resolve({
            status: "failed",
            fault: { code: "MUST_NOT_RUN" },
          });
        },
      },
      sleep: fastSleep,
    });
    supervisorRef.current = supervisor;
    await supervisor.run();
    assertEquals(executions, 0);
    assertEquals((await store.load())?.activeAssignments, undefined);
    assertEquals((await spool.records()).length, 0);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test(
  "a paused live owner keeps the kernel state lock from being stolen",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-paused-lock-",
    });
    const lockPath = `${directory}/worker.lock`;
    const pausedGate = Promise.withResolvers<void>();
    const resumedGate = Promise.withResolvers<void>();
    const paused = pausedGate.promise;
    const resumed = resumedGate.promise;
    let firstLock: StateLock | undefined;
    let secondLock: StateLock | undefined;
    try {
      const firstPromise = acquireStateLock(lockPath, {
        beforePublish: async () => {
          pausedGate.resolve();
          await resumed;
        },
      });
      await paused;
      let secondSettled = false;
      const secondPromise = acquireStateLock(lockPath).then((lock) => {
        secondSettled = true;
        return lock;
      });
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 25);
      await delay.promise;
      assertEquals(secondSettled, false);
      resumedGate.resolve();
      firstLock = await firstPromise;
      assertEquals(secondSettled, false);
      await firstLock.release();
      firstLock = undefined;
      secondLock = await secondPromise;
      await secondLock.release();
    } finally {
      if (secondLock) await secondLock.release().catch(() => undefined);
      if (firstLock) await firstLock.release().catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
