import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
} from "../diagnostics.ts";
import { WORKFLOW_COMPILER_LIMITS } from "../limits.ts";
import type {
  WorkflowLane,
  WorkflowNode,
  WorkflowSemanticDocument,
} from "../schema.ts";
import type { NodeLocations } from "./shape.ts";

const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const REPEAT_RESERVED: ReadonlySet<string> = new Set(["iterations", "outcome"]);

type Walk = {
  readonly collector: DiagnosticCollector;
  readonly locations: NodeLocations;
  count: number;
  countReported: boolean;
};

function locationOf(
  walk: Walk,
  value: object,
  ...extra: PointerSegment[]
): string {
  return pointerOf([...(walk.locations.get(value) ?? []), ...extra]);
}

/**
 * Checks one identifier namespace: every id must match the identifier
 * pattern and be unique within the scope; reserved ids are rejected.
 * Returns the set of valid ids seen.
 */
function checkScope(
  walk: Walk,
  members: readonly (WorkflowNode | WorkflowLane)[],
  reserved: ReadonlySet<string> | undefined,
): Set<string> {
  const seen = new Set<string>();
  for (const member of members) {
    if (!IDENTIFIER.test(member.id)) {
      walk.collector.add(locationOf(walk, member, "id"), "node_id_invalid");
      continue;
    }
    if (seen.has(member.id)) {
      walk.collector.add(locationOf(walk, member, "id"), "node_id_duplicate");
      continue;
    }
    seen.add(member.id);
    if (reserved?.has(member.id)) {
      walk.collector.add(locationOf(walk, member, "id"), "node_id_reserved");
    }
  }
  return seen;
}

function walkNodes(
  walk: Walk,
  members: readonly WorkflowNode[],
  depth: number,
  reserved: ReadonlySet<string> | undefined,
  extraScope: readonly WorkflowNode[] = [],
): void {
  checkScope(walk, [...extraScope, ...members], reserved);
  for (const node of extraScope) walkNode(walk, node, depth);
  for (const node of members) walkNode(walk, node, depth);
}

function walkNode(walk: Walk, node: WorkflowNode, depth: number): void {
  walk.count += 1;
  if (walk.count > WORKFLOW_COMPILER_LIMITS.authoredNodes) {
    if (!walk.countReported) {
      walk.countReported = true;
      walk.collector.add("/steps", "node_count_exceeded");
    }
    return;
  }
  if (depth > WORKFLOW_COMPILER_LIMITS.nodeDepth) {
    walk.collector.add(locationOf(walk, node), "node_depth_exceeded");
    return;
  }
  switch (node.kind) {
    case "action":
    case "wait":
      return;
    case "sequence":
      walkNodes(walk, node.steps, depth + 1, undefined);
      return;
    case "branch": {
      const arms = checkScope(walk, [...node.then, ...node.else], undefined);
      for (const name of Object.keys(node.outputs)) {
        if (arms.has(name)) {
          walk.collector.add(
            locationOf(walk, node, "branch", "outputs", name),
            "output_name_conflict",
          );
        }
      }
      for (const child of node.then) walkNode(walk, child, depth + 1);
      for (const child of node.else) walkNode(walk, child, depth + 1);
      return;
    }
    case "repeat": {
      const seedSteps = node.seed.form === "sequence" ? node.seed.steps : [];
      walkNodes(walk, node.steps, depth + 1, REPEAT_RESERVED, seedSteps);
      return;
    }
    case "parallel": {
      const laneIds = checkScope(walk, node.lanes, undefined);
      for (const lane of node.lanes) {
        const children = checkScope(walk, lane.steps, undefined);
        const exports = node.outputs[lane.id];
        if (exports) {
          for (const name of Object.keys(exports)) {
            if (children.has(name)) {
              walk.collector.add(
                locationOf(walk, node, "parallel", "outputs", lane.id, name),
                "output_name_conflict",
              );
            }
          }
        }
        for (const child of lane.steps) walkNode(walk, child, depth + 1);
      }
      for (const key of Object.keys(node.outputs)) {
        if (!laneIds.has(key)) {
          walk.collector.add(
            locationOf(walk, node, "parallel", "outputs"),
            "parallel_lanes_invalid",
          );
        }
      }
      return;
    }
  }
}

/**
 * Identifier pass over a shaped document. Direct children of a node share one
 * namespace: sequence steps; both branch arms; repeat seed and body steps;
 * lanes (and each lane's steps separately). `iterations` and `outcome` are
 * reserved under a repeat. Branch and lane export names may not equal a
 * direct child identifier. Also bounds node depth and total node count.
 */
export function indexWorkflowNodes(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  const walk: Walk = { collector, locations, count: 0, countReported: false };
  walkNodes(walk, document.steps, 1, undefined);
}
