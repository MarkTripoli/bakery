import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  assertRejects,
  EventSpool,
  WorkerApiClient,
  WorkerRequestError,
  WorkerSupervisor,
  RegistrationStore,
  ackResponse,
  fastSleep,
  localAssignment,
  heartbeatResponse,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
  main,
  createDeterministicExecutor,
  acquireStateLock,
} = issue39;
type WorkerResultRequest = issue39.WorkerResultRequest;
type StateLockFactory = issue39.StateLockFactory;
type WorkerSupervisor = issue39.WorkerSupervisorInstance;

// Cases are imported from the issue entrypoint.
Deno.test("protocol v2 mutation requests carry the session tuple", async () => {
  const attemptId = crypto.randomUUID();
  const workerSessionId = crypto.randomUUID();
  const bodies: Array<Record<string, unknown>> = [];
  const versions: string[] = [];
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: (input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      versions.push(
        new Headers(init?.headers).get(
          "X-Bakery-Worker-Protocol-Version",
        ) ?? "",
      );
      if (new URL(String(input)).pathname.endsWith("/lease-renewals")) {
        return Promise.resolve(protocolResponse({
          attemptId,
          fence: "1",
          status: "active",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          leaseDurationSeconds: 45,
          serverTime: new Date().toISOString(),
        }));
      }
      return Promise.resolve(ackResponse(init));
    },
  });
  await client.postEvents(attemptId, {
    leaseToken: "x".repeat(43),
    fence: "1",
    events: [{
      eventId: crypto.randomUUID(),
      localSeq: "1",
      eventType: "job.accepted",
      payload: { acceptedAt: new Date().toISOString() },
    }],
    workerSessionId,
    workerSessionGeneration: "2",
  });
  await client.renewLease(
    attemptId,
    {
      leaseToken: "x".repeat(43),
      fence: "1",
      leaseSeconds: 45,
      workerSessionId,
      workerSessionGeneration: "2",
    },
    undefined,
    "renew-key",
  );
  const resultBody = {
    leaseToken: "x".repeat(43),
    fence: "1",
    localSeq: "2",
    status: "failed",
    fault: {
      type: "about:blank",
      title: "Worker execution failed",
      status: 500,
      detail: "test",
      code: "TEST",
      requestId: crypto.randomUUID(),
      retryable: false,
    },
    workerSessionId,
    workerSessionGeneration: "2",
  } as unknown as WorkerResultRequest;
  const resultKey = crypto.randomUUID();
  await client.postResult(attemptId, resultBody, resultKey);
  assertEquals(
    bodies.map((body) => [
      body.workerSessionId,
      body.workerSessionGeneration,
    ]),
    [
      [workerSessionId, "2"],
      [workerSessionId, "2"],
      [workerSessionId, "2"],
    ],
  );
  assertEquals(versions, ["2", "2", "2"]);
});
Deno.test("unsupported protocol negotiation is rejected without retry", async () => {
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () =>
      Promise.resolve(
        protocolResponse(
          { code: "WORKER_PROTOCOL_UNSUPPORTED", retryable: false },
          {
            status: 426,
            headers: { "X-Bakery-Worker-Protocol-Version": "1" },
          },
        ),
      ),
  });
  await assertRejects(
    () =>
      client.heartbeat({
        workerHostId: crypto.randomUUID(),
        observedAt: new Date().toISOString(),
        load: 0,
        activeAttemptIds: [],
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "0",
        ackCommandIds: [],
        rejectedCommandIds: [],
      }),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );
});
Deno.test("persistence mutation queues recover after lock acquisition failure", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-queue-lock-" });
  try {
    let failRegistration = true;
    const registrationLock: StateLockFactory = async (path, options) => {
      if (failRegistration) {
        failRegistration = false;
        throw new Error("INJECTED_LOCK_ACQUISITION");
      }
      return await acquireStateLock(path, options);
    };
    const store = new RegistrationStore(
      `${directory}/registration.json`,
      { acquireStateLock: registrationLock },
    );
    await assertRejects(
      () => store.savePendingRegistration("credential", crypto.randomUUID()),
      Error,
      "INJECTED_LOCK_ACQUISITION",
    );
    // The watchdogs only tell a wedged queue from a slow one. Each save is
    // fsynced writes behind a lock, which took longer than the old 500 ms on a
    // loaded host; a queue that never recovers still fails after 30 s.
    const registered = await Promise.race([
      store.savePendingRegistration("credential-2", crypto.randomUUID()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("REGISTRATION_QUEUE_WEDGED")), 30_000)
      ),
    ]);
    assertEquals(registered.workerCredential, "credential-2");

    let spoolLockCalls = 0;
    const spoolLock: StateLockFactory = async (path, options) => {
      spoolLockCalls++;
      if (spoolLockCalls === 2) {
        throw new Error("INJECTED_LOCK_ACQUISITION");
      }
      return await acquireStateLock(path, options);
    };
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 10,
      maxBytes: 20_000,
      acquireStateLock: spoolLock,
    });
    const input = {
      attemptId: crypto.randomUUID(),
      leaseToken: "x".repeat(43),
      fence: "1",
      localSeq: "1",
      eventId: crypto.randomUUID(),
      eventType: "job.progress",
      payload: { message: "queue recovery" },
    };
    await assertRejects(
      () => spool.enqueueEvent(input),
      Error,
      "INJECTED_LOCK_ACQUISITION",
    );
    const record = await Promise.race([
      spool.enqueueEvent(input),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SPOOL_QUEUE_WEDGED")), 30_000)
      ),
    ]);
    assertEquals(record.localSeq, "1");
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("terminal release removes spool metadata before assignment deletion", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-terminal-release-order-",
  });
  try {
    const assignment = localAssignment();
    const registrationPath = `${directory}/registration.json`;
    const spoolPath = `${directory}/spool.json`;
    const store = new RegistrationStore(registrationPath);
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
      path: spoolPath,
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
        detail: "injected release ordering crash",
        code: "INJECTED_RELEASE_ORDER",
        requestId: crypto.randomUUID(),
        retryable: false,
      },
    });
    const originalComplete = store.completeRelease.bind(store);
    store.completeRelease = () =>
      Promise.reject(new Error("INJECTED_CRASH_AFTER_SPOOL_DISCARD"));
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
    });
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: createDeterministicExecutor(),
      sleep: fastSleep,
    });
    await assertRejects(
      () => supervisor.replayStandalone(),
      Error,
      "INJECTED_CRASH_AFTER_SPOOL_DISCARD",
    );
    await supervisor.drain();
    assertEquals(supervisor.fatalReason, "INJECTED_CRASH_AFTER_SPOOL_DISCARD");
    assertEquals(spool.attemptIds(), []);
    assertEquals(spool.journalState(assignment.attemptId), {
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
    });
    assertEquals(
      (await store.load())?.activeAssignments?.[
        assignment.attemptId
      ].terminalAcked,
      true,
    );
    assertEquals(
      (await store.load())?.releaseMarkers?.[assignment.attemptId].reason,
      "RESULT_ACKED",
    );

    store.completeRelease = originalComplete;
    const reopenedSpool = await EventSpool.open({
      path: spoolPath,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let executions = 0;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const restartClient = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(heartbeatResponse(assignment.workerHostId));
        }
        if (path.endsWith("/claims")) {
          queueMicrotask(() =>
            supervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        }
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const restarted = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client: restartClient,
      registrationStore: new RegistrationStore(registrationPath),
      spool: reopenedSpool,
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
    supervisorRef.current = restarted;
    await restarted.run();
    assertEquals(executions, 0);
    assertEquals(
      (await new RegistrationStore(registrationPath).load())
        ?.activeAssignments,
      undefined,
    );
    assertEquals(reopenedSpool.attemptIds(), []);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("expired replayed renewal never starts the restored executor", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-expired-renewal-replay-",
  });
  try {
    const assignment = localAssignment(
      new Date(Date.now() + 50).toISOString(),
    );
    assignment.serverTime = new Date().toISOString();
    const registrationPath = `${directory}/registration.json`;
    const store = new RegistrationStore(registrationPath);
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
      renewalKey: "expired-renewal-key",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let renewalCount = 0;
    let executions = 0;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: async (input) => {
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
        if (path.endsWith("/lease-renewals")) {
          renewalCount++;
          const delay = Promise.withResolvers<void>();
          setTimeout(delay.resolve, 150);
          await delay.promise;
          return Promise.resolve(protocolResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: assignment.leaseExpiresAt,
            leaseDurationSeconds: assignment.leaseDurationSeconds,
            serverTime: assignment.serverTime,
          }, { headers: { "Idempotent-Replayed": "true" } }));
        }
        if (path.endsWith("/claims")) {
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
    assertEquals(renewalCount, 1);
    assertEquals(executions, 0);
    assertEquals((await store.load())?.activeAssignments, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test(
  "delayed fresh heartbeat cannot extend a replayed renewal lease",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-delayed-heartbeat-replay-",
    });
    try {
      const serverTimeMs = Date.now();
      const serverTime = new Date(serverTimeMs).toISOString();
      const assignment = localAssignment(
        new Date(serverTimeMs + 80).toISOString(),
      );
      assignment.serverTime = serverTime;
      const store = new RegistrationStore(
        `${directory}/registration.json`,
      );
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
        nextLocalSeq: "2",
        ackedLocalSeq: "1",
        renewalKey: "delayed-heartbeat-renewal-key",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      let heartbeatCount = 0;
      let renewalCount = 0;
      let executions = 0;
      const supervisorRef: { current?: WorkerSupervisor } = {};
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            heartbeatCount++;
            if (heartbeatCount === 1) {
              const delayed = Promise.withResolvers<void>();
              setTimeout(delayed.resolve, 150);
              await delayed.promise;
              return protocolResponse({
                workerHostId: assignment.workerHostId,
                status: "accepted",
                receivedAt: serverTime,
                pendingCommands: [],
                commandAcks: [],
                reconciledAttemptIds: [assignment.attemptId],
                workerSessionId: assignment.workerSessionId,
                workerSessionGeneration: assignment.workerSessionGeneration,
                serverTime,
                inventoryRevision: 1,
              });
            }
            queueMicrotask(() =>
              supervisorRef.current?.requestStop("TEST_COMPLETE")
            );
            return heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              assignment.workerSessionId,
              assignment.workerSessionGeneration,
            );
          }
          if (path.endsWith("/lease-renewals")) {
            renewalCount++;
            return protocolResponse({
              attemptId: assignment.attemptId,
              fence: assignment.fence,
              status: "active",
              leaseExpiresAt: assignment.leaseExpiresAt,
              leaseDurationSeconds: assignment.leaseDurationSeconds,
              serverTime,
            }, { headers: { "Idempotent-Replayed": "true" } });
          }
          if (path.endsWith("/claims")) {
            queueMicrotask(() =>
              supervisorRef.current?.requestStop("TEST_COMPLETE")
            );
            return protocolEmptyResponse({ status: 204 });
          }
          return ackResponse();
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
            queueMicrotask(() =>
              supervisorRef.current?.requestStop("TEST_EXECUTION_STARTED")
            );
            const blocked = Promise.withResolvers<never>();
            return blocked.promise;
          },
        },
        sleep: fastSleep,
      });
      supervisorRef.current = supervisor;
      await supervisor.run();
      assertEquals(renewalCount, 1);
      assertEquals(executions, 0);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test("headerless v2 success and no-content responses are non-retryable", async () => {
  const workerHostId = crypto.randomUUID();
  const sessionFields = {
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "0",
  };
  const heartbeatBody = {
    workerHostId,
    status: "accepted",
    receivedAt: new Date().toISOString(),
    pendingCommands: [],
    commandAcks: [],
    serverTime: new Date().toISOString(),
    inventoryRevision: 1,
    ...sessionFields,
  };
  const successful = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () => Promise.resolve(Response.json(heartbeatBody)),
  });
  await assertRejects(
    () =>
      successful.heartbeat({
        workerHostId,
        observedAt: new Date().toISOString(),
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
        ...sessionFields,
      }),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );

  const noContent = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () => Promise.resolve(new Response(null, { status: 204 })),
  });
  await assertRejects(
    () =>
      noContent.claim({
        claimKey: crypto.randomUUID(),
        workerHostId,
        capabilities: ["git"],
        ...sessionFields,
      }),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );
});
Deno.test("non-retryable control failures drain fatally and main rejects", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-fatal-drain-" });
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
    const mainSpool = await EventSpool.open({
      path: `${directory}/main-spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let mainSupervisor: WorkerSupervisor | undefined;
    const heartbeatFailureClient = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () =>
        Promise.resolve(
          protocolResponse(
            { code: "AUTH_FORBIDDEN", retryable: false },
            { status: 403 },
          ),
        ),
    });
    await assertRejects(
      () =>
        main({
          config: supervisorConfig(directory),
          client: heartbeatFailureClient,
          registrationStore,
          spool: mainSpool,
          executor: {
            supportedActions: [],
            execute: () => Promise.reject(new Error("MUST_NOT_EXECUTE")),
          },
          onSupervisor: (value) => mainSupervisor = value,
        }),
      Error,
      "AUTH_FORBIDDEN",
    );
    assertEquals(mainSupervisor?.fatalReason, "AUTH_FORBIDDEN");

    const claimStore = new RegistrationStore(
      `${directory}/claim-registration.json`,
    );
    await claimStore.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const claimSupervisorRef: { current?: WorkerSupervisor } = {};
    const claimClient = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(heartbeatResponse(workerHostId));
        }
        if (path.endsWith("/claims")) {
          return Promise.resolve(
            protocolResponse(
              { code: "CLAIM_REJECTED", retryable: false },
              { status: 409 },
            ),
          );
        }
        queueMicrotask(() =>
          claimSupervisorRef.current?.requestStop("UNEXPECTED_WORKER_PATH")
        );
        return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
      },
    });
    const claimSupervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client: claimClient,
      registrationStore: claimStore,
      spool: await EventSpool.open({
        path: `${directory}/claim-spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      }),
      executor: createDeterministicExecutor(),
      sleep: fastSleep,
    });
    claimSupervisorRef.current = claimSupervisor;
    await claimSupervisor.run();
    assertEquals(claimSupervisor.fatalReason, "CLAIM_REJECTED");
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
