import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  assertRejects,
  EventSpool,
  WorkerApiClient,
  WorkerRequestError,
  WorkerSupervisor,
  RegistrationStore,
  fastSleep,
  localAssignment,
  heartbeatResponse,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
  createDeterministicExecutor,
  acquireStateLock,
} = issue39;
type WorkerHeartbeatRequest = issue39.WorkerHeartbeatRequest;
type RegistrationState = issue39.RegistrationState;
const assert: typeof issue39.assert = issue39.assert;
type WorkerSupervisor = issue39.WorkerSupervisorInstance;

type CapturedHeartbeat = {
  rawBody: string;
  key: string;
  body: WorkerHeartbeatRequest;
};
const captureHeartbeat = (init?: RequestInit): CapturedHeartbeat => {
  const rawBody = String(init?.body ?? "");
  return {
    rawBody,
    key: new Headers(init?.headers).get("Idempotency-Key") ?? "",
    body: JSON.parse(rawBody) as WorkerHeartbeatRequest,
  };
};

// Cases are imported from the issue entrypoint.
Deno.test("state lock acquisition times out without leaking its pending FD", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-lock-timeout-" });
  const lockPath = `${directory}/worker.lock`;
  const firstLock = await acquireStateLock(lockPath);
  try {
    await assertRejects(
      () => acquireStateLock(lockPath),
      Error,
      "WORKER_STATE_LOCKED",
    );
  } finally {
    await firstLock.release();
  }
  const reopened = await acquireStateLock(lockPath);
  await reopened.release();
  await Deno.remove(directory, { recursive: true }).catch(() => undefined);
});
Deno.test(
  "heartbeat takeover reuses its proposal and persists the returned generation",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-heartbeat-takeover-",
    });
    const workerHostId = crypto.randomUUID();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const firstBodies: Array<Record<string, unknown>> = [];
    const firstKeys: string[] = [];
    let firstHeartbeatCount = 0;
    let pendingAtFirstSend: unknown;
    const firstServerSessionId = crypto.randomUUID();
    const firstSupervisorRef: { current?: WorkerSupervisor } = {};
    try {
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "7",
      });
      const firstClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        requestTimeoutMs: 100,
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            firstBodies.push(JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >);
            firstKeys.push(
              new Headers(init?.headers).get("Idempotency-Key") ?? "",
            );
            firstHeartbeatCount++;
            if (firstHeartbeatCount === 1) {
              pendingAtFirstSend = await store.load();
              return Promise.reject(new Error("RESPONSE_LOST"));
            }
            queueMicrotask(() =>
              firstSupervisorRef.current?.requestStop("TEST_COMPLETE")
            );
            return Promise.resolve(
              heartbeatResponse(
                workerHostId,
                [],
                [],
                firstServerSessionId,
                "8",
              ),
            );
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const firstSupervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: firstClient,
        registrationStore: store,
        spool,
        executor: createDeterministicExecutor(),
        sleep: fastSleep,
      });
      firstSupervisorRef.current = firstSupervisor;
      await firstSupervisor.run();
      assertEquals(firstBodies.length, 2);
      assertEquals(firstBodies[0].workerSessionGeneration, "7");
      assertEquals(firstBodies[1].workerSessionGeneration, "7");
      assertEquals(
        firstBodies[0].workerSessionId,
        firstBodies[1].workerSessionId,
      );
      assertEquals(firstKeys[0], firstKeys[1]);
      const persistedFirstHeartbeat = pendingAtFirstSend as RegistrationState;
      assertEquals(
        persistedFirstHeartbeat.pendingHeartbeat?.idempotencyKey,
        firstKeys[0],
      );
      assertEquals(
        persistedFirstHeartbeat.pendingHeartbeat?.body,
        firstBodies[0],
      );
      assertEquals((await store.load())?.pendingHeartbeat, undefined);
      assertEquals((await store.load())?.workerSessionGeneration, "8");

      const secondBodies: Array<Record<string, unknown>> = [];
      const secondKeys: string[] = [];
      const secondSessionId = crypto.randomUUID();
      let secondHeartbeatCount = 0;
      const secondSupervisorRef: { current?: WorkerSupervisor } = {};
      const secondClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            secondBodies.push(JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >);
            secondKeys.push(
              new Headers(init?.headers).get("Idempotency-Key") ?? "",
            );
            secondHeartbeatCount++;
            if (secondHeartbeatCount === 2) {
              queueMicrotask(() =>
                secondSupervisorRef.current?.requestStop("TEST_COMPLETE")
              );
              return Promise.resolve(
                heartbeatResponse(
                  workerHostId,
                  [],
                  [],
                  secondSessionId,
                  "9",
                ),
              );
            }
            return Promise.resolve(
              heartbeatResponse(
                workerHostId,
                [],
                [],
                firstServerSessionId,
                "8",
                [],
                { headers: { "Idempotent-Replayed": "true" } },
              ),
            );
          }
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const secondSupervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: secondClient,
        registrationStore: store,
        spool,
        sleep: fastSleep,
      });
      secondSupervisorRef.current = secondSupervisor;
      await secondSupervisor.run();
      assertEquals(secondBodies.length, 2);
      assertEquals(secondBodies[0].workerSessionGeneration, "8");
      assertEquals(secondBodies[1].workerSessionGeneration, "8");
      assertEquals(
        secondBodies[0].workerSessionId === secondBodies[1].workerSessionId,
        true,
      );
      assertEquals(secondKeys.length, 2);
      assertEquals(secondKeys[0] === secondKeys[1], false);
      assertEquals((await store.load())?.workerSessionGeneration, "9");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test(
  "restart replays a committed heartbeat without reusing its process session",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-heartbeat-restart-",
    });
    const workerHostId = crypto.randomUUID();
    const initialSessionId = crypto.randomUUID();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    let serverSessionId: string = initialSessionId;
    let serverGeneration = 7n;
    let serverInvariantFailure: string | null = null;
    const pendingAtFirstSend: { state?: RegistrationState | null } = {};
    const firstBodies: CapturedHeartbeat[] = [];
    const firstSupervisorRef: { current?: WorkerSupervisor } = {};
    try {
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: initialSessionId,
        workerSessionGeneration: "7",
      });
      const restoredAssignment = localAssignment(
        new Date(Date.now() + 60_000).toISOString(),
      );
      await store.saveActiveAssignment({
        assignment: restoredAssignment,
        nextLocalSeq: "2",
        ackedLocalSeq: "1",
      });

      const firstClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        requestTimeoutMs: 1_000,
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (!path.endsWith("/heartbeat")) {
            return protocolEmptyResponse({ status: 204 });
          }
          const captured = captureHeartbeat(init);
          firstBodies.push(captured);
          if (firstBodies.length === 1) {
            serverSessionId = captured.body.workerSessionId;
            serverGeneration = 8n;
            pendingAtFirstSend.state = await store.load();
            queueMicrotask(() =>
              firstSupervisorRef.current?.requestStop("TEST_RESTART")
            );
            return Promise.reject(new Error("RESPONSE_LOST"));
          }
          return heartbeatResponse(
            workerHostId,
            [],
            [],
            serverSessionId,
            String(serverGeneration),
          );
        },
      });
      const firstSupervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: firstClient,
        registrationStore: store,
        spool,
        sleep: fastSleep,
      });
      firstSupervisorRef.current = firstSupervisor;
      await firstSupervisor.run();

      assertEquals(firstBodies.length, 1);
      const persistedPending = pendingAtFirstSend.state?.pendingHeartbeat;
      assert(persistedPending !== undefined);
      assertEquals(persistedPending.idempotencyKey, firstBodies[0].key);
      assertEquals(
        JSON.stringify(persistedPending.body),
        firstBodies[0].rawBody,
      );
      assertEquals(
        (await store.load())?.pendingHeartbeat?.idempotencyKey,
        firstBodies[0].key,
      );

      const secondBodies: CapturedHeartbeat[] = [];
      const secondResponses: Array<{
        replayed: boolean;
        body: Record<string, unknown>;
      }> = [];
      const secondSupervisorRef: { current?: WorkerSupervisor } = {};
      const secondClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        requestTimeoutMs: 1_000,
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (!path.endsWith("/heartbeat")) {
            return protocolEmptyResponse({ status: 204 });
          }
          const captured = captureHeartbeat(init);
          secondBodies.push(captured);
          if (secondBodies.length === 1) {
            if (
              captured.rawBody !== firstBodies[0].rawBody ||
              captured.key !== firstBodies[0].key ||
              !(captured.body.activeAttemptIds ?? []).includes(
                restoredAssignment.attemptId,
              )
            ) {
              serverInvariantFailure = "replay request changed";
            }
            const response = heartbeatResponse(
              workerHostId,
              [],
              [],
              serverSessionId,
              String(serverGeneration),
              [restoredAssignment.attemptId],
              { headers: { "Idempotent-Replayed": "true" } },
            );
            secondResponses.push({
              replayed: true,
              body: await response.clone().json() as Record<string, unknown>,
            });
            return response;
          }
          const suppliedGeneration = BigInt(
            captured.body.workerSessionGeneration,
          );
          if (
            captured.body.workerSessionId === serverSessionId ||
            suppliedGeneration !== serverGeneration
          ) {
            serverInvariantFailure = "fresh heartbeat did not take over";
            return protocolResponse(
              { code: "LEASE_FENCED", retryable: false },
              { status: 409 },
            );
          }
          serverSessionId = captured.body.workerSessionId;
          serverGeneration++;
          const response = heartbeatResponse(
            workerHostId,
            [],
            [],
            serverSessionId,
            String(serverGeneration),
            [restoredAssignment.attemptId],
          );
          secondResponses.push({
            replayed: false,
            body: await response.clone().json() as Record<string, unknown>,
          });
          queueMicrotask(() =>
            secondSupervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          return response;
        },
      });
      const secondSupervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: secondClient,
        registrationStore: store,
        spool,
        sleep: fastSleep,
      });
      secondSupervisorRef.current = secondSupervisor;
      await secondSupervisor.run();

      assertEquals(serverInvariantFailure, null);
      assertEquals(secondBodies.length, 2);
      assertEquals(secondResponses[0].replayed, true);
      assertEquals(secondResponses[1].replayed, false);
      assertEquals(secondBodies[0].rawBody, firstBodies[0].rawBody);
      assertEquals(secondBodies[0].key, firstBodies[0].key);
      assertEquals(secondBodies[0].body.workerSessionGeneration, "7");
      assertEquals(secondResponses[0].body.workerSessionGeneration, "8");
      assertEquals(secondBodies[1].body.workerSessionGeneration, "8");
      assertEquals(secondResponses[1].body.workerSessionGeneration, "9");
      assert(
        secondBodies[1].body.workerSessionId !==
          secondBodies[0].body.workerSessionId,
      );
      assert(secondBodies[1].key !== secondBodies[0].key);
      assertEquals(serverGeneration, 9n);
      assert(
        serverSessionId !== firstBodies[0].body.workerSessionId,
      );

      const restored = (await store.load())?.activeAssignments?.[
        restoredAssignment.attemptId
      ]?.assignment;
      assertEquals(restored?.workerSessionId, serverSessionId);
      assertEquals(restored?.workerSessionGeneration, "9");

      const staleClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: () =>
          Promise.resolve(
            protocolResponse(
              { code: "LEASE_FENCED", retryable: false },
              { status: 409 },
            ),
          ),
      });
      await assertRejects(
        () =>
          staleClient.heartbeat(
            firstBodies[0].body,
            undefined,
            crypto.randomUUID(),
          ),
        WorkerRequestError,
        "LEASE_FENCED",
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
// The heartbeat loop saves its body before it sends it, so a worker killed
// mid-request leaves a body that names its own session. When the server never
// committed that body, it accepts it from the host's current session and answers
// that session as new; the restarted worker must not take the answer for its own.
Deno.test(
  "restart sends an uncommitted heartbeat first without adopting its process session",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-heartbeat-uncommitted-restart-",
    });
    const workerHostId = crypto.randomUUID();
    const initialSessionId = crypto.randomUUID();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    // The host row and replay table of packages/persistence/src/heartbeat.ts:
    // a heartbeat must supply the host's generation; the host's own session
    // keeps it, any other session takes the host over at the next one. A claim
    // must name the host's current session, and the attempt it creates carries
    // that session.
    let serverSessionId: string = initialSessionId;
    let serverGeneration = 7n;
    const committed = new Map<
      string,
      { sessionId: string; generation: string }
    >();
    const answers: Array<{
      replayed: boolean;
      sessionId: string;
      generation: string;
    }> = [];
    const serveHeartbeat = (captured: CapturedHeartbeat): Response => {
      const replay = committed.get(captured.key);
      if (replay) {
        answers.push({ replayed: true, ...replay });
        return heartbeatResponse(
          workerHostId,
          [],
          [],
          replay.sessionId,
          replay.generation,
          [],
          { headers: { "Idempotent-Replayed": "true" } },
        );
      }
      if (BigInt(captured.body.workerSessionGeneration) !== serverGeneration) {
        return protocolResponse(
          { code: "LEASE_FENCED", retryable: false },
          { status: 409 },
        );
      }
      if (captured.body.workerSessionId !== serverSessionId) {
        serverSessionId = captured.body.workerSessionId;
        serverGeneration++;
      }
      const answer = {
        sessionId: serverSessionId,
        generation: String(serverGeneration),
      };
      committed.set(captured.key, answer);
      answers.push({ replayed: false, ...answer });
      return heartbeatResponse(
        workerHostId,
        [],
        [],
        answer.sessionId,
        answer.generation,
        [],
      );
    };
    const firstBodies: CapturedHeartbeat[] = [];
    const pendingAtSecondSend: { state?: RegistrationState | null } = {};
    const firstSupervisorRef: { current?: WorkerSupervisor } = {};
    try {
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: initialSessionId,
        workerSessionGeneration: "7",
      });
      const firstClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        requestTimeoutMs: 1_000,
        fetcher: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (!path.endsWith("/heartbeat")) {
            return protocolEmptyResponse({ status: 204 });
          }
          const captured = captureHeartbeat(init);
          firstBodies.push(captured);
          if (firstBodies.length === 1) return serveHeartbeat(captured);
          // The worker is killed with this body in flight; the server never
          // commits it.
          pendingAtSecondSend.state = await store.load();
          queueMicrotask(() =>
            firstSupervisorRef.current?.requestStop("TEST_RESTART")
          );
          return Promise.reject(new Error("RESPONSE_LOST"));
        },
      });
      const firstSupervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: firstClient,
        registrationStore: store,
        spool,
        sleep: fastSleep,
      });
      firstSupervisorRef.current = firstSupervisor;
      await firstSupervisor.run();

      assertEquals(firstBodies.length, 2);
      const killedSessionId = firstBodies[0].body.workerSessionId;
      assertEquals(firstBodies[1].body.workerSessionId, killedSessionId);
      assertEquals(firstBodies[1].body.workerSessionGeneration, "8");
      assertEquals(serverSessionId, killedSessionId);
      assertEquals(serverGeneration, 8n);
      assertEquals(committed.has(firstBodies[1].key), false);
      const persistedPending = pendingAtSecondSend.state?.pendingHeartbeat;
      assert(persistedPending !== undefined);
      assertEquals(persistedPending.idempotencyKey, firstBodies[1].key);
      assertEquals(
        JSON.stringify(persistedPending.body),
        firstBodies[1].rawBody,
      );
      assertEquals(
        (await store.load())?.pendingHeartbeat?.idempotencyKey,
        firstBodies[1].key,
      );

      const secondBodies: CapturedHeartbeat[] = [];
      const claimBodies: Array<{
        workerSessionId: string;
        workerSessionGeneration: string;
      }> = [];
      const claimedSessionIds: string[] = [];
      const secondSupervisorRef: { current?: WorkerSupervisor } = {};
      const secondClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        requestTimeoutMs: 1_000,
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            const captured = captureHeartbeat(init);
            secondBodies.push(captured);
            return Promise.resolve(serveHeartbeat(captured));
          }
          if (!path.endsWith("/claims")) {
            return Promise.resolve(protocolEmptyResponse({ status: 204 }));
          }
          const claim = JSON.parse(String(init?.body)) as {
            workerSessionId: string;
            workerSessionGeneration: string;
          };
          claimBodies.push(claim);
          queueMicrotask(() =>
            secondSupervisorRef.current?.requestStop("TEST_COMPLETE")
          );
          if (
            claim.workerSessionId !== serverSessionId ||
            BigInt(claim.workerSessionGeneration) !== serverGeneration
          ) {
            return Promise.resolve(protocolResponse(
              { code: "LEASE_FENCED", retryable: false },
              { status: 409 },
            ));
          }
          claimedSessionIds.push(serverSessionId);
          return Promise.resolve(protocolEmptyResponse({ status: 204 }));
        },
      });
      const secondSupervisor = new WorkerSupervisor({
        // The test counts the two heartbeats of the restart (the replayed one
        // and the follow-up) before the claim stops the supervisor. The claim
        // follows fsynced registration writes behind one lock, which took
        // longer than the 100 ms heartbeat interval on a loaded host (and with
        // every fsync delayed by 100 ms): a periodic third heartbeat went out
        // first. Neither heartbeat of the scenario waits for the interval, so
        // a longer one leaves the scenario as it was.
        config: { ...supervisorConfig(directory), heartbeatIntervalMs: 60_000 },
        client: secondClient,
        registrationStore: store,
        spool,
        executor: createDeterministicExecutor(),
        sleep: fastSleep,
      });
      secondSupervisorRef.current = secondSupervisor;
      await secondSupervisor.run();

      assertEquals(claimBodies.length, 1);
      assert(
        claimedSessionIds[0] !== killedSessionId,
        "the claim created its attempt under the killed process's session",
      );
      assertEquals(secondBodies.length, 2);
      assertEquals(secondBodies[0].rawBody, firstBodies[1].rawBody);
      assertEquals(secondBodies[0].key, firstBodies[1].key);
      assertEquals(answers[1], {
        replayed: false,
        sessionId: killedSessionId,
        generation: "8",
      });
      assertEquals(secondBodies[1].body.workerSessionGeneration, "8");
      assert(secondBodies[1].key !== secondBodies[0].key);
      assert(secondBodies[1].body.workerSessionId !== killedSessionId);
      assertEquals(
        claimBodies[0].workerSessionId,
        secondBodies[1].body.workerSessionId,
      );
      assertEquals(serverSessionId, secondBodies[1].body.workerSessionId);
      assertEquals(serverGeneration, 9n);
      const restored = await store.load();
      assertEquals(restored?.workerSessionId, serverSessionId);
      assertEquals(restored?.workerSessionGeneration, "9");
      assertEquals(restored?.pendingHeartbeat, undefined);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
