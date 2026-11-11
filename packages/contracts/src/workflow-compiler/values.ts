import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
} from "./diagnostics.ts";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";
import { parseWorkflowExpression } from "./expression.ts";
import type { WorkflowJsonValue } from "./json-value.ts";
import { parseReferenceText } from "./reference.ts";
import type {
  WorkflowEffectKey,
  WorkflowExpressionNode,
  WorkflowReferenceNode,
  WorkflowValueNode,
} from "./schema.ts";

const RESERVED_TOKENS: readonly string[] = [
  "$input",
  "$task",
  "$step",
  "$repeat",
  "$secret",
];
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EFFECT_LITERAL = /^[a-z0-9_-]{1,64}$/;
const MAX_EFFECT_PARTS = 8;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteral(
  node: WorkflowValueNode,
): node is Extract<WorkflowValueNode, { kind: "literal" }> {
  return node.kind === "literal";
}

function literalOf(value: WorkflowJsonValue): WorkflowValueNode {
  return { kind: "literal", value };
}

function compileString(
  text: string,
  pointer: string,
  collector: DiagnosticCollector,
): WorkflowValueNode | undefined {
  if (text.startsWith("$")) {
    const parsed = parseReferenceText(text);
    if (!parsed.ok) {
      collector.add(pointer, parsed.code);
      return undefined;
    }
    return { kind: "ref", root: parsed.root, path: parsed.path };
  }
  for (const token of RESERVED_TOKENS) {
    if (text.includes(token)) {
      collector.add(pointer, "value_reference_ambiguous");
      return undefined;
    }
  }
  return literalOf(text);
}

function compileInner(
  raw: unknown,
  path: readonly PointerSegment[],
  collector: DiagnosticCollector,
): WorkflowValueNode | undefined {
  const pointer = pointerOf(path);
  if (typeof raw === "string") return compileString(raw, pointer, collector);
  if (raw === null || typeof raw === "boolean" || typeof raw === "number") {
    return literalOf(raw);
  }
  if (Array.isArray(raw)) {
    const items: WorkflowValueNode[] = [];
    let failed = false;
    for (const item of raw) {
      const node = compileInner(item, path, collector);
      if (node) items.push(node);
      else failed = true;
    }
    if (failed) return undefined;
    if (items.every(isLiteral)) {
      return literalOf(items.map((item) => item.value));
    }
    if (items.length > WORKFLOW_COMPILER_LIMITS.valueListItems) {
      collector.add(pointer, "field_invalid");
      return undefined;
    }
    return { kind: "list", items };
  }
  if (!isPlainObject(raw)) {
    collector.add(pointer, "field_invalid");
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === "$literal") {
    return literalOf(raw["$literal"] as WorkflowJsonValue);
  }
  if (keys.some((key) => key.startsWith("$"))) {
    collector.add(pointer, "literal_reserved_key");
    return undefined;
  }
  const fields: Record<string, WorkflowValueNode> = Object.create(null);
  let failed = false;
  for (const key of keys) {
    const node = compileInner(raw[key], path, collector);
    if (node) fields[key] = node;
    else failed = true;
  }
  if (failed) return undefined;
  const nodes = Object.values(fields);
  if (nodes.every(isLiteral)) {
    const value: Record<string, WorkflowJsonValue> = Object.create(null);
    for (const key of keys) {
      value[key] = (fields[key] as { value: WorkflowJsonValue }).value;
    }
    return literalOf(value);
  }
  if (!keys.every((key) => FIELD_NAME.test(key))) {
    collector.add(pointer, "field_invalid");
    return undefined;
  }
  return { kind: "object", fields };
}

/**
 * Compiles one value position into a tagged value node. A string starting
 * with `$` is one whole reference; any other string holding a reserved token
 * is ambiguous; `{"$literal": X}` is an inert literal whose content is never
 * parsed; any other `$` key is reserved. Values without references collapse
 * to a single literal node. Diagnostics are reported at `path`; submitted keys
 * never extend it.
 */
export function compileWorkflowValue(
  raw: unknown,
  path: readonly PointerSegment[],
  collector: DiagnosticCollector,
): WorkflowValueNode | undefined {
  return compileInner(raw, path, collector);
}

/** Compiles a condition position (an expression string) into data nodes. */
export function compileWorkflowCondition(
  raw: unknown,
  path: readonly PointerSegment[],
  collector: DiagnosticCollector,
): WorkflowExpressionNode | undefined {
  const parsed = parseWorkflowExpression(raw);
  if (!parsed.ok) {
    collector.add(pointerOf(path), parsed.diagnostic.code);
    return undefined;
  }
  return parsed.ast;
}

/**
 * Compiles `effectKey`: one reference string, or a list of at most eight
 * parts, each a literal matching `[a-z0-9_-]{1,64}` or a reference. At least
 * one part must be a reference, otherwise the key is constant across runs.
 */
export function compileWorkflowEffectKey(
  raw: unknown,
  path: readonly PointerSegment[],
  collector: DiagnosticCollector,
): WorkflowEffectKey | undefined {
  const pointer = pointerOf(path);
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0 || items.length > MAX_EFFECT_PARTS) {
    collector.add(pointer, "effect_key_invalid");
    return undefined;
  }
  const parts: WorkflowEffectKey["parts"] = [];
  let failed = false;
  for (const item of items) {
    if (typeof item !== "string") {
      collector.add(pointer, "effect_key_invalid");
      failed = true;
    } else if (item.startsWith("$")) {
      const parsed = parseReferenceText(item);
      if (!parsed.ok) {
        collector.add(pointer, parsed.code);
        failed = true;
      } else {
        const reference: WorkflowReferenceNode = {
          kind: "ref",
          root: parsed.root,
          path: parsed.path,
        };
        parts.push(reference);
      }
    } else if (EFFECT_LITERAL.test(item)) {
      parts.push({ kind: "literal", value: item });
    } else {
      collector.add(pointer, "effect_key_invalid");
      failed = true;
    }
  }
  if (failed) return undefined;
  if (!parts.some((part) => part.kind === "ref")) {
    collector.add(pointer, "effect_key_invalid");
    return undefined;
  }
  return { kind: "effect_key", parts };
}
