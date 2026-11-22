/**
 * The lifecycle of a deployment (#43, B10.06), in the delivery adapter
 * contract's own words. Pure: the store and the tests read the same table.
 *
 * queued -> deploying -> verifying -> healthy | degraded | failed
 *   healthy | degraded | failed -> rolling_back -> rolled_back | failed
 * `unknown` is entered when the answer to a deploy or a rollback was lost. It
 * never moves on a person's request: it is settled by reading the same
 * external effect back, which says what really happened.
 */

export const DEPLOYMENT_STATUSES = [
  "queued",
  "deploying",
  "verifying",
  "healthy",
  "degraded",
  "failed",
  "unknown",
  "rolling_back",
  "rolled_back",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_ENVIRONMENTS = [
  "preview",
  "staging",
  "production",
] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/**
 * In flight: something is, or may be, changing the environment. An `unknown`
 * outcome counts, so uncertainty blocks further writes until it is settled. The
 * database's partial unique index uses the same list (migration 0323).
 */
export const IN_FLIGHT_STATUSES: readonly DeploymentStatus[] = [
  "queued",
  "deploying",
  "verifying",
  "rolling_back",
  "unknown",
];

/** A release that can serve the environment, and so can be rolled back. */
export const SERVING_STATUSES: readonly DeploymentStatus[] = [
  "healthy",
  "degraded",
];

/** What a person may roll back: a release that served, or one that failed to. */
export const ROLLBACK_SOURCE_STATUSES: readonly DeploymentStatus[] = [
  "healthy",
  "degraded",
  "failed",
];

const SETTLED_OUTCOMES: readonly DeploymentStatus[] = [
  "deploying",
  "verifying",
  "healthy",
  "degraded",
  "failed",
  "rolling_back",
  "rolled_back",
];

const NEXT: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  // A failed prepare ends here; a lost answer is unknown, never assumed.
  queued: ["deploying", "failed", "unknown"],
  deploying: ["verifying", "failed", "unknown"],
  verifying: ["healthy", "degraded", "failed", "unknown"],
  healthy: ["rolling_back"],
  degraded: ["rolling_back"],
  failed: ["rolling_back"],
  // Only a read-back settles it, and it settles to what the read says.
  unknown: SETTLED_OUTCOMES,
  rolling_back: ["rolled_back", "failed", "unknown"],
  rolled_back: [],
};

export function isDeploymentStatus(value: string): value is DeploymentStatus {
  return (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}

export function isInFlight(status: DeploymentStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

/** Whether a deployment may move from `from` to `to`. */
export function canMove(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return NEXT[from].includes(to);
}

/** The statuses a deployment may move to from `from`. */
export function movesFrom(from: DeploymentStatus): readonly DeploymentStatus[] {
  return NEXT[from];
}
