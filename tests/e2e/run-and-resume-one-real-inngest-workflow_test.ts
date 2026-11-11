import { assertEquals } from "@std/assert";
import {
  createRealInngestStack,
  type RealInngestStack,
  type SeededWorkflow,
} from "../fixtures/real-inngest-stack.ts";
import {
  waitForAtomicHandoff,
  waitForStepAdmission,
  waitForSuppressedWakeupWithinLease,
  waitForTerminal,
} from "../helpers/real-inngest-workflow.ts";

// A wrong invocation count names its lineage: which events started which
// invocations, and whether the run's owner lease had lapsed.
async function assertInvocationCount(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  expected: number,
): Promise<void> {
  try {
    assertEquals((await stack.engineInvocations(seed.runId)).length, expected);
  } catch (error) {
    console.error(
      `[restart-lineage:count-assertion-failed] ${await stack
        .restartLineageDiagnostic(seed)}`,
    );
    throw error;
  }
}

Deno.test("engine restart resumes an active wait without redispatch", async () => {
  // The owner lease is twice this timeout. The wait expires with the engine
  // down, so the engine restart must finish inside the other half; 10s left a
  // loaded 4-CPU runner too little room and recovery rearmed the run.
  const stack = createRealInngestStack({ jobCompletionTimeout: "20s" });
  let seed!: SeededWorkflow;
  try {
    await stack.start();
    seed = await stack.seedWorkflow(crypto.randomUUID());
    const initialState = await waitForStepAdmission(stack, seed, 0);
    if (!initialState.engineOwnerToken) {
      throw new Error("initial engine owner token missing");
    }
    const initialToken = initialState.engineOwnerToken;
    const initialGeneration = initialState.engineOwnerGeneration;
    assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
    assertEquals(await stack.requestEventCount(seed), 1);

    // Complete a durable step while dispatch is down and let its wait expire.
    await stack.stopDispatch();
    await stack.stopEngine();
    await stack.completeNextStep(seed);
    const waitingState = await waitForSuppressedWakeupWithinLease(
      stack,
      seed,
      20_250,
    );
    assertEquals(waitingState.engineOwnerToken, initialToken);
    assertEquals(waitingState.engineOwnerGeneration, initialGeneration);
    assertEquals(waitingState.steps[0]?.attemptCount, 1);
    assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
    assertEquals(await stack.requestEventCount(seed), 1);

    await stack.restartEngine();
    const resumedState = await waitForStepAdmission(stack, seed, 1);
    assertEquals(resumedState.engineOwnerToken, initialToken);
    assertEquals(resumedState.engineOwnerGeneration, initialGeneration);
    assertEquals(resumedState.steps[0]?.status, "completed");
    assertEquals(resumedState.steps[0]?.attemptCount, 1);
    assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
    assertEquals(await stack.requestEventCount(seed), 1);

    await stack.restartDispatch();
    await stack.completeNextStep(seed);
    const terminalState = await waitForTerminal(stack, seed);
    assertEquals(terminalState.runStatus, "completed");
    assertEquals(terminalState.taskStatus, "completed");
    assertEquals(terminalState.steps.map((step) => step.attemptCount), [1, 1]);
    assertEquals(await stack.requestEventCount(seed), 1);
  } finally {
    await stack.cleanup();
  }
});

Deno.test("bounded wait handoff survives an Inngest restart", async () => {
  // The owner lease is twice this timeout and the run renews it around each of
  // its eight waits. A run stalled past the 6s lease that the default 3s leaves
  // is rearmed by the recovery cron, and the extra invocation makes the count
  // 3 (a forced lapse reproduces it; a natural lapse was not observed
  // directly). 10s gives the 20s lease the room that run needs.
  const stack: RealInngestStack = createRealInngestStack({
    jobCompletionTimeout: "10s",
  });
  let seed!: SeededWorkflow;
  try {
    await stack.start();
    seed = await stack.seedWorkflow(crypto.randomUUID());
    const initialState = await waitForStepAdmission(stack, seed, 0);
    const initialGeneration = initialState.engineOwnerGeneration;
    await stack.stopDispatch();

    const handedOffState = await waitForAtomicHandoff(stack, seed);
    assertEquals(handedOffState.engineOwnerToken, null);
    assertEquals(await stack.requestEventCount(seed), 2);
    if ((await stack.pendingOutboxCount(seed)) < 1) {
      throw new Error("handoff successor event was not durable");
    }

    // Interrupt after the handoff transaction commits but before its
    // checkpoint acknowledges the persisted result.
    await stack.stopEngine();
    await stack.restartEngine();
    await stack.restartDispatch();
    const successor = await waitForStepAdmission(stack, seed, 0);
    if (
      BigInt(successor.engineOwnerGeneration) <= BigInt(initialGeneration)
    ) {
      throw new Error("handoff successor did not advance owner generation");
    }
    const restartLineage = await stack.restartLineageDiagnostic(seed);
    console.log(
      `[restart-lineage:before-count-assertion] ${restartLineage}`,
    );
    try {
      assertEquals((await stack.engineInvocations(seed.runId)).length, 2);
    } catch (error) {
      console.error(
        `[restart-lineage:count-assertion-failed] ${restartLineage}`,
      );
      throw error;
    }
    assertEquals(await stack.requestEventCount(seed), 2);

    await stack.completeNextStep(seed);
    await waitForStepAdmission(stack, seed, 1);
    await stack.completeNextStep(seed);
    const terminalState = await waitForTerminal(stack, seed);
    assertEquals(terminalState.runStatus, "completed");
    assertEquals(terminalState.taskStatus, "completed");
    assertEquals(terminalState.steps.map((step) => step.attemptCount), [1, 1]);
    assertEquals(await stack.requestEventCount(seed), 2);
  } finally {
    await stack.cleanup();
  }
});

Deno.test("retry exhaustion rearms the same persisted action", async () => {
  // Same lease arithmetic as the handoff test above: a 1s timeout left the 3s
  // minimum lease, and a run stalled past it is rearmed by the recovery cron,
  // which reads as an extra invocation (seen once as 2 for 1). At 5s the lease
  // is 10s. Only the first pass waits out the timeout; the retries after it
  // back off for a second each.
  const stack = createRealInngestStack({ jobCompletionTimeout: "5s" });
  let seed!: SeededWorkflow;
  try {
    await stack.start();
    seed = await stack.seedWorkflow(crypto.randomUUID());
    const initialState = await waitForStepAdmission(stack, seed, 0);
    await stack.stopDispatch();

    // Model a persisted, bounded retryable state with a real queued job. The
    // workflow must exhaust its retry loop and durably hand off before work
    // becomes claimable again.
    await stack.setStepAvailableAt(seed, 0, 60_000);
    const handedOffState = await waitForAtomicHandoff(stack, seed);
    assertEquals(handedOffState.engineOwnerToken, null);
    assertEquals(handedOffState.steps[0]?.jobStatus, "queued");
    assertEquals(handedOffState.steps[0]?.attemptCount, 0);
    await assertInvocationCount(stack, seed, 1);

    // Keep the successor queued until the persisted retry becomes claimable.
    await stack.setStepAvailableAt(seed, 0, 0);
    await stack.restartDispatch();
    const successor = await waitForStepAdmission(stack, seed, 0);
    if (
      BigInt(successor.engineOwnerGeneration) <=
        BigInt(initialState.engineOwnerGeneration)
    ) {
      throw new Error("retry successor did not advance owner generation");
    }
    await assertInvocationCount(stack, seed, 2);
    assertEquals(await stack.requestEventCount(seed), 2);

    await stack.completeNextStep(seed);
    await waitForStepAdmission(stack, seed, 1);
    await stack.completeNextStep(seed);
    const terminalState = await waitForTerminal(stack, seed);
    assertEquals(terminalState.runStatus, "completed");
    assertEquals(terminalState.taskStatus, "completed");
    assertEquals(terminalState.steps.map((step) => step.attemptCount), [1, 1]);
    assertEquals(await stack.requestEventCount(seed), 2);
  } finally {
    await stack.cleanup();
  }
});
