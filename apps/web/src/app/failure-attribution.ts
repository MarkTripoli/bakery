import { sentryOperationName } from "@bakery/config/sentry-privacy";

/**
 * Which handled failures are reported, and under what name. Kept free of the
 * query client so the rules stay testable on their own.
 */

/**
 * Reads the operation name out of a query or mutation key. Protected keys are
 * `["protected", sessionGeneration, organizationId, operation, input]`, public
 * keys are `["public", resource, …]` and a mutation key is `[operation]`.
 * Inputs, identifiers and session generations are never part of the name.
 */
export function operationFor(key: readonly unknown[]): string {
  const candidate = key[0] === "protected"
    ? key[3]
    : key[0] === "public"
    ? key[1]
    : key[0];
  return typeof candidate === "string" && sentryOperationName.test(candidate)
    ? candidate
    : "unknown";
}

/** Honours an explicit opt-out for failures that are expected control flow. */
export function reportsFailure(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return true;
  if (!("report" in meta)) return true;
  return meta.report !== false;
}
