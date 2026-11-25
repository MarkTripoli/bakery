import { assertEquals } from "@std/assert";
import type { WorkerAttemptResponse } from "../../apps/web/src/api/client.ts";
import {
  placeOf,
  slotsOf,
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

Deno.test("the unoccupied slots are the total minus the server's occupied count, never below zero (#70)", () => {
  assertEquals(slotsOf(3, 2).unoccupied, 1);
  assertEquals(slotsOf(1, 3), { slots: 1, occupied: 3, unoccupied: 0 });
});

Deno.test("an unknown work state falls back to now (#70)", () => {
  assertEquals(workState("finished"), "finished");
  assertEquals(workState("needs_attention"), "needs_attention");
  assertEquals(workState("elsewhere"), "now");
});

Deno.test("work with no task names its action, and a step links only when both ids exist (#70)", () => {
  assertEquals(placeOf(ATTEMPT), {
    kind: "taskless",
    action: "repository.inspect",
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
