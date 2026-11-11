import { type DiagnosticCollector, pointerOf } from "../diagnostics.ts";
import { authoredIndexOf } from "./authored-order.ts";
import type { WorkflowSemanticDocument } from "../schema.ts";
import { buildFlowIndex, type FlowIndex, type FlowNode } from "./flow-index.ts";
import type { NodeLocations } from "./shape.ts";

function checkNodeNeeds(node: FlowNode, collector: DiagnosticCollector): void {
  node.node.needs.forEach((id, position) => {
    const at = pointerOf([
      ...node.path,
      "needs",
      authoredIndexOf(node.node.needs, id, position),
    ]);
    const target = node.scope.byId.get(id);
    if (!target) collector.add(at, "needs_unknown");
    else if (target === node) collector.add(at, "needs_cycle");
    else if (target.index > node.index) collector.add(at, "needs_forward");
  });
}

/**
 * Iterative depth-first cycle search over one lane graph. Edges name
 * prerequisite lanes by authored order; a back edge to a lane still on the
 * stack closes a cycle and is reported on the needs entry that closes it.
 */
function checkLaneCycles(
  group: FlowNode,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  const node = group.node;
  if (node.kind !== "parallel") return;
  const lanes = new Map(node.lanes.map((lane, index) => [lane.id, index]));
  const state = new Map<string, "open" | "done">();
  for (const root of node.lanes) {
    if (state.has(root.id)) continue;
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const lane = node.lanes[lanes.get(frame.id)!]!;
      if (frame.next >= lane.needs.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const sortedPosition = frame.next;
      frame.next += 1;
      const target = lane.needs[sortedPosition]!;
      const position = authoredIndexOf(lane.needs, target, sortedPosition);
      if (!lanes.has(target)) continue;
      const status = state.get(target);
      if (status === "open") {
        collector.add(
          pointerOf([...(locations.get(lane) ?? []), "needs", position]),
          "needs_cycle",
        );
      } else if (status === undefined) {
        state.set(target, "open");
        stack.push({ id: target, next: 0 });
      }
    }
  }
}

function checkLaneNeeds(
  group: FlowNode,
  locations: NodeLocations,
  collector: DiagnosticCollector,
): void {
  const node = group.node;
  if (node.kind !== "parallel") return;
  for (const lane of node.lanes) {
    lane.needs.forEach((id, sortedPosition) => {
      if (!group.lanes.has(id)) {
        collector.add(
          pointerOf([
            ...(locations.get(lane) ?? []),
            "needs",
            authoredIndexOf(lane.needs, id, sortedPosition),
          ]),
          "needs_unknown",
        );
      }
    });
  }
  checkLaneCycles(group, locations, collector);
}

/**
 * Checks every `needs` list. A step may only need an earlier sibling of its
 * own scope (`needs_unknown` for any other name, `needs_forward` for a later
 * sibling, `needs_cycle` for itself). Lanes need other lanes of the same
 * group in any order, and the lane graph must be acyclic.
 */
export function checkWorkflowNeeds(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  collector: DiagnosticCollector,
  index: FlowIndex = buildFlowIndex(document, locations),
): void {
  for (const scope of index.scopes) {
    for (const member of scope.members) {
      checkNodeNeeds(member, collector);
      if (member.node.kind === "parallel") {
        checkLaneNeeds(member, locations, collector);
      }
    }
  }
}
