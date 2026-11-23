import type { DiagnosticCollector } from "./diagnostics.ts";
import { indexWorkflowNodes } from "./passes/index.ts";
import { type NodeLocations, shapeWorkflow } from "./passes/shape.ts";
import {
  type ChildWorkflows,
  inlineWorkflowCalls,
  type ShapeChild,
} from "./call.ts";
import type { WorkflowSemanticDocument } from "./schema.ts";

export type NormalizeResult = {
  readonly document: WorkflowSemanticDocument | undefined;
  readonly locations: NodeLocations;
};

/**
 * Normalizes an inert definition snapshot into the layout-free semantic
 * document: shape and tagged values first, identifier indexing second. A
 * document is returned only when neither pass reported a diagnostic, so
 * later passes never see a half-built tree.
 */
export function normalizeWorkflow(
  snapshot: unknown,
  collector: DiagnosticCollector,
  calls?: {
    readonly children: ChildWorkflows;
    readonly shapeChild: ShapeChild;
  },
): NormalizeResult {
  const before = collector.size;
  const shaped = shapeWorkflow(snapshot, collector);
  if (!shaped.document || collector.size > before) {
    return { document: undefined, locations: shaped.locations };
  }
  // A call is replaced by the called workflow's steps before anything else
  // reads the document; with no versions to call, any call is unavailable.
  inlineWorkflowCalls(
    shaped.document,
    shaped.locations,
    calls?.children ?? new Map(),
    calls?.shapeChild ?? (() => ({
      document: undefined,
      locations: shaped.locations,
    })),
    collector,
  );
  if (collector.size > before) {
    return { document: undefined, locations: shaped.locations };
  }
  indexWorkflowNodes(shaped.document, shaped.locations, collector);
  return {
    document: collector.size > before ? undefined : shaped.document,
    locations: shaped.locations,
  };
}
