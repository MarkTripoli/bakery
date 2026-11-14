import { assert, assertEquals } from "@std/assert";
import {
  createRealInngestStack,
  type RealInngestStack,
  type SeededWorkflow,
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

// #30 E4. A compiled plan on the real Inngest stack: the engine admits the
// lanes of a parallel group together and joins them, waits durably without a
// job, and a cancel reaches every lane, ending the engine for good.

// The owner lease is twice this timeout: long enough that a loaded host cannot
// lapse it between a job's admission and its completion.
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

async function assertOneEngineInvocation(
  stack: RealInngestStack,
  seed: SeededWorkflow,
): Promise<void> {
  assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
  assertEquals(await stack.requestEventCount(seed), 1);
}

Deno.test("a parallel group's lanes are admitted together and joined before the next step", () =>
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
    // Both lanes' jobs are queued at once, from one pass of the one engine run.
    const admitted = await waitForPlanState(
      stack,
      seed,
      "both lanes were not admitted together",
      (state) => queuedUnclaimed(state, lanes) && state.steps.length === 2,
    );
    assert(admitted.engineOwnerToken !== null);

    // One lane finishing does not release the next step: the join waits for all.
    const first = await stack.completePlanJob(seed);
    assert(lanes.includes(first), `first claimed step ${first}`);
    await delay(2_000);
    const half = await stack.readWorkflowState(seed);
    assertEquals(byKey(half).map((step) => step.key), lanes);
    assertEquals(half.runStatus, "running");

    const second = await stack.completePlanJob(seed);
    assertEquals([first, second].sort(), lanes);
    // The join released: `after` is admitted, and finishes the run.
    await waitForPlanState(
      stack,
      seed,
      "the step after the join was not admitted",
      (state) => rowOf(state, "after")?.jobStatus === "queued",
    );
    assertEquals(await stack.completePlanJob(seed), "after");
    const done = await waitForTerminal(stack, seed);
    assertEquals(done.runStatus, "completed");
    assertEquals(done.taskStatus, "completed");
    assertEquals(
      byKey(done).map((step) => [step.key, step.status, step.attemptCount]),
      [
        ["after", "completed", 1],
        ["fan.lane_a.a1", "completed", 1],
        ["fan.lane_b.b1", "completed", 1],
      ],
    );
    await assertOneEngineInvocation(stack, seed);
  }));

Deno.test("a duration wait is a durable row without a job, and the plan goes on after it", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      plan: plan([
        implement("first"),
        { id: "pause", needs: ["first"], wait: { duration: "6s" } },
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
    // The wait is a row of the run with no job, and nothing after it exists yet.
    const waiting = await waitForPlanState(
      stack,
      seed,
      "the wait row was not written",
      (state) => rowOf(state, "pause") !== undefined,
    );
    assertEquals(rowOf(waiting, "pause")?.jobStatus, null);
    assertEquals(rowOf(waiting, "last"), undefined);

    // When it has elapsed the run moves on by itself.
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
      done.steps.map((step) => [step.key, step.status]),
      [["first", "completed"], ["pause", "completed"], ["last", "completed"]],
    );
    await assertOneEngineInvocation(stack, seed);
  }));

Deno.test("a cancel reaches every live lane and the engine does not run the plan again", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      slots: 3,
      plan: plan([
        fan([
          lane("lane_a", [implement("a1"), implement("a2")]),
          lane("lane_b", [implement("b1")]),
          lane("lane_c", [implement("c1")]),
        ]),
      ]),
    });
    const keys = ["fan.lane_a.a1", "fan.lane_b.b1", "fan.lane_c.c1"];
    await waitForPlanState(
      stack,
      seed,
      "the lanes were not admitted",
      (state) => queuedUnclaimed(state, keys),
    );
    // Two lanes are held by the worker; the third's job is still queued.
    await stack.claimPlanJob(seed);
    await stack.claimPlanJob(seed);

    const response = await stack.cancelRun(seed);
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals(
      (await response.json() as { status: string }).status,
      "canceled",
    );

    const done = await waitForTerminal(stack, seed);
    assertEquals(done.runStatus, "canceled");
    assertEquals(done.taskStatus, "canceled");
    assertEquals(
      byKey(done).map((step) => [step.key, step.status, step.jobStatus]),
      keys.map((key) => [key, "canceled", "canceled"]),
    );
    // The lane's second step was never admitted, and nothing is admitted now.
    // The wait is longer than a job completion timeout: an engine that had not
    // seen the cancel would time out on its jobs and hand the run off again.
    await delay(25_000);
    const later = await stack.readWorkflowState(seed);
    assertEquals(later.steps.length, 3);
    assertEquals(later.runStatus, "canceled");
    // The engine function ended with the cancel: no second invocation, no new
    // request event, nothing pending for the outbox.
    await assertOneEngineInvocation(stack, seed);
    assertEquals(await stack.pendingOutboxCount(seed), 0);
  }));
