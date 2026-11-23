/**
 * A small JSON Schema check for a tool call's arguments against the input schema
 * the tool declared when its snapshot was pinned (#435, 25-one-engine.md 15.4).
 *
 * It refuses what the common subset can say is wrong: a value of the wrong type,
 * a missing required property, an unknown property where the schema closes the
 * object, a value outside an enum or const, a string or number outside its
 * bounds, an array item that does not match. It returns the pointer of the first
 * problem, never the value. A keyword it does not know (`$ref`, `format`,
 * `pattern`, conditionals) is not checked here; the server checks its own rules,
 * and a pin that is stricter than the server would refuse calls the server accepts.
 */

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeOf(value) === type;
  }
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function pointer(path: readonly (string | number)[]): string {
  return path.map((part) =>
    "/" + String(part).replaceAll("~", "~0").replaceAll("/", "~1")
  ).join("");
}

function check(
  schema: unknown,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
): readonly (string | number)[] | null {
  if (!isRecord(schema) || depth > 32) return null;
  const s = schema as Schema;
  if ("const" in s && !same(s.const, value)) return path;
  if (Array.isArray(s.enum) && !s.enum.some((item) => same(item, value))) {
    return path;
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (
      types.every((t) => typeof t === "string") &&
      !types.some((t) => matchesType(t as string, value))
    ) return path;
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    if (
      !s.anyOf.some((branch) => check(branch, value, path, depth + 1) === null)
    ) {
      return path;
    }
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const matching = s.oneOf.filter((branch) =>
      check(branch, value, path, depth + 1) === null
    );
    if (matching.length !== 1) return path;
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      return path;
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      return path;
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return path;
    if (typeof s.maximum === "number" && value > s.maximum) return path;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      return path;
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      return path;
    }
    if (s.items !== undefined && !Array.isArray(s.items)) {
      for (let at = 0; at < value.length; at++) {
        const found = check(s.items, value[at], [...path, at], depth + 1);
        if (found !== null) return found;
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(s.properties) ? s.properties : {};
    if (Array.isArray(s.required)) {
      for (const name of s.required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) {
          return [...path, name];
        }
      }
    }
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        const found = check(properties[name], item, [...path, name], depth + 1);
        if (found !== null) return found;
      } else if (s.additionalProperties === false) {
        return [...path, name];
      } else if (isRecord(s.additionalProperties)) {
        const found = check(
          s.additionalProperties,
          item,
          [...path, name],
          depth + 1,
        );
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** The JSON Pointer of the first place `value` breaks `schema`, or null when it holds. */
export function checkAgainstSchema(
  schema: unknown,
  value: unknown,
): string | null {
  const found = check(schema, value, [], 0);
  return found === null ? null : pointer(found);
}
