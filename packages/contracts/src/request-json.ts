/**
 * Two things about a parsed request body that schema validation cannot be left
 * to find (issue #36, QA on #364), both found without recursion so the check
 * itself cannot overflow the stack:
 *
 *   - Depth. The generated JSON schemas are recursive; a body nested a few
 *     thousand levels deep overflows the stack inside the validator, before any
 *     byte limit is read, and the request fails as a server error. No honest
 *     body nests this deep.
 *   - A `__proto__` key. JSON parsing makes it an own property, validators drop
 *     it silently, and what reaches a handler is a document that says something
 *     other than what was sent (a filter `{"__proto__": "x"}` becomes `{}`, the
 *     widest one). It is refused instead.
 *   - A NUL character (U+0000) in any key or text. PostgreSQL cannot store it
 *     in text or jsonb, so it would fail as a server error after the work began;
 *     it is refused at the boundary, as the rule routes already refuse it.
 */

/** The deepest nesting a request body may have. */
export const MAX_REQUEST_JSON_DEPTH = 128;

export type UnsafeRequestJson = "too_deep" | "proto_key" | "nul";

/** What is wrong with a parsed JSON value, or null when it is fine. */
export function unsafeRequestJson(value: unknown): UnsafeRequestJson | null {
  if (typeof value === "string") return value.includes("\u0000") ? "nul" : null;
  if (value === null || typeof value !== "object") return null;
  const stack: [object, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > MAX_REQUEST_JSON_DEPTH) return "too_deep";
    const entries: [string | null, unknown][] = Array.isArray(node)
      ? node.map((item) => [null, item])
      : Object.entries(node);
    for (const [key, item] of entries) {
      if (key !== null) {
        if (key === "__proto__") return "proto_key";
        if (key.includes("\u0000")) return "nul";
      }
      if (typeof item === "string") {
        if (item.includes("\u0000")) return "nul";
      } else if (item !== null && typeof item === "object") {
        stack.push([item, depth + 1]);
      }
    }
  }
  return null;
}
