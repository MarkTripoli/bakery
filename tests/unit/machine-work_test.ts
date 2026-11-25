import { assertEquals } from "@std/assert";
import type { WorkerAttemptResponse } from "../../apps/web/src/api/client.ts";
import {
  placeOf,
  rowState,
  slotsOf,
  stateLineKey,
  stepHref,
  workState,
} from "../../apps/web/src/pages/machine-work.ts";

const ATTEMPT = {
  id: "a",
  jobId: "j",
  taskId: null,
  taskTitle: null,
  runStepId: null,
  stepKey: null,
  jobAction: "repository.inspect",
  codingAgent: null,
  model: null,
  status: "running",
  leaseState: "active",
  startedAt: null,
  createdAt: "2026-11-20T10:00:00.000Z",
} as unknown as WorkerAttemptResponse;

Deno.test("free is the total minus the server's running count, never below zero (#70)", () => {
  assertEquals(slotsOf(3, 2).free, 1);
  assertEquals(slotsOf(1, 3), { slots: 1, running: 3, free: 0 });
});

Deno.test("a row says the design's state, so work whose lease ran out is never Running (#70)", () => {
  const cases = [
    ["leased", "active", "running"],
    ["running", "active", "running"],
    ["canceling", "active", "stopping"],
    ["running", "expired", "lost"],
    ["canceling", "expired", "lost"],
    ["lost", "lost", "lost"],
    ["running", "unknown", "unknown"],
    ["quarantined", "unknown", "unknown"],
    ["completed", "closed", "completed"],
    ["failed", "closed", "failed"],
    ["canceled", "closed", "canceled"],
  ] as const;
  for (const [status, leaseState, shown] of cases) {
    assertEquals(rowState({ status, leaseState }), shown, status + leaseState);
  }
});

Deno.test("only stopping, lost contact and unknown carry a sentence (#70)", () => {
  const known = { hasTask: true, silentSince: true };
  assertEquals(stateLineKey("running", known), null);
  assertEquals(stateLineKey("completed", known), null);
  assertEquals(stateLineKey("lost", known), "machines.work.line.lostSinceTask");
  assertEquals(
    stateLineKey("lost", { hasTask: false, silentSince: false }),
    "machines.work.line.lost",
  );
  assertEquals(stateLineKey("unknown", known), "machines.work.line.unknown");
});

Deno.test("an unknown work state falls back to now (#70)", () => {
  assertEquals(workState("finished"), "finished");
  assertEquals(workState("needs_attention"), "needs_attention");
  assertEquals(workState("elsewhere"), "now");
});

Deno.test("work with no task gets a plain name, and a step links only when both ids exist (#70)", () => {
  assertEquals(placeOf(ATTEMPT), {
    kind: "taskless",
    nameKey: "machines.work.taskless.repository",
  });
  assertEquals(placeOf({ ...ATTEMPT, jobAction: "coordinator.turn" }), {
    kind: "taskless",
    nameKey: "machines.work.taskless.other",
  });
  assertEquals(stepHref(ATTEMPT), null);
  assertEquals(stepHref({ ...ATTEMPT, taskId: "t" }), null);
  assertEquals(
    stepHref({ ...ATTEMPT, taskId: "t", runStepId: "s" }),
    "/tasks/t?at=step:s",
  );
  assertEquals(placeOf({ ...ATTEMPT, taskId: "t", taskTitle: "Write" }), {
    kind: "task",
    taskId: "t",
    title: "Write",
  });
});
