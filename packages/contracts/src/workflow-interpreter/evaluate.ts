import type { WorkflowJsonValue } from "../workflow-compiler/json-value.ts";
import type {
  WorkflowExpressionNode,
  WorkflowReferenceNode,
  WorkflowValueNode,
} from "../workflow-compiler/schema.ts";
import { WorkflowInterpreterError } from "./errors.ts";

export type JsonValue = WorkflowJsonValue;

/** Reads the current value a reference points at, for a given reader position. */
export type ReferenceReader = (reference: WorkflowReferenceNode) => JsonValue;

/** An object value, as opposed to a scalar, a list or null. */
export function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Follows field segments into a value. A missing field of an object, or any
 * field read through `null`, is `null`: the compiler only lets a reference
 * name an optional field when the schema declares it optional, and an optional
 * missing value is `null`, never `false` or an empty string. Reading a field of
 * a scalar or a list is not a thing the compiler allows, so it is refused.
 */
export function readFields(
  value: JsonValue,
  segments: readonly string[],
): JsonValue {
  let current: JsonValue = value;
  for (const segment of segments) {
    if (current === null) return null;
    if (!isJsonObject(current)) {
      throw new WorkflowInterpreterError("reference_unresolved");
    }
    current = Object.hasOwn(current, segment) ? current[segment]! : null;
  }
  return current;
}

/** A value position: literal, reference, object of values or list of values. */
export function evaluateValue(
  node: WorkflowValueNode,
  read: ReferenceReader,
): JsonValue {
  switch (node.kind) {
    case "literal":
      // A copy, so nothing the run produces aliases the workflow document.
      return structuredClone(node.value);
    case "ref":
      return read(node);
    case "object": {
      const fields: { [key: string]: JsonValue } = Object.create(null);
      for (const [name, field] of Object.entries(node.fields)) {
        fields[name] = evaluateValue(field, read);
      }
      return fields;
    }
    case "list":
      return node.items.map((item) => evaluateValue(item, read));
  }
}

type Scalar = string | number | boolean | null;

function isScalar(value: JsonValue): value is Scalar {
  return value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean";
}

function expectBoolean(value: JsonValue): boolean {
  if (typeof value !== "boolean") {
    throw new WorkflowInterpreterError("operand_invalid");
  }
  return value;
}

function compare(
  op: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "in",
  left: JsonValue,
  right: JsonValue,
): boolean {
  if (op === "in") {
    if (!Array.isArray(right) || !isScalar(left)) {
      throw new WorkflowInterpreterError("operand_invalid");
    }
    return right.some((item) => isScalar(item) && item === left);
  }
  if (!isScalar(left) || !isScalar(right)) {
    throw new WorkflowInterpreterError("operand_invalid");
  }
  // No coercion anywhere: `1 == "1"` is false, and `null` equals only `null`.
  if (op === "eq") return left === right;
  if (op === "ne") return left !== right;
  const numbers = typeof left === "number" && typeof right === "number";
  const strings = typeof left === "string" && typeof right === "string";
  if (!numbers && !strings) {
    throw new WorkflowInterpreterError("operand_invalid");
  }
  const a = left as number | string;
  const b = right as number | string;
  switch (op) {
    case "lt":
      return a < b;
    case "le":
      return a <= b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
  }
}

/**
 * Evaluates the restricted expression grammar over typed nodes. There is no
 * implicit coercion: `&&`, `||` and `!` take booleans, ordering takes two
 * numbers or two strings, and `in` takes a scalar and a list. `&&` and `||`
 * stop at the first operand that decides the result, so a guard such as
 * `outcome == "completed" && ...` never reads what its left side rules out.
 */
export function evaluateExpression(
  node: WorkflowExpressionNode,
  read: ReferenceReader,
): JsonValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "list":
      return node.items.map((item) => evaluateExpression(item, read));
    case "ref":
      return read(node);
    case "not":
      return !expectBoolean(evaluateExpression(node.operand, read));
    case "logical": {
      const left = expectBoolean(evaluateExpression(node.left, read));
      if (node.op === "and" && !left) return false;
      if (node.op === "or" && left) return true;
      return expectBoolean(evaluateExpression(node.right, read));
    }
    case "compare":
      return compare(
        node.op,
        evaluateExpression(node.left, read),
        evaluateExpression(node.right, read),
      );
  }
}

/** A condition (`if`, `when`, `until`) must be a boolean, never merely truthy. */
export function evaluateCondition(
  node: WorkflowExpressionNode,
  read: ReferenceReader,
): boolean {
  const value = evaluateExpression(node, read);
  if (typeof value !== "boolean") {
    throw new WorkflowInterpreterError("condition_not_boolean");
  }
  return value;
}
