import { assert, assertEquals } from "@std/assert";
import {
  createRealInngestStack,
  type RealInngestStack,
} from "../fixtures/real-inngest-stack.ts";
import {
  byKey,
  fan,
  implement,
  lane,
  plan,
  queuedUnclaimed,
  rowOf,
  waitForPlanState,
} from "../helpers/real-inngest-plan.ts";
import { delay, waitForTerminal } from "../helpers/real-inngest-workflow.ts";

// #30 E4. What a compiled plan keeps through an engine restart: lanes admitted
// together are not dispatched twice, and a duration wait neither restarts nor
// is skipped. The owner lease is twice the completion timeout: the restarts
// below finish well inside it, so the same owner resumes.
const COMPLETION_TIMEOUT = "20s";

async function withStack(
  body: (stack: RealInngestStack) => Promise<void>,
): Promise<void> {
  const stack = createRealInngestStack({
    jobCompletionTimeout: COMPLETION_TIMEOUT,
  });
  try {
    await stack.start();
    await body(stack);
  } finally {
    await stack.cleanup();
  }
}

Deno.test("an engine restart with a parallel group in flight resumes it without dispatching a lane twice", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      slots: 2,
      plan: plan([
        fan([
          lane("lane_a", [implement("a1")]),
          lane("lane_b", [implement("b1")]),
        ]),
        { ...implement("after"), needs: ["fan"] },
      ]),
    });
    const lanes = ["fan.lane_a.a1", "fan.lane_b.b1"];
    const admitted = await waitForPlanState(
      stack,
      seed,
      "the lanes were not admitted",
      (state) => queuedUnclaimed(state, lanes),
    );
    assert(admitted.engineOwnerToken !== null);

    // Both lanes finish while no engine is there to see it.
    await stack.stopDispatch();
    await stack.stopEngine();
    await stack.completePlanJob(seed);
    await stack.completePlanJob(seed);
    const quiet = await stack.readWorkflowState(seed);
    assertEquals(
      byKey(quiet).map((step) => [step.key, step.status]),
      lanes.map((key) => [key, "completed"]),
    );

    await stack.restartEngine();
    await stack.restartDispatch();
    // The restarted engine reads the finished lanes, joins them, and admits
    // the next step: the lanes are not dispatched again.
    await waitForPlanState(
      stack,
      seed,
      "the step after the join was not admitted",
      (state) => rowOf(state, "after")?.jobStatus === "queued",
    );
    assertEquals(await stack.completePlanJob(seed), "after");
    const done = await waitForTerminal(stack, seed);
    assertEquals(done.runStatus, "completed");
    assertEquals(
      byKey(done).map((step) => [step.key, step.attemptCount]),
      [["after", 1], ["fan.lane_a.a1", 1], ["fan.lane_b.b1", 1]],
    );
  }));

Deno.test("an engine restart during a duration wait does not restart the wait or skip it", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      plan: plan([
        implement("first"),
        { id: "pause", needs: ["first"], wait: { duration: "8s" } },
        { ...implement("last"), needs: ["pause"] },
      ]),
    });
    await waitForPlanState(
      stack,
      seed,
      "the first step was not admitted",
      (state) => queuedUnclaimed(state, ["first"]),
    );
    assertEquals(await stack.completePlanJob(seed), "first");
    const waiting = await waitForPlanState(
      stack,
      seed,
      "the wait row was not written",
      (state) => rowOf(state, "pause") !== undefined,
    );
    assertEquals(rowOf(waiting, "pause")?.jobStatus, null);

    // The engine goes away for the rest of the wait and comes back after it.
    await stack.stopDispatch();
    await stack.stopEngine();
    await delay(9_000);
    assertEquals(rowOf(await stack.readWorkflowState(seed), "last"), undefined);
    await stack.restartEngine();
    await stack.restartDispatch();

    // The wait was kept on its own clock: it has elapsed, so the plan goes on at
    // once, and it is not run a second time.
    await waitForPlanState(
      stack,
      seed,
      "the step after the wait was not admitted",
      (state) =>
        rowOf(state, "pause")?.status === "completed" &&
        rowOf(state, "last")?.jobStatus === "queued",
    );
    assertEquals(await stack.completePlanJob(seed), "last");
    const done = await waitForTerminal(stack, seed);
    assertEquals(done.runStatus, "completed");
    assertEquals(
      done.steps.map((step) => [step.key, step.status, step.attemptCount]),
      [["first", "completed", 1], ["pause", "completed", 0], [
        "last",
        "completed",
        1,
      ]],
    );
  }));
