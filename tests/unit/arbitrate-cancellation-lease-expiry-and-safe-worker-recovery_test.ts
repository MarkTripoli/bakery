import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyControlAction,
  createControlState,
  MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT,
  MAX_TERMINATION_EVIDENCE,
  mergeTerminationEvidence,
  terminationEvidence,
  TerminationEvidenceCapacityError,
} from "../../apps/worker/src/control-state.ts";
import {
  createDeterministicExecutor,
  type ExecutionOutcome,
  NativeExecutorError,
} from "../../apps/worker/src/executor.ts";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import {
  createSupervisorState,
  type SupervisorState,
} from "../../apps/worker/src/supervisor-state.ts";
import {
  executeAssignment,
  flushOnce,
  releaseAttempt,
  retryPendingTerminationCleanup,
  runFlushLoop,
} from "../../apps/worker/src/supervisor-execution.ts";
import {
  runClaimLoop,
  runLeaseRenewalLoop,
} from "../../apps/worker/src/supervisor-claims.ts";
import { runHeartbeatLoop } from "../../apps/worker/src/supervisor-heartbeat.ts";
import { withControlPlane } from "../../apps/worker/src/supervisor-control-plane.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import {
  type ActiveAssignment,
  reconcileLeaseResponse,
} from "../../apps/worker/src/supervisor-support.ts";
import {
  ackPayload,
  ackResponse,
  heartbeatResponse,
  localAssignment,
  nonmodelAssignment,
  protocolEmptyResponse,
  protocolResponse,
  recoverySleep,
  supervisorConfig,
  waitForCondition,
} from "../helpers/worker-execution/recovery-support.ts";

type PublicationFailureFixture = {
  directory: string;
  assignment: JobAssignment;
  store: RegistrationStore;
  spool: EventSpool;
  state: SupervisorState;
  active: ActiveAssignment;
};

async function createPublicationFailureFixture(options: {
  client: WorkerApiClient;
  executionStarted?: boolean;
  executionSettled?: boolean;
}): Promise<PublicationFailureFixture> {
  const directory = await Deno.makeTempDir({
    prefix: "issue393-publication-failure-",
  });
  const assignment = localAssignment();
  const store = new RegistrationStore(`${directory}/registration.json`);
  await store.saveRegistered("credential", {
    workerHostId: assignment.workerHostId,
    principalId: crypto.randomUUID(),
    status: "registered",
    registrationGeneration: 1,
    workerSessionId: assignment.workerSessionId!,
    workerSessionGeneration: String(assignment.workerSessionGeneration),
  });
  await store.saveActiveAssignment({
    assignment,
    nextLocalSeq: "2",
    ackedLocalSeq: "0",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 20,
    maxBytes: 20_000,
  });
  await spool.enqueueResult({
    attemptId: assignment.attemptId,
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: "1",
    eventId: crypto.randomUUID(),
    status: "completed",
    result: {
      headSha: "head",
      baseSha: "base",
      sessionId: crypto.randomUUID(),
      artifacts: [],
    },
  });
  const state = createSupervisorState({
    config: supervisorConfig(directory),
    client: options.client,
    registrationStore: store,
    spool,
    sleep: () => Promise.resolve(),
  });
  state.registration = await store.load();
  state.processSessionId = assignment.workerSessionId!;
  state.processSessionGeneration = String(assignment.workerSessionGeneration);
  state.processSessionAcquired = true;
  state.freshHeartbeatReady = true;
  const active: ActiveAssignment = {
    assignment,
    controller: new AbortController(),
    renewalController: new AbortController(),
    leaseSeconds: 45,
    leaseDeadline: performance.now() + 60_000,
    renewalLoopStarted: true,
    terminalAcked: false,
    executionStarted: options.executionStarted ?? true,
    executionSettled: options.executionSettled ?? false,
    restored: true,
  };
  state.active.set(assignment.attemptId, active);
  state.publicationAuthorities.set(assignment.attemptId, {
    attemptId: assignment.attemptId,
    leaseToken: assignment.leaseToken,
    workerSessionId: assignment.workerSessionId!,
    workerSessionGeneration: String(assignment.workerSessionGeneration),
    attemptFence: assignment.fence,
    lifecycle: "active",
    leaseDeadline: performance.now() + 60_000,
  });
  return { directory, assignment, store, spool, state, active };
}

Deno.test("cleanup replay validates original observation provenance", async () => {
  const attemptId = crypto.randomUUID();
  const oldSessionId = crypto.randomUUID();
  const currentSessionId = crypto.randomUUID();
  const exitedAt = new Date().toISOString();
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () =>
      Promise.resolve(
        protocolResponse({
          attemptId,
          status: "canceled",
          cancellation: {
            processExited: true,
            cleanupStatus: "complete",
            terminationStatus: "confirmed",
            exitedAt,
            cleanupObserver: {
              observedBy: {
                workerSessionId: oldSessionId,
                workerSessionGeneration: "1",
              },
              attestedBy: {
                workerSessionId: oldSessionId,
                workerSessionGeneration: "1",
              },
            },
          },
        }),
      ),
  });
  const response = await client.confirmCleanup(attemptId, {
    fence: "1",
    workerSessionId: currentSessionId,
    workerSessionGeneration: "2",
    observedByWorkerSessionId: oldSessionId,
    observedByWorkerSessionGeneration: "1",
    exitedAt,
  });
  assertEquals(response.value.attemptId, attemptId);
});

Deno.test("control actions transition deterministically and duplicate commands replay", () => {
  const state = createControlState();
  assertEquals(
    applyControlAction(state, "pause-1", "pause", { active: true }),
    {
      mode: "paused",
      acknowledged: true,
    },
  );
  assertEquals(state.admissionPaused, true);
  assertEquals(applyControlAction(state, "pause-1", "pause"), {
    mode: "paused",
    acknowledged: true,
  });
  assertEquals(
    applyControlAction(state, "interrupt-1", "interrupt", { active: true }),
    { mode: "interrupted", acknowledged: true, termination: "pending" },
  );
  assertEquals(state.admissionPaused, true);
  assertEquals(
    applyControlAction(state, "resume-1", "resume", { active: true }),
    {
      mode: "interrupted",
      acknowledged: false,
    },
  );
  assertEquals(
    applyControlAction(state, "resume-2", "resume", {
      active: true,
      freshHeartbeat: true,
    }),
    { mode: "running", acknowledged: true },
  );
  assertEquals(
    applyControlAction(state, "resume-3", "resume", {
      active: false,
      workerScoped: true,
      freshHeartbeat: true,
    }),
    { mode: "running", acknowledged: true },
  );
  assertEquals(state.admissionPaused, false);
});

Deno.test("terminal cancel command preserves unknown termination outcome", () => {
  const state = createControlState();
  assertEquals(
    applyControlAction(state, "terminal-cancel-1", "cancel", {
      active: false,
      terminallyCanceled: true,
    }),
    {
      mode: "cancelling",
      acknowledged: true,
      termination: "unknown",
    },
  );
});

Deno.test("pause and unknown termination evidence survive registration restart", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-persisted-state-",
  });
  try {
    const attemptId = crypto.randomUUID();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "1",
    });
    await store.saveCommandOutcome(
      crypto.randomUUID(),
      "acknowledged",
      { admissionPaused: true },
    );
    await store.saveTerminationEvidence(attemptId, {
      status: "unknown",
      observedAt: new Date().toISOString(),
    });
    const restarted = await new RegistrationStore(
      `${directory}/registration.json`,
    ).load();
    assertEquals(restarted?.admissionPaused, true);
    assertEquals(
      restarted?.terminationEvidence?.[attemptId]?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("public supervisor run preserves unknown termination quarantine", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-heartbeat-quarantine-",
  });
  try {
    const workerHostId = crypto.randomUUID();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const workerSessionId = crypto.randomUUID();
    await store.saveRegistered("credential", {
      workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId,
      workerSessionGeneration: "1",
    });
    const attemptId = crypto.randomUUID();
    await store.saveTerminationEvidence(attemptId, {
      status: "unknown",
      observedAt: new Date().toISOString(),
    });
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        assert(new URL(request.url).pathname.endsWith("/heartbeat"));
        const body = JSON.parse(await request.text()) as {
          workerHostId: string;
          workerSessionId: string;
          workerSessionGeneration: string;
        };
        return heartbeatResponse(
          body.workerHostId,
          [],
          [],
          body.workerSessionId,
          body.workerSessionGeneration,
        );
      },
    });
    client.setCredential("credential");
    const supervisor = new WorkerSupervisor({
      config: {
        ...supervisorConfig(directory),
        serverUrl: "http://127.0.0.1:8788",
      },
      client,
      registrationStore: store,
      spool,
      sleep: () => {
        supervisor.requestStop("TEST_STOP");
        return Promise.resolve();
      },
    });
    await supervisor.run();
    assertEquals(supervisor.fatalReason, null);
    assertEquals(
      (await store.load())?.terminationEvidence?.[attemptId]?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("CANCEL_REQUESTED retires one attempt without stopping the worker", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-cancel-requested-flush-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "2",
      ackedLocalSeq: "0",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const eventId = crypto.randomUUID();
    await spool.enqueueResult({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      eventId,
      status: "completed",
      result: {
        headSha: "head",
        baseSha: "base",
        sessionId: crypto.randomUUID(),
        artifacts: [],
      },
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: () =>
          Promise.resolve(
            protocolResponse(
              { code: "CANCEL_REQUESTED", retryable: false },
              { status: 409 },
            ),
          ),
      }),
      registrationStore: store,
      spool,
      sleep: () => {
        state.stopping = true;
        return Promise.resolve();
      },
    });
    state.registration = await store.load();
    state.processSessionId = assignment.workerSessionId!;
    state.processSessionGeneration = String(assignment.workerSessionGeneration);
    state.processSessionAcquired = true;
    state.freshHeartbeatReady = true;
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalLoopStarted: true,
      terminalAcked: false,
      executionStarted: true,
      executionSettled: false,
      restored: true,
    };
    state.active.set(assignment.attemptId, active);
    state.publicationAuthorities.set(assignment.attemptId, {
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
      attemptFence: assignment.fence,
      lifecycle: "active",
      leaseDeadline: performance.now() + 60_000,
    });
    let fatalReason: string | undefined;
    await runFlushLoop(
      state,
      (signal) => flushOnce(state, signal),
      (reason) => {
        fatalReason = reason;
      },
    );
    assertEquals(fatalReason, undefined);
    assertEquals(state.stopping, true);
    assertEquals(state.spool.attemptIds(), []);
    assertEquals(state.active.has(assignment.attemptId), true);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test(
  "non-retryable result publication reports a fault and classifies retirement",
  async () => {
    for (
      const scenario of [
        {
          name: "unknown",
          executionSettled: false,
        },
        {
          name: "settled",
          executionSettled: true,
        },
      ]
    ) {
      const fixture = await createPublicationFailureFixture({
        executionSettled: scenario.executionSettled,
        client: new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          credential: "credential",
          fetcher: () =>
            Promise.resolve(
              protocolResponse(
                { code: "RESULT_POST_REJECTED", retryable: false },
                { status: 422 },
              ),
            ),
        }),
      });
      try {
        const faults: unknown[] = [];
        let fatalReason: string | undefined;
        assertEquals(
          await flushOnce(
            fixture.state,
            undefined,
            (reason) => fatalReason = reason,
            (error) => faults.push(error),
          ),
          true,
          scenario.name,
        );
        assertEquals(fatalReason, undefined, scenario.name);
        assertEquals(faults.length, 1, scenario.name);
        assertEquals(
          faults[0] instanceof WorkerRequestError,
          true,
          scenario.name,
        );
        if (faults[0] instanceof WorkerRequestError) {
          assertEquals(faults[0].code, "RESULT_POST_REJECTED", scenario.name);
        }
        assertEquals(fixture.spool.attemptIds(), [], scenario.name);
        const registration = await fixture.store.load();
        if (scenario.executionSettled) {
          assertEquals(
            registration?.activeAssignments?.[fixture.assignment.attemptId],
            undefined,
            scenario.name,
          );
          assertEquals(
            registration?.releaseMarkers?.[fixture.assignment.attemptId],
            undefined,
            scenario.name,
          );
          assertEquals(
            fixture.state.active.has(fixture.assignment.attemptId),
            false,
            scenario.name,
          );
        } else {
          assertEquals(
            registration?.releaseMarkers?.[fixture.assignment.attemptId],
            undefined,
            scenario.name,
          );
          assertEquals(
            registration?.terminationEvidence?.[fixture.assignment.attemptId]
              ?.status,
            "unknown",
            scenario.name,
          );
          assertEquals(
            fixture.state.active.has(fixture.assignment.attemptId),
            true,
            scenario.name,
          );
        }
      } finally {
        await Deno.remove(fixture.directory, { recursive: true }).catch(
          () => undefined,
        );
      }
    }
  },
);

const AMBIGUOUS_PUBLICATION_SCENARIOS: ReadonlyArray<{
  name: string;
  code: string;
  fetcher: (init?: RequestInit) => Response;
}> = [
  {
    name: "invalid 201 ACK",
    code: "WORKER_RESPONSE_STATUS_INVALID",
    fetcher: (init) =>
      protocolResponse(JSON.parse(ackResponseText(init)), { status: 201 }),
  },
  {
    name: "proxy 503 without protocol header",
    code: "WORKER_PROTOCOL_UNSUPPORTED",
    fetcher: () => Response.json({ code: "UPSTREAM" }, { status: 503 }),
  },
  {
    name: "502 with erroring body stream",
    code: "WORKER_RESPONSE_BODY_INVALID",
    fetcher: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("BODY_STREAM_BROKEN"));
          },
        }),
        {
          status: 502,
          headers: {
            "X-Bakery-Worker-Protocol-Version": "2",
            "cache-control": "no-store",
          },
        },
      ),
  },
  {
    name: "413 with bad content-length",
    code: "WORKER_RESPONSE_LENGTH_INVALID",
    fetcher: () =>
      protocolResponse({ code: "TOO_BIG" }, {
        status: 413,
        headers: { "cache-control": "no-store", "content-length": "abc" },
      }),
  },
];

function ackResponseText(init?: RequestInit): string {
  return JSON.stringify(ackPayload(init));
}

Deno.test(
  "ambiguous result publication keeps the journal and fails fatal",
  async () => {
    for (const scenario of AMBIGUOUS_PUBLICATION_SCENARIOS) {
      const fixture = await createPublicationFailureFixture({
        executionSettled: true,
        client: new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          credential: "credential",
          fetcher: (_input, init) => Promise.resolve(scenario.fetcher(init)),
        }),
      });
      try {
        const faults: unknown[] = [];
        let fatalReason: string | undefined;
        fixture.state.sleep = () => {
          fixture.state.stopping = true;
          return Promise.resolve();
        };
        await runFlushLoop(
          fixture.state,
          (signal) =>
            flushOnce(
              fixture.state,
              signal,
              (reason) => fatalReason = reason,
              (error) => faults.push(error),
            ),
          (reason) => fatalReason = reason,
          (error) => faults.push(error),
        );
        assertEquals(fatalReason, scenario.code, scenario.name);
        assertEquals(
          fixture.spool.attemptIds(),
          [fixture.assignment.attemptId],
          scenario.name,
        );
        const registration = await fixture.store.load();
        assertEquals(
          registration?.releaseMarkers?.[fixture.assignment.attemptId],
          undefined,
          scenario.name,
        );
        assertEquals(
          registration?.terminationEvidence?.[fixture.assignment.attemptId],
          undefined,
          scenario.name,
        );
        assert(
          registration?.activeAssignments?.[fixture.assignment.attemptId],
          scenario.name,
        );
      } finally {
        await Deno.remove(fixture.directory, { recursive: true }).catch(
          () => undefined,
        );
      }
    }
  },
);

Deno.test(
  "standalone replay rejects with the original request error",
  async () => {
    const fixture = await createPublicationFailureFixture({
      executionSettled: true,
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (_input, init) =>
          Promise.resolve(
            protocolResponse(JSON.parse(ackResponseText(init)), {
              status: 201,
            }),
          ),
      }),
    });
    try {
      const supervisor = new WorkerSupervisor({
        config: fixture.state.config,
        client: fixture.state.client,
        registrationStore: fixture.store,
        spool: fixture.spool,
        sleep: () => Promise.resolve(),
      });
      const error = await assertRejects(
        () => supervisor.replayStandalone(),
        WorkerRequestError,
      );
      assertEquals(error.code, "WORKER_RESPONSE_STATUS_INVALID");
      assertEquals(error.name, "WorkerRequestError");
    } finally {
      await Deno.remove(fixture.directory, { recursive: true }).catch(
        () => undefined,
      );
    }
  },
);

Deno.test(
  "local journal sync failure reports a fault without losing the terminal state",
  async () => {
    const fixture = await createPublicationFailureFixture({
      executionSettled: true,
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
      }),
    });
    try {
      const originalUpdate = fixture.store.updateActiveAssignment.bind(
        fixture.store,
      );
      let updateCount = 0;
      fixture.store.updateActiveAssignment = async (attemptId, patch) => {
        updateCount++;
        if (updateCount === 2) throw new Error("JOURNAL_SYNC_FAILED");
        return await originalUpdate(attemptId, patch);
      };
      const faults: unknown[] = [];
      let fatalReason: string | undefined;
      assertEquals(
        await flushOnce(
          fixture.state,
          undefined,
          (reason) => fatalReason = reason,
          (error) => faults.push(error),
        ),
        true,
      );
      assertEquals(updateCount, 2);
      assertEquals(fatalReason, undefined);
      assertEquals(faults.length, 1);
      assertEquals(
        faults[0] instanceof Error ? faults[0].message : faults[0],
        "JOURNAL_SYNC_FAILED",
      );
      assertEquals(fixture.spool.attemptIds(), []);
      const registration = await fixture.store.load();
      assertEquals(
        registration?.activeAssignments?.[fixture.assignment.attemptId]
          ?.terminalAcked,
        true,
      );
      assertEquals(
        registration?.activeAssignments?.[fixture.assignment.attemptId]
          ?.ackedLocalSeq,
        "0",
      );
      assertEquals(
        fixture.state.active.has(fixture.assignment.attemptId),
        true,
      );
    } finally {
      await Deno.remove(fixture.directory, { recursive: true }).catch(
        () => undefined,
      );
    }
  },
);

Deno.test(
  "release failure after result ACK is fatal and keeps the release marker",
  async () => {
    const fixture = await createPublicationFailureFixture({
      executionSettled: true,
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (_input, init) => Promise.resolve(ackResponse(init)),
      }),
    });
    try {
      fixture.store.completeRelease = () =>
        Promise.reject(new Error("INJECTED_RELEASE_FAILURE"));
      let fatalReason: string | undefined;
      await assertRejects(
        () =>
          flushOnce(
            fixture.state,
            undefined,
            (reason) => fatalReason = reason,
            () => undefined,
          ),
      );
      assertEquals(fatalReason, "INJECTED_RELEASE_FAILURE");
      assertEquals(fixture.spool.attemptIds(), []);
      const registration = await fixture.store.load();
      assertEquals(
        registration?.releaseMarkers?.[fixture.assignment.attemptId]?.reason,
        "RESULT_ACKED",
      );
    } finally {
      await Deno.remove(fixture.directory, { recursive: true }).catch(
        () => undefined,
      );
    }
  },
);

Deno.test(
  "assignment publication fault does not swallow release failure",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue393-assignment-release-failure-",
    });
    try {
      const assignment = localAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: String(assignment.workerSessionGeneration),
      });
      await store.saveActiveAssignment({
        assignment,
        nextLocalSeq: "1",
        ackedLocalSeq: "0",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      const state = createSupervisorState({
        config: supervisorConfig(directory),
        client: new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          credential: "credential",
          fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
        }),
        registrationStore: store,
        spool,
        executor: {
          execute: () =>
            Promise.resolve({
              status: "failed" as const,
              fault: { code: "EXPECTED_FAILURE" },
            }),
        },
        sleep: () => Promise.resolve(),
      });
      state.registration = await store.load();
      state.processSessionId = assignment.workerSessionId!;
      state.processSessionGeneration = String(
        assignment.workerSessionGeneration,
      );
      state.processSessionAcquired = true;
      state.freshHeartbeatReady = true;
      const active: ActiveAssignment = {
        assignment,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: performance.now() + 60_000,
        renewalLoopStarted: true,
        terminalAcked: false,
        executionStarted: true,
        executionSettled: false,
        restored: true,
      };
      state.active.set(assignment.attemptId, active);
      state.publicationAuthorities.set(assignment.attemptId, {
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: String(assignment.workerSessionGeneration),
        attemptFence: assignment.fence,
        lifecycle: "active",
        leaseDeadline: performance.now() + 60_000,
      });
      state.registrationStore.updateActiveAssignment = () =>
        Promise.reject(
          new WorkerRequestError(
            "JOURNAL_SYNC_REJECTED",
            422,
            false,
            undefined,
            { serverProblem: true },
          ),
        );
      state.registrationStore.saveReleaseMarker = () =>
        Promise.reject(new Error("RELEASE_MARKER_FAILED"));
      const faults: unknown[] = [];
      let fatalReason: string | undefined;
      await executeAssignment(
        state,
        assignment,
        active.controller.signal,
        {
          failFatal: (reason) => fatalReason = reason,
          reportSupervisorFault: (error) => faults.push(error),
          startLeaseRenewal: () => {},
        },
        () => Promise.resolve(),
      );
      assertEquals(fatalReason, "RELEASE_MARKER_FAILED");
      assertEquals(faults.length, 2);
      assertEquals(spool.records().length, 1);
      const registration = await store.load();
      assertEquals(
        registration?.terminationEvidence?.[assignment.attemptId]?.status,
        "unknown",
      );
      assertEquals(
        registration?.activeAssignments?.[assignment.attemptId]?.assignment
          .attemptId,
        assignment.attemptId,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(
        () => undefined,
      );
    }
  },
);

Deno.test("fresh heartbeat preserves a running restored assignment", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-fresh-heartbeat-occupancy-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
    });
    let claims = 0;
    let executorStarted = false;
    const executorSettled = Promise.withResolvers<ExecutionOutcome>();
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const body = JSON.parse(await request.text()) as Record<
          string,
          unknown
        >;
        if (path.endsWith("/heartbeat")) {
          return heartbeatResponse(
            String(body.workerHostId),
            [],
            [],
            String(body.workerSessionId),
            String(body.workerSessionGeneration),
            [assignment.attemptId],
          );
        }
        if (path.endsWith("/claim")) {
          claims++;
          return protocolResponse(assignment);
        }
        if (path.endsWith("/events")) {
          const event = (body.events as Array<Record<string, unknown>>)?.[0];
          return protocolResponse({
            eventId: event?.eventId ?? crypto.randomUUID(),
            status: "applied",
            lastEventSeq: event?.localSeq ?? "1",
          });
        }
        throw new Error(`UNEXPECTED_WORKER_REQUEST:${path}`);
      },
    });
    client.setCredential("credential");
    const supervisor = new WorkerSupervisor({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () => {
          executorStarted = true;
          return executorSettled.promise;
        },
      },
      sleep: recoverySleep,
    });
    const run = supervisor.run();
    await waitForCondition(
      () => executorStarted,
      "RUNNING_ASSIGNMENT_NOT_STARTED",
    );
    supervisor.requestStop("TEST_STOP");
    const settledBeforeExecutor = await Promise.race([
      run.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    assertEquals(settledBeforeExecutor, false);
    executorSettled.resolve({ status: "canceled", cancellation: null });
    await run;
    assertEquals(supervisor.fatalReason, null);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test(
  "shutdown cancels abandonment before a replacement can observe its timer",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-abandonment-shutdown-",
    });
    try {
      const assignment = nonmodelAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: "1",
      });
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      });
      const started = Promise.withResolvers<void>();
      const executorSettled = Promise.withResolvers<ExecutionOutcome>();
      let claimIssued = false;
      let executorStarted = false;
      const interrupt = {
        id: crypto.randomUUID(),
        attemptId: assignment.attemptId,
        messageId: crypto.randomUUID(),
        commandType: "steer" as const,
        payload: {
          controlAction: "interrupt" as const,
          controlScope: "attempt" as const,
          workerHostId: assignment.workerHostId,
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: "1",
          fence: String(assignment.fence),
        },
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = JSON.parse(await request.text()) as {
            workerHostId?: string;
            workerSessionId?: string;
            workerSessionGeneration?: string;
          };
          if (path.endsWith("/heartbeat")) {
            if (claimIssued && executorStarted) {
              interrupt.payload.workerSessionId = String(body.workerSessionId);
            }
            return heartbeatResponse(
              String(body.workerHostId),
              claimIssued && executorStarted ? [interrupt] : [],
              [],
              String(body.workerSessionId),
              String(body.workerSessionGeneration),
              [assignment.attemptId],
            );
          }
          if (path.endsWith("/claims")) {
            claimIssued = true;
            return protocolResponse(assignment);
          }
          if (path.endsWith("/events")) return ackResponse(init);
          throw new Error(`UNEXPECTED_WORKER_REQUEST:${path}`);
        },
      });
      client.setCredential("credential");
      const supervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(directory),
          terminationGraceMs: 1_000,
        },
        client,
        registrationStore: store,
        spool,
        executor: {
          execute: () => {
            executorStarted = true;
            started.resolve();
            return executorSettled.promise;
          },
        },
        sleep: recoverySleep,
      });
      const supervisorInternals = supervisor as unknown as {
        state: SupervisorState;
      };
      const state = supervisorInternals.state;
      const run = supervisor.run();
      await started.promise;
      await waitForCondition(
        () => state.abandonmentTimers.size === 1,
        "ABANDONMENT_TIMER_NOT_SCHEDULED",
      );
      supervisor.requestStop("TEST_STOP_BEFORE_ABANDONMENT");
      executorSettled.resolve({ status: "canceled", cancellation: null });
      await run;
      assertEquals(state.abandonmentTimers.size, 0);
      assertEquals(state.abandonmentTasks.size, 0);
      const stopped = await store.load();
      assertEquals(stopped?.releaseMarkers?.[assignment.attemptId], undefined);

      const replacementRef: { current?: WorkerSupervisor } = {};
      const replacementClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = JSON.parse(await request.text()) as {
            workerHostId?: string;
            workerSessionId?: string;
            workerSessionGeneration?: string;
          };
          if (path.endsWith("/heartbeat")) {
            queueMicrotask(() => {
              const activeReplacement = replacementRef.current;
              if (!activeReplacement) {
                throw new Error("REPLACEMENT_SUPERVISOR_NOT_INITIALIZED");
              }
              activeReplacement.requestStop("REPLACEMENT_STOP");
            });
            return heartbeatResponse(
              String(body.workerHostId),
              [],
              [],
              String(body.workerSessionId),
              String(body.workerSessionGeneration),
              [assignment.attemptId],
            );
          }
          throw new Error(`UNEXPECTED_REPLACEMENT_REQUEST:${path}`);
        },
      });
      replacementClient.setCredential("credential");
      replacementRef.current = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: replacementClient,
        registrationStore: store,
        spool,
      });
      const replacement = replacementRef.current;
      if (!replacement) {
        throw new Error("REPLACEMENT_SUPERVISOR_NOT_INITIALIZED");
      }
      await replacement.run();
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      const afterReplacement = await store.load();
      assertEquals(
        afterReplacement?.releaseMarkers?.[assignment.attemptId],
        undefined,
      );
      assertEquals(
        afterReplacement?.terminationEvidence?.[assignment.attemptId],
        stopped?.terminationEvidence?.[assignment.attemptId],
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test(
  "shutdown awaits an in-flight abandonment before replacement starts",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-abandonment-task-shutdown-",
    });
    const releaseStarted = Promise.withResolvers<void>();
    const releasePending = Promise.withResolvers<void>();
    let supervisor: WorkerSupervisor | undefined;
    let replacement: WorkerSupervisor | undefined;
    let run: Promise<void> | undefined;
    let replacementRun: Promise<void> | undefined;
    try {
      const assignment = nonmodelAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: "1",
      });
      const originalSaveReleaseMarker = store.saveReleaseMarker.bind(store);
      let replacementStarted = false;
      let lateAbandonmentReleaseWrites = 0;
      store.saveReleaseMarker = async (attemptId, reason) => {
        if (reason === "TERMINATION_UNKNOWN") {
          if (replacementStarted) lateAbandonmentReleaseWrites++;
          releaseStarted.resolve();
          await releasePending.promise;
        }
        return await originalSaveReleaseMarker(attemptId, reason);
      };
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 100_000,
      });
      const executorStarted = Promise.withResolvers<void>();
      const executorSettled = Promise.withResolvers<ExecutionOutcome>();
      let claimIssued = false;
      let executorIsRunning = false;
      const interrupt = {
        id: crypto.randomUUID(),
        attemptId: assignment.attemptId,
        messageId: crypto.randomUUID(),
        commandType: "steer" as const,
        payload: {
          controlAction: "interrupt" as const,
          controlScope: "attempt" as const,
          workerHostId: assignment.workerHostId,
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: "1",
          fence: String(assignment.fence),
        },
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = JSON.parse(await request.text()) as {
            workerHostId?: string;
            workerSessionId?: string;
            workerSessionGeneration?: string;
          };
          if (path.endsWith("/heartbeat")) {
            if (claimIssued && executorIsRunning) {
              interrupt.payload.workerSessionId = String(body.workerSessionId);
            }
            return heartbeatResponse(
              String(body.workerHostId),
              claimIssued && executorIsRunning ? [interrupt] : [],
              [],
              String(body.workerSessionId),
              String(body.workerSessionGeneration),
              [assignment.attemptId],
            );
          }
          if (path.endsWith("/claims")) {
            claimIssued = true;
            return protocolResponse(assignment);
          }
          if (path.endsWith("/events")) return ackResponse(init);
          throw new Error(`UNEXPECTED_WORKER_REQUEST:${path}`);
        },
      });
      client.setCredential("credential");
      supervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(directory),
          terminationGraceMs: 0,
        },
        client,
        registrationStore: store,
        spool,
        executor: {
          supportedActions: [assignment.action],
          execute: () => {
            executorIsRunning = true;
            executorStarted.resolve();
            return executorSettled.promise;
          },
        },
        sleep: recoverySleep,
      });
      run = supervisor.run();
      await executorStarted.promise;
      await releaseStarted.promise;
      supervisor.requestStop("TEST_STOP_DURING_ABANDONMENT");
      const settledBeforeRelease = await Promise.race([
        run.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      assertEquals(settledBeforeRelease, false);
      releasePending.resolve();
      const settledBeforeExecutor = await Promise.race([
        run.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      assertEquals(settledBeforeExecutor, false);
      executorSettled.resolve({ status: "canceled", cancellation: null });
      await run;

      const replacementClient = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = JSON.parse(await request.text()) as {
            workerHostId?: string;
            workerSessionId?: string;
            workerSessionGeneration?: string;
          };
          if (path.endsWith("/heartbeat")) {
            queueMicrotask(() => {
              const activeReplacement = replacement;
              if (!activeReplacement) {
                throw new Error("REPLACEMENT_SUPERVISOR_NOT_INITIALIZED");
              }
              activeReplacement.requestStop("REPLACEMENT_STOP");
            });
            return heartbeatResponse(
              String(body.workerHostId),
              [],
              [],
              String(body.workerSessionId),
              String(body.workerSessionGeneration),
              [],
            );
          }
          throw new Error(`UNEXPECTED_REPLACEMENT_REQUEST:${path}`);
        },
      });
      replacementClient.setCredential("credential");
      const activeReplacement = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client: replacementClient,
        registrationStore: store,
        spool,
      });
      replacement = activeReplacement;
      replacementStarted = true;
      replacementRun = activeReplacement.run();
      await replacementRun;
      const afterReplacement = await store.load();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const afterGrace = await store.load();
      assertEquals(lateAbandonmentReleaseWrites, 0);
      assertEquals(
        afterGrace?.releaseMarkers,
        afterReplacement?.releaseMarkers,
      );
      assertEquals(
        afterGrace?.terminationEvidence,
        afterReplacement?.terminationEvidence,
      );
    } finally {
      releasePending.resolve();
      supervisor?.requestStop("TEST_CLEANUP");
      replacement?.requestStop("TEST_CLEANUP");
      await run?.catch(() => undefined);
      await replacementRun?.catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test("heartbeat routes every control action and resumes pause without draining", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-controls-" });
  let activeForCleanup: ActiveAssignment | undefined;
  let stateForCleanup: SupervisorState | undefined;
  let attemptIdForCleanup: string | undefined;
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const workerSessionId = crypto.randomUUID();
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId,
      workerSessionGeneration: "1",
    });
    let heartbeatCount = 0;
    const command = (
      id: string,
      commandType: "steer" | "follow_up" | "cancel",
      controlAction?: string,
      attemptId = assignment.attemptId,
      payloadOverrides: Record<string, unknown> = {},
    ) => ({
      id,
      attemptId,
      messageId: crypto.randomUUID(),
      commandType,
      payload: controlAction === undefined ? {} : {
        controlAction,
        controlScope: controlAction === "resume" ? "worker" : "attempt",
        workerHostId: assignment.workerHostId,
        workerSessionId,
        workerSessionGeneration: "1",
        fence: String(assignment.fence),
        ...payloadOverrides,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    const ack = (commandId: string) => ({
      commandId,
      status: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
    });
    const pauseId = crypto.randomUUID();
    const interruptId = crypto.randomUUID();
    const resumeId = crypto.randomUUID();
    const cancelId = crypto.randomUUID();
    const invalidSteerResumeId = crypto.randomUUID();
    const invalidFollowPauseId = crypto.randomUUID();
    const stalePauseId = crypto.randomUUID();
    const missingAuthorityId = crypto.randomUUID();
    const staleSessionId = crypto.randomUUID();
    const staleGenerationId = crypto.randomUUID();
    const staleFenceId = crypto.randomUUID();
    const responses = [
      heartbeatResponse(
        assignment.workerHostId,
        [command(pauseId, "steer", "pause")],
        [],
        workerSessionId,
        "1",
      ),
      heartbeatResponse(
        assignment.workerHostId,
        [command(interruptId, "steer", "interrupt")],
        [ack(pauseId)],
        workerSessionId,
        "1",
      ),
      heartbeatResponse(
        assignment.workerHostId,
        [command(resumeId, "follow_up", "resume")],
        [ack(interruptId)],
        workerSessionId,
        "1",
      ),
      heartbeatResponse(
        assignment.workerHostId,
        [command(cancelId, "cancel", "cancel")],
        [ack(resumeId)],
        workerSessionId,
        "1",
      ),
      heartbeatResponse(
        assignment.workerHostId,
        [
          command(invalidSteerResumeId, "steer", "resume"),
          command(invalidFollowPauseId, "follow_up", "pause"),
          command(
            stalePauseId,
            "steer",
            "pause",
            crypto.randomUUID(),
          ),
          command(
            missingAuthorityId,
            "steer",
            "pause",
            assignment.attemptId,
            { workerSessionId: undefined },
          ),
          command(
            staleSessionId,
            "steer",
            "pause",
            assignment.attemptId,
            { workerSessionId: crypto.randomUUID() },
          ),
          command(
            staleGenerationId,
            "steer",
            "pause",
            assignment.attemptId,
            { workerSessionGeneration: "0" },
          ),
          command(
            staleFenceId,
            "steer",
            "pause",
            assignment.attemptId,
            { fence: "0" },
          ),
        ],
        [ack(cancelId)],
        workerSessionId,
        "1",
      ),
    ];
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        assert(path.endsWith("/heartbeat"));
        const response = responses[heartbeatCount++];
        if (!response) throw new Error("HEARTBEAT_RESPONSE_EXHAUSTED");
        return Promise.resolve(response);
      },
    });
    client.setCredential("credential");
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => {
        if (heartbeatCount === responses.length) state.stopping = true;
        return Promise.resolve();
      },
    });
    state.registration = await store.load();
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: false,
      restored: false,
    };
    activeForCleanup = active;
    stateForCleanup = state;
    attemptIdForCleanup = assignment.attemptId;
    state.active.set(assignment.attemptId, active);
    await runHeartbeatLoop(state, {
      withControlPlane: (work) => work(new AbortController().signal),
      releaseAttempt: async () => {},
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {},
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: async () => {},
      markSessionReady: () => {},
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    assertEquals(state.controlState.mode, "cancelling");
    assertEquals(state.commandOutcomes.size, 7);
    assertEquals(state.commandOutcomes.get(invalidSteerResumeId), "rejected");
    assertEquals(state.commandOutcomes.get(invalidFollowPauseId), "rejected");
    assertEquals(state.commandOutcomes.get(stalePauseId), "rejected");
    assertEquals(state.commandOutcomes.get(missingAuthorityId), "rejected");
    assertEquals(state.commandOutcomes.get(staleSessionId), "rejected");
    assertEquals(state.commandOutcomes.get(staleGenerationId), "rejected");
    assertEquals(state.commandOutcomes.get(staleFenceId), "rejected");
    assertEquals(active.controller.signal.aborted, true);
  } finally {
    if (activeForCleanup) {
      clearTimeout(activeForCleanup.abandonmentTimer);
      activeForCleanup.controller.abort();
    }
    if (stateForCleanup && attemptIdForCleanup) {
      stateForCleanup.active.delete(attemptIdForCleanup);
    }
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("termination evidence never infers exit from cancellation", async () => {
  assertEquals(terminationEvidence({}), "unknown");
  assertEquals(terminationEvidence({ processExited: false }), "pending");
  assertEquals(
    terminationEvidence({
      processExited: true,
      cleanupComplete: true,
      observedExitAt: "now",
    }),
    "confirmed",
  );
  const executor = createDeterministicExecutor();
  const controller = new AbortController();
  controller.abort();
  const outcome = await executor.execute(
    localAssignment(),
    controller.signal,
  );
  assertEquals(outcome.status, "canceled");
  if (outcome.status === "canceled") {
    const cancellation = outcome.cancellation as {
      terminationStatus: string;
    };
    assertEquals(cancellation.terminationStatus, "unknown");
  }
});

Deno.test("confirmed exit upgrades unknown evidence without downgrade", () => {
  const upgraded = mergeTerminationEvidence(
    {
      status: "unknown",
      observedAt: "2026-09-20T00:00:00.000Z",
    },
    {
      status: "pending",
      observedAt: "2026-09-20T00:00:01.000Z",
      cleanupComplete: true,
      observedExitAt: "2026-09-20T00:00:02.000Z",
    },
  );
  assertEquals(upgraded.status, "pending");
  assertEquals(upgraded.cleanupComplete, true);
  assertEquals(upgraded.observedExitAt, "2026-09-20T00:00:02.000Z");
  assertEquals(
    mergeTerminationEvidence(upgraded, {
      status: "unknown",
      observedAt: "2026-09-20T00:00:03.000Z",
    }).status,
    "pending",
  );
});
Deno.test("unknown evidence dominates pending until exit is confirmed", () => {
  assertEquals(
    mergeTerminationEvidence(
      {
        status: "pending",
        observedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        status: "unknown",
        observedAt: "2026-09-20T00:00:01.000Z",
      },
    ).status,
    "unknown",
  );
});

Deno.test("termination evidence capacity pauses without evicting unresolved attempts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-evidence-cap-" });
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
    const attemptIds = Array.from(
      { length: MAX_TERMINATION_EVIDENCE },
      () => crypto.randomUUID(),
    );
    for (const attemptId of attemptIds) {
      await store.saveTerminationEvidence(attemptId, {
        status: "unknown",
        observedAt: new Date().toISOString(),
      });
    }
    let error: unknown;
    try {
      await store.saveTerminationEvidence(crypto.randomUUID(), {
        status: "unknown",
        observedAt: new Date().toISOString(),
      });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TerminationEvidenceCapacityError);
    const saved = await store.load();
    assertEquals(Object.keys(saved?.terminationEvidence ?? {}).length, 64);
    assertEquals(
      saved?.terminationEvidence?.[attemptIds[0]]?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("termination cleanup retries stop at the per-heartbeat bound", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-cleanup-bound-",
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    const attemptIds = Array.from(
      { length: MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT + 4 },
      () => crypto.randomUUID(),
    );
    for (const attemptId of attemptIds) {
      const evidence = {
        status: "pending" as const,
        observedAt: new Date().toISOString(),
        fence: "1",
        observedExitAt: new Date().toISOString(),
        cleanupComplete: true,
        observedBy: {
          workerSessionId: state.processSessionId,
          workerSessionGeneration: state.processSessionGeneration,
        },
      };
      await store.saveTerminationEvidence(attemptId, evidence);
      state.terminationEvidence.set(attemptId, evidence);
    }
    const confirmed: string[] = [];
    state.client.confirmCleanup = (attemptId) => {
      confirmed.push(attemptId);
      return undefined as never;
    };
    await retryPendingTerminationCleanup(state);
    assertEquals(
      confirmed.length,
      MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT,
    );
    assertEquals(
      state.terminationEvidence.size,
      attemptIds.length - MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("lease renewal maps every non-active status to canonical loss reasons", () => {
  const assignment = localAssignment();
  const active: ActiveAssignment = {
    assignment,
    controller: new AbortController(),
    renewalController: new AbortController(),
    leaseSeconds: 45,
    leaseDeadline: performance.now() + 60_000,
    renewalKey: undefined,
    renewalLoopStarted: false,
    terminalAcked: false,
    executionStarted: false,
    restored: false,
  };
  const reconcile = (status: "expired" | "revoked") =>
    reconcileLeaseResponse({
      active,
      response: {
        value: {
          attemptId: assignment.attemptId,
          fence: assignment.fence,
          status,
          leaseExpiresAt: assignment.leaseExpiresAt,
          serverTime: assignment.serverTime,
        } as never,
        replayed: false,
      },
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
      authoritativeServerTimeMs: null,
      authoritativeObservedAtMs: null,
      requestStartedAt: performance.now(),
      requestFinishedAt: performance.now(),
    });
  assertEquals(reconcile("expired"), {
    status: "release",
    reason: "LEASE_EXPIRED",
  });
  assertEquals(reconcile("revoked"), {
    status: "release",
    reason: "LEASE_REVOKED",
  });
});

Deno.test("aborted executor keeps cancellation termination evidence nonterminal", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-abort-" });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
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
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
    });
    const activeController = new AbortController();
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () => {
          activeController?.abort();
          return Promise.reject(new Error("EXECUTOR_ABORTED"));
        },
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    const active: ActiveAssignment = {
      assignment,
      controller: activeController,
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      restored: false,
    };

    state.active.set(assignment.attemptId, active);
    await executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => {
          throw new Error(reason);
        },
        startLeaseRenewal: () => {},
      },
      async () => {},
    );
    const result = spool.records().find((record) => record.kind === "result");
    assertEquals(result, undefined);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "pending",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test(
  "native boundary failure drains without releasing active assignment",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-native-boundary-failure-",
    });
    try {
      const assignment = localAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: String(assignment.workerSessionGeneration),
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
      await spool.restoreJournalState(assignment.attemptId, "3", "2");
      const state = createSupervisorState({
        config: supervisorConfig(directory),
        client: new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
        }),
        registrationStore: store,
        spool,
        executor: {
          execute: () =>
            Promise.reject(
              new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true),
            ),
        },
        sleep: () => Promise.resolve(),
      });
      state.registration = await store.load();
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
      state.active.set(assignment.attemptId, active);
      let fatalReason: string | undefined;
      let releases = 0;
      await executeAssignment(
        state,
        assignment,
        active.controller.signal,
        {
          failFatal: (reason) => {
            fatalReason = reason;
            state.draining = true;
          },
          startLeaseRenewal: () => {},
        },
        () => {
          releases++;
          return Promise.resolve();
        },
      );
      assertEquals(fatalReason, "NATIVE_CGROUP_CLEANUP_FAILED");
      assertEquals(releases, 0);
      assertEquals(state.active.has(assignment.attemptId), true);
      assertEquals(state.draining, true);
      assertEquals(active.executionSettled, true);
      assertEquals(state.terminationEvidence.has(assignment.attemptId), false);
      assertEquals(
        spool.records().some((record) => record.kind === "result"),
        false,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test("cancel during started event acknowledgement skips executor", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-started-cancel-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await spool.restoreJournalState(assignment.attemptId, "2", "1");
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: false,
      restored: false,
    };
    state.active.set(assignment.attemptId, active);
    const originalEnqueue = spool.enqueueEvent.bind(spool);
    spool.enqueueEvent = async (input) => {
      const record = await originalEnqueue(input);
      if (input.eventType === "job.started") active.controller.abort();
      return record;
    };
    let executions = 0;
    state.executor = {
      execute: () => {
        executions++;
        return Promise.resolve({
          status: "failed",
          fault: { code: "MUST_NOT_EXECUTE" },
        });
      },
    };
    await executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => {
          throw new Error(reason);
        },
        startLeaseRenewal: () => {},
      },
      async () => {},
    );
    assertEquals(executions, 0);
    const eventTypes = spool.records().map((record) => record.type);
    assertEquals(eventTypes.length, 1);
    assertEquals(eventTypes.includes("job.started"), true);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("ignored abort keeps an unknown attempt quarantined until settlement", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-quarantine-" });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
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
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<{
      status: "canceled";
      cancellation: {
        processExited: false;
        exitedAt: null;
        cleanupStatus: "pending";
      };
    }>();
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      executor: {
        execute: () => {
          started.resolve();
          return settled.promise;
        },
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
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
    state.active.set(assignment.attemptId, active);
    const execution = executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => {
          throw new Error(reason);
        },
        startLeaseRenewal: () => {},
      },
      (attemptId, reason, options) =>
        releaseAttempt(state, attemptId, reason, options),
    );
    await started.promise;
    await releaseAttempt(state, assignment.attemptId, "LEASE_EXPIRED", {
      discardJournal: true,
    });
    assertEquals(state.active.get(assignment.attemptId), active);
    assertEquals(active.controller.signal.aborted, true);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
    settled.resolve({
      status: "canceled",
      cancellation: {
        processExited: false,
        exitedAt: null,
        cleanupStatus: "pending",
      },
    });
    await execution;
    assertEquals(state.active.has(assignment.attemptId), false);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("cleanup finalization cannot be re-quarantined by a concurrent heartbeat", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue46-cleanup-race-" });
  const cleanupCleared = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  const heartbeatQueued = Promise.withResolvers<void>();
  let execution: Promise<void> | undefined;
  let heartbeat: Promise<void> | undefined;
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
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
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    const clearEvidence = store.clearTerminationEvidence.bind(store);
    store.clearTerminationEvidence = async (attemptId) => {
      const registration = await clearEvidence(attemptId);
      cleanupCleared.resolve();
      await finishCleanup.promise;
      return registration;
    };
    const exitedAt = new Date().toISOString();
    const ordering: string[] = [];
    let reportedAttemptIds: unknown;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/cleanup")) {
          ordering.push("cleanup-confirmed");
          return Promise.resolve(protocolResponse({
            attemptId: assignment.attemptId,
            status: "canceled",
            cancellation: {
              processExited: true,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
              exitedAt,
              cleanupObserver: {
                observedBy: {
                  workerSessionId: assignment.workerSessionId!,
                  workerSessionGeneration: String(
                    assignment.workerSessionGeneration,
                  ),
                },
              },
            },
          }));
        }
        if (path.endsWith("/heartbeat")) {
          const body = JSON.parse(String(init?.body));
          reportedAttemptIds = body.activeAttemptIds;
          ordering.push("retirement-heartbeat");
          return Promise.resolve(heartbeatResponse(
            assignment.workerHostId,
            [],
            [],
            assignment.workerSessionId!,
            String(assignment.workerSessionGeneration),
            [],
          ));
        }
        return Promise.reject(new Error(`UNEXPECTED_REQUEST:${path}`));
      },
    });
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
    state.processSessionId = assignment.workerSessionId!;
    state.processSessionGeneration = String(assignment.workerSessionGeneration);
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
    state.active.set(assignment.attemptId, active);
    const release = async (
      attemptId: string,
      reason: string,
      options?: { discardJournal?: boolean },
    ) => {
      await releaseAttempt(state, attemptId, reason, options);
      if (reason === "CLEANUP_CONFIRMED") ordering.push("release-final");
    };
    execution = executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => {
          throw new Error(reason);
        },
        startLeaseRenewal: () => {},
      },
      release,
    );
    // Queue reconciliation after cleanup evidence is durably removed, but
    // before the active assignment and release marker have been finalized.
    await cleanupCleared.promise;
    heartbeat = runHeartbeatLoop(state, {
      withControlPlane: (work) => {
        const pending = withControlPlane(
          state.controlPlane,
          state.lifecycleController.signal,
          work,
        );
        heartbeatQueued.resolve();
        return pending;
      },
      releaseAttempt: release,
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {},
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: () => retryPendingTerminationCleanup(state),
      markSessionReady: () => {},
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    await heartbeatQueued.promise;
    finishCleanup.resolve();
    await Promise.all([execution, heartbeat]);
    assertEquals(ordering, [
      "cleanup-confirmed",
      "release-final",
      "retirement-heartbeat",
    ]);
    assertEquals(reportedAttemptIds, []);
    const persisted = await store.load();
    assertEquals(
      persisted?.activeAssignments?.[assignment.attemptId],
      undefined,
    );
    assertEquals(persisted?.releaseMarkers?.[assignment.attemptId], undefined);
    assertEquals(
      persisted?.terminationEvidence?.[assignment.attemptId],
      undefined,
    );
    assertEquals(state.active.has(assignment.attemptId), false);
    assertEquals(state.terminationEvidence.has(assignment.attemptId), false);
    assertEquals(spool.records(), []);
  } finally {
    finishCleanup.resolve();
    await Promise.allSettled(
      [execution, heartbeat].filter((task) => task !== undefined),
    );
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("ALREADY_TERMINAL before command delivery remains quarantined", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-terminal-race-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
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
      executionSettled: false,
      restored: false,
    };
    state.active.set(assignment.attemptId, active);
    await releaseAttempt(state, assignment.attemptId, "ALREADY_TERMINAL", {
      discardJournal: true,
    });
    assertEquals(active.controller.signal.aborted, true);
    assertEquals(state.active.get(assignment.attemptId), active);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("publication expiry enters the same termination quarantine", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-publication-" });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await spool.enqueueEvent({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      eventType: "job.started",
      payload: { startedAt: new Date().toISOString() },
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.processSessionId = assignment.workerSessionId!;
    state.processSessionGeneration = String(assignment.workerSessionGeneration);
    state.processSessionAcquired = true;
    state.freshHeartbeatReady = true;
    state.active.set(assignment.attemptId, {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      executionSettled: false,
      restored: false,
    });
    state.publicationAuthorities.set(assignment.attemptId, {
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
      attemptFence: assignment.fence,
      lifecycle: "active",
      leaseDeadline: performance.now() - 1,
    });
    await flushOnce(state);
    assertEquals(spool.records(), []);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("worker-scoped resume targets the host after its attempt is terminal", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-resume-" });
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const commandId = crypto.randomUUID();
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () =>
        Promise.resolve(
          heartbeatResponse(
            assignment.workerHostId,
            [{
              id: commandId,
              attemptId: assignment.attemptId,
              messageId: crypto.randomUUID(),
              commandType: "follow_up",
              payload: {
                controlAction: "resume",
                controlScope: "worker",
                workerHostId: assignment.workerHostId,
                workerSessionId: state.processSessionId,
                workerSessionGeneration: "1",
                fence: assignment.fence,
              },
              status: "pending",
              createdAt: new Date().toISOString(),
            }],
            [],
            state.processSessionId,
            "1",
          ),
        ),
    });
    client.setCredential("credential");
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
    state.controlState.mode = "paused";
    state.controlState.admissionPaused = true;
    await runHeartbeatLoop(state, {
      withControlPlane: (work) => work(new AbortController().signal),
      releaseAttempt: async () => {},
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {},
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: async () => {},
      markSessionReady: () => {},
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    assertEquals(state.commandOutcomes.get(commandId), "acknowledged");
    assertEquals(state.controlState.mode, "running");
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("paused restored assignments renew without starting execution", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-renewal-" });
  let activeForCleanup: ActiveAssignment | undefined;
  let renewalLoop: Promise<void> | undefined;
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    let renewalCalls = 0;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return Promise.resolve(
            heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              state.processSessionId,
              "1",
              [assignment.attemptId],
            ),
          );
        }
        renewalCalls++;
        state.stopping = true;
        return Promise.resolve(
          protocolResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            serverTime: new Date().toISOString(),
          }),
        );
      },
    });
    client.setCredential("credential");
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    });
    state.registration = await store.load();
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: false,
      restored: true,
    };
    activeForCleanup = active;
    state.active.set(assignment.attemptId, active);
    state.controlState.mode = "paused";
    state.controlState.admissionPaused = true;
    await runHeartbeatLoop(state, {
      withControlPlane: (work) => work(new AbortController().signal),
      releaseAttempt: async () => {},
      restoreRestoredAssignments: async () => {},
      startRestoredLeaseRenewals: () => {
        if (active.renewalLoopStarted) return;
        active.renewalLoopStarted = true;
        renewalLoop = runLeaseRenewalLoop(state, active, {
          releaseAttempt: async () => {},
          failFatal: (reason) => {
            throw new Error(reason);
          },
        });
      },
      resumeRestoredAssignments: async () => {},
      retryPendingCleanupEvidence: async () => {},
      markSessionReady: () => {},
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    assertEquals(renewalCalls, 1);
  } finally {
    activeForCleanup?.renewalController.abort();
    if (renewalLoop) await renewalLoop;
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("lease renewal sleep stays inside the remaining lease margin", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-renewal-margin-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const sleepDelays: number[] = [];
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () =>
        Promise.reject(new Error("renewal should not cross lease")),
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: (delay) => {
        sleepDelays.push(delay);
        state.stopping = true;
        return Promise.resolve();
      },
    });
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 120,
      renewalKey: undefined,
      renewalLoopStarted: true,
      terminalAcked: false,
      executionStarted: false,
      restored: true,
    };
    state.active.set(assignment.attemptId, active);

    await runLeaseRenewalLoop(state, active, {
      releaseAttempt: async () => {},
      failFatal: () => {},
    });

    assertEquals(sleepDelays.length, 1);
    assert(sleepDelays[0] < 50);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test(
  "lease renewal releases after a retryable failure inside final margin",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-renewal-final-margin-",
    });
    try {
      const assignment = localAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 20,
        maxBytes: 20_000,
      });
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: assignment.workerSessionGeneration!,
      });
      await store.saveActiveAssignment({
        assignment,
        nextLocalSeq: "1",
        ackedLocalSeq: "0",
      });
      let renewalCalls = 0;
      let releaseReason: string | undefined;
      const sleepDelays: number[] = [];
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: () => {
          renewalCalls += 1;
          return Promise.reject(
            new WorkerRequestError("RETRYABLE_RENEWAL", 503, true),
          );
        },
      });
      const active: ActiveAssignment = {
        assignment,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: performance.now() + 120,
        renewalKey: undefined,
        renewalLoopStarted: true,
        terminalAcked: false,
        executionStarted: false,
        restored: true,
      };
      const state = createSupervisorState({
        config: supervisorConfig(directory),
        client,
        registrationStore: store,
        spool,
        sleep: (delay) => {
          sleepDelays.push(delay);
          if (sleepDelays.length === 1) {
            active.leaseDeadline = performance.now() + 50;
          }
          return Promise.resolve();
        },
      });
      state.active.set(assignment.attemptId, active);
      await runLeaseRenewalLoop(state, active, {
        releaseAttempt: (_attemptId, reason) => {
          releaseReason = reason;
          state.active.delete(assignment.attemptId);
          return Promise.resolve();
        },
        failFatal: (reason) => {
          throw new Error(reason);
        },
      });

      assertEquals(renewalCalls, 1);
      assertEquals(sleepDelays.length, 1);
      assertEquals(releaseReason, "LEASE_EXPIRED");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
Deno.test("revoked renewal cannot restore authority after async persistence", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-renewal-revoked-",
  });
  let activeForCleanup: ActiveAssignment | undefined;
  let renewalLoop: Promise<void> | undefined;
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    await store.saveActiveAssignment({
      assignment,
      nextLocalSeq: "1",
      ackedLocalSeq: "0",
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const updateStarted = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    let dispatches = 0;
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/lease-renewals")) {
            return Promise.resolve(
              protocolResponse({
                attemptId: assignment.attemptId,
                fence: assignment.fence,
                status: "active",
                leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                serverTime: new Date().toISOString(),
              }),
            );
          }
          dispatches++;
          return Promise.resolve(ackResponse(init));
        },
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.processSessionId = assignment.workerSessionId!;
    state.processSessionGeneration = String(assignment.workerSessionGeneration);
    state.client.setCredential("credential");
    const originalUpdate = store.updateActiveAssignment.bind(store);
    store.updateActiveAssignment = async (...args) => {
      updateStarted.resolve();
      await releaseUpdate.promise;
      return await originalUpdate(...args);
    };
    const active: ActiveAssignment = {
      assignment,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60_000,
      renewalKey: undefined,
      renewalLoopStarted: true,
      terminalAcked: false,
      executionStarted: false,
      restored: true,
    };
    activeForCleanup = active;
    state.active.set(assignment.attemptId, active);
    renewalLoop = runLeaseRenewalLoop(state, active, {
      releaseAttempt: async () => {},
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    await updateStarted.promise;
    await spool.enqueueResult({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "completed",
      result: {
        headSha: "head",
        baseSha: "base",
        sessionId: crypto.randomUUID(),
        artifacts: [],
      },
    });
    active.publicationRevoked = true;
    active.controller.abort();
    active.renewalController.abort();
    state.terminationEvidence.set(
      assignment.attemptId,
      cleanupEvidence(state),
    );
    state.stopping = true;
    releaseUpdate.resolve();
    await renewalLoop;
    assertEquals(
      state.publicationAuthorities.has(assignment.attemptId),
      false,
    );
    state.processSessionAcquired = true;
    state.freshHeartbeatReady = true;
    state.publicationAuthorities.set(assignment.attemptId, {
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
      attemptFence: assignment.fence,
      lifecycle: "active",
      leaseDeadline: performance.now() + 60_000,
    });
    state.draining = true;
    await flushOnce(state);
    assertEquals(dispatches, 0);
    assertEquals(state.spool.attemptIds().length, 1);
    active.controller = new AbortController();
    active.renewalController = new AbortController();
    active.publicationRevoked = false;
    state.terminationEvidence.delete(assignment.attemptId);
    state.draining = false;
    active.executionStarted = true;
    await flushOnce(state);
    assertEquals(dispatches, 1);
    assertEquals(state.spool.attemptIds(), []);
    assertEquals(state.serverTerminalObservations.size, 0);
  } finally {
    activeForCleanup?.renewalController.abort();
    if (renewalLoop) await renewalLoop;
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("heartbeat reconciliation preserves completed and failed results awaiting ACK", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-lost-ack-" });
  try {
    const assignments = [localAssignment(), localAssignment()];
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignments[0].workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignments[0].workerSessionId!,
      workerSessionGeneration: String(
        assignments[0].workerSessionGeneration,
      ),
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();

    for (const [index, status] of ["completed", "failed"].entries()) {
      const assignment = assignments[index];
      await spool.enqueueResult({
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        eventId: crypto.randomUUID(),
        status: status as "completed" | "failed",
        ...(status === "completed"
          ? { result: { accepted: true } }
          : { fault: { code: "EXECUTION_FAILED" } }),
      });
      state.active.set(assignment.attemptId, {
        assignment,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: performance.now() + 60_000,
        renewalKey: undefined,
        renewalLoopStarted: false,
        terminalAcked: false,
        executionStarted: true,
        executionSettled: false,
        restored: false,
      });

      await releaseAttempt(
        state,
        assignment.attemptId,
        "HEARTBEAT_NOT_RECONCILED",
        { discardJournal: true },
      );

      assertEquals(
        spool.records().find((record) =>
          record.attemptId === assignment.attemptId
        )?.kind,
        "result",
      );
      assertEquals(state.terminationEvidence.has(assignment.attemptId), false);
      assertEquals(
        state.releasedJournalAttempts.has(assignment.attemptId),
        true,
      );
      assertEquals(state.active.has(assignment.attemptId), false);
    }
    assertEquals(spool.records().length, 2);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("heartbeat reconciliation quarantines an unsettled canceled result", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-canceled-" });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    await spool.enqueueEvent({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      eventType: "job.started",
      payload: { startedAt: new Date().toISOString() },
    });
    await spool.enqueueResult({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "2",
      eventId: crypto.randomUUID(),
      status: "canceled",
      cancellation: { reason: "requested" },
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
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
      executionSettled: false,
      restored: false,
    };
    state.active.set(assignment.attemptId, active);

    await releaseAttempt(
      state,
      assignment.attemptId,
      "HEARTBEAT_NOT_RECONCILED",
      { discardJournal: true },
    );

    assertEquals(spool.records(), []);
    assertEquals(
      state.terminationEvidence.get(assignment.attemptId)?.status,
      "unknown",
    );
    assertEquals(
      state.releasedJournalAttempts.has(assignment.attemptId),
      false,
    );
    assertEquals(state.active.get(assignment.attemptId), active);
    assertEquals(active.controller.signal.aborted, true);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("held replay-safe journals drain without head-blocking publication", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-held-journal-" });
  try {
    const first = localAssignment();
    const second = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: first.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: first.workerSessionId!,
      workerSessionGeneration: String(first.workerSessionGeneration),
    });
    await store.saveReleaseMarker(
      first.attemptId,
      "HEARTBEAT_NOT_RECONCILED",
    );
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const replayResult = {
      headSha: "head",
      baseSha: "base",
      sessionId: crypto.randomUUID(),
      artifacts: [],
    };
    await spool.enqueueResult({
      attemptId: first.attemptId,
      leaseToken: first.leaseToken,
      fence: first.fence,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "completed",
      result: replayResult,
    });
    await spool.enqueueResult({
      attemptId: second.attemptId,
      leaseToken: second.leaseToken,
      fence: second.fence,
      localSeq: "1",
      eventId: crypto.randomUUID(),
      status: "completed",
      result: replayResult,
    });
    const posted: string[] = [];
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const attemptId = path.split("/attempts/")[1]?.split("/")[0];
        if (attemptId) posted.push(attemptId);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          eventId?: string;
          localSeq?: string;
          events?: Array<{ eventId?: string; localSeq?: string }>;
        };
        return Promise.resolve(
          protocolResponse({
            eventId: request.headers.get("Idempotency-Key") ??
              body.eventId ??
              body.events?.[0]?.eventId ??
              crypto.randomUUID(),
            status: "applied",
            lastEventSeq: body.localSeq ??
              body.events?.[0]?.localSeq ??
              "1",
          }),
        );
      },
    });
    client.setCredential("credential");
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.processSessionAcquired = true;
    state.processSessionId = second.workerSessionId!;
    state.processSessionGeneration = second.workerSessionGeneration!;
    state.freshHeartbeatReady = true;
    state.releasedJournalAttempts.add(first.attemptId);
    state.registration = await store.saveReleaseMarker(
      second.attemptId,
      "HEARTBEAT_NOT_RECONCILED",
    );
    state.releasedJournalAttempts.add(second.attemptId);
    assertEquals(await flushOnce(state), true);
    assertEquals(posted, [first.attemptId]);
    assertEquals(spool.attemptIds(), [second.attemptId]);
    assertEquals(await flushOnce(state), true);
    assertEquals(posted, [first.attemptId, second.attemptId]);
    assertEquals(spool.attemptIds(), []);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("held released journal retention is bounded", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-held-cap-" });
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    const attempts: string[] = [];
    for (let index = 0; index < 65; index++) {
      const attemptId = crypto.randomUUID();
      attempts.push(attemptId);
      await spool.enqueueResult({
        attemptId,
        leaseToken: "lease-token",
        fence: "1",
        localSeq: "1",
        eventId: crypto.randomUUID(),
        status: "completed",
        result: { index },
      });
      await releaseAttempt(state, attemptId, "HEARTBEAT_NOT_RECONCILED");
    }
    assertEquals(state.releasedJournalAttempts.size, 64);
    assertEquals(spool.attemptIds().length, 64);
    assertEquals(state.releasedJournalAttempts.has(attempts[0]), false);
    assertEquals(
      state.releasedJournalAttempts.has(attempts[attempts.length - 1]),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("admission changes after claim release the newly leased attempt", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-claim-admission-",
  });
  try {
    const assignment = nonmodelAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
    });
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () => {
        state.terminationEvidence.set(assignment.attemptId, {
          status: "pending",
          observedAt: new Date().toISOString(),
        });
        return Promise.resolve(protocolResponse(assignment));
      },
    });
    client.setCredential("credential");
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        execute: () => Promise.reject(new Error("UNEXPECTED_EXECUTION")),
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.freshHeartbeatReady = true;
    state.healthy = true;
    state.processSessionAcquired = true;
    const released: string[] = [];
    await runClaimLoop(state, {
      withControlPlane: (work, signal) =>
        work(signal ?? new AbortController().signal),
      releaseAttempt: async (attemptId, reason, options) => {
        released.push(reason);
        await releaseAttempt(state, attemptId, reason, options);
        state.stopping = true;
      },
      executeAssignment: () => {
        throw new Error("UNEXPECTED_EXECUTION");
      },
      failFatal: (reason) => {
        throw new Error(reason);
      },
    });
    assertEquals(released, ["ADMISSION_BLOCKED"]);
    assertEquals(state.active.has(assignment.attemptId), false);
    assertEquals(
      state.registration?.activeAssignments?.[assignment.attemptId],
      undefined,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

function cleanupEvidence(
  state: SupervisorState,
  observedAt = new Date().toISOString(),
) {
  return {
    status: "pending" as const,
    observedAt,
    fence: "1",
    observedExitAt: observedAt,
    cleanupComplete: true,
    observedBy: {
      workerSessionId: state.processSessionId,
      workerSessionGeneration: state.processSessionGeneration,
    },
  };
}

Deno.test("termination cleanup cursor services more than eight entries fairly", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-cleanup-fair-" });
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    const attemptIds = Array.from(
      { length: MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT + 4 },
      () => crypto.randomUUID(),
    );
    for (const attemptId of attemptIds) {
      state.terminationEvidence.set(attemptId, cleanupEvidence(state));
    }
    const calls: string[] = [];
    state.client.confirmCleanup = (attemptId) => {
      calls.push(attemptId);
      return Promise.reject(
        new WorkerRequestError("SERVICE_UNAVAILABLE", 503, true),
      );
    };
    await retryPendingTerminationCleanup(state);
    assertEquals(calls, attemptIds.slice(0, 8));
    assertEquals(state.terminationCleanupCursor, attemptIds[7]);
    state.terminationCleanupNextRetryAt.clear();
    await retryPendingTerminationCleanup(state);
    assertEquals(calls.slice(8, 12), attemptIds.slice(8));
    assertEquals(state.terminationCleanupRetries.get(attemptIds[8]), 1);
    assertEquals(state.terminationCleanupFailures.has(attemptIds[8]), false);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("retryable cleanup 503 is replayed before evidence retirement", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-cleanup-503-" });
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    const attemptId = crypto.randomUUID();
    state.terminationEvidence.set(attemptId, cleanupEvidence(state));
    let calls = 0;
    state.client.confirmCleanup = () => {
      calls++;
      return calls === 1
        ? Promise.reject(
          new WorkerRequestError("SERVICE_UNAVAILABLE", 503, true),
        )
        : Promise.resolve(undefined as never);
    };
    await retryPendingTerminationCleanup(state);
    assertEquals(calls, 1);
    assertEquals(state.terminationEvidence.has(attemptId), true);
    assertEquals(state.terminationCleanupRetries.get(attemptId), 1);
    assertEquals(state.terminationCleanupFailures.has(attemptId), false);
    const retryAt = state.terminationCleanupNextRetryAt.get(attemptId);
    assert(retryAt !== undefined);
    await retryPendingTerminationCleanup(state);
    assertEquals(calls, 1);
    await waitForCondition(
      () => performance.now() >= retryAt,
      "TERMINATION_CLEANUP_BACKOFF",
    );
    await retryPendingTerminationCleanup(state);
    assertEquals(calls, 2);
    assertEquals(state.terminationEvidence.has(attemptId), false);
    assertEquals(state.terminationCleanupRetries.has(attemptId), false);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
Deno.test("permanent cleanup conflicts retire evidence after three failures", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-cleanup-permanent-",
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
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    });
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      sleep: () => Promise.resolve(),
    });
    const attemptId = crypto.randomUUID();
    state.terminationEvidence.set(attemptId, cleanupEvidence(state));
    let calls = 0;
    state.client.confirmCleanup = () => {
      calls++;
      return Promise.reject(
        new WorkerRequestError("STATE_CONFLICT", 409, false),
      );
    };
    await retryPendingTerminationCleanup(state);
    await retryPendingTerminationCleanup(state);
    await retryPendingTerminationCleanup(state);
    assertEquals(calls, 3);
    assertEquals(state.terminationEvidence.has(attemptId), false);
    assertEquals(state.terminationCleanupFailures.has(attemptId), false);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("interrupt revokes publication before an abort-ignoring executor settles", async () => {
  const directory = await Deno.makeTempDir({ prefix: "issue42-late-success-" });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: String(assignment.workerSessionGeneration),
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
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<ExecutionOutcome>();
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client: new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
      }),
      registrationStore: store,
      spool,
      executor: {
        supportedActions: ["harness.implement"],
        execute: () => {
          started.resolve();
          return settled.promise;
        },
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
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
      executionSettled: false,
      restored: false,
    };
    state.active.set(assignment.attemptId, active);
    const execution = executeAssignment(
      state,
      assignment,
      active.controller.signal,
      {
        failFatal: (reason) => {
          throw new Error(reason);
        },
        startLeaseRenewal: () => {},
      },
      async () => {},
    );
    await started.promise;
    await releaseAttempt(
      state,
      assignment.attemptId,
      "CONTROL_COMMAND_ABORTED",
      {
        discardJournal: true,
      },
    );
    assertEquals(state.active.get(assignment.attemptId), active);
    settled.resolve({
      status: "completed",
      result: {
        headSha: "head",
        baseSha: "base",
        sessionId: "late",
        artifacts: [],
      },
    });
    await execution;
    assertEquals(
      spool.records().some((record) => record.kind === "result"),
      false,
    );
    assertEquals(state.publicationAuthorities.has(assignment.attemptId), false);
    assertEquals(state.active.has(assignment.attemptId), false);
    assertEquals(
      state.terminationEvidence.has(assignment.attemptId),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("capacity pause clearing preserves operator pause provenance", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-capacity-provenance-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: "1",
    });
    await store.saveCommandOutcome("operator-pause", "acknowledged", {
      admissionPaused: true,
      operatorPaused: true,
      capacityPaused: false,
    });
    await store.setCapacityPaused(true);
    await store.saveTerminationEvidence(assignment.attemptId, {
      status: "unknown",
      observedAt: new Date().toISOString(),
    });
    const saved = await store.clearTerminationEvidence(assignment.attemptId);
    assertEquals(saved.operatorPaused, true);
    assertEquals(saved.capacityPaused, false);
    assertEquals(saved.admissionPaused, true);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("startup reconciliation restores legacy operator pause", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue42-legacy-pause-",
  });
  try {
    const assignment = localAssignment();
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("credential", {
      workerHostId: assignment.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: "1",
    });
    await store.saveCommandOutcome("legacy-operator-pause", "acknowledged", {
      admissionPaused: true,
      capacityPaused: false,
    });
    const reconciled = await store.reconcileCapacityPause();
    assertEquals(reconciled.operatorPaused, true);
    assertEquals(reconciled.admissionPaused, true);
    assertEquals(reconciled.capacityPaused, false);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test(
  "capacity pause provenance remains without silent evidence expiry",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "issue42-capacity-restart-",
    });
    try {
      const assignment = localAssignment();
      const store = new RegistrationStore(`${directory}/registration.json`);
      await store.saveRegistered("credential", {
        workerHostId: assignment.workerHostId,
        principalId: crypto.randomUUID(),
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: "1",
      });
      await store.setCapacityPaused(true);
      await store.saveTerminationEvidence(assignment.attemptId, {
        status: "unknown",
        observedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      });
      let heartbeatCount = 0;
      let claimCount = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.endsWith("/heartbeat")) {
            heartbeatCount++;
            const body = JSON.parse(await request.text()) as {
              workerHostId: string;
              workerSessionId: string;
              workerSessionGeneration: string;
            };
            queueMicrotask(() =>
              supervisor.requestStop("CAPACITY_REMAINS_PAUSED")
            );
            return heartbeatResponse(
              body.workerHostId,
              [],
              [],
              body.workerSessionId,
              body.workerSessionGeneration,
            );
          }
          if (path.endsWith("/claims")) {
            claimCount++;
            setTimeout(() => supervisor.requestStop("CAPACITY_RESUMED"), 0);
            return protocolEmptyResponse({ status: 204 });
          }
          throw new Error(`UNEXPECTED_REQUEST:${path}`);
        },
      });
      client.setCredential("credential");
      const supervisor = new WorkerSupervisor({
        config: supervisorConfig(directory),
        client,
        registrationStore: store,
        spool: await EventSpool.open({
          path: `${directory}/spool.json`,
          maxRecords: 20,
          maxBytes: 20_000,
        }),
        executor: createDeterministicExecutor(),
        sleep: recoverySleep,
      });
      await supervisor.run();
      const saved = await store.load();
      assertEquals(heartbeatCount >= 1, true);
      assertEquals(claimCount, 0);
      assertEquals(saved?.capacityPaused, true);
      assertEquals(saved?.admissionPaused, true);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
