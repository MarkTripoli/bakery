import { type DiagnosticCollector, pointerOf } from "../diagnostics.ts";
import { WORKFLOW_COMPILER_LIMITS } from "../limits.ts";
import type {
  WorkflowLane,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSemanticDocument,
} from "../schema.ts";
import { resolveStepFiles } from "../step-files.ts";
import type { NodeLocations } from "./shape.ts";

/** Worst-case totals of a node list or a whole workflow. */
export type WorstCase = {
  steps: number;
  attempts: number;
  timeMs: number;
  costUsd: number;
};

/** Nodes nested deeper than this are ignored; the index pass reports them. */
const MAX_WALK_DEPTH = WORKFLOW_COMPILER_LIMITS.nodeDepth + 2;

const SATURATED = Number.MAX_SAFE_INTEGER;

function saturate(value: number): number {
  return value > SATURATED ? SATURATED : value;
}

/** Cost is held at micro-dollar scale so decimal sums compare exactly. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function zero(): WorstCase {
  return { steps: 0, attempts: 0, timeMs: 0, costUsd: 0 };
}

function add(left: WorstCase, right: WorstCase): WorstCase {
  return {
    steps: saturate(left.steps + right.steps),
    attempts: saturate(left.attempts + right.attempts),
    timeMs: saturate(left.timeMs + right.timeMs),
    costUsd: roundCost(left.costUsd + right.costUsd),
  };
}

function maximum(left: WorstCase, right: WorstCase): WorstCase {
  return {
    steps: Math.max(left.steps, right.steps),
    attempts: Math.max(left.attempts, right.attempts),
    timeMs: Math.max(left.timeMs, right.timeMs),
    costUsd: Math.max(left.costUsd, right.costUsd),
  };
}

function scale(value: WorstCase, factor: number): WorstCase {
  return {
    steps: saturate(value.steps * factor),
    attempts: saturate(value.attempts * factor),
    timeMs: saturate(value.timeMs * factor),
    costUsd: roundCost(value.costUsd * factor),
  };
}

function sum(nodes: readonly WorkflowNode[], depth: number): WorstCase {
  let total = zero();
  for (const node of nodes) total = add(total, nodeWorstCase(node, depth));
  return total;
}

/**
 * Worst case of one node. Per action: attempts = retry.maxAttempts, time =
 * timeout x attempts + backoff x (attempts - 1), cost = (limits.maxCostUsd
 * ?? 0) x attempts. A wait is one step and one attempt lasting its duration
 * or event timeout. Sequences and lanes sum; a branch takes the per-metric
 * maximum of its arms; a repeat is seed + max x body; a forEach is max x
 * body (its list is refused at run time past max); a parallel group sums
 * every lane (a conservative upper bound for time).
 */
export function nodeWorstCase(node: WorkflowNode, depth = 1): WorstCase {
  if (depth > MAX_WALK_DEPTH) return zero();
  switch (node.kind) {
    case "action": {
      const attempts = node.retry.maxAttempts;
      return {
        steps: 1,
        attempts,
        timeMs: saturate(
          node.timeoutMs * attempts + node.retry.backoffMs * (attempts - 1),
        ),
        costUsd: roundCost((node.limits?.maxCostUsd ?? 0) * attempts),
      };
    }
    case "wait":
      return {
        steps: 1,
        attempts: 1,
        timeMs: node.wait.kind === "duration"
          ? node.wait.durationMs
          : node.wait.timeoutMs,
        costUsd: 0,
      };
    case "sequence":
      return sum(node.steps, depth + 1);
    case "branch":
      return maximum(sum(node.then, depth + 1), sum(node.else, depth + 1));
    case "repeat": {
      const seed = node.seed.form === "sequence"
        ? sum(node.seed.steps, depth + 1)
        : zero();
      return add(seed, scale(sum(node.steps, depth + 1), node.max));
    }
    case "forEach":
      return scale(sum(node.steps, depth + 1), node.max);
    case "parallel": {
      let total = zero();
      for (const lane of node.lanes) {
        total = add(total, sum(lane.steps, depth + 1));
      }
      return total;
    }
  }
}

/** Worst case of the whole workflow (sum of its top-level nodes). */
export function workflowWorstCase(
  document: WorkflowSemanticDocument,
): WorstCase {
  return sum(document.steps, 1);
}

function laneWaitsOn(
  lanes: readonly WorkflowLane[],
): (later: string, earlier: string) => boolean {
  const needs = new Map(lanes.map((lane) => [lane.id, lane.needs]));
  return (later, earlier) => {
    const seen = new Set<string>();
    const pending = [...(needs.get(later) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (next === earlier) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(needs.get(next) ?? []));
    }
    return false;
  };
}

function concurrentWorkspaceWriters(
  node: WorkflowParallelNode,
): WorkflowNode[] {
  if (node.maxConcurrency <= 1) return [];
  const waitsOn = laneWaitsOn(node.lanes);
  const writing = node.lanes
    .map((lane) => ({ lane, writers: writersOf(lane.steps, "workspace") }))
    .filter(({ writers }) => writers.length > 0);
  return writing.flatMap(({ lane, writers }, index) =>
    writing.slice(0, index).some(({ lane: earlier }) =>
        earlier.repository === lane.repository &&
        !waitsOn(lane.id, earlier.id) &&
        !waitsOn(earlier.id, lane.id)
      )
      ? writers
      : []
  );
}

function writersOf(
  nodes: readonly WorkflowNode[],
  area: "workspace",
): WorkflowNode[] {
  return nodes.flatMap((node): WorkflowNode[] => {
    switch (node.kind) {
      case "action":
        return resolveStepFiles(node.files).write.includes(area) ? [node] : [];
      case "wait":
        return [];
      case "sequence":
      case "forEach":
        return writersOf(node.steps, area);
      case "branch":
        return [...writersOf(node.then, area), ...writersOf(node.else, area)];
      case "repeat":
        return [
          ...(node.seed.form === "sequence"
            ? writersOf(node.seed.steps, area)
            : []),
          ...writersOf(node.steps, area),
        ];
      case "parallel":
        return node.lanes.flatMap((lane) => writersOf(lane.steps, area));
    }
  });
}

function checkParallelForEachPolicy(
  nodes: readonly WorkflowNode[],
  parallel: boolean,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "action":
        if (
          parallel &&
          resolveStepFiles(node.files).write.includes("workspace")
        ) {
          collector.add(
            pointerOf([...(locations.get(node) ?? []), "files"]),
            "for_each_parallel_workspace_write",
          );
        }
        break;
      case "wait":
        break;
      case "sequence":
        checkParallelForEachPolicy(
          node.steps,
          parallel,
          locations,
          collector,
        );
        break;
      case "branch":
        checkParallelForEachPolicy(node.then, parallel, locations, collector);
        checkParallelForEachPolicy(node.else, parallel, locations, collector);
        break;
      case "repeat":
        if (node.seed.form === "sequence") {
          checkParallelForEachPolicy(
            node.seed.steps,
            parallel,
            locations,
            collector,
          );
        }
        checkParallelForEachPolicy(
          node.steps,
          parallel,
          locations,
          collector,
        );
        break;
      case "parallel": {
        for (const writer of concurrentWorkspaceWriters(node)) {
          collector.add(
            pointerOf([...(locations.get(writer) ?? []), "files"]),
            "parallel_lanes_workspace_write",
          );
        }
        for (const lane of node.lanes) {
          checkParallelForEachPolicy(
            lane.steps,
            parallel,
            locations,
            collector,
          );
        }
        break;
      }
      case "forEach":
        checkParallelForEachPolicy(
          node.steps,
          parallel || (node.maxConcurrency ?? 1) > 1,
          locations,
          collector,
        );
        break;
    }
  }
}

function checkRepeatPolicy(
  nodes: readonly WorkflowNode[],
  depth: number,
  ceiling: number,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  for (const node of nodes) {
    switch (node.kind) {
      case "sequence":
        checkRepeatPolicy(node.steps, depth + 1, ceiling, locations, collector);
        break;
      case "branch":
        checkRepeatPolicy(node.then, depth + 1, ceiling, locations, collector);
        checkRepeatPolicy(node.else, depth + 1, ceiling, locations, collector);
        break;
      case "repeat": {
        if (node.max > ceiling) {
          collector.add(
            pointerOf([...(locations.get(node) ?? []), "repeat", "max"]),
            "repeat_exceeds_policy",
          );
        }
        if (node.seed.form === "sequence") {
          checkRepeatPolicy(
            node.seed.steps,
            depth + 1,
            ceiling,
            locations,
            collector,
          );
        }
        checkRepeatPolicy(node.steps, depth + 1, ceiling, locations, collector);
        break;
      }
      case "forEach":
        checkRepeatPolicy(node.steps, depth + 1, ceiling, locations, collector);
        break;
      case "parallel":
        for (const lane of node.lanes) {
          checkRepeatPolicy(
            lane.steps,
            depth + 1,
            ceiling,
            locations,
            collector,
          );
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Compares the worst-case expansion against the compiler ceiling and the
 * workflow's own limits, and repeat counts against the repair-cycle policy.
 * Returns the computed worst case.
 */
export function checkWorkflowBounds(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): WorstCase {
  checkParallelForEachPolicy(document.steps, false, locations, collector);
  const limits = document.limits;
  if (limits.maxRepairCycles !== undefined) {
    checkRepeatPolicy(
      document.steps,
      1,
      limits.maxRepairCycles,
      locations,
      collector,
    );
  }
  const worst = workflowWorstCase(document);
  if (worst.steps > WORKFLOW_COMPILER_LIMITS.expandedSteps) {
    collector.add("/steps", "expansion_steps_exceeded");
  }
  if (worst.attempts > limits.maxAttempts) {
    collector.add("/limits", "expansion_attempts_exceeded");
  }
  if (worst.timeMs > limits.wallClockMs) {
    collector.add("/limits", "expansion_wall_clock_exceeded");
  }
  if (
    limits.maxCostUsd !== undefined &&
    worst.costUsd > roundCost(limits.maxCostUsd)
  ) {
    collector.add("/limits", "expansion_cost_exceeded");
  }
  return worst;
}
