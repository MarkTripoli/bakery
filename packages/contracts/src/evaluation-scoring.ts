/**
 * Pure scoring helpers shared by the worker (`evaluation.check`,
 * `evaluation.score`) and the server finalizer. Nothing here performs I/O.
 *
 * The JSON-schema support is a deliberate subset: `type` (one name or a list),
 * `required` and `properties`, applied recursively, plus `items` for arrays.
 * Every other keyword is ignored, so a schema that relies on one validates
 * less than its author meant; callers treat the subset as the contract.
 */

export type JsonSchemaTypeName =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

const TYPE_NAMES: readonly JsonSchemaTypeName[] = Object.freeze([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** Deepest nesting the validator walks before refusing the value. */
export const JSON_SCHEMA_SUBSET_MAX_DEPTH = 32;

export type JsonSchemaViolation = Readonly<{ path: string; message: string }>;

export type JsonSchemaVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; violations: readonly JsonSchemaViolation[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(name: JsonSchemaTypeName, value: unknown): boolean {
  switch (name) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

/**
 * Checks that a schema uses the subset correctly. A malformed schema is a
 * caller defect, reported instead of silently validating nothing.
 */
export function jsonSchemaSubsetDefect(
  schema: unknown,
  depth = 0,
): string | null {
  if (depth > JSON_SCHEMA_SUBSET_MAX_DEPTH) return "schema nests too deeply";
  if (typeof schema === "boolean") return null;
  if (!isRecord(schema)) return "schema must be an object or a boolean";
  const type = schema.type;
  if (type !== undefined) {
    const names = Array.isArray(type) ? type : [type];
    if (
      names.length === 0 ||
      names.some((name) => !(TYPE_NAMES as readonly unknown[]).includes(name))
    ) return "type must name JSON types";
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((key) => typeof key !== "string"))
  ) return "required must be a list of property names";
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) return "properties must be an object";
    for (const child of Object.values(schema.properties)) {
      const defect = jsonSchemaSubsetDefect(child, depth + 1);
      if (defect) return defect;
    }
  }
  if (schema.items !== undefined) {
    return jsonSchemaSubsetDefect(schema.items, depth + 1);
  }
  return null;
}

function walk(
  schema: unknown,
  value: unknown,
  path: string,
  depth: number,
  out: JsonSchemaViolation[],
): void {
  if (depth > JSON_SCHEMA_SUBSET_MAX_DEPTH) {
    out.push({ path, message: "value nests too deeply" });
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    out.push({ path, message: "no value is allowed here" });
    return;
  }
  if (!isRecord(schema)) {
    out.push({ path, message: "schema is not valid" });
    return;
  }
  if (schema.type !== undefined) {
    const names = (Array.isArray(schema.type)
      ? schema.type
      : [schema.type]) as JsonSchemaTypeName[];
    if (
      !names.some((name) =>
        typeMatches(name, value)
      )
    ) {
      out.push({ path, message: `expected ${names.join(" or ")}` });
      return;
    }
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(value, key)) {
          out.push({ path: `${path}/${key}`, message: "is required" });
        }
      }
    }
    if (isRecord(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key)) {
          walk(child, value[key], `${path}/${key}`, depth + 1, out);
        }
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      walk(schema.items, item, `${path}/${index}`, depth + 1, out)
    );
  }
}

/** Validates `value` against the JSON-schema subset described above. */
export function validateJsonSchemaSubset(
  schema: unknown,
  value: unknown,
): JsonSchemaVerdict {
  const defect = jsonSchemaSubsetDefect(schema);
  if (defect) return { ok: false, violations: [{ path: "", message: defect }] };
  const violations: JsonSchemaViolation[] = [];
  walk(schema, value, "", 0, violations);
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Structural equality of JSON values; object key order does not matter. */
export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonDeepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key) =>
        Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key])
      );
  }
  return false;
}

export const EVALUATION_CHECK_KINDS = Object.freeze(
  ["json_schema", "contains", "equals"] as const,
);
export type EvaluationCheckKind = typeof EVALUATION_CHECK_KINDS[number];

export type EvaluationCheckSpec = Readonly<{
  kind: EvaluationCheckKind;
  config: unknown;
}>;

/** What a scorer decided about one output; `score` is null unless measured. */
export type EvaluationVerdict = Readonly<{
  state: "passed" | "failed" | "error";
  score: number | null;
  reason: string | null;
}>;

function failed(reason: string): EvaluationVerdict {
  return { state: "failed", score: 0, reason };
}

function errored(reason: string): EvaluationVerdict {
  return { state: "error", score: null, reason };
}

function violationText(violations: readonly JsonSchemaViolation[]): string {
  return violations.slice(0, 5).map(({ path, message }) =>
    `${path || "/"} ${message}`
  ).join("; ");
}

/**
 * Scores one output deterministically. An output that cannot be read the way
 * the check needs (not UTF-8, not JSON) fails with a reason; a check whose own
 * config is unusable is an `error`, because no output could have passed it.
 */
export function evaluateCheck(
  check: EvaluationCheckSpec,
  bytes: Uint8Array,
): EvaluationVerdict {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failed("output is not valid UTF-8 text");
  }
  const config = isRecord(check.config) ? check.config : null;
  switch (check.kind) {
    case "contains": {
      const needle = config?.substring;
      if (typeof needle !== "string" || needle === "") {
        return errored("contains check needs a non-empty config.substring");
      }
      return text.includes(needle)
        ? { state: "passed", score: 1, reason: null }
        : failed("output does not contain the expected text");
    }
    case "equals":
    case "json_schema": {
      if (config === null) return errored(`${check.kind} check needs a config`);
      if (check.kind === "json_schema") {
        const defect = jsonSchemaSubsetDefect(config.schema);
        if (defect) return errored(`json_schema config.schema: ${defect}`);
      } else if (!Object.hasOwn(config, "expected")) {
        return errored("equals check needs config.expected");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return failed("output is not valid JSON");
      }
      if (check.kind === "equals") {
        return jsonDeepEqual(parsed, config.expected)
          ? { state: "passed", score: 1, reason: null }
          : failed("output does not equal the expected value");
      }
      const verdict = validateJsonSchemaSubset(config.schema, parsed);
      return verdict.ok ? { state: "passed", score: 1, reason: null } : failed(
        `output does not match the schema: ${
          violationText(verdict.violations)
        }`,
      );
    }
  }
}

export { violationText as jsonSchemaViolationText };
