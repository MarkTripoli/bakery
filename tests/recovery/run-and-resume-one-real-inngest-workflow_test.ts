import { assertEquals } from "@std/assert";
import {
  createRealInngestStack,
  type RealInngestStack,
  type SeededWorkflow,
  type WorkflowState,
} from "../fixtures/real-inngest-stack.ts";
import {
  delay,
  waitForAtomicHandoff,
  waitForStepAdmission,
  waitForTerminal,
} from "../helpers/real-inngest-workflow.ts";

async function waitForSuccessor(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  generation: string,
): Promise<WorkflowState> {
  for (let attempt = 0; attempt < 360; attempt++) {
    const state = await stack.readWorkflowState(seed);
    if (
      state.engineOwnerToken !== null &&
      BigInt(state.engineOwnerGeneration) > BigInt(generation)
    ) return state;
    await delay(250);
  }
  throw new Error("cron reconciler did not acquire an owner successor");
}

Deno.test("pending handoff survives engine restart through cron without a competing request", async () => {
  const stack = createRealInngestStack();
  const query = async (database: "bakery" | "inngest", sql: string) => {
    const result = await new Deno.Command("docker", {
      args: [
        "exec",
        `${stack.project}-postgres-1`,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) throw new Error("RECOVERY_OBSERVATION_QUERY_FAILED");
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await stack.start();
    // The recovery cron fires every minute and legitimately rearms an owner
    // whose lease lapsed under host load. Seed right after a real tick so the
    // generation-one owner and its handoff finish before the next tick.
    const recoveryRuns = async () =>
      Number(
        await query(
          "inngest",
          `select count(*)
             from public.function_runs invocation
             join public.functions function on function.id = invocation.function_id
            where function.slug like '%workflow-recovery'`,
        ),
      );
    const ticksBefore = await recoveryRuns();
    let ticked = false;
    for (let attempt = 0; attempt < 360; attempt++) {
      if (await recoveryRuns() > ticksBefore) {
        ticked = true;
        break;
      }
      await delay(250);
    }
    assertEquals(ticked, true);
    const seed = await stack.seedWorkflow(crypto.randomUUID());
    const initial = await waitForStepAdmission(stack, seed, 0);
    assertEquals(initial.engineOwnerGeneration, "1");
    assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
    await stack.stopDispatch();
    const handoff = await waitForAtomicHandoff(stack, seed);
    assertEquals(handoff.engineOwnerToken, null);
    assertEquals(handoff.engineOwnerGeneration, "1");
    await stack.stopEngine();
    // Wait for a completed real cron invocation after restart, not for an
    // owner that must now remain absent while its durable delivery is pending.
    const restartBoundary = await query(
      "inngest",
      "select clock_timestamp()::text",
    );
    await stack.restartEngine();
    let cronCompleted = false;
    for (let attempt = 0; attempt < 360; attempt++) {
      const completed = await query(
        "inngest",
        `
        select count(*)
          from public.function_runs invocation
          join public.functions function on function.id = invocation.function_id
          join public.function_finishes finish on finish.run_id = invocation.run_id
         where function.slug like '%workflow-recovery'
           and invocation.run_started_at > '${restartBoundary}'::timestamptz
           and finish.status = 'Completed'
      `,
      );
      if (Number(completed) > 0) {
        cronCompleted = true;
        break;
      }
      await delay(250);
    }
    assertEquals(cronCompleted, true);
    const suppressed = await stack.readWorkflowState(seed);
    assertEquals(suppressed.engineOwnerToken, null);
    assertEquals(suppressed.engineOwnerGeneration, "1");
    assertEquals((await stack.engineInvocations(seed.runId)).length, 1);
    assertEquals(await stack.requestEventCount(seed), 2);
    const deliveryState = async () =>
      await query(
        "bakery",
        `
      select delivery.status || ':' || delivery.attempt_count
        from bakery.outbox delivery
        join bakery.domain_events event
          on event.organization_id = delivery.organization_id and event.id = delivery.event_id
       where event.organization_id = '${seed.organizationId}'
         and event.aggregate_id = '${seed.runId}' and event.event_type = 'run.requested'
         and delivery.destination = 'inngest'
       order by event.organization_sequence
    `,
      );
    assertEquals(await deliveryState(), "delivered:1\npending:0");
    await stack.restartDispatch();
    const successor = await waitForStepAdmission(stack, seed, 0);
    assertEquals(successor.engineOwnerGeneration, "2");
    assertEquals((await stack.engineInvocations(seed.runId)).length, 2);
    assertEquals(await stack.requestEventCount(seed), 2);
    assertEquals(await deliveryState(), "delivered:1\ndelivered:1");
    await stack.completeNextStep(seed);
    await waitForStepAdmission(stack, seed, 1);
    await stack.completeNextStep(seed);
    const terminal = await waitForTerminal(stack, seed);
    assertEquals(terminal.runStatus, "completed");
    assertEquals(terminal.taskStatus, "completed");
    assertEquals(terminal.engineOwnerGeneration, "2");
    assertEquals(terminal.steps.map((step) => step.attemptCount), [1, 1]);
    assertEquals((await stack.engineInvocations(seed.runId)).length, 2);
    assertEquals(await stack.requestEventCount(seed), 2);
  } finally {
    await stack.cleanup();
  }
});

Deno.test("database outage fences an expired owner through cron", async () => {
  const stack = createRealInngestStack();
  let seed!: SeededWorkflow;
  try {
    await stack.start();
    seed = await stack.seedWorkflow(crypto.randomUUID());
    const initialState = await waitForStepAdmission(stack, seed, 0);
    const initialGeneration = initialState.engineOwnerGeneration;
    if (
      !initialState.engineOwnerLeaseExpiresAt ||
      initialState.engineOwnerToken === null
    ) {
      throw new Error("database outage owner lease missing");
    }
    const initialToken = initialState.engineOwnerToken;
    const leaseDeadline = Date.parse(initialState.engineOwnerLeaseExpiresAt);
    await stack.stopDispatch();
    await stack.stopServer();
    await stack.stopPostgres();
    while (Date.now() <= leaseDeadline + 500) await delay(100);
    await stack.restartPostgres();

    let expiredState: WorkflowState | undefined;
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await stack.readWorkflowState(seed);
      if (
        state.engineOwnerToken !== null &&
        state.engineOwnerLeaseExpiresAt !== null &&
        Date.parse(state.engineOwnerLeaseExpiresAt) <= Date.now()
      ) {
        expiredState = state;
        break;
      }
      await delay(100);
    }
    if (!expiredState) {
      throw new Error("database outage did not leave an expired owner");
    }
    assertEquals(expiredState.engineOwnerToken, initialToken);
    await stack.restartServer();
    const successor = await waitForSuccessor(
      stack,
      seed,
      initialGeneration,
    );
    const invocations = await stack.engineInvocations(seed.runId);
    assertEquals(invocations.length, 2);
    assertEquals(await stack.requestEventCount(seed), 1);
    if (
      BigInt(successor.engineOwnerGeneration) <= BigInt(initialGeneration)
    ) {
      throw new Error("cron successor did not advance owner generation");
    }
    await stack.restartDispatch();
    await stack.completeNextStep(seed);
    await waitForStepAdmission(stack, seed, 1);
    await stack.completeNextStep(seed);
    const terminalState = await waitForTerminal(stack, seed);
    assertEquals(terminalState.runStatus, "completed");
    assertEquals(terminalState.taskStatus, "completed");
    assertEquals(await stack.requestEventCount(seed), 1);
  } finally {
    await stack.cleanup();
  }
});
