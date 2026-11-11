import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";
import type {
  WorkflowNode,
  WorkflowPlanStep,
  WorkflowSemanticDocument,
} from "./schema.ts";
import { workflowWorstCase } from "./passes/bounds.ts";
import type { WorstCase } from "./passes/bounds.ts";

/** One executable step of the plan. */
export type PlanStep = WorkflowPlanStep;

/** Flattened plan: every executable step in authored order plus totals. */
export type WorkflowPlan = {
  readonly steps: readonly PlanStep[];
  readonly worstCase: WorstCase;
};

/** Raised when a step key cannot be allocated or parsed. Never echoes input. */
export class WorkflowStepKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStepKeyError";
  }
}

const MARKER = "@n";
const SEGMENT = /^([a-z][a-z0-9_]{1,63})(?:@(0|[1-9][0-9]{0,2}))?$/;

type Frame = {
  readonly qualified: readonly string[];
  readonly template: readonly string[];
  readonly parent: string | null;
  readonly loops: PlanStep["loops"];
};

function pushStep(
  out: PlanStep[],
  frame: Frame,
  node: WorkflowNode,
  position: number,
): void {
  const qualified = [...frame.qualified, node.id].join(".");
  const keyTemplate = [...frame.template, node.id].join(".");
  if (node.kind === "action") {
    out.push({
      qualifiedId: qualified,
      kind: "action",
      keyTemplate,
      parent: frame.parent,
      position,
      action: node.action,
      timeoutMs: node.timeoutMs,
      retry: node.retry,
      loops: [...frame.loops],
    });
  } else if (node.kind === "wait") {
    out.push({
      qualifiedId: qualified,
      kind: "wait",
      keyTemplate,
      parent: frame.parent,
      position,
      timeoutMs: node.wait.kind === "duration"
        ? node.wait.durationMs
        : node.wait.timeoutMs,
      retry: { maxAttempts: 1, backoffMs: 0, on: [] },
      loops: [...frame.loops],
    });
  }
}

function flatten(
  out: PlanStep[],
  nodes: readonly WorkflowNode[],
  frame: Frame,
  start: number,
  depth: number,
): void {
  if (depth > WORKFLOW_COMPILER_LIMITS.nodeDepth + 2) return;
  nodes.forEach((node, offset) => {
    const position = start + offset;
    const qualified = [...frame.qualified, node.id];
    const joined = qualified.join(".");
    const child = (
      segment: string,
      loops: PlanStep["loops"] = frame.loops,
    ): Frame => ({
      qualified,
      template: [...frame.template, segment],
      parent: joined,
      loops,
    });
    switch (node.kind) {
      case "action":
      case "wait":
        pushStep(out, frame, node, position);
        return;
      case "sequence":
        flatten(out, node.steps, child(node.id), 0, depth + 1);
        return;
      case "branch":
        flatten(out, node.then, child(node.id), 0, depth + 1);
        flatten(out, node.else, child(node.id), node.then.length, depth + 1);
        return;
      case "repeat": {
        const marked = `${node.id}${MARKER}`;
        const seedSteps = node.seed.form === "sequence" ? node.seed.steps : [];
        flatten(
          out,
          seedSteps,
          child(marked, [
            ...frame.loops,
            { repeat: joined, max: node.max, seed: true },
          ]),
          0,
          depth + 1,
        );
        flatten(
          out,
          node.steps,
          child(marked, [
            ...frame.loops,
            { repeat: joined, max: node.max, seed: false },
          ]),
          seedSteps.length,
          depth + 1,
        );
        return;
      }
      case "parallel":
        for (const lane of node.lanes) {
          const laneId = `${joined}.${lane.id}`;
          flatten(
            out,
            lane.steps,
            {
              qualified: [...qualified, lane.id],
              template: [...frame.template, node.id, lane.id],
              parent: laneId,
              loops: frame.loops,
            },
            0,
            depth + 1,
          );
        }
        return;
    }
  });
}

/** Builds the flattened plan of a document that passed every other pass. */
export function buildWorkflowPlan(
  document: WorkflowSemanticDocument,
): WorkflowPlan {
  const steps: PlanStep[] = [];
  flatten(
    steps,
    document.steps,
    { qualified: [], template: [], parent: null, loops: [] },
    0,
    1,
  );
  return { steps, worstCase: workflowWorstCase(document) };
}

/**
 * Allocates the concrete step key of a plan step for one iteration path.
 * The path holds one entry per enclosing repeat, outermost first: `0` for a
 * seed step, `1..max` for a body step. Throws on a wrong length or range.
 */
export function allocateStepKey(
  step: Pick<PlanStep, "keyTemplate" | "loops">,
  iterationPath: readonly number[],
): string {
  if (iterationPath.length !== step.loops.length) {
    throw new WorkflowStepKeyError("iteration path length does not match");
  }
  let next = 0;
  const segments = step.keyTemplate.split(".").map((segment) => {
    if (!segment.endsWith(MARKER)) return segment;
    const loop = step.loops[next]!;
    const iteration = iterationPath[next]!;
    next += 1;
    const low = loop.seed ? 0 : 1;
    const high = loop.seed ? 0 : loop.max;
    if (!Number.isInteger(iteration) || iteration < low || iteration > high) {
      throw new WorkflowStepKeyError("iteration out of range");
    }
    return `${segment.slice(0, -MARKER.length)}@${iteration}`;
  });
  if (next !== step.loops.length) {
    throw new WorkflowStepKeyError("step key template does not match loops");
  }
  return segments.join(".");
}

/** Parses a step key back to its qualified identifier and iteration path. */
export function parseStepKey(
  key: string,
): { qualifiedId: string; iterationPath: number[] } {
  const ids: string[] = [];
  const iterationPath: number[] = [];
  for (const segment of key.split(".")) {
    const match = SEGMENT.exec(segment);
    if (!match) throw new WorkflowStepKeyError("step key is malformed");
    ids.push(match[1]!);
    if (match[2] !== undefined) iterationPath.push(Number(match[2]));
  }
  return { qualifiedId: ids.join("."), iterationPath };
}

/**
 * Lists every concrete step key the plan can allocate, in plan order. The
 * list is an upper bound of `worstCase.steps` when a branch has steps in
 * both arms. Throws when it would exceed the compiler's expanded-step limit.
 */
export function expandStepKeys(
  plan: { readonly steps: readonly PlanStep[] },
): string[] {
  let total = 0;
  for (const step of plan.steps) {
    let count = 1;
    for (const loop of step.loops) count *= loop.seed ? 1 : loop.max;
    total += count;
    if (total > WORKFLOW_COMPILER_LIMITS.expandedSteps) {
      throw new WorkflowStepKeyError("expansion exceeds the step limit");
    }
  }
  const keys: string[] = [];
  for (const step of plan.steps) {
    const path: number[] = step.loops.map((loop) => (loop.seed ? 0 : 1));
    for (;;) {
      keys.push(allocateStepKey(step, path));
      let index = path.length - 1;
      while (index >= 0) {
        const loop = step.loops[index]!;
        if (!loop.seed && path[index]! < loop.max) {
          path[index] = path[index]! + 1;
          break;
        }
        path[index] = loop.seed ? 0 : 1;
        index -= 1;
      }
      if (index < 0) break;
    }
  }
  return keys;
}
