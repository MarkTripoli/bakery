import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  EventSpool,
  WorkerApiClient,
  RegistrationStore,
  ackResponse,
  fastSleep,
  heartbeatResponse,
  openWorkerFixture,
  closeWorkerFixture,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  protocolResponse,
  supervisorConfig,
  openRecoveryState,
  createRecoverySupervisor,
  main,
  readWorkerConfig,
} = issue39;
const assert: typeof issue39.assert = issue39.assert;
type WorkerSupervisor = issue39.WorkerSupervisorInstance;
type EventSpool = issue39.EventSpoolInstance;

// Cases are imported from the issue entrypoint.
Deno.test({
  name: "supervisor heartbeats without an executor and never claims",
  fn: async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-no-executor-",
    });
    try {
      const workerHostId = crypto.randomUUID();
      const { registrationStore: store, spool } = await openRecoveryState(
        directory,
        { maxRecords: 10, maxBytes: 20_000 },
      );
      await store.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            setTimeout(() => supervisor?.requestStop("TEST_COMPLETE"), 0);
            return Promise.resolve(heartbeatResponse(workerHostId));
          }
          if (path.endsWith("/claims")) {
            return Promise.reject(new Error("HEARTBEAT_ONLY_MUST_NOT_CLAIM"));
          }
          return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
        },
      });
      const supervisor = createRecoverySupervisor(directory, {
        client,
        registrationStore: store,
        spool,
        sleep: fastSleep,
      });
      await supervisor.run();
      assertEquals(supervisor.stopReason, "TEST_COMPLETE");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test({
  name: "malformed claim success preserves the durable pending claim key",
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "issue39-claim-key-" });
    try {
      const { registrationStore, spool } = await openRecoveryState(
        directory,
        { maxRecords: 10, maxBytes: 20_000 },
      );
      const workerHostId = crypto.randomUUID();
      await registrationStore.saveRegistered("credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      let claimCount = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            return Promise.resolve(protocolResponse({
              workerHostId,
              status: "accepted",
              receivedAt: "2026-09-20T00:00:00.000Z",
              pendingCommands: [],
              commandAcks: [],
              workerSessionId: crypto.randomUUID(),
              workerSessionGeneration: "1",
              serverTime: "2026-09-20T00:00:00.000Z",
              inventoryRevision: 1,
            }));
          }
          if (path.endsWith("/claims")) {
            claimCount++;
            return Promise.resolve(protocolResponse({}));
          }
          return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
        },
      });
      const supervisor = createRecoverySupervisor(directory, {
        client,
        registrationStore,
        spool,
        executor: {
          execute: (assignment) =>
            Promise.resolve({
              status: "completed",
              result: {
                headSha: `test-head-${assignment.jobId}`,
                baseSha: `test-base-${assignment.jobId}`,
                sessionId: assignment.attemptId,
                artifacts: [],
              },
            }),
        },
        sleep: fastSleep,
      });
      await supervisor.run();
      const state = await registrationStore.load();
      assertEquals(claimCount, 1);
      assertEquals(typeof state?.pendingClaimKey, "string");
      assertEquals(supervisor.stopReason, "WORKER_RESPONSE_ASSIGNMENT_INVALID");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test({
  name:
    "WorkerSupervisor claims, renews, spools, and completes through the real API",
  fn: async () => {
    const fixture = await openWorkerFixture();
    const directory = await Deno.makeTempDir({ prefix: "issue39-supervisor-" });
    try {
      const worker = await registeredWorker(fixture, {
        name: "issue39-supervisor-real",
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const registrationStore = new RegistrationStore(
        `${directory}/registration.json`,
      );
      await registrationStore.saveRegistered(
        worker.credential,
        worker.registration,
      );
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      });
      let requestStop = () => {};
      let renewalCount = 0;
      let renewalResolve!: () => void;
      const renewalSeen = new Promise<void>((resolve) => {
        renewalResolve = resolve;
      });
      const client = new WorkerApiClient({
        baseUrl: fixture.config.publicBaseUrl,
        fetcher: async (input, init) => {
          const response = await fixture.app.fetch(new Request(input, init));
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/lease-renewals") && response.ok) {
            renewalCount++;
            renewalResolve();
          }
          if (path.endsWith("/result") && response.ok) {
            queueMicrotask(requestStop);
          }
          return response;
        },
        requestTimeoutMs: 1_000,
      });
      const supervisor = createRecoverySupervisor(directory, {
        serverUrl: fixture.config.publicBaseUrl,
        client,
        registrationStore,
        spool,
        executor: {
          execute: async (assignment) => {
            await Promise.race([
              renewalSeen,
              new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
            ]);
            return {
              status: "completed",
              result: {
                headSha: `test-head-${assignment.jobId}`,
                baseSha: `test-base-${assignment.jobId}`,
                sessionId: job.sessionId,
                artifacts: [],
              },
            };
          },
        },
        sleep: fastSleep,
      });
      requestStop = () => supervisor.requestStop("TEST_COMPLETE");
      await supervisor.run();
      assertEquals(supervisor.stopReason, "TEST_COMPLETE");
      assertEquals(renewalCount > 0, true);
      assertEquals((await spool.records()).length, 0);
      assertEquals(
        (await registrationStore.load())?.pendingClaimKey,
        undefined,
      );
      const state = await readExecutionState(fixture.pgDatabase, job.jobId);
      assertEquals(state.events.map(({ eventType }) => eventType), [
        "job.accepted",
        "job.started",
        "job.succeeded",
      ]);
      assertEquals(state.attempts[0].status, "completed");
      assertEquals(state.job.status, "completed");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
      await closeWorkerFixture(fixture);
    }
  },
});
Deno.test({
  name:
    "durable spool resumes acknowledgements, releases stale attempts, and drains",
  fn: async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-spool-resume-",
    });
    const resumedAttemptId = crypto.randomUUID();
    const enqueue = (
      spool: EventSpool,
      attemptId: string,
      message: string,
    ) =>
      spool.enqueueEvent({
        attemptId,
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        eventType: "job.progress",
        payload: { message, percent: 50 },
      });
    try {
      const crashed = await EventSpool.open({
        path: `${directory}/durable.json`,
        maxRecords: 10,
        maxBytes: 20_000,
      });
      await enqueue(crashed, resumedAttemptId, "resumed");
      const resumed = await EventSpool.open({
        path: `${directory}/durable.json`,
        maxRecords: 10,
        maxBytes: 20_000,
      });
      const ackClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
      });
      const resumedSupervisor = createRecoverySupervisor(directory, {
        client: ackClient,
        registrationStore: new RegistrationStore(
          `${directory}/registration.json`,
        ),
        spool: resumed,
        sleep: fastSleep,
      });
      await resumedSupervisor.replayStandalone();
      assertEquals(await resumed.records(), []);

      const stale = await EventSpool.open({
        path: `${directory}/stale.json`,
        maxRecords: 2,
        maxBytes: 20_000,
      });
      const staleAttemptId = crypto.randomUUID();
      const validAttemptId = crypto.randomUUID();
      await enqueue(stale, staleAttemptId, "stale");
      await enqueue(stale, validAttemptId, "later");
      assertEquals((await stale.records()).length, 2);
      assert((await stale.records()).length <= stale.maxRecords);
      let staleRequests = 0;
      let validRequests = 0;
      const staleClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith(`/${staleAttemptId}/events`)) {
            staleRequests++;
            return Promise.resolve(
              protocolResponse(
                { code: "LEASE_FENCED", retryable: false },
                { status: 409 },
              ),
            );
          }
          validRequests++;
          return Promise.resolve(ackResponse(init));
        },
      });
      const staleSupervisor = createRecoverySupervisor(directory, {
        client: staleClient,
        registrationStore: new RegistrationStore(
          `${directory}/registration.json`,
        ),
        spool: stale,
        sleep: fastSleep,
      });
      await staleSupervisor.replayStandalone(undefined, {
        discardUnregisteredLeaseLoss: true,
      });
      assertEquals(staleRequests, 1);
      assertEquals(validRequests, 0);
      assertEquals(
        (await stale.records()).map(({ attemptId }) => attemptId),
        [validAttemptId],
      );
      assertEquals(staleSupervisor.stopReason, null);
      await staleSupervisor.replayStandalone();

      await staleSupervisor.drain();
      assertEquals(staleRequests, 1);
      assertEquals(validRequests, 1);
      assertEquals(await stale.records(), []);
      assertEquals(staleSupervisor.isDraining, true);
      assertEquals(staleSupervisor.stopReason, "DRAINED");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test({
  name: "production main with no supported actions heartbeats and never claims",
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "issue39-main-" });
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
        maxRecords: 100,
        maxBytes: 100_000,
      });
      let supervisor: WorkerSupervisor | undefined;
      let heartbeatCount = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/claims") || path.endsWith("/result")) {
            throw new Error("DEFAULT_WORKER_MUST_NOT_CLAIM");
          }
          if (path.endsWith("/heartbeat")) {
            heartbeatCount++;
            setTimeout(() => supervisor?.requestStop("TEST_COMPLETE"), 0);
            return Promise.resolve(heartbeatResponse(workerHostId));
          }
          return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
        },
      });
      await main({
        config: supervisorConfig(directory),
        client,
        registrationStore,
        spool,
        executor: {
          supportedActions: [],
          execute: () => Promise.reject(new Error("MUST_NOT_EXECUTE")),
        },
        onSupervisor: (value) => supervisor = value,
      });
      assertEquals(heartbeatCount >= 1, true);
      assertEquals(await spool.records(), []);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test(
  "production main restart uses persisted credential without enrollment secret",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-main-restart-",
    });
    try {
      const missingSecret = `${directory}/missing-enrollment-token`;
      const config = readWorkerConfig({
        BAKERY_ENV: "production",
        BAKERY_SERVER_URL: "https://worker.example",
        BAKERY_WORKER_CAPABILITIES: "git",
        BAKERY_WORKER_STATE_DIR: directory,
        BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: missingSecret,
        HOME: directory,
      });
      const workerHostId = crypto.randomUUID();
      const registrationStore = new RegistrationStore(config.registrationPath);
      await registrationStore.saveRegistered("persisted-credential", {
        workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      const spool = await EventSpool.open({
        path: config.spoolPath,
        maxRecords: config.spoolMaxRecords,
        maxBytes: config.spoolMaxBytes,
      });
      let supervisor: WorkerSupervisor | undefined;
      let heartbeatCount = 0;
      let authorization = "";
      const client = new WorkerApiClient({
        baseUrl: config.serverUrl,
        fetcher: (input, init) => {
          authorization = new Headers(init?.headers).get("Authorization") ??
            "";
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            heartbeatCount++;
            setTimeout(() => supervisor?.requestStop("TEST_COMPLETE"), 0);
            return Promise.resolve(heartbeatResponse(workerHostId));
          }
          throw new Error(`UNEXPECTED_WORKER_PATH:${path}`);
        },
      });
      await main({
        config,
        client,
        registrationStore,
        spool,
        executor: {
          supportedActions: [],
          execute: () => Promise.reject(new Error("MUST_NOT_EXECUTE")),
        },
        onSupervisor: (value) => supervisor = value,
      });
      assertEquals(heartbeatCount >= 1, true);
      assertEquals(authorization, "Bearer persisted-credential");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
