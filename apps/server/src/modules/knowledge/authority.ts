import { StandardError } from "@bakery/contracts/http";

/**
 * Require the caller to name the current immutable parent before promoting a
 * later version. The comparison happens after the artifact row is locked.
 */
export function assertParentVersion(
  currentVersionId: string | null,
  suppliedIfMatch: string | null | undefined,
): void {
  const supplied = normalizeIfMatch(suppliedIfMatch);
  if (supplied === INVALID_IF_MATCH) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (currentVersionId === null) {
    if (supplied !== null) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    return;
  }
  if (supplied === null) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (!supplied.includes(currentVersionId)) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
}

const INVALID_IF_MATCH = Symbol("invalid-if-match");
const STRONG_IF_MATCH = /^"[A-Za-z0-9][A-Za-z0-9._~-]*"$/;

function normalizeIfMatch(
  value: string | null | undefined,
): string[] | typeof INVALID_IF_MATCH | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!STRONG_IF_MATCH.test(trimmed)) return INVALID_IF_MATCH;
  return [trimmed.slice(1, -1)];
}
