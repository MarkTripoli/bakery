import type {
  PlanSeed,
  RealInngestStack,
  SeededWorkflow,
  WorkflowState,
} from "../fixtures/real-inngest-stack.ts";
import { delay } from "./real-inngest-workflow.ts";

// Compiled-plan runs on the real Inngest stack (#30 E4d): the definitions the
// stack seeds, and the waits the tests make on what the engine did with them.

const PLAN_ARTIFACT = "00000000-0000-4000-8000-0000000000b1";

/** One worker action step, run as the agent the seed binds to the action. */
export const implement = (id: string) => ({
  id,
  uses: "harness.implement",
  with: { repositoryId: "$input.repo", planArtifact: PLAN_ARTIFACT },
});

/** A lane of a parallel group: its steps run in order on one repository. */
export const lane = (id: string, steps: readonly unknown[]) => ({
  id,
  repository: "repo",
  steps,
});

export const fan = (lanes: readonly unknown[]) => ({
  id: "fan",
  parallel: {
    maxConcurrency: lanes.length,
    join: "all-required",
    failurePolicy: "stop-dependent",
    branches: lanes,
  },
});

/** The seed's plan: the steps over a `repo` input that names the seeded repository. */
export const plan =
  (steps: readonly unknown[]) => (ids: { repositoryId: string }): PlanSeed => ({
    definition: {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "real-stack-plan",
      description: "A compiled plan on the real Inngest stack.",
      inputs: { repo: { type: "uuid", required: true } },
      steps,
    },
    inputs: { repo: ids.repositoryId },
  });

type PlanRow = WorkflowState["steps"][number];

/** Polls by time (a read costs a host-dependent round trip) until `ready` holds. */
export async function waitForPlanState(
  stack: RealInngestStack,
  seed: SeededWorkflow,
  describe: string,
  ready: (state: WorkflowState) => boolean,
  timeoutMs = 150_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowState | undefined;
  while (Date.now() < deadline) {
    last = await stack.readWorkflowState(seed);
    if (ready(last)) return last;
    await delay(250);
  }
  throw new Error(`${describe}: ${JSON.stringify(last)}`);
}

export const rowOf = (
  state: WorkflowState,
  key: string,
): PlanRow | undefined => state.steps.find((step) => step.key === key);

/** Every admitted job of the named steps is queued and not yet claimed. */
export const queuedUnclaimed = (state: WorkflowState, keys: string[]) =>
  keys.every((key) => {
    const row = rowOf(state, key);
    return row?.status === "running" && row.jobStatus === "queued" &&
      row.attemptCount === 0;
  });

/** The run's steps by key: lanes finish in either order, so a test compares sorted. */
export const byKey = (state: WorkflowState): PlanRow[] =>
  [...state.steps].sort((left, right) => left.key.localeCompare(right.key));
