import { type DiagnosticCollector, pointerOf } from "../diagnostics.ts";
import type {
  WorkflowActionNode,
  WorkflowNode,
  WorkflowRepeatNode,
  WorkflowSemanticDocument,
} from "../schema.ts";
import type { NodeLocations } from "./shape.ts";

const REPAIR_ACTION = "harness.repair";
const REVIEW_ACTION = "review.independent";
const MERGE_ACTION = "delivery.merge";
/** The engine completes this projection itself, so it may follow the review. */
const PROJECTION_ACTION = "delivery.candidate_evidence";

const isAction = (
  node: WorkflowNode,
  action: string,
): node is WorkflowActionNode =>
  node.kind === "action" && node.action === action;

/** A repeat whose own steps repair: the "fix until it passes" block. */
const isFixLoop = (node: WorkflowRepeatNode): boolean =>
  node.steps.some((step) => isAction(step, REPAIR_ACTION));

/** Every child node, in authored order: seed steps before the body, lanes in order. */
function childrenOf(node: WorkflowNode): readonly WorkflowNode[] {
  switch (node.kind) {
    case "sequence":
      return node.steps;
    case "branch":
      return [...node.then, ...node.else];
    case "repeat":
      return [
        ...(node.seed.form === "sequence" ? node.seed.steps : []),
        ...node.steps,
      ];
    case "parallel":
      return node.lanes.flatMap((lane) => lane.steps);
    default:
      return [];
  }
}

function hasFixLoop(nodes: readonly WorkflowNode[]): boolean {
  return nodes.some((node) =>
    (node.kind === "repeat" && isFixLoop(node)) ||
    hasFixLoop(childrenOf(node))
  );
}

type Walk = {
  readonly locations: NodeLocations;
  readonly collector: DiagnosticCollector;
  /** Whether an independent review precedes the node being visited. */
  reviewSeen: boolean;
};

function checkFixLoop(walk: Walk, node: WorkflowRepeatNode): void {
  const reviews = node.steps.flatMap((step, index) =>
    isAction(step, REVIEW_ACTION) ? [index] : []
  );
  const here = walk.locations.get(node) ?? [];
  if (reviews.length === 0) {
    walk.collector.add(
      pointerOf([...here, "repeat"]),
      "fix_loop_review_missing",
    );
    return;
  }
  const last = reviews[reviews.length - 1]!;
  const trailing = node.steps.slice(last + 1).some((step) =>
    !isAction(step, PROJECTION_ACTION)
  );
  if (trailing) {
    walk.collector.add(
      pointerOf(walk.locations.get(node.steps[last]!) ?? here),
      "fix_loop_review_not_last",
    );
  }
}

function visit(walk: Walk, node: WorkflowNode): void {
  if (node.kind === "action") {
    if (node.action === REVIEW_ACTION) walk.reviewSeen = true;
    if (node.action === MERGE_ACTION && !walk.reviewSeen) {
      walk.collector.add(
        pointerOf(walk.locations.get(node) ?? []),
        "merge_without_review",
      );
    }
    return;
  }
  if (node.kind === "repeat" && isFixLoop(node)) checkFixLoop(walk, node);
  for (const child of childrenOf(node)) visit(walk, child);
}

/**
 * The shape rules of a repair block, which hold without a catalog. A repeat
 * whose own steps repair must review its own result (`fix_loop_review_missing`)
 * and the review must be its last step, the engine's candidate projection
 * aside (`fix_loop_review_not_last`). In a workflow that holds such a block, a
 * merge may not come before an independent review in authored order
 * (`merge_without_review`); a workflow with no repair block is left alone, so
 * a merge-only workflow still compiles. Pointers use only the authored location.
 */
export function checkWorkflowReviewLoops(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  if (!hasFixLoop(document.steps)) return;
  const walk: Walk = { locations, collector, reviewSeen: false };
  for (const node of document.steps) visit(walk, node);
}
