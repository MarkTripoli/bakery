import type { PointerSegment } from "./diagnostics.ts";
import type { FlowIndex, Scope } from "./passes/flow-index.ts";

/**
 * One executable action of a compiled workflow with where the author wrote it.
 * Callers that check an action against organization state (agent binding,
 * capability policy) need the exact JSON Pointer of the step so a finding
 * lands on the authored node, however deeply a container nests it.
 */
export type WorkflowActionSite = Readonly<{
  /** Dot-joined identifiers from the root, lane ids included; matches the plan. */
  qualifiedId: string;
  /** Authored JSON Pointer segments of the node. */
  path: readonly PointerSegment[];
  /** Registered action name the node runs. */
  action: string;
  /** Extra capabilities the node requests, as authored (defaults applied). */
  requires: readonly string[];
}>;

/**
 * Lists every action node of an indexed document in authored order: sequence
 * members, then and else arms, repeat seed then body, and each parallel lane.
 */
export function listWorkflowActionSites(
  index: FlowIndex,
): readonly WorkflowActionSite[] {
  const sites: WorkflowActionSite[] = [];
  const visit = (scope: Scope, prefix: readonly string[]): void => {
    for (const flow of scope.members) {
      const qualified = [...prefix, flow.node.id];
      if (flow.node.kind === "action") {
        sites.push(Object.freeze({
          qualifiedId: qualified.join("."),
          path: flow.path,
          action: flow.node.action,
          requires: Object.freeze([...flow.node.requires]),
        }));
      }
      for (const child of flow.scopes) {
        visit(
          child,
          child.kind === "lane" && child.laneId !== undefined
            ? [...qualified, child.laneId]
            : qualified,
        );
      }
    }
  };
  visit(index.root, []);
  return Object.freeze(sites);
}
