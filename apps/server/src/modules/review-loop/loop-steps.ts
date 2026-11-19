import {
  extractFixedWorkflowSteps,
  type FixedWorkflowStep,
} from "../work/run-steps.ts";

/**
 * The three steps of a review and repair loop, found in a run's frozen
 * workflow spec by what they do and never by what they are called: a published
 * workflow may name them anything. `isReviewLoopSpec` already guarantees that
 * a loop run has exactly one of each, so a missing or repeated step here means
 * the snapshot is not a loop snapshot, which no caller may repair by guessing.
 */
export type ReviewLoopSteps = {
  /** The on-demand `harness.repair` step: no row until a decision appends it. */
  readonly repair: FixedWorkflowStep;
  /** The `quality.check` step that judges a candidate. */
  readonly check: FixedWorkflowStep;
  /** The `review.independent` step that reviews it. */
  readonly review: FixedWorkflowStep;
};

function only(
  steps: readonly FixedWorkflowStep[],
  action: string,
): FixedWorkflowStep {
  const found = steps.filter((step) => step.action === action);
  if (found.length !== 1) throw new Error(`REVIEW_LOOP_STEP_COUNT:${action}`);
  return found[0]!;
}

/** The normalized spec a run snapshot froze, or a thrown error. */
function frozenSpec(snapshot: unknown): unknown {
  if (
    snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
  ) throw new Error("RUN_SNAPSHOT_INVALID");
  const workflow = (snapshot as Record<string, unknown>).workflow;
  if (
    workflow === null || typeof workflow !== "object" || Array.isArray(workflow)
  ) throw new Error("RUN_SNAPSHOT_INVALID");
  return (workflow as Record<string, unknown>).normalizedSpec;
}

/** The repair, check and review steps of the loop a run snapshot froze. */
export function reviewLoopSteps(snapshot: unknown): ReviewLoopSteps {
  const steps = extractFixedWorkflowSteps(frozenSpec(snapshot));
  return {
    repair: only(steps, "harness.repair"),
    check: only(steps, "quality.check"),
    review: only(steps, "review.independent"),
  };
}
