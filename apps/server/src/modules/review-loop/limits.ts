/**
 * The review and repair bounds of a compiled plan (issue #397).
 *
 * A flat workflow freezes its loop bounds from its spec (`reviewLoopLimitsFor`).
 * A compiled plan declares its loop with a `repeat`, so its bounds come from the
 * plan itself: the plan has a loop when it holds a `review.independent` step,
 * the repair count is the largest `repeat.max` of a repeat that review sits in
 * (the plan's own bound, capped at the contract ceiling), and the duration and
 * findings bounds are the server defaults, as for a flat run. A plan with no
 * review step freezes nothing, so nothing about it changes.
 */
import {
  buildWorkflowPlan,
  type WorkflowPlan,
  type WorkflowSemanticDocument,
} from "@bakery/contracts/workflow-compiler";
import { REVIEW_LOOP_LIMITS } from "@bakery/contracts/review-evidence";
import type { ReviewLoopLimits } from "@bakery/persistence/repository-admission";

const REVIEW_ACTION = "review.independent";

/**
 * The repeats around a step's body: the loops whose tries are repair cycles.
 * A forEach around a review walks a list; its bound is a count of items, not
 * of tries, so it neither sets the cycle bound nor takes an allowance.
 */
const repairLoops = (step: WorkflowPlan["steps"][number]) =>
  step.loops.filter((loop) => loop.kind === "repeat" && !loop.seed);

/** The bounds to freeze into a plan run's snapshot, or `null` when the plan has no review. */
export function planReviewLoopLimits(
  document: WorkflowSemanticDocument,
): ReviewLoopLimits | null {
  const reviews = buildWorkflowPlan(document).steps.filter((step) =>
    step.kind === "action" && step.action === REVIEW_ACTION
  );
  if (reviews.length === 0) return null;
  const repeats = reviews.flatMap((step) =>
    repairLoops(step).map((loop) => loop.max)
  );
  const maxRepairCycles = repeats.length === 0 ? 0 : Math.min(
    Math.max(...repeats),
    REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
  );
  return {
    maxRepairCycles,
    maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
    maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
  };
}

/**
 * The step key of the repeat a plan's review sits in (the one with the largest
 * bound, as in {@link planReviewLoopLimits}), or `null` when the review sits in
 * no repeat. It names the repeat whose bound an allowance of more tries raises.
 */
export function planReviewRepeatKey(
  document: WorkflowSemanticDocument,
): string | null {
  const loops = buildWorkflowPlan(document).steps.filter((step) =>
    step.kind === "action" && step.action === REVIEW_ACTION
  ).flatMap(repairLoops);
  if (loops.length === 0) return null;
  return loops.reduce((best, loop) => loop.max > best.max ? loop : best).repeat;
}
