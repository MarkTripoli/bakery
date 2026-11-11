import {
  createDiagnosticCollector,
  type WorkflowCompilerDiagnostic,
} from "./diagnostics.ts";
import { workflowSemanticDigest } from "./digest.ts";
import {
  decodeWorkflowJson,
  type SnapshotOptions,
  snapshotWorkflowValue,
} from "./json-value.ts";
import type { PointerSegment } from "./diagnostics.ts";
import { normalizeWorkflow } from "./normalize.ts";
import type { WorkflowCompilerCatalog } from "./catalog.ts";
import { resolveWorkflowActions } from "./passes/actions.ts";
import { checkWorkflowFlow } from "./passes/flow.ts";
import { buildFlowIndex } from "./passes/flow-index.ts";
import {
  INPUT_NAME,
  LANE_ID,
  OUTPUT_NAME,
  STRUCTURAL_KEY_NAMES,
} from "./passes/shape.ts";
import { checkWorkflowBounds } from "./passes/bounds.ts";
import { checkWorkflowNeeds } from "./passes/needs.ts";
import { buildWorkflowPlan, type WorkflowPlan } from "./plan.ts";
import {
  type WorkflowSemanticDocument,
  WorkflowSemanticDocumentSchema,
} from "./schema.ts";

/** Thrown when the compiler produced output that violates its own schema. */
export class WorkflowCompilerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCompilerInvariantError";
  }
}

export type WorkflowDocumentResult =
  | {
    readonly ok: true;
    readonly document: WorkflowSemanticDocument;
    readonly digest: string;
    readonly plan: WorkflowPlan;
    readonly diagnostics: readonly [];
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly WorkflowCompilerDiagnostic[];
  };

/** Optional inputs to a compile. */
export type WorkflowCompileOptions = {
  /**
   * Catalog to resolve actions, checks, limits, events and `with` fields
   * against. Without one the compiler validates shape and identifiers only.
   */
  readonly catalog?: WorkflowCompilerCatalog | undefined;
};

const SLOT_ARMS: ReadonlySet<PointerSegment> = new Set(["then", "else"]);

/**
 * Whether the path ends at a value slot. Everything below a slot is data the
 * author wrote (`with` arguments, candidates, branch arm and lane exports):
 * diagnostics there are reported at the slot, never at a submitted key.
 */
function isValueSlot(segments: readonly PointerSegment[]): boolean {
  const last = segments.length - 1;
  const tail = segments[last];
  if (tail === "effectKey") return true;
  if (tail === "agents" && last === 0) return true;
  if (tail === "with") return typeof segments[last - 1] === "number";
  if (tail === "currentCandidate") return true;
  if (segments[last - 3] === "branch" && segments[last - 2] === "outputs") {
    return tail !== undefined && SLOT_ARMS.has(tail);
  }
  return segments[last - 3] === "parallel" && segments[last - 2] === "outputs";
}

/**
 * Whether `path` is the exact authored path of a step node: `steps/N` from the
 * root, then any nesting of sequence nodes (`steps/N`), branch arms, repeat
 * bodies, repeat seed sequences and parallel lanes. Declared-name positions (branch outputs, lane ids, lane
 * exports, arm keys, repeat candidates) count only below such a path, so a
 * submitted key chain cannot rebuild one elsewhere (`ui`, `limits`, ...).
 */
function isNodePath(path: readonly PointerSegment[]): boolean {
  if (path[0] !== "steps" || typeof path[1] !== "number") return false;
  let i = 2;
  while (i < path.length) {
    const a = path[i];
    const b = path[i + 1];
    if (a === "steps" && typeof b === "number") {
      i += 2;
    } else if (a === "branch" && (b === "then" || b === "else")) {
      if (typeof path[i + 2] !== "number") return false;
      i += 3;
    } else if (a === "repeat" && b === "steps") {
      if (typeof path[i + 2] !== "number") return false;
      i += 3;
    } else if (a === "repeat" && b === "seed" && path[i + 2] === "steps") {
      if (typeof path[i + 3] !== "number") return false;
      i += 4;
    } else if (a === "parallel" && b === "branches") {
      if (typeof path[i + 2] !== "number" || path[i + 3] !== "steps") {
        return false;
      }
      if (typeof path[i + 4] !== "number") return false;
      i += 5;
    } else return false;
  }
  return true;
}

/**
 * A key reaches a pointer only when it is a compiler-fixed name or sits at an
 * exact declared-name position that matches its shape pattern: a workflow
 * input name, a branch output name, a parallel lane id or a lane export name.
 * Below a repeat `outputs` or `seed.outputs` only `currentCandidate` is
 * fixed. Every other submitted key stops at its parent.
 */
function isStructuralKey(
  parent: readonly PointerSegment[],
  key: string,
): boolean {
  const n = parent.length;
  if (n === 1 && parent[0] === "inputs") return INPUT_NAME.test(key);
  if (n >= 2 && parent[n - 1] === "outputs") {
    const owner = parent[n - 2];
    const prefix = parent.slice(0, n - 2);
    if (owner === "branch" && isNodePath(prefix)) {
      return OUTPUT_NAME.test(key);
    }
    if (owner === "parallel" && isNodePath(prefix)) return LANE_ID.test(key);
    if (owner === "repeat" && isNodePath(prefix)) {
      return key === "currentCandidate";
    }
    if (
      owner === "seed" && prefix[prefix.length - 1] === "repeat" &&
      isNodePath(prefix.slice(0, -1))
    ) {
      return key === "currentCandidate";
    }
  }
  if (n >= 3 && parent[n - 2] === "outputs") {
    const owner = parent[n - 3];
    const prefix = parent.slice(0, n - 3);
    if (owner === "parallel" && isNodePath(prefix)) {
      return OUTPUT_NAME.test(key);
    }
    if (owner === "branch" && isNodePath(prefix)) {
      return key === "then" || key === "else";
    }
  }
  return STRUCTURAL_KEY_NAMES.has(key);
}

const SNAPSHOT_OPTIONS: SnapshotOptions = {
  opaqueAt: isValueSlot,
  structuralKey: isStructuralKey,
};

/**
 * Compiles one authored definition to a normalized semantic document and its
 * digest. A string input is JSON text and goes through the duplicate-rejecting
 * decoder; any other input is copied through the inert snapshot (YAML is
 * parsed by the caller under the strict profile). Never throws on hostile
 * input; throws `WorkflowCompilerInvariantError` only when the compiler's own
 * output fails its schema.
 */
export async function compileWorkflowDocument(
  input: unknown,
  options: WorkflowCompileOptions = {},
): Promise<WorkflowDocumentResult> {
  const collector = createDiagnosticCollector();
  const decoded = typeof input === "string"
    ? decodeWorkflowJson(input, SNAPSHOT_OPTIONS)
    : snapshotWorkflowValue(input, SNAPSHOT_OPTIONS, collector);
  if (!decoded.ok) return { ok: false, diagnostics: decoded.diagnostics };
  const { document, locations } = normalizeWorkflow(decoded.value, collector);
  if (document && options.catalog && collector.size === 0) {
    resolveWorkflowActions(document, locations, options.catalog, collector);
  }
  if (document) {
    const index = buildFlowIndex(document, locations);
    checkWorkflowNeeds(document, locations, collector, index);
    checkWorkflowFlow(document, locations, options.catalog, collector, index);
    checkWorkflowBounds(document, locations, collector);
  }
  if (!document || collector.size > 0) {
    return { ok: false, diagnostics: collector.list() };
  }
  const checked = WorkflowSemanticDocumentSchema.safeParse(document, {
    jitless: true,
  });
  if (!checked.success) {
    throw new WorkflowCompilerInvariantError(
      "normalized workflow document violates its schema",
    );
  }
  return {
    ok: true,
    document,
    digest: await workflowSemanticDigest(document),
    plan: buildWorkflowPlan(document),
    diagnostics: [],
  };
}
