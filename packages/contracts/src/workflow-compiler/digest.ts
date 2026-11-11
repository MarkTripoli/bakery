import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { WorkflowSemanticDocument } from "./schema.ts";

/**
 * Identity of the compiler's normalization and digest rules. Bump when a
 * change alters the semantic digest of an unchanged definition.
 */
export const WORKFLOW_COMPILER_VERSION = "1";

/**
 * Semantic digest: lowercase sha256 of the canonical JSON of the normalized
 * document. Object keys are sorted, array order is preserved, and every
 * layout or presentation field is already gone, so equivalent authored forms
 * share a digest while execution-affecting edits change it.
 */
export function workflowSemanticDigest(
  document: WorkflowSemanticDocument,
): Promise<string> {
  return sha256Hex(canonicalJson(document));
}
