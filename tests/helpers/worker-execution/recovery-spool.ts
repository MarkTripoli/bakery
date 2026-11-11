import * as issue39 from "./recovery-case-imports.ts";
import { workerRunExecutables } from "../../../apps/worker/src/config.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";

const {
  assertEquals,
  assertRejects,
  assertThrows,
  EventSpool,
  SpoolError,
  WorkerApiClient,
  WorkerRequestError,
  RegistrationStore,
  WORKER_RESULT_MAX_BYTES,
  WORKER_SPOOL_MIN_BYTES,
  WORKER_SPOOL_MIN_RECORDS,
  terminalReservationBytes,
  resultRequest,
  ackPayload,
  ackResponse,
  fastSleep,
  localAssignment,
  openWorkerFixture,
  closeWorkerFixture,
  expireAndSupersedeAttempt,
  readExecutionState,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
  protocolEmptyResponse,
  protocolResponse,
  openRecoveryState,
  createRecoverySupervisor,
  workerActionOutputSchema,
  readWorkerConfig,
  readWorkerEnrollmentToken,
  readWorkerLaunchPermissions,
  WORKER_RUNTIME_ENVIRONMENT_NAMES,
} = issue39;
type WorkerResultRequest = issue39.WorkerResultRequest;
const assert: typeof issue39.assert = issue39.assert;
type EventSpool = issue39.EventSpoolInstance;
type SpoolError = issue39.SpoolErrorInstance;

// Cases are imported from the issue entrypoint.
Deno.test("terminal result usage survives the durable spool and the terminal request", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue52-usage-spool-" });
  try {
    const usage = {
      usageFactId: `fact-${crypto.randomUUID()}`,
      providerCallId: `call-${crypto.randomUUID()}`,
      provider: "openai",
      billingAccountId: "review-account",
      model: "gpt-5.6-luna",
      billingRoute: "api" as const,
      pricingMetadataSnapshot: "review-price-v1",
      inputTokens: "2",
      outputTokens: "3",
      costUsd: "0.040000",
      measurement: "reported" as const,
      occurredAt: new Date().toISOString(),
    };
    const attemptId = crypto.randomUUID();
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: WORKER_SPOOL_MIN_RECORDS,
      maxBytes: WORKER_SPOOL_MIN_BYTES,
    });
    const identity = {
      attemptId,
      leaseToken: "lease-token",
      fence: "1",
    };
    await spool.reserveTerminal(attemptId, terminalReservationBytes(identity));
    const record = await spool.enqueueNextResult({
      ...identity,
      eventId: crypto.randomUUID(),
      status: "completed",
      result: { ok: true },
      usage,
    });
    const reopen = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: WORKER_SPOOL_MIN_RECORDS,
      maxBytes: WORKER_SPOOL_MIN_BYTES,
    });
    const persisted = reopen.records().find((entry) =>
      entry.eventId === record.eventId
    );
    assertEquals(persisted?.payload, {
      status: "completed",
      result: { ok: true },
      usage,
    });
    const request = resultRequest(reopen.records()[0]!, "session", "1");
    assertEquals(request.usage, usage);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("a committed event replays its original ack after expiry without a second mutation", async () => {
  const fixture = await openWorkerFixture();
  try {
    const worker = await registeredWorker(fixture, {
      name: "issue39-recovery-ack",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const claim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(claim.status, 200);
    const assignment = await claim.json() as {
      attemptId: string;
      leaseToken: string;
      fence: string;
    };
    const eventId = crypto.randomUUID();
    const body = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      events: [{
        eventId,
        localSeq: "1",
        eventType: "job.accepted",
        payload: { acceptedAt: "2026-09-20T00:00:01.000Z" },
      }],
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      body,
      { idempotencyKey: eventId },
    );
    assertEquals(first.status, 200);
    const firstRaw = new Uint8Array(await first.arrayBuffer());

    await expireAndSupersedeAttempt(fixture.pgDatabase, job.jobId);
    const afterExpiry = await readExecutionState(fixture.pgDatabase, job.jobId);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      body,
      { idempotencyKey: eventId },
    );
    assertEquals(replay.status, 200);
    assertEquals(new Uint8Array(await replay.arrayBuffer()), firstRaw);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      afterExpiry,
    );
    assertEquals(afterExpiry.events.length, 1);
    assertEquals(afterExpiry.attempts[0].lastEventSeq, "1");
  } finally {
    await closeWorkerFixture(fixture);
  }
});
Deno.test("a committed result replays its original ack after expiry without a second mutation", async () => {
  const fixture = await openWorkerFixture();
  try {
    const worker = await registeredWorker(fixture, {
      name: "issue39-recovery-result-ack",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const claim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(claim.status, 200);
    const assignment = await claim.json() as {
      attemptId: string;
      leaseToken: string;
      fence: string;
    };
    const resultKey = crypto.randomUUID();
    const body = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      status: "failed",
      fault: {
        type: "about:blank",
        title: "Worker execution failed",
        status: 500,
        detail: "lost result acknowledgement",
        code: "TEST_LOST_RESULT_ACK",
        requestId: crypto.randomUUID(),
        retryable: false,
      },
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      body,
      { idempotencyKey: resultKey },
    );
    assertEquals(first.status, 200);
    const firstRaw = new Uint8Array(await first.arrayBuffer());

    await expireAndSupersedeAttempt(fixture.pgDatabase, job.jobId);
    const afterExpiry = await readExecutionState(fixture.pgDatabase, job.jobId);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      body,
      { idempotencyKey: resultKey },
    );
    assertEquals(replay.status, 200);
    assertEquals(new Uint8Array(await replay.arrayBuffer()), firstRaw);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      afterExpiry,
    );
    assertEquals(afterExpiry.events.length, 1);
    assertEquals(afterExpiry.events[0].eventType, "job.failed");
    assertEquals(afterExpiry.attempts[0].lastEventSeq, "1");
  } finally {
    await closeWorkerFixture(fixture);
  }
});
Deno.test("bodyless result acknowledgements are rejected", async () => {
  const assignment = localAssignment();
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () => Promise.resolve(protocolEmptyResponse({ status: 204 })),
  });
  const resultRequest = {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: "1",
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
    workerSessionId: assignment.workerSessionId,
    workerSessionGeneration: assignment.workerSessionGeneration,
  } as unknown as WorkerResultRequest;
  await assertRejects(
    () =>
      client.postResult(
        assignment.attemptId,
        resultRequest,
        crypto.randomUUID(),
      ),
    WorkerRequestError,
    "WORKER_RESPONSE_STATUS_INVALID",
  );
});
Deno.test(
  "supervisor retains and replays spool after every invalid ACK response",
  async () => {
    const cases = [
      {
        name: "valid-looking 201",
        error: "WORKER_RESPONSE_STATUS_INVALID",
        response: (init: RequestInit) =>
          protocolResponse(ackPayload(init), { status: 201 }),
      },
      {
        name: "valid-looking 202",
        error: "WORKER_RESPONSE_STATUS_INVALID",
        response: (init: RequestInit) =>
          protocolResponse(ackPayload(init), { status: 202 }),
      },
      {
        name: "bodyless 200",
        error: "WORKER_RESPONSE_BODY_INVALID",
        response: (_init: RequestInit) =>
          protocolEmptyResponse({ status: 200 }),
      },
      {
        name: "malformed 200",
        error: "WORKER_RESPONSE_ACK_INVALID",
        response: (_init: RequestInit) => protocolResponse({}, { status: 200 }),
      },
      {
        name: "valid-looking 206",
        error: "WORKER_RESPONSE_STATUS_INVALID",
        response: (init: RequestInit) =>
          protocolResponse(ackPayload(init), { status: 206 }),
      },
      ...(["ignored", "rejected"] as const).map((status) => ({
        name: status,
        error: "WORKER_ACK_REJECTED",
        response: (init: RequestInit) =>
          protocolResponse(
            { ...ackPayload(init), status },
            { status: 200 },
          ),
      })),
      {
        name: "wrong key",
        error: "WORKER_ACK_INVALID",
        response: (init: RequestInit) =>
          protocolResponse(
            { ...ackPayload(init), eventId: crypto.randomUUID() },
            { status: 200 },
          ),
      },
      {
        name: "wrong sequence",
        error: "WORKER_ACK_INVALID",
        response: (init: RequestInit) =>
          protocolResponse(
            { ...ackPayload(init), lastEventSeq: "2" },
            { status: 200 },
          ),
      },
    ];
    for (const kind of ["event", "result"] as const) {
      for (const testCase of cases) {
        const directory = await Deno.makeTempDir({
          prefix: `issue39-invalid-ack-${kind}-`,
        });
        try {
          const assignment = localAssignment();
          const spoolPath = `${directory}/spool.json`;
          const { registrationStore, spool } = await openRecoveryState(
            directory,
            { spoolPath, maxRecords: 10, maxBytes: 20_000 },
          );
          await registrationStore.saveRegistered("credential", {
            workerHostId: assignment.workerHostId,
            principalId: crypto.randomUUID(),
            status: "registered",
            registrationGeneration: 1,
            workerSessionId: assignment.workerSessionId,
            workerSessionGeneration: assignment.workerSessionGeneration,
          });
          if (kind === "result") {
            await registrationStore.saveActiveAssignment({
              assignment,
              nextLocalSeq: "2",
              ackedLocalSeq: "0",
            });
          }
          if (kind === "event") {
            await spool.enqueueEvent({
              attemptId: assignment.attemptId,
              leaseToken: assignment.leaseToken,
              fence: assignment.fence,
              localSeq: "1",
              eventId: crypto.randomUUID(),
              eventType: "job.progress",
              payload: { message: "durable", percent: 1 },
            });
          } else {
            await spool.enqueueResult({
              attemptId: assignment.attemptId,
              leaseToken: assignment.leaseToken,
              fence: assignment.fence,
              localSeq: "1",
              eventId: crypto.randomUUID(),
              status: "failed",
              fault: {
                type: "about:blank",
                title: "Worker execution failed",
                status: 500,
                detail: "durable",
                code: "TEST",
                requestId: crypto.randomUUID(),
                retryable: false,
              },
            });
          }
          const invalidClient = new WorkerApiClient({
            baseUrl: "http://127.0.0.1:8788",
            credential: "credential",
            fetcher: (_input, init) =>
              Promise.resolve(testCase.response(init ?? {})),
          });
          const invalidSupervisor = createRecoverySupervisor(directory, {
            client: invalidClient,
            registrationStore,
            spool,
            sleep: fastSleep,
          });
          await assertRejects(
            () => invalidSupervisor.replayStandalone(),
            WorkerRequestError,
            testCase.error,
          );
          assertEquals((await spool.records()).length, 1, testCase.name);

          const { spool: restartedSpool } = await openRecoveryState(
            directory,
            { spoolPath, maxRecords: 10, maxBytes: 20_000 },
          );
          assertEquals(
            (await restartedSpool.records()).length,
            1,
            `${kind}:${testCase.name}:journal discarded`,
          );
          const validClient = new WorkerApiClient({
            baseUrl: "http://127.0.0.1:8788",
            credential: "credential",
            fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
          });
          const restarted = createRecoverySupervisor(directory, {
            client: validClient,
            registrationStore,
            spool: restartedSpool,
            sleep: fastSleep,
          });
          await restarted.replayStandalone();
          assertEquals(
            await restartedSpool.records(),
            [],
            `${kind}:${testCase.name}:valid replay did not drain`,
          );
        } finally {
          await Deno.remove(directory, { recursive: true }).catch(() =>
            undefined
          );
        }
      }
    }
  },
);
Deno.test({
  name:
    "persisted worker spool preserves identity, order, digests, contiguous ack, and bounded failure",
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "issue39-spool-" });
    const attemptId = crypto.randomUUID();
    const enqueue = (
      spool: EventSpool,
      localSeq: string,
      payload: { message: string; percent: number },
    ) =>
      spool.enqueueEvent({
        attemptId,
        leaseToken: "lease-token",
        fence: "1",
        localSeq,
        eventId: crypto.randomUUID(),
        eventType: "job.progress",
        payload,
      });
    try {
      const first = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 4,
        maxBytes: 20_000,
      });
      for (const localSeq of ["1", "2", "3"]) {
        await enqueue(first, localSeq, {
          message: `event-${localSeq}`,
          percent: Number(localSeq),
        });
      }
      const beforeReopen = (await first.records()).map((
        { eventId, localSeq, digest },
      ) => ({
        eventId,
        localSeq,
        digest,
      }));

      const reopened = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 4,
        maxBytes: 20_000,
      });
      assertEquals(
        (await reopened.records()).map(({ eventId, localSeq, digest }) => ({
          eventId,
          localSeq,
          digest,
        })),
        beforeReopen,
      );
      await reopened.acknowledge(attemptId, "1");
      assertEquals((await reopened.records()).map(({ localSeq }) => localSeq), [
        "2",
        "3",
      ]);

      const reopenedAfterAck = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 4,
        maxBytes: 20_000,
      });
      await reopenedAfterAck.acknowledge(attemptId, "3");
      assertEquals(await reopenedAfterAck.records(), []);
      const compacted = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 4,
        maxBytes: 20_000,
      });
      assertEquals(compacted.nextLocalSeq(attemptId), "4");
      await enqueue(compacted, "4", {
        message: "recordless-metadata-recovered",
        percent: 100,
      });

      const bounded = await EventSpool.open({
        path: `${directory}/count/spool.json`,
        maxRecords: 2,
        maxBytes: 20_000,
      });
      await enqueue(bounded, "1", { message: "count-1", percent: 1 });
      await enqueue(bounded, "2", { message: "count-2", percent: 2 });
      let countError: unknown;
      try {
        await enqueue(bounded, "3", { message: "count-3", percent: 3 });
      } catch (error) {
        countError = error;
      }
      assertEquals(countError instanceof SpoolError, true);
      assertEquals((countError as SpoolError).code, "SPOOL_CAPACITY_EXCEEDED");
      assertEquals((await bounded.records()).length, 2);
      const boundedReopen = await EventSpool.open({
        path: `${directory}/count/spool.json`,
        maxRecords: 2,
        maxBytes: 20_000,
      });
      assertEquals((await boundedReopen.records()).length, 2);
      await assertRejects(
        () =>
          EventSpool.open({
            path: `${directory}/count/spool.json`,
            maxRecords: 1,
            maxBytes: 20_000,
          }),
        SpoolError,
        "SPOOL_CAPACITY_EXCEEDED",
      );

      const bytesBounded = await EventSpool.open({
        path: `${directory}/bytes/spool.json`,
        maxRecords: 10,
        maxBytes: 1_000,
      });
      let bytesError: unknown;
      try {
        await enqueue(bytesBounded, "1", {
          message: "x".repeat(4_000),
          percent: 1,
        });
      } catch (error) {
        bytesError = error;
      }
      assertEquals(bytesError instanceof SpoolError, true);
      assertEquals((bytesError as SpoolError).code, "SPOOL_CAPACITY_EXCEEDED");
      assertEquals(await bytesBounded.records(), []);
      const terminalAttemptId = crypto.randomUUID();
      const terminalBase = {
        headSha: "",
        baseSha: "base",
        sessionId: terminalAttemptId,
        artifacts: [],
      };
      const terminalEnvelope = {
        status: "completed",
        result: terminalBase,
      };
      const terminalResult = {
        ...terminalBase,
        headSha: "h".repeat(
          WORKER_RESULT_MAX_BYTES -
            new TextEncoder().encode(JSON.stringify(terminalEnvelope))
              .byteLength +
            terminalBase.headSha.length,
        ),
      };
      const terminalPayload = {
        status: "completed" as const,
        result: terminalResult,
      };
      workerActionOutputSchema("harness.implement").parse(terminalResult);
      assertEquals(
        new TextEncoder().encode(JSON.stringify(terminalPayload)).byteLength,
        WORKER_RESULT_MAX_BYTES,
      );
      const terminalSpoolPath = `${directory}/terminal/spool.json`;
      const terminalSpool = await EventSpool.open({
        path: terminalSpoolPath,
        maxRecords: 1,
        maxBytes: WORKER_SPOOL_MIN_BYTES,
      });
      await terminalSpool.enqueueResult({
        attemptId: terminalAttemptId,
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        ...terminalPayload,
      });
      const terminalReopen = await EventSpool.open({
        path: terminalSpoolPath,
        maxRecords: 1,
        maxBytes: WORKER_SPOOL_MIN_BYTES,
      });
      assertEquals(terminalReopen.records()[0]?.payload, terminalPayload);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test({
  name: "worker spool and registration mutations reopen without lost updates",
  fn: async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue39-concurrency-",
    });
    try {
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 200_000,
      });
      const attemptId = crypto.randomUUID();
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          spool.enqueueEvent({
            attemptId,
            leaseToken: "lease-token",
            fence: "1",
            localSeq: String(index + 1),
            eventId: crypto.randomUUID(),
            eventType: "job.progress",
            payload: { message: `event-${index}`, percent: index },
          })),
      );
      await Promise.all(
        Array.from(
          { length: 20 },
          (_, index) => spool.acknowledge(attemptId, String(index + 1)),
        ),
      );
      const reopenedSpool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 200_000,
      });
      assertEquals(await reopenedSpool.records(), []);
      assertEquals(reopenedSpool.journalState(attemptId), {
        nextLocalSeq: "21",
        ackedLocalSeq: "20",
      });

      const store = new RegistrationStore(`${directory}/registration.json`);
      const registered = await store.saveRegistered("credential", {
        workerHostId: crypto.randomUUID(),
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      });
      const assignments = Array.from({ length: 4 }, () => localAssignment());
      await Promise.all(
        assignments.map((assignment) =>
          store.saveActiveAssignment({
            assignment,
            nextLocalSeq: "1",
            ackedLocalSeq: "0",
            renewalKey: crypto.randomUUID(),
          })
        ),
      );
      await Promise.all([
        store.savePendingClaimKey(crypto.randomUUID()),
        ...Array.from(
          { length: 20 },
          (_, index) =>
            store.saveCommandOutcome(
              crypto.randomUUID(),
              index % 2 ? "rejected" : "acknowledged",
            ),
        ),
        ...assignments.map((assignment) =>
          store.savePendingRenewalKey(assignment.attemptId, crypto.randomUUID())
        ),
      ]);
      const reopenedStore = new RegistrationStore(
        `${directory}/registration.json`,
      );
      const persisted = await reopenedStore.load();
      assertEquals(persisted?.pendingClaimKey !== undefined, true);
      assertEquals(Object.keys(persisted?.commandOutcomes ?? {}).length, 20);
      assertEquals(Object.keys(persisted?.activeAssignments ?? {}).length, 4);
      assertEquals(Object.keys(persisted?.pendingRenewalKeys ?? {}).length, 4);
      assertEquals(
        persisted?.workerCredential,
        registered.workerCredential,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test("registration renewal pruning follows persisted active assignments", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue39-renewal-prune-",
  });
  try {
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    const active = localAssignment();
    const stale = crypto.randomUUID();
    await store.saveActiveAssignment({
      assignment: active,
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
      renewalKey: "active-renewal-key",
    });
    const state = await store.load();
    assertEquals(
      state?.pendingRenewalKeys?.[active.attemptId],
      "active-renewal-key",
    );
    const raw = JSON.parse(
      await Deno.readTextFile(`${directory}/registration.json`),
    ) as Record<string, unknown>;
    raw.pendingRenewalKeys = {
      ...(raw.pendingRenewalKeys as Record<string, string>),
      [stale]: "stale-renewal-key",
    };
    await Deno.writeTextFile(
      `${directory}/registration.json`,
      `${JSON.stringify(raw)}\n`,
    );
    const pruned = await store.prunePendingRenewalKeys();
    assertEquals(pruned.pendingRenewalKeys, {
      [active.attemptId]: "active-renewal-key",
    });
    assertEquals(
      pruned.activeAssignments?.[active.attemptId].renewalKey,
      "active-renewal-key",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test({
  name: "worker enrollment credentials use protected file input only",
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "issue39-config-" });
    const tokenPath = `${directory}/enrollment-token`;
    const base = {
      BAKERY_ENV: "test",
      BAKERY_SERVER_URL: "http://127.0.0.1:8788",
      BAKERY_WORKER_CAPABILITIES: "git",
      HOME: directory,
    };
    try {
      await Deno.writeTextFile(tokenPath, "enrollment-secret\n");
      await Deno.chmod(tokenPath, 0o600);
      const configured = readWorkerConfig({
        ...base,
        BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: tokenPath,
      });
      assertEquals(configured.enrollmentToken, undefined);
      assertEquals(configured.enrollmentTokenPath, tokenPath);
      assertEquals(
        readWorkerEnrollmentToken({ path: tokenPath }),
        "enrollment-secret",
      );
      const composeConfig = readWorkerConfig({
        ...base,
        BAKERY_ENV: "development",
        BAKERY_SERVER_URL: "http://server:8000",
        BAKERY_WORKER_STATE_DIR: `${directory}/worker-state`,
      });
      assertEquals(composeConfig.serverUrl, "http://server:8000");
      const minimumConfig = readWorkerConfig({
        ...base,
        BAKERY_WORKER_SPOOL_BYTES: String(WORKER_SPOOL_MIN_BYTES),
      });
      assertEquals(minimumConfig.spoolMaxBytes, WORKER_SPOOL_MIN_BYTES);
      assertThrows(
        () =>
          readWorkerConfig({
            ...base,
            BAKERY_WORKER_SPOOL_BYTES: String(WORKER_SPOOL_MIN_BYTES - 1),
          }),
        Error,
        "BAKERY_WORKER_SPOOL_BYTES_INVALID",
      );

      for (
        const BAKERY_SERVER_URL of [
          "http://server:8001",
          "http://server:8000/other",
          "http://worker:8000",
        ]
      ) {
        assertThrows(
          () => readWorkerConfig({ ...base, BAKERY_SERVER_URL }),
          Error,
          "BAKERY_SERVER_URL_INVALID",
        );
      }

      assertThrows(
        () =>
          readWorkerConfig({
            ...base,
            BAKERY_WORKER_ENROLLMENT_TOKEN: "secret-in-environment",
          }),
        Error,
        "BAKERY_WORKER_ENROLLMENT_TOKEN_ENV_UNSUPPORTED",
      );

      await Deno.chmod(tokenPath, 0o644);
      assertThrows(
        () => readWorkerEnrollmentToken({ path: tokenPath }),
        Error,
        "BAKERY_WORKER_ENROLLMENT_TOKEN_INPUT_INVALID",
      );
      const missing = readWorkerConfig({
        ...base,
        BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: `${directory}/missing`,
      });
      assertEquals(missing.enrollmentToken, undefined);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
});
Deno.test("supported spool minima admit one reserved terminal result", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue52-spool-min-" });
  try {
    const terminalBytes = terminalReservationBytes({
      attemptId: "c".repeat(36),
      leaseToken: "lease-token",
      fence: "1",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: WORKER_SPOOL_MIN_RECORDS,
      maxBytes: WORKER_SPOOL_MIN_BYTES,
    });
    await spool.reserveTerminal("c".repeat(36), terminalBytes);
    const reopen = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: WORKER_SPOOL_MIN_RECORDS,
      maxBytes: WORKER_SPOOL_MIN_BYTES,
    });
    await assertRejects(
      () => reopen.reserveTerminal("d".repeat(36), terminalBytes),
      SpoolError,
      "SPOOL_CAPACITY_EXCEEDED",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("worker net grants preserve effective default ports and IPv6", () => {
  const common = {
    BAKERY_WORKER_CAPABILITIES: "git",
    HOME: "/tmp",
  };
  assertEquals(
    readWorkerLaunchPermissions({
      ...common,
      BAKERY_ENV: "test",
      BAKERY_SERVER_URL: "http://127.0.0.1:80",
    }, "/workspace").net,
    ["127.0.0.1:80"],
  );
  assertEquals(
    readWorkerLaunchPermissions({
      ...common,
      BAKERY_ENV: "production",
      BAKERY_SERVER_URL: "https://bakery.example.com:443",
    }, "/workspace").net,
    ["bakery.example.com:443"],
  );
  assertEquals(
    readWorkerLaunchPermissions({
      ...common,
      BAKERY_ENV: "production",
      BAKERY_SERVER_URL: "https://[2001:db8::1]:443",
    }, "/workspace").net,
    ["[2001:db8::1]:443"],
  );
});

Deno.test("worker cgroup launch grants stay inside canonical subtree", () => {
  const common = {
    BAKERY_ENV: "test",
    BAKERY_SERVER_URL: "http://127.0.0.1:80",
    BAKERY_WORKER_CAPABILITIES: "git",
    HOME: "/tmp",
  };
  for (
    const invalid of [
      "/",
      "/etc",
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/../etc",
      "/sys/fs/cgroup/worker-subtree/",
    ]
  ) {
    assertThrows(
      () =>
        readWorkerLaunchPermissions({
          ...common,
          BAKERY_WORKER_CGROUP_ROOT: invalid,
        }, "/workspace"),
      Error,
      "BAKERY_WORKER_CGROUP_ROOT_INVALID",
    );
  }
  const permissions = readWorkerLaunchPermissions({
    ...common,
    BAKERY_WORKER_CGROUP_ROOT: "/sys/fs/cgroup/worker-subtree",
  }, "/workspace");
  assertEquals(permissions.run, [
    Deno.execPath(),
    "/usr/bin/bwrap",
    "/usr/bin/ldd",
    "/usr/bin/kill",
  ]);
  assertEquals(permissions.sys, ["uid"]);
  assert(permissions.read.includes("/sys/fs/cgroup/worker-subtree"));
  assert(permissions.write.includes("/sys/fs/cgroup/worker-subtree"));
});
Deno.test("worker launch grants fail closed without prompting", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue39-env-smoke-" });
  const deniedDirectory = await Deno.makeTempDir({
    prefix: "issue39-denied-read-",
  });
  const scriptPath = `${directory}/env-smoke.ts`;
  const deniedPath = `${deniedDirectory}/denied.txt`;
  const stateDir = `${directory}/state`;
  const environment = {
    BAKERY_ENV: "development",
    BAKERY_SERVER_URL: "http://server:8000",
    BAKERY_WORKER_STATE_DIR: stateDir,
    BAKERY_WORKER_CAPABILITIES: "git",
    HOME: "/tmp",
    PATH: "/bin",
    TMPDIR: "/tmp",
  };
  await Deno.writeTextFile(deniedPath, "secret");
  await Deno.writeTextFile(
    scriptPath,
    `import { readWorkerConfig } from ${
      JSON.stringify(
        new URL("../../../apps/worker/src/config.ts", import.meta.url).href,
      )
    };
import { SkillCache } from ${
      JSON.stringify(
        new URL("../../../apps/worker/src/skill-cache.ts", import.meta.url)
          .href,
      )
    };
const deniedPath = Deno.args[0];
try {
  await Deno.readTextFile(deniedPath);
  console.error("DENIED_READ_WAS_ALLOWED");
  Deno.exit(1);
} catch (error) {
  if (!(error instanceof Deno.errors.NotCapable)) {
    console.error("DENIED_READ_FAILED_UNEXPECTEDLY");
    Deno.exit(1);
  }
}
try {
  Deno.hostname();
  console.error("DENIED_HOSTNAME_WAS_ALLOWED");
  Deno.exit(1);
} catch (error) {
  if (!(error instanceof Deno.errors.NotCapable)) {
    console.error("DENIED_HOSTNAME_FAILED_UNEXPECTEDLY");
    Deno.exit(1);
  }
}
const config = readWorkerConfig();
if (
  config.serverUrl !== "http://server:8000" ||
  config.stateDir !== ${JSON.stringify(stateDir)} ||
  Deno.uid() === null
) Deno.exit(1);
await new SkillCache(config.stateDir).initialize();
console.log("CACHE_ACCESS_ALLOWED_UNRELATED_CAPABILITIES_DENIED");`,
  );
  const permissions = readWorkerLaunchPermissions(environment, Deno.cwd());
  // Normal launchers do not grant the native CI probe variables.
  const environmentGrant = WORKER_RUNTIME_ENVIRONMENT_NAMES.filter((name) =>
    name !== "BAKERY_WORKER_STARTUP_MARKER" &&
    name !== "BAKERY_WORKER_NATIVE_SMOKE"
  ).join(",");
  try {
    const helper = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        `--allow-env=${environmentGrant}`,
        `--allow-read=${permissions.read.join(",")}`,
        "apps/worker/scripts/worker-permissions.ts",
      ],
      cwd: Deno.cwd(),
      env: environment,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      helper.success,
      true,
      new TextDecoder().decode(helper.stderr),
    );
    const [read, write, net, run, sys] = new TextDecoder().decode(helper.stdout)
      .trim().split("\n");
    // The launch grant is the runtime plus the native sandbox helpers.
    assertEquals(run, workerRunExecutables(Deno.execPath()).join(","));
    assertEquals(sys, "uid");
    const readGrant = [read, directory].join(",");
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        // The worker imports bare workspace specifiers mapped only by the root config.
        "--config=deno.json",
        `--allow-env=${environmentGrant}`,
        `--allow-read=${readGrant}`,
        `--allow-write=${write}`,
        `--allow-net=${net}`,
        `--allow-sys=${sys}`,
        scriptPath,
        deniedPath,
      ],
      cwd: Deno.cwd(),
      env: environment,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.success, true, stderr);
    assert(
      stdout.includes("CACHE_ACCESS_ALLOWED_UNRELATED_CAPABILITIES_DENIED"),
      stderr,
    );
    assertEquals(stderr, "", "denied permissions must not prompt");
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    await Deno.remove(deniedDirectory, { recursive: true }).catch(() =>
      undefined
    );
  }
});
