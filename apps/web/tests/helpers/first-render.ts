import { test } from "@playwright/test";

/**
 * First-render budget: the goto plus the first post-goto assertion. Local runs
 * keep Playwright's 5 s default; CI gets 15 s from the measured 150% CPUQuota
 * arms below because a cold dev-server module graph renders slowly under
 * runner contention.
 *
 * Measured under `systemd-run --user --scope` with a 150% CPUQuota, 2 workers
 * (an earlier 150% shell reproduction showed the same headroom gap):
 * the six-test state-matrix arm had 0 failures (p50 6577 ms, p99 6592 ms,
 * max 6592 ms), and the 106-test shell arm had 0 failures (p50 5203 ms,
 * p99 7304 ms, max 7660 ms). The earlier 17148 ms max came from the
 * network-drop attempt with failed module requests, not first-render time,
 * and does not size this budget. The same 5 s signature failed 26 tests in
 * main runs 39750094163 and 39761987792. No failure occurred after first
 * render, so the global expect timeout stays 5 s. A built preview cannot
 * serve these routes (`router.tsx` dev-only `developmentRoutes`).
 */
export const FIRST_RENDER_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

/** Runs `navigate` then `ready` as one boxed `first render` step. */
export function firstRender(
  navigate: () => Promise<unknown>,
  ready: (timeout: number) => Promise<void>,
): Promise<void> {
  return test.step("first render", async () => {
    await navigate();
    await ready(FIRST_RENDER_TIMEOUT_MS);
  }, { box: true });
}
