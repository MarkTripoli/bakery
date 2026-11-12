import { WorkflowInterpreterError } from "./errors.ts";
import type { JsonValue } from "./evaluate.ts";

/** Deeper than any workflow value is, and shallow enough to copy without a stack overflow. */
const MAX_DEPTH = 256;

/**
 * The most values one copy will visit. Each array, object and scalar counts
 * once per visit, so a value referenced twice counts twice: that is what makes
 * the bound hold for a dispatch built as `{a: $x, b: $x}` over a candidate that
 * itself did the same, which grows by the number of references at every
 * repeat iteration. A string counts once whatever its length. Generous for the
 * payloads a run records (hundreds to thousands of values), small enough that
 * a refused copy is refused in tens of milliseconds, not after exhausting memory.
 */
export const MAX_CLONE_NODES = 500_000;

type Budget = { remaining: number };

/**
 * The value of an own data property. An accessor is refused by name rather
 * than run: a stored jsonb value has none, and a getter could throw an error of
 * its own or return something different on each read. A hole in a list has no
 * descriptor at all and is not JSON either.
 */
function dataValue(holder: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new WorkflowInterpreterError("state_not_json");
  }
  return descriptor.value;
}

function copy(value: unknown, depth: number, budget: Budget): JsonValue {
  if (depth > MAX_DEPTH) throw new WorkflowInterpreterError("state_not_json");
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new WorkflowInterpreterError("state_too_large");
  }
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
      items.push(copy(dataValue(value, index), depth + 1, budget));
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
    const member = dataValue(value, key);
    // A missing property is absent, as it is in JSON.
    if (member === undefined) continue;
    // defineProperty, not assignment: assigning "__proto__" would replace the
    // prototype, and JSON.parse (so a stored jsonb column) makes it a plain key.
    Object.defineProperty(result, key, {
      value: copy(member, depth + 1, budget),
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
 * NaN or Infinity, a cycle, an accessor property, a hole in a list. The cost
 * is linear in the number of values visited, and that number is bounded:
 * past `MAX_CLONE_NODES` it refuses with `state_too_large`, counting a value
 * referenced twice twice, so no shape of references can make one copy
 * unbounded.
 */
export function cloneJson(value: unknown): JsonValue {
  return copy(value, 0, { remaining: MAX_CLONE_NODES });
}
