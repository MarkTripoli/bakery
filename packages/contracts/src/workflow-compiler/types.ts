import type { WorkflowJsonValue } from "./json-value.ts";
import { isSecretName } from "./secrets.ts";

/**
 * Source-literal uuid check applied to literals bound to a `format: uuid`
 * target. Catalog `pattern` text is never compiled; this fixed expression is
 * the only uuid test in the compiler.
 */
export const UUID_LITERAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Constraints the runtime parser enforces but the compiler never evaluates:
 * `pattern`, length, size and numeric bounds, non-uuid formats. They are kept
 * for documentation and for the identical-shape union collapse only.
 */
export type RuntimeConstraints = Readonly<
  Record<string, string | number | boolean>
>;

export type ObjectField = {
  readonly type: ValueType;
  readonly required: boolean;
  /** Named with a secret word segment, or declared `writeOnly`. */
  readonly sensitive: boolean;
};

/** Static type of one value position, derived from a JSON Schema subset. */
export type ValueType =
  | {
    readonly kind: "string";
    readonly format?: "uuid";
    readonly enum?: readonly string[];
    readonly constraints?: RuntimeConstraints;
  }
  | {
    readonly kind: "number";
    readonly integer: boolean;
    readonly constraints?: RuntimeConstraints;
  }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | {
    readonly kind: "list";
    readonly item: ValueType;
    readonly constraints?: RuntimeConstraints;
  }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyMap<string, ObjectField>;
    readonly constraints?: RuntimeConstraints;
  }
  | { readonly kind: "nullable"; readonly inner: ValueType }
  | { readonly kind: "json" };

export type ObjectValueType = Extract<ValueType, { kind: "object" }>;

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 4_000;
const MAX_UNION_MEMBERS = 16;
const MAX_ENUM_VALUES = 256;

const UNSUPPORTED_KEYWORDS: readonly string[] = [
  "$ref",
  "$dynamicRef",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "prefixItems",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
];

const CONSTRAINT_KEYWORDS: readonly string[] = [
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "x-utf8-max-bytes",
];

type Budget = { nodes: number };

type SchemaRecord = Record<string, unknown>;

function isSchemaRecord(value: unknown): value is SchemaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constraintsOf(schema: SchemaRecord): RuntimeConstraints | undefined {
  const found: Record<string, string | number | boolean> = {};
  for (const key of CONSTRAINT_KEYWORDS) {
    if (!Object.hasOwn(schema, key)) continue;
    const value = schema[key];
    // A string constant is already the one-value enum.
    if (key === "const" && typeof value === "string") continue;
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      found[key] = value;
    }
  }
  const format = schema["format"];
  if (typeof format === "string" && format !== "uuid") found["format"] = format;
  return Object.keys(found).length > 0 ? Object.freeze(found) : undefined;
}

function withConstraints<T extends ValueType>(
  type: T,
  constraints: RuntimeConstraints | undefined,
): T {
  return constraints ? { ...type, constraints } : type;
}

function intersectConstraints(
  left: RuntimeConstraints | undefined,
  right: RuntimeConstraints | undefined,
): RuntimeConstraints | undefined {
  if (!left || !right) return undefined;
  const found: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(left)) {
    if (Object.hasOwn(right, key) && right[key] === value) found[key] = value;
  }
  return Object.keys(found).length > 0 ? Object.freeze(found) : undefined;
}

function typeNames(schema: SchemaRecord): readonly string[] | undefined {
  const type = schema["type"];
  if (typeof type === "string") return [type];
  if (
    Array.isArray(type) && type.length > 0 && type.length <= 2 &&
    type.every((entry) => typeof entry === "string")
  ) {
    return type as string[];
  }
  return undefined;
}

/**
 * True for the recursive JSON-value union the contracts emit for opaque
 * `json` fields: string, number, boolean, null, array of values and object of
 * values, each exactly once.
 */
function isJsonValueUnion(members: readonly unknown[]): boolean {
  if (members.length !== 6) return false;
  const seen = new Set<string>();
  for (const member of members) {
    if (!isSchemaRecord(member)) return false;
    const names = typeNames(member);
    if (!names || names.length !== 1) return false;
    const name = names[0]!;
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === "array" && !isSchemaRecord(member["items"])) return false;
    if (name === "object") {
      if (!isSchemaRecord(member["additionalProperties"])) return false;
      if (Object.hasOwn(member, "properties")) return false;
    }
  }
  return ["string", "number", "boolean", "null", "array", "object"].every(
    (name) => seen.has(name),
  );
}

function sameEnum(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((v) => right.includes(v));
}

/**
 * Collapses two types of identical shape into one. Differences confined to
 * runtime constraints (for example `minItems`) are dropped from the result;
 * any structural difference returns `undefined`.
 */
function collapse(left: ValueType, right: ValueType): ValueType | undefined {
  if (left.kind !== right.kind) return undefined;
  switch (left.kind) {
    case "boolean":
    case "null":
    case "json":
      return left;
    case "string": {
      const other = right as typeof left;
      if (left.format !== other.format || !sameEnum(left.enum, other.enum)) {
        return undefined;
      }
      return withConstraints(
        { kind: "string", format: left.format, enum: left.enum } as ValueType,
        intersectConstraints(left.constraints, other.constraints),
      );
    }
    case "number": {
      const other = right as typeof left;
      if (left.integer !== other.integer) return undefined;
      return withConstraints(
        { kind: "number", integer: left.integer },
        intersectConstraints(left.constraints, other.constraints),
      );
    }
    case "list": {
      const other = right as typeof left;
      const item = collapse(left.item, other.item);
      if (!item) return undefined;
      return withConstraints(
        { kind: "list", item },
        intersectConstraints(left.constraints, other.constraints),
      );
    }
    case "nullable": {
      const other = right as typeof left;
      const inner = collapse(left.inner, other.inner);
      return inner ? { kind: "nullable", inner } : undefined;
    }
    case "object": {
      const other = right as typeof left;
      if (left.fields.size !== other.fields.size) return undefined;
      const fields = new Map<string, ObjectField>();
      for (const [name, field] of left.fields) {
        const peer = other.fields.get(name);
        if (!peer || peer.required !== field.required) return undefined;
        const type = collapse(field.type, peer.type);
        if (!type) return undefined;
        fields.set(name, {
          type,
          required: field.required,
          sensitive: field.sensitive || peer.sensitive,
        });
      }
      return withConstraints(
        { kind: "object", fields },
        intersectConstraints(left.constraints, other.constraints),
      );
    }
  }
}

function convertUnion(
  members: unknown,
  depth: number,
  budget: Budget,
): ValueType | undefined {
  if (
    !Array.isArray(members) || members.length === 0 ||
    members.length > MAX_UNION_MEMBERS
  ) {
    return undefined;
  }
  if (isJsonValueUnion(members)) return { kind: "json" };
  const converted: ValueType[] = [];
  for (const member of members) {
    const type = convert(member, depth + 1, budget);
    if (!type) return undefined;
    converted.push(type);
  }
  const nonNull = converted.filter((type) => type.kind !== "null");
  const hasNull = nonNull.length !== converted.length;
  if (nonNull.length === 0) {
    return converted.length === 1 ? converted[0] : undefined;
  }
  let merged: ValueType | undefined = nonNull[0];
  for (let index = 1; merged && index < nonNull.length; index += 1) {
    merged = collapse(merged, nonNull[index]!);
  }
  if (!merged) return undefined;
  return hasNull && merged.kind !== "nullable" && merged.kind !== "json"
    ? { kind: "nullable", inner: merged }
    : merged;
}

function convertObject(
  schema: SchemaRecord,
  depth: number,
  budget: Budget,
): ValueType | undefined {
  if (schema["additionalProperties"] !== false) return undefined;
  if (Object.hasOwn(schema, "propertyNames")) return undefined;
  const properties = schema["properties"];
  if (properties !== undefined && !isSchemaRecord(properties)) return undefined;
  const required = schema["required"];
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      !required.every((entry) => typeof entry === "string"))
  ) {
    return undefined;
  }
  const requiredNames = new Set<string>((required ?? []) as string[]);
  const fields = new Map<string, ObjectField>();
  for (const name of Object.keys(properties ?? {})) {
    const property = (properties as SchemaRecord)[name];
    const type = convert(property, depth + 1, budget);
    if (!type) return undefined;
    const writeOnly = isSchemaRecord(property) &&
      property["writeOnly"] === true;
    fields.set(name, {
      type,
      required: requiredNames.has(name),
      sensitive: writeOnly || isSecretName(name),
    });
  }
  for (const name of requiredNames) {
    if (!fields.has(name)) return undefined;
  }
  return withConstraints({ kind: "object", fields }, constraintsOf(schema));
}

function convert(
  schema: unknown,
  depth: number,
  budget: Budget,
): ValueType | undefined {
  budget.nodes += 1;
  if (
    depth > MAX_SCHEMA_DEPTH || budget.nodes > MAX_SCHEMA_NODES ||
    !isSchemaRecord(schema)
  ) {
    return undefined;
  }
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) return undefined;
  }
  const hasAnyOf = Object.hasOwn(schema, "anyOf");
  const hasOneOf = Object.hasOwn(schema, "oneOf");
  if (hasAnyOf || hasOneOf) {
    if (hasAnyOf && hasOneOf) return undefined;
    return convertUnion(
      hasAnyOf ? schema["anyOf"] : schema["oneOf"],
      depth,
      budget,
    );
  }
  const constant = schema["const"];
  const enumeration = schema["enum"];
  // Numeric and boolean constants keep their declared type; the value is a
  // runtime constraint like any other bound.
  const stringConst = typeof constant === "string";
  if (stringConst || enumeration !== undefined) {
    const values = stringConst ? [constant] : enumeration;
    if (
      !Array.isArray(values) || values.length === 0 ||
      values.length > MAX_ENUM_VALUES ||
      !values.every((value) => typeof value === "string")
    ) {
      return undefined;
    }
    const names = typeNames(schema);
    if (names && !(names.length === 1 && names[0] === "string")) {
      return undefined;
    }
    return withConstraints(
      { kind: "string", enum: Object.freeze([...values] as string[]) },
      constraintsOf(schema),
    );
  }
  if (
    constant !== undefined && typeof constant !== "number" &&
    typeof constant !== "boolean"
  ) {
    return undefined;
  }
  const names = typeNames(schema);
  if (!names) return undefined;
  if (names.length === 2) {
    const other = names.find((name) => name !== "null");
    if (!other || other === "null" || !names.includes("null")) {
      return undefined;
    }
    const inner = convert({ ...schema, type: other }, depth + 1, budget);
    return inner ? { kind: "nullable", inner } : undefined;
  }
  switch (names[0]) {
    case "string": {
      const constraints = constraintsOf(schema);
      return schema["format"] === "uuid"
        ? withConstraints({ kind: "string", format: "uuid" }, constraints)
        : withConstraints({ kind: "string" }, constraints);
    }
    case "integer":
      return withConstraints(
        { kind: "number", integer: true },
        constraintsOf(schema),
      );
    case "number":
      return withConstraints(
        { kind: "number", integer: false },
        constraintsOf(schema),
      );
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "array": {
      const item = convert(schema["items"], depth + 1, budget);
      return item
        ? withConstraints({ kind: "list", item }, constraintsOf(schema))
        : undefined;
    }
    case "object":
      return convertObject(schema, depth, budget);
    default:
      return undefined;
  }
}

/**
 * Converts the supported JSON Schema subset to a `ValueType`. Returns
 * `undefined` for any unsupported construct (open objects, `$ref`, `allOf`,
 * heterogeneous unions, numeric enums, an untyped `{}`): the compiler never
 * silently widens an unrepresentable schema.
 *
 * `format: uuid` becomes the uuid string subtype. `pattern`, length, size
 * and numeric bounds are recorded as runtime constraints only: they are never
 * compiled into a `RegExp` and never evaluated statically. `anyOf` of closed
 * objects (or any members) that differ only in runtime constraints collapse
 * to one type, and the recursive JSON-value union maps to `json`.
 */
export function schemaToValueType(schema: unknown): ValueType | undefined {
  return convert(schema, 0, { nodes: 0 });
}

/** Narrows a converted type to a closed object type. */
export function asObjectType(
  type: ValueType | undefined,
): ObjectValueType | undefined {
  return type?.kind === "object" ? type : undefined;
}

/** Coarse family used for comparison rules. */
export type TypeFamily =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "list"
  | "object"
  | "json";

export function isNullableType(type: ValueType): boolean {
  return type.kind === "nullable" || type.kind === "null";
}

export function stripNullable(type: ValueType): ValueType {
  return type.kind === "nullable" ? type.inner : type;
}

export function familyOf(type: ValueType): TypeFamily {
  const base = stripNullable(type);
  switch (base.kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "nullable":
      return familyOf(base.inner);
    default:
      return base.kind;
  }
}

/**
 * Static type of a JSON literal. Numbers are `integer` when whole; lists take
 * their first item's type when every item shares a family, else `json`.
 */
export function typeOfLiteral(value: WorkflowJsonValue): ValueType {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") {
    return { kind: "number", integer: Number.isInteger(value) };
  }
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) return { kind: "list", item: { kind: "json" } };
    const item = typeOfLiteral(first);
    const family = familyOf(item);
    const uniform = value.every((entry) =>
      familyOf(typeOfLiteral(entry)) === family
    );
    return { kind: "list", item: uniform ? item : { kind: "json" } };
  }
  return { kind: "json" };
}

/**
 * Whether a source type may be bound to a target type with no coercion.
 * `json` accepts anything and is never a source for a narrower target.
 */
export function isAssignable(source: ValueType, target: ValueType): boolean {
  if (target.kind === "json") return true;
  if (source === target) return true;
  let row = ASSIGNABLE_MEMO.get(source);
  if (!row) {
    row = new WeakMap();
    ASSIGNABLE_MEMO.set(source, row);
  }
  const known = row.get(target);
  if (known !== undefined) return known;
  // Seeded true on entry: author-built types share subtype objects (a DAG),
  // so each (source, target) pair is decided once, not once per path.
  row.set(target, true);
  const result = computeAssignable(source, target);
  row.set(target, result);
  return result;
}

const ASSIGNABLE_MEMO = new WeakMap<
  ValueType,
  WeakMap<ValueType, boolean>
>();

/** Expanded node count of a type, saturating just above `limit`. */
export function valueTypeSize(type: ValueType, limit: number): number {
  const known = SIZE_MEMO.get(type);
  if (known !== undefined) return known;
  let size = 1;
  switch (type.kind) {
    case "nullable":
      size += valueTypeSize(type.inner, limit);
      break;
    case "list":
      size += valueTypeSize(type.item, limit);
      break;
    case "object":
      for (const field of type.fields.values()) {
        size += valueTypeSize(field.type, limit);
        if (size > limit) break;
      }
      break;
    default:
      break;
  }
  size = Math.min(size, limit + 1);
  SIZE_MEMO.set(type, size);
  return size;
}

const SIZE_MEMO = new WeakMap<ValueType, number>();

function computeAssignable(source: ValueType, target: ValueType): boolean {
  if (target.kind === "json") return true;
  if (source.kind === "json") return false;
  if (target.kind === "nullable") {
    if (source.kind === "null") return true;
    return isAssignable(
      source.kind === "nullable" ? source.inner : source,
      target.inner,
    );
  }
  if (source.kind === "nullable") return false;
  if (source.kind !== target.kind) return false;
  switch (target.kind) {
    case "boolean":
    case "null":
      return true;
    case "string": {
      const from = source as typeof target;
      if (target.format === "uuid" && from.format !== "uuid") return false;
      if (target.enum) {
        return from.enum !== undefined &&
          from.enum.every((value) => target.enum!.includes(value));
      }
      return true;
    }
    case "number": {
      const from = source as typeof target;
      return !target.integer || from.integer;
    }
    case "list":
      return isAssignable((source as typeof target).item, target.item);
    case "object": {
      const from = source as typeof target;
      for (const [name, field] of from.fields) {
        const peer = target.fields.get(name);
        if (!peer || !isAssignable(field.type, peer.type)) return false;
      }
      for (const [name, field] of target.fields) {
        const own = from.fields.get(name);
        if (field.required && (!own || !own.required)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Whether a JSON literal satisfies a target type. Uuid targets use the fixed
 * source-literal regex; `pattern`, length and numeric bounds are runtime-only
 * and are not evaluated here.
 */
export function literalMatches(
  value: WorkflowJsonValue,
  target: ValueType,
): boolean {
  switch (target.kind) {
    case "json":
      return true;
    case "null":
      return value === null;
    case "nullable":
      return value === null || literalMatches(value, target.inner);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" &&
        (!target.integer || Number.isInteger(value));
    case "string":
      if (typeof value !== "string") return false;
      if (target.format === "uuid" && !UUID_LITERAL.test(value)) return false;
      return !target.enum || target.enum.includes(value);
    case "list":
      return Array.isArray(value) &&
        value.every((entry) => literalMatches(entry, target.item));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, WorkflowJsonValue>;
      for (const name of Object.keys(record)) {
        const field = target.fields.get(name);
        if (!field || !literalMatches(record[name]!, field.type)) return false;
      }
      for (const [name, field] of target.fields) {
        if (field.required && !Object.hasOwn(record, name)) return false;
      }
      return true;
    }
  }
}
