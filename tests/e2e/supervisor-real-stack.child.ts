import { assertEquals } from "@std/assert";
import { createAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import {
  createPostgresAuthPersistence,
} from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  createBrowserSessionMiddleware,
} from "../../apps/server/src/modules/auth/middleware.ts";
import {
  createExecutionControlApp,
} from "../../apps/server/src/modules/execution/control.ts";
import { type Fetcher, WorkerApiClient } from "../../apps/worker/src/client.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import {
  fastSleep,
  recoverySleep,
  supervisorConfig,
  waitForCondition,
} from "../helpers/worker-execution/recovery-support.ts";
import {
  type ExecutionState,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { supervisorPhaseLine } from "../helpers/supervisor-e2e-phase.ts";
import { type PostgresStack, upPostgresStack } from "./helpers/stack.ts";
import {
  createRealInngestStack,
  type RealInngestStack,
  type SeededWorkflow,
  type WorkflowState,
} from "../fixtures/real-inngest-stack.ts";
// One line per boundary, so the parent can name where a timed-out child was.
function phase(test: string, name: string): void {
  console.log(supervisorPhaseLine(test, name, performance.now()));
}

function controlAppForFixture(fixture: WorkerFixture) {
  const authStore = createPostgresAuthPersistence(fixture.runtimePgDatabase);
  const auth = createAuthProvider({
    pgDatabase: fixture.runtimePgDatabase,
    config: fixture.config.auth!,
    persistence: authStore,
  });
  return createExecutionControlApp({
    database: fixture.runtimePgDatabase,
    browserSession: createBrowserSessionMiddleware({
      auth,
      store: authStore,
      publicBaseUrl: fixture.config.publicBaseUrl,
      trustedOrigins: [fixture.config.publicBaseUrl],
      secret: fixture.config.auth!.secret,
    }),
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}

function completedExecutor(
  sessionId: string,
  executions?: { count: number },
): WorkerExecutor {
  return {
    supportedActions: ["harness.implement"],
    execute: () => {
      if (executions) executions.count++;
      return Promise.resolve({
        status: "completed",
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId,
          artifacts: [],
        },
      });
    },
  };
}

function interruptedExecutor(executions: { count: number }): WorkerExecutor {
  return {
    supportedActions: ["harness.implement"],
    execute: (_assignment, signal) => {
      executions.count++;
      return new Promise((resolve) => {
        const canceled = () =>
          resolve({
            status: "canceled" as const,
            cancellation: {
              processExited: false,
              exitedAt: null,
              cleanupStatus: "pending",
              terminationStatus: "unknown",
            },
          });
        if (signal.aborted) canceled();
        else signal.addEventListener("abort", canceled, { once: true });
      });
    },
  };
}
function clientFor(
  fixture: WorkerFixture,
  fetcher?: Fetcher,
): WorkerApiClient {
  return new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    fetcher: fetcher ??
      (async (input, init) =>
        await fixture.app.fetch(new Request(input, init))),
  });
}

async function waitForState(
  fixture: WorkerFixture,
  jobId: string,
  predicate: (state: ExecutionState) => boolean,
): Promise<ExecutionState> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await readExecutionState(fixture.pgDatabase, jobId);
    if (predicate(state)) return state;
    await fastSleep(10);
  }
  throw new Error(`WORKER_E2E_STATE_TIMEOUT:${jobId}`);
}

async function waitForEngineRegistration(
  stack: RealInngestStack,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const registration = await stack.readEngineRegistration();
    if (Number(registration.function_count ?? 0) > 0) return;
    await recoverySleep(250);
  }
  throw new Error("REAL_STACK_ENGINE_REGISTRATION_TIMEOUT");
}

async function withIssue42DatabaseEnvironment<T>(
  stack: PostgresStack,
  callback: () => Promise<T>,
): Promise<T> {
  const names = ["DATABASE_URL", "BAKERY_APP_DATABASE_URL"] as const;
  const previous: Record<string, string | undefined> = {};
  const values = {
    DATABASE_URL: stack.ownerDatabaseUrl,
    BAKERY_APP_DATABASE_URL: stack.appDatabaseUrl,
  };
  for (const name of names) {
    previous[name] = Deno.env.get(name);
    Deno.env.set(name, values[name]);
  }
  try {
    return await callback();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

async function withIssue42WorkerFixture<T>(
  callback: (fixture: WorkerFixture) => Promise<T>,
): Promise<T> {
  const stack = await upPostgresStack("issue42-worker");
  let result: T | undefined;
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    result = await withIssue42DatabaseEnvironment(
      stack,
      () => withWorkerFixture(callback),
    );
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  let cleanupError: unknown;
  try {
    await stack.down();
  } catch (error) {
    cleanupError = error;
  }
  if (callbackFailed) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [callbackError, cleanupError],
        "ISSUE42_FIXTURE_CLEANUP_FAILED",
      );
    }
    throw callbackError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

function createIssue42RealStack(
  options: { jobCompletionTimeout?: string } = {},
): {
  stack: RealInngestStack;
  cleanup: () => Promise<void>;
} {
  const stack = createRealInngestStack(options);
  return {
    stack,
    cleanup: async () => await stack.cleanup(),
  };
}

async function waitForStepAdmission(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  index: 0 | 1,
): Promise<WorkflowState> {
  let lastState: WorkflowState | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    lastState = await stack.readWorkflowState(seed);
    if (
      lastState.runStatus === "running" &&
      lastState.steps[index]?.status === "running" &&
      lastState.steps[index]?.jobStatus === "queued" &&
      lastState.steps[index]?.attemptCount === 0 &&
      lastState.engineOwnerToken !== null
    ) return lastState;
    await recoverySleep(250);
  }
  throw new Error(
    `REAL_STACK_STEP_NOT_ADMITTED:${JSON.stringify(lastState)}`,
  );
}

async function newStores(stateDir: string): Promise<{
  registrationStore: RegistrationStore;
  spool: EventSpool;
}> {
  return {
    registrationStore: new RegistrationStore(
      `${stateDir}/registration.json`,
    ),
    spool: await EventSpool.open({
      path: `${stateDir}/spool.json`,
      maxRecords: 100,
      maxBytes: 100_000,
    }),
  };
}

Deno.test("public supervisor run recovers durable interrupt and lost result ACK", () => {
  phase("supervisor-recovery", "begin");
  return withIssue42WorkerFixture(async (fixture) => {
    phase("supervisor-recovery", "stack-up");
    const worker = await registeredWorker(fixture, {
      name: "issue42-real-supervisor",
    });
    const stateDir = await Deno.makeTempDir({
      prefix: "issue42-real-supervisor-",
    });
    try {
      const initialStores = await newStores(stateDir);
      await initialStores.registrationStore.saveRegistered(
        worker.credential,
        worker.registration,
      );
      phase("supervisor-recovery", "registration");

      const lostAckJob = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const resultApplied = Promise.withResolvers<void>();
      const releaseLostAck = Promise.withResolvers<void>();
      let resultDropped = false;
      const firstClient = clientFor(fixture, async (input, init) => {
        const response = await fixture.app.fetch(new Request(input, init));
        if (
          !resultDropped &&
          String(input).includes("/result")
        ) {
          resultDropped = true;
          resultApplied.resolve();
          await releaseLostAck.promise;
          throw new Error("LOST_RESULT_ACK");
        }
        return response;
      });
      const firstSupervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(stateDir),
          serverUrl: fixture.config.publicBaseUrl,
        },
        client: firstClient,
        registrationStore: initialStores.registrationStore,
        spool: initialStores.spool,
        executor: completedExecutor(lostAckJob.sessionId),
        sleep: fastSleep,
      });
      const firstRun = firstSupervisor.run();
      await waitForState(
        fixture,
        lostAckJob.jobId,
        (state) =>
          state.attempts.some((attempt) => attempt.status === "completed"),
      );
      await resultApplied.promise;
      phase("supervisor-recovery", "first-claim");
      firstSupervisor.requestStop("LOST_RESULT_ACK");
      releaseLostAck.resolve();
      await firstRun;
      assertEquals(resultDropped, true);
      assertEquals(initialStores.spool.peek()?.kind, "result");
      phase("supervisor-recovery", "restart-lost-ack");

      const reopenedStores = await newStores(stateDir);
      const secondExecutions = { count: 0 };
      const secondSupervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(stateDir),
          serverUrl: fixture.config.publicBaseUrl,
        },
        client: clientFor(fixture),
        registrationStore: reopenedStores.registrationStore,
        spool: reopenedStores.spool,
        executor: completedExecutor(lostAckJob.sessionId, secondExecutions),
        sleep: fastSleep,
      });
      const secondRun = secondSupervisor.run();
      await waitForState(
        fixture,
        lostAckJob.jobId,
        (state) =>
          state.attempts.filter((attempt) => attempt.status === "completed")
            .length === 1,
      );
      await waitForCondition(
        () => reopenedStores.spool.peek() === null,
        "LOST_ACK_SPOOL_DRAIN",
        30_000,
      );
      assertEquals(reopenedStores.spool.peek(), null);
      phase("supervisor-recovery", "resumed-completion");
      secondSupervisor.requestStop("LOST_ACK_RECOVERED");
      await secondRun;
      assertEquals(secondExecutions.count, 0);
      assertEquals(secondSupervisor.fatalReason, null);

      const interruptedJob = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const interruptedExecutions = { count: 0 };
      const interruptedStores = await newStores(stateDir);
      const interruptedSupervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(stateDir),
          serverUrl: fixture.config.publicBaseUrl,
        },
        client: clientFor(fixture),
        registrationStore: interruptedStores.registrationStore,
        spool: interruptedStores.spool,
        executor: interruptedExecutor(interruptedExecutions),
        sleep: fastSleep,
      });
      const interruptedRun = interruptedSupervisor.run();
      const runningState = await waitForState(
        fixture,
        interruptedJob.jobId,
        (state) =>
          state.attempts.some((attempt) => attempt.status === "running"),
      );
      const attemptId = runningState.attempts[0].id;
      await waitForCondition(
        () => interruptedExecutions.count === 1,
        "INTERRUPTED_EXECUTOR_START_TIMEOUT",
        30_000,
      );
      phase("supervisor-recovery", "interrupt-claimed");
      const cancellation = await controlAppForFixture(fixture).fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/execution/attempts/${attemptId}/control`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              Cookie: fixture.adminCookie,
              "Idempotency-Key": `issue42-e2e-cancel-${attemptId}`,
            },
            body: JSON.stringify({ action: "cancel" }),
          },
        ),
      );
      assertEquals(cancellation.status, 202);
      const canceledState = await waitForState(
        fixture,
        interruptedJob.jobId,
        (state) =>
          state.attempts.some((attempt) => attempt.status === "canceled"),
      );
      phase("supervisor-recovery", "interrupt-canceled");
      assertEquals(canceledState.attempts.length, 1);
      assertEquals(interruptedExecutions.count, 1);
      await waitForCondition(
        async () =>
          Boolean(
            (await interruptedStores.registrationStore.load())
              ?.terminationEvidence?.[attemptId],
          ),
        "INTERRUPTED_EVIDENCE_DURABLE",
        30_000,
      );
      assertEquals(
        (await interruptedStores.registrationStore.load())
          ?.terminationEvidence?.[attemptId]?.status,
        "unknown",
      );
      phase("supervisor-recovery", "restart-interrupted");
      interruptedSupervisor.requestStop("INTERRUPT_DURABLE");
      await interruptedRun;
      const recoveredInterruptedStores = await newStores(stateDir);
      const recoveredExecutions = { count: 0 };
      let recoveredHeartbeats = 0;
      let recoveredClaims = 0;
      let recoveredEmptyClaims = 0;
      const recoveredClient = clientFor(fixture, async (input, init) => {
        const response = await fixture.app.fetch(new Request(input, init));
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat") && response.status === 200) {
          recoveredHeartbeats++;
        }
        if (path.endsWith("/claims")) {
          recoveredClaims++;
          if (response.status === 204) recoveredEmptyClaims++;
        }
        return response;
      });
      const recoveredSupervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(stateDir),
          serverUrl: fixture.config.publicBaseUrl,
        },
        client: recoveredClient,
        registrationStore: recoveredInterruptedStores.registrationStore,
        spool: recoveredInterruptedStores.spool,
        executor: completedExecutor(
          interruptedJob.sessionId,
          recoveredExecutions,
        ),
        sleep: fastSleep,
      });
      const recoveredRun = recoveredSupervisor.run();
      await waitForCondition(
        () => recoveredHeartbeats >= 1 && recoveredEmptyClaims >= 1,
        "RECOVERED_EMPTY_CLAIM_BARRIER_TIMEOUT",
        30_000,
      );
      phase("supervisor-recovery", "terminal-barrier");
      recoveredSupervisor.requestStop("TERMINAL_NOT_CLAIMABLE");
      await recoveredRun;
      const terminalState = await readExecutionState(
        fixture.pgDatabase,
        interruptedJob.jobId,
      );
      assertEquals(terminalState.attempts.length, 1);
      assertEquals(terminalState.attempts[0].status, "canceled");
      assertEquals(recoveredExecutions.count, 0);
      assertEquals(recoveredSupervisor.fatalReason, null);
    } finally {
      phase("supervisor-recovery", "cleanup");
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    }
  });
});

Deno.test("real stack restarts recover one continuation and reject terminal claims", async () => {
  const realStack = createIssue42RealStack({
    jobCompletionTimeout: "10s",
  });
  const stack = realStack.stack;
  const stateDir = await Deno.makeTempDir({
    prefix: "issue42-real-stack-lifecycle-",
  });
  try {
    phase("stack-restart", "begin");
    await stack.start();
    phase("stack-restart", "stack-up");
    await waitForEngineRegistration(stack);
    const seed = await stack.seedWorkflow(crypto.randomUUID());
    phase("stack-restart", "registration");
    await waitForStepAdmission(stack, seed, 0);
    phase("stack-restart", "first-admission");
    const initialStores = await newStores(stateDir);
    await initialStores.registrationStore.saveRegistered(
      seed.worker.credential,
      {
        workerHostId: seed.worker.workerHostId,
        principalId: seed.organizationId,
        status: "registered",
        registrationGeneration: 1,
        workerSessionId: seed.worker.workerSessionId,
        workerSessionGeneration: seed.worker.workerSessionGeneration,
      },
    );
    let firstAttemptId = "";
    const stoppingExecutor = interruptedExecutor({ count: 0 });
    const firstSupervisor = new WorkerSupervisor({
      config: {
        ...supervisorConfig(stateDir),
        serverUrl: stack.serverUrl,
      },
      client: new WorkerApiClient({ baseUrl: stack.serverUrl }),
      registrationStore: initialStores.registrationStore,
      spool: initialStores.spool,
      executor: {
        supportedActions: ["harness.implement"],
        execute: (assignment, signal) => {
          firstAttemptId = assignment.attemptId;
          return stoppingExecutor.execute(assignment, signal);
        },
      },
      sleep: fastSleep,
    });
    const firstRun = firstSupervisor.run();
    await waitForCondition(
      () => Boolean(firstAttemptId),
      "FIRST_ATTEMPT_NOT_CLAIMED",
      30_000,
    );
    phase("stack-restart", "first-claim");
    firstSupervisor.requestStop("WORKER_RESTART");
    await firstRun;
    assertEquals(firstSupervisor.fatalReason, null);

    await stack.stopEngine();
    await stack.stopServer();
    await stack.restartServer();
    phase("stack-restart", "restart-server");
    await stack.restartEngine();
    phase("stack-restart", "restart-engine");

    const resumedStores = await newStores(stateDir);
    const resumedAttempts = new Map<string, number>();
    let resumedStepIndex = 0;
    const resumedSupervisor = new WorkerSupervisor({
      config: {
        ...supervisorConfig(stateDir),
        serverUrl: stack.serverUrl,
      },
      client: new WorkerApiClient({ baseUrl: stack.serverUrl }),
      registrationStore: resumedStores.registrationStore,
      spool: resumedStores.spool,
      executor: {
        supportedActions: ["harness.implement"],
        execute: (assignment) => {
          resumedAttempts.set(
            assignment.attemptId,
            (resumedAttempts.get(assignment.attemptId) ?? 0) + 1,
          );
          const step = seed.steps[Math.min(resumedStepIndex++, 1)];
          return Promise.resolve({
            status: "completed" as const,
            result: {
              headSha: "issue42-head",
              baseSha: "issue42-base",
              sessionId: step.sessionId,
              artifacts: [],
            },
          });
        },
      },
      sleep: fastSleep,
    });
    const resumedRun = resumedSupervisor.run();
    await waitForCondition(
      async () =>
        (await stack.readWorkflowState(seed)).runStatus ===
          "completed",
      "REAL_STACK_WORKFLOW_NOT_COMPLETED",
      60_000,
    );
    phase("stack-restart", "resumed-completion");
    assertEquals(
      resumedAttempts.has(firstAttemptId),
      false,
      "unproven termination must quarantine the original attempt",
    );
    assertEquals(resumedAttempts.size, 2);
    resumedSupervisor.requestStop("TERMINAL_WORKFLOW");
    await resumedRun;

    const terminalStores = await newStores(stateDir);
    const terminalExecutions = { count: 0 };
    let terminalHeartbeats = 0;
    let terminalClaims = 0;
    let terminalEmptyClaims = 0;
    const terminalClient = new WorkerApiClient({
      baseUrl: stack.serverUrl,
      fetcher: async (input, init) => {
        const response = await fetch(input, init);
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/heartbeat") && response.status === 200) {
          terminalHeartbeats++;
        }
        if (path.endsWith("/claims")) {
          terminalClaims++;
          if (response.status === 204) terminalEmptyClaims++;
        }
        return response;
      },
    });
    const terminalSupervisor = new WorkerSupervisor({
      config: {
        ...supervisorConfig(stateDir),
        serverUrl: stack.serverUrl,
      },
      client: terminalClient,
      registrationStore: terminalStores.registrationStore,
      spool: terminalStores.spool,
      executor: completedExecutor(seed.steps[0].sessionId, terminalExecutions),
      sleep: fastSleep,
    });
    const terminalRun = terminalSupervisor.run();
    await waitForCondition(
      () => terminalHeartbeats >= 1 && terminalEmptyClaims >= 1,
      "TERMINAL_EMPTY_CLAIM_BARRIER_TIMEOUT",
      30_000,
    );
    phase("stack-restart", "terminal-barrier");
    terminalSupervisor.requestStop("TERMINAL_UNCLAIMABLE");
    await terminalRun;
    assertEquals(terminalExecutions.count, 0);
    assertEquals((await stack.readWorkflowState(seed)).runStatus, "completed");
  } finally {
    phase("stack-restart", "cleanup");
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    await realStack.cleanup();
  }
});
