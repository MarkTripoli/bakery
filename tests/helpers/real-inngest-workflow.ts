import type {
  RealInngestStack,
  SeededWorkflow,
  WorkflowState,
} from "../fixtures/real-inngest-stack.ts";

export function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function waitForTerminal(
  stack: RealInngestStack,
  seed: SeededWorkflow,
): Promise<WorkflowState> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const state = await stack.readWorkflowState(seed);
    if (
      ["completed", "failed", "canceled", "blocked"].includes(
        state.runStatus,
      )
    ) return state;
    await delay(250);
  }
  throw new Error("recovery workflow did not reach a terminal state");
}

export async function waitForStepAdmission(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  index: 0 | 1,
): Promise<WorkflowState> {
  let lastState: WorkflowState | undefined;
  for (let attempt = 0; attempt < 240; attempt++) {
    lastState = await stack.readWorkflowState(seed);
    if (
      lastState.runStatus === "running" &&
      lastState.steps[index]?.status === "running" &&
      lastState.steps[index]?.jobStatus === "queued" &&
      lastState.steps[index]?.attemptCount === 0 &&
      lastState.engineOwnerToken !== null
    ) return lastState;
    await delay(250);
  }
  throw new Error(
    `workflow step ${index + 1} was not durably admitted: ${
      JSON.stringify(lastState)
    }`,
  );
}

export async function waitForSuppressedWakeupWithinLease(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  waitTimeoutMs: number,
): Promise<WorkflowState> {
  const deadline = Date.now() + waitTimeoutMs;
  let lastState: WorkflowState | undefined;
  // Poll by time, not attempt count: each read costs a host-dependent round trip.
  while (Date.now() < deadline + 5_000) {
    lastState = await stack.readWorkflowState(seed);
    const pendingOutbox = await stack.pendingOutboxCount(seed);
    if (
      Date.now() >= deadline &&
      pendingOutbox >= 1 &&
      lastState.steps[0]?.status === "completed" &&
      lastState.steps[1]?.status === "pending" &&
      lastState.engineOwnerToken !== null &&
      lastState.engineOwnerLeaseExpiresAt !== null &&
      Date.parse(lastState.engineOwnerLeaseExpiresAt) > Date.now()
    ) return lastState;
    await delay(100);
  }
  throw new Error(
    `suppressed wakeup did not remain within its lease: ${
      JSON.stringify(lastState)
    }`,
  );
}

export async function waitForAtomicHandoff(
  stack: RealInngestStack,
  seed: SeededWorkflow,
): Promise<WorkflowState> {
  let lastState: WorkflowState | undefined;
  // The run spends its whole job completion timeout in each of up to eight
  // waits before it hands off (80s at 10s). Poll by time, not attempt count:
  // 240 attempts of three reads are only ~120s on a quick host.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    lastState = await stack.readWorkflowState(seed);
    const requestEvents = await stack.requestEventCount(seed);
    const pendingOutbox = await stack.pendingOutboxCount(seed);
    if (
      lastState.engineOwnerToken === null &&
      requestEvents === 2 &&
      pendingOutbox >= 1
    ) return lastState;
    await delay(250);
  }
  throw new Error(
    `handoff did not atomically release and enqueue: ${
      JSON.stringify(lastState)
    }`,
  );
}
