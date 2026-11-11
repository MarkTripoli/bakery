import type { Page } from "@playwright/test";

/**
 * Better Auth's built-in default special rules cap every `/sign-in*`,
 * `/sign-up*`, and (via the two-factor plugin's own rule) `/two-factor/*`
 * path at 3 requests per 10-second window, keyed `<ip>|<path>`
 * (`node_modules/better-auth/dist/api/rate-limiter/index.mjs`'s
 * `getDefaultSpecialRules`, and `dist/plugins/two-factor/index.mjs`'s own
 * `pathMatcher`), overriding this repo's `rateLimit: { window: 10, max: 100
 * }` (`apps/server/src/modules/auth/adapters/better-auth.ts:77`). Rather
 * than mirror that bucket client-side (which cannot see requests from any
 * other worker or spec sharing the same server), these helpers observe the
 * real response: a `429` waits out the server's own `X-Retry-After` header
 * and resubmits, so this is correct regardless of what else contends for
 * the bucket. Shared by every retrying submit/request in `auth-journey.spec.ts`.
 */
type RetryableResponse = {
  status(): number;
  headers(): Record<string, string>;
};

/** Server-directed wait after a `429`: its `X-Retry-After` (capped) plus slack. */
export function retryDelayMs(response: RetryableResponse): number {
  const headers = response.headers();
  const raw = headers["x-retry-after"] ?? headers["retry-after"] ?? "1";
  const seconds = Number(raw);
  const bounded = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, 15)
    : 1;
  return bounded * 1000 + 500;
}

/** Shared by every caller in this directory that needs a plain delay. */
export async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/**
 * Clicks/taps a submit control and resubmits on `429` until it is accepted.
 * `submit` must redo *every* field fill it depends on, not just the click:
 * a failed submit (including a `429`) clears the relevant password/code
 * field in this app's own error handling (`SignInPage`/`TwoFactorPage`/
 * `SecuritySettingsPage`), so a bare re-click would resubmit an empty field
 * and never reach the network at all.
 */
export async function submitUntilAccepted(
  page: Page,
  urlIncludes: string,
  submit: () => Promise<void>,
): Promise<void> {
  for (;;) {
    // A 429 on sign-in replaces the form with the "A short pause" interstitial
    // (`data-testid="sign-in-throttled"`); only its "Return to sign in" button
    // restores the fields `submit` fills, so step back out before resubmitting.
    if (await page.getByTestId("sign-in-throttled").isVisible()) {
      await page.getByRole("button", { name: "Return to sign in", exact: true })
        .click();
    }
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(urlIncludes)
    );
    await submit();
    const response = await responsePromise;
    if (response.status() !== 429) return;
    await sleep(retryDelayMs(response));
  }
}

/** Reissues a raw `page.request`/`request` API call on `429` until accepted. */
export async function requestUntilAccepted<T extends RetryableResponse>(
  request: () => Promise<T>,
): Promise<T> {
  for (;;) {
    const response = await request();
    if (response.status() !== 429) return response;
    await sleep(retryDelayMs(response));
  }
}
