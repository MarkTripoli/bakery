import { WorkflowInterpreterError } from "./errors.ts";
import type { JsonValue } from "./evaluate.ts";

/** Deeper than any workflow value is, and shallow enough to copy without a stack overflow. */
const MAX_DEPTH = 256;

function copy(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) throw new WorkflowInterpreterError("state_not_json");
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new WorkflowInterpreterError("state_not_json");
      }
      return value;
    case "object":
      break;
    default:
      // undefined, function, symbol and bigint are not JSON.
      throw new WorkflowInterpreterError("state_not_json");
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(copy(value[index], depth + 1));
    }
    return items;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    // A Map, a Date, a class instance: not something a run can have recorded.
    throw new WorkflowInterpreterError("state_not_json");
  }
  // The copy keeps the prototype it found: the interpreter builds its own
  // objects without one so that a key named toString is only data, and a
  // recorded object is ordinary.
  const result: { [key: string]: JsonValue } = prototype === null
    ? Object.create(null)
    : {};
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    // A missing property is absent, as it is in JSON.
    if (member === undefined) continue;
    // defineProperty, not assignment: assigning "__proto__" would replace the
    // prototype, and JSON.parse (so a stored jsonb column) makes it a plain key.
    Object.defineProperty(result, key, {
      value: copy(member, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * A deep copy of a JSON value that shares nothing with the original. It keeps
 * each object's prototype, keeps an own `__proto__` key as data, copies a
 * value referenced twice twice, and refuses by name (`state_not_json`) what
 * is not plain JSON of bounded depth: a function, a Map, a Date, a bigint,
 * NaN or Infinity, a cycle. The cost is linear in the size of the value, so a
 * large referenced payload is paid for once per call.
 */
export function cloneJson(value: unknown): JsonValue {
  return copy(value, 0);
}
