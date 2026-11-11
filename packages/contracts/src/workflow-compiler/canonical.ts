/**
 * Canonical JSON with recursively sorted object keys and preserved array
 * order. Mirrors `apps/server/src/platform/canonical-json.ts` exactly for
 * JSON-compatible input; contracts cannot import the server, so the semantics
 * are copied and pinned by a parity test. Output objects have a null
 * prototype so a `__proto__` member stays an own property.
 */
const MAX_CANONICAL_DEPTH = 1_000;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, 0));
}

function canonicalize(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("workflow canonical input has a non-finite number");
    }
    return value;
  }
  if (typeof value === "string") return value;
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError("workflow canonical input is nested too deeply");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) sorted[key] = canonicalize(entry, depth + 1);
    }
    return sorted;
  }
  throw new TypeError("workflow canonical input is not JSON-compatible");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
