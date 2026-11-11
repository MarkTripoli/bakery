import { assertEquals } from "@std/assert";
import { runFixedWorkflow } from "../../apps/server/src/modules/workflow-adapter/fixed-workflow.ts";
import {
  type AdmissionRecord,
  type LogicalInvocationKey,
} from "../../apps/server/src/modules/workflow-adapter/invocation-contract.ts";
import {
  type AuthoritativeState,
  decideResume,
} from "../../apps/server/src/modules/workflow-adapter/resume-decision.ts";

type TestState = AuthoritativeState<{ ok: true }>;

const key: LogicalInvocationKey = {
  runId: "run-1",
  stepKey: "step-1",
  iteration: 0,
  actionVersion: "version-1",
};

const admission: AdmissionRecord = { key, terminal: false, jobId: "job-1" };

function state(overrides: Partial<TestState> = {}): TestState {
  return {
    key,
    admission,
    attempts: 0,
    liveAttempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

Deno.test("reconciliation observes completion before registering a wait", async () => {
  let waits = 0;
  const outcome = await runFixedWorkflow(
    { logical: key },
    {
      store: {
        read: () => state({ result: { ok: true } }),
        admit: () => admission,
      },
      wait: () => {
        waits += 1;
      },
    },
  );

  assertEquals(outcome.decision, {
    kind: "terminal-result",
    result: { ok: true },
  });
  assertEquals(waits, 0);
});

Deno.test("reconciliation rereads after a wakeup before returning completion", async () => {
  let reads = 0;
  let current: TestState | undefined;
  let waits = 0;
  const outcome = await runFixedWorkflow(
    { logical: key },
    {
      store: {
        read: () => {
          reads += 1;
          return current;
        },
        admit: () => {
          current = state();
          return admission;
        },
      },
      wait: () => {
        waits += 1;
        current = state({ result: { ok: true } });
      },
    },
  );

  assertEquals(outcome.decision, {
    kind: "terminal-result",
    result: { ok: true },
  });
  assertEquals({ reads, waits }, { reads: 3, waits: 1 });
});

Deno.test("a timed-out wait remains waiting and does not consume a logical step", async () => {
  let reads = 0;
  let current: TestState | undefined;
  let waits = 0;
  const outcome = await runFixedWorkflow(
    { logical: key },
    {
      store: {
        read: () => {
          reads += 1;
          return current;
        },
        admit: () => {
          current = state();
          return admission;
        },
      },
      wait: () => {
        waits += 1;
      },
      checkpoint: 99,
    },
  );

  assertEquals(outcome.decision.kind, "waiting");
  assertEquals({ reads, waits }, { reads: 3, waits: 1 });
});

Deno.test("resume decisions bound terminal attempts but ignore live leases", () => {
  assertEquals(
    decideResume(key, state({ attempts: 3, maxAttempts: 3 })).kind,
    "stalled",
  );
  assertEquals(
    decideResume(key, state({ attempts: 3, liveAttempts: 1, maxAttempts: 3 }))
      .kind,
    "stalled",
  );
  assertEquals(
    decideResume(key, state({ attempts: 2, liveAttempts: 1, maxAttempts: 3 }))
      .kind,
    "already-admitted-action",
  );
  assertEquals(
    decideResume({ ...key, actionVersion: "other" }, state()).kind,
    "state-conflict",
  );
});

Deno.test("reconciliation preserves durable failure, retry, stall, and conflict decisions", async () => {
  const future = new Date(Date.now() + 60_000);
  const cases = [
    {
      state: state({ terminalFailure: "engine_retries_exhausted" }),
      decision: { kind: "failed", reason: "engine_retries_exhausted" },
    },
    {
      state: state({ nextRetryAt: future, attempts: 1 }),
      decision: { kind: "retryable", nextRetryAt: future, attempts: 1 },
    },
    {
      state: state({ attempts: 3, maxAttempts: 3 }),
      decision: { kind: "stalled", reason: "attempt_budget_exhausted" },
    },
    {
      state: state({ key: { ...key, actionVersion: "other" } }),
      decision: { kind: "state-conflict", reason: "logical_identity_mismatch" },
    },
  ] as const;

  for (const candidate of cases) {
    let waits = 0;
    const outcome = await runFixedWorkflow(
      { logical: key },
      {
        store: {
          read: () => candidate.state,
          admit: () => admission,
        },
        wait: () => {
          waits += 1;
        },
      },
    );
    assertEquals(outcome.decision, candidate.decision);
    assertEquals(waits, 0);
  }
});
