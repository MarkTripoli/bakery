import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import { createSupervisorState } from "../../apps/worker/src/supervisor-state.ts";
import { runLeaseRenewalLoop } from "../../apps/worker/src/supervisor-claims.ts";
import { runHeartbeatLoop } from "../../apps/worker/src/supervisor-heartbeat.ts";
import {
  type ActiveAssignment,
  isTransientControlPlaneFailure,
} from "../../apps/worker/src/supervisor-support.ts";
import {
  createDeterministicExecutor,
  fastSleep,
  heartbeatResponse,
  localAssignment,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";

const NO_SANITIZE = { sanitizeResources: false, sanitizeOps: false } as const;

const INTERNAL_500 = {
  code: "INTERNAL",
  retryable: false,
  status: 500,
  detail: "secret-canary",
};

function internalResponse(): Response {
  return protocolResponse(INTERNAL_500, { status: 500 });
}

async function withDirectory<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir({ prefix: "bakery-transient-cp-" });
  try {
    return (await captureConsole(() => work(directory))).value;
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

async function registeredSupervisor(
  directory: string,
  fetcher: (input: URL | Request | string, init?: RequestInit) => Response,
  workerHostId: string,
): Promise<WorkerSupervisor> {
  const store = new RegistrationStore(`${directory}/registration.json`);
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
    credential: "credential",
    fetcher: (input, init) => Promise.resolve(fetcher(input, init)),
  });
  return new WorkerSupervisor({
    config: supervisorConfig(directory),
    client,
    registrationStore: store,
    spool: await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    }),
    executor: createDeterministicExecutor(),
    sleep: fastSleep,
  });
}

type ConsoleCapture = { warnings: string[]; others: string[] };

/** Captures console output so expected 500 problem logs do not flood the run. */
async function captureConsole<T>(
  work: () => Promise<T>,
): Promise<{ value: T; output: ConsoleCapture }> {
  const output: ConsoleCapture = { warnings: [], others: [] };
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    info: console.info,
  };
  console.warn = (...args: unknown[]) => output.warnings.push(args.join(" "));
  console.error = (...args: unknown[]) => output.others.push(args.join(" "));
  console.log = (...args: unknown[]) => output.others.push(args.join(" "));
  console.info = (...args: unknown[]) => output.others.push(args.join(" "));
  try {
    return { value: await work(), output };
  } finally {
    Object.assign(console, original);
  }
}

function idempotencyKey(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("Idempotency-Key");
}

Deno.test("isTransientControlPlaneFailure covers retryable and 5xx only", () => {
  assert(isTransientControlPlaneFailure(
    new WorkerRequestError("INTERNAL", 500, false),
  ));
  assert(isTransientControlPlaneFailure(
    new WorkerRequestError("DEPENDENCY_UNAVAILABLE", 503, true),
  ));
  assert(isTransientControlPlaneFailure(
    new WorkerRequestError("NETWORK", null, true),
  ));
  assert(
    !isTransientControlPlaneFailure(
      new WorkerRequestError("LEASE_FENCED", 409, false),
    ),
  );
  assert(
    !isTransientControlPlaneFailure(
      new WorkerRequestError("AUTH_INVALID", 401, false),
    ),
  );
  assert(!isTransientControlPlaneFailure(new Error("INTERNAL")));
  assert(
    !isTransientControlPlaneFailure(
      new WorkerRequestError("WORKER_PROTOCOL_UNSUPPORTED", 426, false),
    ),
  );
});

Deno.test({
  name:
    "a transient 500 INTERNAL heartbeat is retried with the same key and logs one bounded line",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      const workerHostId = crypto.randomUUID();
      let heartbeats = 0;
      const heartbeatKeys: Array<string | null> = [];
      let supervisor: WorkerSupervisor | undefined;
      const { output } = await captureConsole(async () => {
        supervisor = await registeredSupervisor(directory, (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            heartbeats += 1;
            heartbeatKeys.push(idempotencyKey(init));
            if (heartbeats === 2) return internalResponse();
            if (heartbeats >= 4) {
              queueMicrotask(() => supervisor?.requestStop("TEST_COMPLETE"));
            }
            return heartbeatResponse(workerHostId);
          }
          if (path.endsWith("/claims")) {
            return protocolEmptyResponse({ status: 204 });
          }
          throw new Error(`UNEXPECTED_WORKER_PATH:${path}`);
        }, workerHostId);
        await supervisor.run();
      });
      assert(supervisor !== undefined);
      assertEquals(supervisor!.fatalReason, null);
      assert(heartbeats >= 4);
      assertEquals(heartbeatKeys[2], heartbeatKeys[1]);
      assert(heartbeatKeys[1] !== null);
      const retryLines = output.warnings.filter((line) =>
        line.includes("control_plane_retry")
      );
      assertEquals(retryLines.length, 1);
      const parsed = JSON.parse(retryLines[0]);
      assertEquals(parsed.route, "heartbeat");
      assertEquals(parsed.code, "INTERNAL");
      assertEquals(parsed.status, 500);
      assertEquals(parsed.event, "control_plane_retry");
      // The supervisor's own retry line never carries problem detail.
      assert(!retryLines[0].includes("secret-canary"));
    });
  },
});

Deno.test({
  name: "a heartbeat 409 LEASE_FENCED still stops the worker",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      const supervisor = await registeredSupervisor(directory, (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return protocolResponse(
            { code: "LEASE_FENCED", retryable: false },
            { status: 409 },
          );
        }
        return protocolEmptyResponse({ status: 204 });
      }, crypto.randomUUID());
      await supervisor.run();
      assertEquals(supervisor.fatalReason, "LEASE_FENCED");
    });
  },
});

Deno.test({
  name: "a heartbeat 401 AUTH_INVALID still stops the worker",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      const supervisor = await registeredSupervisor(directory, (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return protocolResponse(
            { code: "AUTH_INVALID", retryable: false },
            { status: 401 },
          );
        }
        return protocolEmptyResponse({ status: 204 });
      }, crypto.randomUUID());
      await supervisor.run();
      assertEquals(supervisor.fatalReason, "AUTH_INVALID");
    });
  },
});

Deno.test({
  name: "a transient 500 INTERNAL claim keeps an idle worker up",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      const workerHostId = crypto.randomUUID();
      let claims = 0;
      const ref: { current?: WorkerSupervisor } = {};
      const supervisor = await registeredSupervisor(directory, (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat")) {
          return heartbeatResponse(workerHostId);
        }
        if (path.endsWith("/claims")) {
          claims += 1;
          if (claims === 1) return internalResponse();
          if (claims >= 3) {
            queueMicrotask(() => ref.current?.requestStop("TEST_COMPLETE"));
          }
          return protocolEmptyResponse({ status: 204 });
        }
        throw new Error(`UNEXPECTED_WORKER_PATH:${path}`);
      }, workerHostId);
      ref.current = supervisor;
      await supervisor.run();
      assertEquals(supervisor.fatalReason, null);
      assert(claims >= 3);
    });
  },
});

async function renewalFixture(
  directory: string,
  options: { leaseMs: number; fetcher: () => Response; onSleep?: () => void },
) {
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
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: () => Promise.resolve(options.fetcher()),
  });
  const state = createSupervisorState({
    config: supervisorConfig(directory),
    client,
    registrationStore: store,
    spool,
    sleep: () => {
      options.onSleep?.();
      return new Promise<void>((resolve) => setTimeout(resolve, 2));
    },
  });
  state.registration = await store.load();
  const active: ActiveAssignment = {
    assignment,
    controller: new AbortController(),
    renewalController: new AbortController(),
    leaseSeconds: 45,
    leaseDeadline: performance.now() + options.leaseMs,
    renewalKey: undefined,
    renewalLoopStarted: true,
    terminalAcked: false,
    executionStarted: false,
    restored: true,
  };
  state.active.set(assignment.attemptId, active);
  return { assignment, state, active };
}

Deno.test({
  name: "a transient 500 INTERNAL lease renewal keeps the fence",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      let renewals = 0;
      const ref: {
        current?: Awaited<ReturnType<typeof renewalFixture>>;
      } = {};
      const fixture = await renewalFixture(directory, {
        leaseMs: 60_000,
        fetcher: () => {
          renewals += 1;
          if (renewals === 1) return internalResponse();
          // Stop after the first successful renewal.
          queueMicrotask(() => ref.current?.active.renewalController.abort());
          return protocolResponse({
            attemptId: fixture.assignment.attemptId,
            fence: fixture.assignment.fence,
            status: "active",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            serverTime: new Date().toISOString(),
          });
        },
      });
      ref.current = fixture;
      const released: string[] = [];
      const fatal: string[] = [];
      await runLeaseRenewalLoop(fixture.state, fixture.active, {
        releaseAttempt: (_attemptId, reason) => {
          released.push(reason);
          return Promise.resolve();
        },
        failFatal: (reason) => fatal.push(reason),
      });
      assert(renewals >= 2);
      assertEquals(fatal, []);
      assertEquals(released, []);
      assertEquals(
        fixture.state.active.get(fixture.assignment.attemptId),
        fixture.active,
      );
      assertEquals(fixture.active.assignment.fence, fixture.assignment.fence);
    });
  },
});

Deno.test({
  name:
    "repeated 500 INTERNAL renewals past the lease release as LEASE_EXPIRED",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
      let renewals = 0;
      const fixture = await renewalFixture(directory, {
        leaseMs: 400,
        fetcher: () => {
          renewals += 1;
          return internalResponse();
        },
      });
      const released: string[] = [];
      const fatal: string[] = [];
      await runLeaseRenewalLoop(fixture.state, fixture.active, {
        releaseAttempt: (_attemptId, reason) => {
          released.push(reason);
          fixture.state.active.delete(fixture.assignment.attemptId);
          return Promise.resolve();
        },
        failFatal: (reason) => fatal.push(reason),
      });
      assert(renewals >= 1);
      assertEquals(fatal, []);
      assertEquals(released, ["LEASE_EXPIRED"]);
      assertStringIncludes(released[0], "LEASE_EXPIRED");
    });
  },
});

Deno.test({
  name:
    "a transient 500 INTERNAL while replaying a restored renewal is retried",
  ...NO_SANITIZE,
  fn: async () => {
    await withDirectory(async (directory) => {
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
      let renewals = 0;
      let heartbeats = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "credential",
        fetcher: (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/heartbeat")) {
            heartbeats += 1;
            // Bound the loop if the failure turns fatal or never recovers.
            if (heartbeats > 10) state.stopping = true;
            return Promise.resolve(heartbeatResponse(
              assignment.workerHostId,
              [],
              [],
              state.processSessionId,
              "1",
              [assignment.attemptId],
            ));
          }
          renewals += 1;
          if (renewals === 1) return Promise.resolve(internalResponse());
          state.stopping = true;
          return Promise.resolve(protocolResponse({
            attemptId: assignment.attemptId,
            fence: assignment.fence,
            status: "active",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            serverTime: new Date().toISOString(),
          }));
        },
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
        renewalKey: crypto.randomUUID(),
        renewalLoopStarted: false,
        terminalAcked: false,
        executionStarted: false,
        restored: true,
      };
      state.active.set(assignment.attemptId, active);
      const fatal: string[] = [];
      await runHeartbeatLoop(state, {
        withControlPlane: (work) => work(new AbortController().signal),
        releaseAttempt: async () => {},
        restoreRestoredAssignments: async () => {},
        startRestoredLeaseRenewals: () => {},
        resumeRestoredAssignments: async () => {},
        retryPendingCleanupEvidence: async () => {},
        markSessionReady: () => {},
        failFatal: (reason) => fatal.push(reason),
      });
      assertEquals(fatal, []);
      assertEquals(renewals, 2);
    });
  },
});
