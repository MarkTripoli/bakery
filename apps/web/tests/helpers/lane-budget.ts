/**
 * The time budget of a whole browser test, sized for the slow CI hosts (#559).
 *
 * `bakery-heavy` names a pool that mixes AMD and Intel x64 hosts with ARM64
 * runners, and the same job took 1.4 to 2.1 times as long on the slower ones
 * (learnings/heavy-lane-label-is-pool-not-cpu.xml). A test budget written as a
 * bare number is right for one host and short for another, so a test gives the
 * budget it needs on a fast host and this scales it for CI. It is only a bound
 * on a stuck test: each wait inside the test keeps its own tight timeout, so a
 * stuck step still fails fast on that wait.
 */

/** The slowest measured host over the fastest, as a factor on a fast-host budget. */
export const SLOW_HOST_FACTOR = 2.1;

/** Minutes, for a budget written as `3 * MINUTE`. */
export const MINUTE = 60_000;

type Environment = Record<string, string | undefined>;

/**
 * The budget for a test that needs `fastHostMs` on a fast host: scaled by
 * `SLOW_HOST_FACTOR` in CI, as is outside it, or by `BAKERY_TEST_TIME_SCALE`
 * when that names a positive number (a slower machine, or to see a hung test
 * fail sooner).
 */
export function laneBudgetMs(
  fastHostMs: number,
  environment: Environment = process.env,
): number {
  const override = Number(environment.BAKERY_TEST_TIME_SCALE);
  const scale = Number.isFinite(override) && override > 0
    ? override
    : environment.CI
    ? SLOW_HOST_FACTOR
    : 1;
  return Math.ceil(fastHostMs * scale);
}
