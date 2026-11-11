import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
} from "../diagnostics.ts";
import type { WorkflowJsonValue } from "../json-value.ts";
import type {
  WorkflowEffectKey,
  WorkflowExpressionNode,
  WorkflowValueNode,
} from "../schema.ts";
import {
  familyOf,
  isAssignable,
  literalMatches,
  type ObjectField,
  stripNullable,
  type TypeFamily,
  type ValueType,
  valueTypeSize,
} from "../types.ts";
import { WORKFLOW_COMPILER_LIMITS } from "../limits.ts";
import { isSecretName } from "../secrets.ts";
import type { Reader } from "./flow-index.ts";
import { type FlowEnv, resolveReference } from "./references.ts";

/** Everything the analysis needs: the resolution environment and the sink. */
export type AnalysisEnv = FlowEnv & { readonly collector: DiagnosticCollector };

/**
 * A value position after reference resolution. `type` is undefined when any
 * part failed or could not be typed, which suppresses follow-on diagnostics.
 */
export type Analyzed =
  | {
    readonly kind: "literal";
    readonly value: WorkflowJsonValue;
    readonly type: ValueType;
  }
  | { readonly kind: "ref"; readonly type: ValueType | undefined }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyMap<string, Analyzed>;
    readonly type: ValueType | undefined;
  }
  | {
    readonly kind: "list";
    readonly items: readonly Analyzed[];
    readonly type: ValueType | undefined;
  };

/** Structural type of a JSON literal; objects are closed with required fields. */
export function inferLiteralType(value: WorkflowJsonValue): ValueType {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") {
    return { kind: "number", integer: Number.isInteger(value) };
  }
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    return {
      kind: "list",
      item: unifyTypes(value.map((entry) => inferLiteralType(entry))) ??
        { kind: "json" },
    };
  }
  const record = value as Record<string, WorkflowJsonValue>;
  const fields = new Map<string, ObjectField>();
  for (const key of Object.keys(record)) {
    fields.set(key, {
      type: inferLiteralType(record[key]!),
      required: true,
      sensitive: isSecretName(key),
    });
  }
  return { kind: "object", fields };
}

/** Common type of several item types, or undefined when none fits all. */
export function unifyTypes(
  types: readonly ValueType[],
): ValueType | undefined {
  if (types.length === 0) return { kind: "json" };
  let common = types[0]!;
  for (const type of types.slice(1)) {
    if (isAssignable(type, common)) continue;
    if (isAssignable(common, type)) {
      common = type;
      continue;
    }
    return undefined;
  }
  return common;
}

function pointerFor(path: readonly PointerSegment[]): string {
  return pointerOf(path);
}

/**
 * Rejects an author-built type whose expanded size passes the ceiling. Shared
 * subtypes expand per use, so a small definition can describe a huge type.
 */
function boundedType(
  env: AnalysisEnv,
  path: readonly PointerSegment[],
  type: ValueType,
): ValueType | undefined {
  if (
    valueTypeSize(type, WORKFLOW_COMPILER_LIMITS.valueTypeNodes) >
      WORKFLOW_COMPILER_LIMITS.valueTypeNodes
  ) {
    env.collector.add(pointerFor(path), "type_mismatch");
    return undefined;
  }
  return type;
}

/**
 * Resolves every reference of a value position and derives its type.
 * Resolution failures are reported at the position; submitted keys never
 * extend the pointer.
 */
export function analyzeValue(
  env: AnalysisEnv,
  reader: Reader,
  node: WorkflowValueNode,
  path: readonly PointerSegment[],
): Analyzed {
  switch (node.kind) {
    case "literal":
      return {
        kind: "literal",
        value: node.value,
        type: inferLiteralType(node.value),
      };
    case "ref": {
      const resolved = resolveReference(env, reader, node);
      if (!resolved.ok) {
        env.collector.add(pointerFor(path), resolved.code);
        return { kind: "ref", type: undefined };
      }
      return { kind: "ref", type: resolved.type };
    }
    case "list": {
      const items = node.items.map((item) =>
        analyzeValue(env, reader, item, path)
      );
      const types = items.map((item) => item.type);
      const known = types.every((type): type is ValueType =>
        type !== undefined
      );
      return {
        kind: "list",
        items,
        type: known
          ? boundedType(env, path, {
            kind: "list",
            item: unifyTypes(types as ValueType[]) ?? { kind: "json" },
          })
          : undefined,
      };
    }
    case "object": {
      const fields = new Map<string, Analyzed>();
      const members = new Map<string, ObjectField>();
      let known = true;
      for (const key of Object.keys(node.fields)) {
        const child = analyzeValue(env, reader, node.fields[key]!, path);
        fields.set(key, child);
        if (child.type) {
          members.set(key, {
            type: child.type,
            required: true,
            sensitive: isSecretName(key),
          });
        } else {
          known = false;
        }
      }
      return {
        kind: "object",
        fields,
        type: known
          ? boundedType(env, path, { kind: "object", fields: members })
          : undefined,
      };
    }
  }
}

/**
 * Whether an analyzed value fits a target type with no coercion. Literals use
 * the precise literal check, references use assignability, and objects and
 * lists are checked member by member. Values whose type is unknown pass: the
 * failure that made them unknown was already reported.
 */
export function matchesType(value: Analyzed, target: ValueType): boolean {
  if (target.kind === "json") return true;
  switch (value.kind) {
    case "literal":
      return literalMatches(value.value, target);
    case "ref":
      return value.type === undefined || isAssignable(value.type, target);
    case "list": {
      const base = stripNullable(target);
      return base.kind === "list" &&
        value.items.every((item) => matchesType(item, base.item));
    }
    case "object": {
      const base = stripNullable(target);
      if (base.kind !== "object") return false;
      for (const [name, member] of value.fields) {
        const expected = base.fields.get(name);
        if (!expected || !matchesType(member, expected.type)) return false;
      }
      for (const [name, expected] of base.fields) {
        if (expected.required && !value.fields.has(name)) return false;
      }
      return true;
    }
  }
}

function boolean(type: ValueType): boolean {
  return type.kind === "boolean";
}

function scalarFamily(type: ValueType): TypeFamily | undefined {
  const family = familyOf(type);
  return family === "string" || family === "number" || family === "boolean"
    ? family
    : undefined;
}

/** Equality is allowed for one scalar family, or `null` against a nullable. */
function comparable(left: ValueType, right: ValueType): boolean {
  if (left.kind === "null" && right.kind === "null") return true;
  if (left.kind === "null") return right.kind === "nullable";
  if (right.kind === "null") return left.kind === "nullable";
  const l = scalarFamily(left);
  return l !== undefined && l === scalarFamily(right);
}

function enumOf(type: ValueType): readonly string[] | undefined {
  const base = stripNullable(type);
  return base.kind === "string" ? base.enum : undefined;
}

/** String literal members of a literal or a list of literals; else undefined. */
function literalStrings(
  node: WorkflowExpressionNode,
): readonly string[] | undefined {
  if (node.kind === "literal") {
    return typeof node.value === "string" ? [node.value] : undefined;
  }
  if (node.kind !== "list") return undefined;
  const values: string[] = [];
  for (const item of node.items) {
    const inner = literalStrings(item);
    if (!inner || item.kind !== "literal") return undefined;
    values.push(...inner);
  }
  return values;
}

/**
 * Whether a string literal compared against an enum-typed operand is a member
 * of that enum. Comparisons without a literal side, or without an enum side,
 * pass: nothing is known to be unreachable.
 */
function enumLiteralsAllowed(
  node: Extract<WorkflowExpressionNode, { kind: "compare" }>,
  left: ValueType,
  right: ValueType,
): boolean {
  const pairs: [ValueType, WorkflowExpressionNode][] = node.op === "in"
    ? [[left, node.right]]
    : [[left, node.right], [right, node.left]];
  for (const [operand, other] of pairs) {
    const members = enumOf(operand);
    const literals = literalStrings(other);
    if (members && literals && !literals.every((v) => members.includes(v))) {
      return false;
    }
  }
  return true;
}

/**
 * Types an expression and reports operand violations at `path`. Equality
 * needs the same scalar family (a nullable or null side may meet its base or
 * `null`), ordering needs non-nullable numbers or strings, `in` needs a list
 * whose item family matches, and logical operators need booleans. Returns the
 * result type, or undefined when an operand could not be typed.
 */
export function analyzeExpression(
  env: AnalysisEnv,
  reader: Reader,
  node: WorkflowExpressionNode,
  path: readonly PointerSegment[],
): ValueType | undefined {
  const fail = (): undefined => {
    env.collector.add(pointerFor(path), "expression_operand_invalid");
    return undefined;
  };
  switch (node.kind) {
    case "literal":
      return inferLiteralType(node.value);
    case "list": {
      const types: ValueType[] = [];
      for (const item of node.items) {
        const type = analyzeExpression(env, reader, item, path);
        if (!type) return undefined;
        types.push(type);
      }
      const item = unifyTypes(types);
      return item ? { kind: "list", item } : fail();
    }
    case "ref": {
      const resolved = resolveReference(env, reader, node);
      if (!resolved.ok) {
        env.collector.add(pointerFor(path), resolved.code);
        return undefined;
      }
      return resolved.type;
    }
    case "not": {
      const operand = analyzeExpression(env, reader, node.operand, path);
      if (operand && !boolean(operand)) fail();
      return { kind: "boolean" };
    }
    case "logical": {
      const left = analyzeExpression(env, reader, node.left, path);
      const right = analyzeExpression(env, reader, node.right, path);
      if (
        (left && !boolean(left)) || (right && !boolean(right))
      ) {
        fail();
      }
      return { kind: "boolean" };
    }
    case "compare": {
      const left = analyzeExpression(env, reader, node.left, path);
      const right = analyzeExpression(env, reader, node.right, path);
      if (!left || !right) return { kind: "boolean" };
      let valid: boolean;
      switch (node.op) {
        case "eq":
        case "ne":
          valid = comparable(left, right);
          break;
        case "in": {
          const leftFamily = scalarFamily(left);
          valid = right.kind === "list" && leftFamily !== undefined &&
            (right.item.kind === "json" ||
              scalarFamily(right.item) === leftFamily);
          break;
        }
        default: {
          valid = (left.kind === "number" && right.kind === "number") ||
            (left.kind === "string" && right.kind === "string");
        }
      }
      const membership = node.op === "eq" || node.op === "ne" ||
        node.op === "in";
      if (!valid || (membership && !enumLiteralsAllowed(node, left, right))) {
        fail();
      }
      return { kind: "boolean" };
    }
  }
}

/** Types a condition position; it must evaluate to a non-nullable boolean. */
export function checkCondition(
  env: AnalysisEnv,
  reader: Reader,
  condition: WorkflowExpressionNode,
  path: readonly PointerSegment[],
): void {
  const type = analyzeExpression(env, reader, condition, path);
  if (type && !boolean(type)) {
    env.collector.add(pointerFor(path), "condition_not_boolean");
  }
}

function minLengthOf(type: ValueType): number {
  if (type.kind !== "string") return 0;
  const value = type.constraints?.["minLength"];
  return typeof value === "number" ? value : 0;
}

/**
 * Effect key type rule: each reference part must be a non-nullable uuid,
 * integer, or string whose schema declares `minLength >= 1`, so the joined key
 * can never collapse to an empty or ambiguous segment. Returns the key type.
 */
export function checkEffectKey(
  env: AnalysisEnv,
  reader: Reader,
  key: WorkflowEffectKey,
  path: readonly PointerSegment[],
): ValueType {
  for (const part of key.parts) {
    if (part.kind !== "ref") continue;
    const resolved = resolveReference(env, reader, part);
    if (!resolved.ok) {
      env.collector.add(pointerFor(path), resolved.code);
      continue;
    }
    const type = resolved.type;
    if (!type) continue;
    const usable = (type.kind === "string" &&
      (type.format === "uuid" || minLengthOf(type) >= 1)) ||
      (type.kind === "number" && type.integer);
    if (!usable) env.collector.add(pointerFor(path), "effect_key_invalid");
  }
  return { kind: "string", constraints: { minLength: 1 } };
}
