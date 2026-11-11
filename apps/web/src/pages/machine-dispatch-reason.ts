import type { DispatchBlockersResponse } from "../api/client.ts";

/** Reason the dispatch-blockers projection names, taken from the contract. */
export type DispatchBlockReason = NonNullable<
  DispatchBlockersResponse["reason"]
>;

/**
 * Catalog key per contract reason. `Record` over the contract union makes the
 * map exhaustive in both directions: a reason added to or removed from the
 * contract fails typecheck here.
 */
const DISPATCH_BLOCK_KEYS: Record<DispatchBlockReason, string> = {
  revoked: "machines.dispatch.blocked.revoked",
  offline: "machines.dispatch.blocked.offline",
  stale: "machines.dispatch.blocked.stale",
  check_failed: "machines.dispatch.blocked.check_failed",
  draining: "machines.dispatch.blocked.draining",
  paused: "machines.dispatch.blocked.paused",
};

/** Every dispatch block reason, derived from the exhaustive key map. */
export const DISPATCH_BLOCK_REASONS = Object.keys(
  DISPATCH_BLOCK_KEYS,
) as DispatchBlockReason[];

/**
 * Readiness reasons the readiness projection emits (a subset of the above).
 * Documented handwritten list: the contract types WorkerHost.readinessReason
 * as an open `string|null`, so no enum exists to derive from.
 */
export const READINESS_REASONS = [
  "revoked",
  "offline",
  "stale",
  "check_failed",
] as const;

export type ReadinessReason = typeof READINESS_REASONS[number];

/** Catalog key for the warning banner, or null when nothing blocks dispatch. */
export function dispatchBlockedKey(
  reason: DispatchBlockReason | null | undefined,
): string | null {
  return reason ? DISPATCH_BLOCK_KEYS[reason] : null;
}

/**
 * Catalog key for the readiness row reason. Null or unrecognised codes have no
 * key, so the caller falls back to the neutral unknown label and never prints
 * a raw server code.
 */
export function readinessReasonKey(
  reason: string | null | undefined,
): string | null {
  return (READINESS_REASONS as readonly string[]).includes(reason ?? "")
    ? `machines.readiness.reason.${reason}`
    : null;
}
