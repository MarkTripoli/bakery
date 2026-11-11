import type { WorkflowCompilerDiagnosticCode } from "./diagnostics.ts";
import { WORKFLOW_REFERENCE_ROOTS } from "./schema.ts";

/** Longest reference path after the root, matching the compiled node schema. */
export const MAX_REFERENCE_SEGMENTS = 32;

const ROOT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET_ROOT = /^(secret|env$|vault$)/;

export type ReferenceRoot = (typeof WORKFLOW_REFERENCE_ROOTS)[number];

export type ReferenceParseResult =
  | {
    readonly ok: true;
    readonly root: ReferenceRoot;
    readonly path: string[];
  }
  | {
    readonly ok: false;
    readonly code: Extract<
      WorkflowCompilerDiagnosticCode,
      | "reference_malformed"
      | "reference_root_unknown"
      | "reference_secret_forbidden"
    >;
  };

/**
 * Parses one whole reference token of the form `$<root>.<seg>(.<seg>)*`.
 * Pure string scanning: no regular expression is built from input, and the
 * token is never echoed. Used by value positions and by the expression
 * grammar so both read the same syntax.
 */
export function parseReferenceText(token: string): ReferenceParseResult {
  if (!token.startsWith("$") || token.length > 2048) {
    return { ok: false, code: "reference_malformed" };
  }
  const parts = token.slice(1).split(".");
  const rootName = parts[0]!;
  if (!ROOT_NAME.test(rootName)) {
    return { ok: false, code: "reference_malformed" };
  }
  const root = WORKFLOW_REFERENCE_ROOTS.find((candidate) =>
    candidate === rootName
  );
  if (!root) {
    return {
      ok: false,
      code: SECRET_ROOT.test(rootName)
        ? "reference_secret_forbidden"
        : "reference_root_unknown",
    };
  }
  const path = parts.slice(1);
  if (path.length === 0 || path.length > MAX_REFERENCE_SEGMENTS) {
    return { ok: false, code: "reference_malformed" };
  }
  for (const segment of path) {
    if (!FIELD_SEGMENT.test(segment)) {
      return { ok: false, code: "reference_malformed" };
    }
  }
  return { ok: true, root, path };
}
