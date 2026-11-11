import { assertEquals } from "@std/assert";
import type { JobAttemptRead } from "../../apps/web/src/api/client.ts";
import { runOutcomeState } from "../../apps/web/src/pages/run-outcome.ts";
const attempt: JobAttemptRead = {
  id: crypto.randomUUID(),
  jobId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  runStepId: crypto.randomUUID(),
  workerHostId: crypto.randomUUID(),
  workerName: "atlas",
  attemptNo: 1,
  status: "running",
  isCurrent: true,
  leaseState: "active",
  leaseExpiresAt: "2026-10-11T00:00:00Z",
  startedAt: "2026-10-11T00:00:00Z",
  endedAt: null,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
  outcome: {
    resultStatus: null,
    reasonCode: null,
    exitCode: null,
    processExited: null,
    terminationStatus: null,
    exitedAt: null,
    usage: null,
  },
};
Deno.test("run state never infers quota, exit or review from a result status", () => {
  assertEquals(runOutcomeState(attempt), "running");
  assertEquals(runOutcomeState(undefined), "unknown");
  assertEquals(
    runOutcomeState({
      ...attempt,
      status: "failed",
      outcome: { ...attempt.outcome, resultStatus: "failed" },
    }),
    "failed",
  );
  assertEquals(
    runOutcomeState({
      ...attempt,
      status: "completed",
      leaseState: "closed",
      outcome: { ...attempt.outcome, resultStatus: "completed" },
    }),
    "completed",
  );
});
Deno.test("explicit machine reason codes drive quota, timeout and lease-loss notices", () => {
  assertEquals(
    runOutcomeState({
      ...attempt,
      outcome: { ...attempt.outcome, resultStatus: "timed_out" },
    }),
    "timeout",
  );
  for (
    const [reasonCode, expected] of [
      ["quota_exceeded", "quota"],
      ["timeout", "timeout"],
      ["lease_lost", "lost-lease"],
      ["lease_expired", "lost-lease"],
    ] as const
  ) {
    assertEquals(
      runOutcomeState({
        ...attempt,
        outcome: { ...attempt.outcome, reasonCode },
      }),
      expected,
    );
  }
  assertEquals(
    runOutcomeState({ ...attempt, leaseState: "expired" }),
    "lost-lease",
  );
});
Deno.test("cancellation stays pending until termination is explicitly confirmed", () => {
  const canceled: JobAttemptRead = {
    ...attempt,
    status: "canceled",
    leaseState: "closed",
    outcome: {
      ...attempt.outcome,
      resultStatus: "canceled",
      processExited: false,
      terminationStatus: "pending",
    },
  };
  assertEquals(runOutcomeState(canceled), "canceling");
  assertEquals(
    runOutcomeState({
      ...canceled,
      outcome: { ...canceled.outcome, processExited: true },
    }),
    "canceling",
  );
  assertEquals(
    runOutcomeState({
      ...canceled,
      outcome: {
        ...canceled.outcome,
        processExited: true,
        terminationStatus: "confirmed",
        exitedAt: "2026-10-11T00:01:00Z",
      },
    }),
    "canceled",
  );
});
Deno.test("explicit process exit evidence remains distinct from completion", () => {
  assertEquals(
    runOutcomeState({
      ...attempt,
      outcome: { ...attempt.outcome, exitCode: 7 },
    }),
    "exit",
  );
  assertEquals(
    runOutcomeState({
      ...attempt,
      outcome: { ...attempt.outcome, processExited: true },
    }),
    "exit",
  );
});
