import type { DiagnosticCollector } from "./diagnostics.ts";
import { indexWorkflowNodes } from "./passes/index.ts";
import { type NodeLocations, shapeWorkflow } from "./passes/shape.ts";
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
): NormalizeResult {
  const before = collector.size;
  const shaped = shapeWorkflow(snapshot, collector);
  if (!shaped.document || collector.size > before) {
    return { document: undefined, locations: shaped.locations };
  }
  indexWorkflowNodes(shaped.document, shaped.locations, collector);
  return {
    document: collector.size > before ? undefined : shaped.document,
    locations: shaped.locations,
  };
}
