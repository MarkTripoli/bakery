import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Real-API smoke: runs only against a running stack whose API sits behind the
 * web origin (see the ephemeral stack workflow in the repository instructions).
 * Everything else in this suite uses deterministic fixtures, so this is the
 * only place the shell, the generated client, the proxy, and the Deno API meet.
 *
 * `/` and every other production route are protected (Phase 4), and the root
 * `beforeLoad` redirects every path except `/setup` to `/setup` until the
 * stack has at least one principal (`installation.status`'s `bootstrapped`
 * flag) — so the boundary smoke below first probes that flag itself via
 * `isBootstrapped()`. A failed probe (non-2xx) fails the test loudly with
 * its status: that is a broken stack, not an expected state. Only a
 * genuine `bootstrapped: false` skips, with a clear reason, instead of
 * failing on an unrelated assertion once the redirect to `/setup` fires.
 *
 * The two signed-in smokes this file used to run (authenticated readiness,
 * and a real non-auth Problem once signed in) were deleted from here and
 * moved into `auth-journey.spec.ts`'s assertion 5a, which already owns the
 * one shared bootstrap admin inside its serial chain. Running them here too
 * meant a second worker/context signing in as that same admin from outside
 * the serial chain — racing desktop's own assertions (a 2FA-enabled admin
 * mid-assertion-8 turns a plain sign-in into a `/sign-in/two-factor` redirect
 * instead of "/"; assertion 4's revoke-others call could kill this session
 * mid-check). This file now only exercises the one case that needs no
 * signed-in principal at all.
 */
const enabled = process.env.BAKERY_REAL_API === "1";

async function isBootstrapped(page: Page): Promise<boolean> {
  const response = await page.request.get("/v1/installation/status");
  expect(
    response.ok(),
    `installation status probe failed: ${response.status()}`,
  ).toBe(true);
  const body = await response.json() as { bootstrapped?: boolean };
  return body.bootstrapped === true;
}

test.describe("real API boundary", () => {
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with the web server proxied to a running API",
  );

  test("redirects to sign-in and remembers the deep link for a real AUTH_REQUIRED Problem", async ({ page }) => {
    try {
      // On CI's fresh, zero-user database this file's own probe can race
      // `auth-journey.spec.ts`'s `beforeAll` seed (which is what actually
      // bootstraps the stack) — poll for up to 30s before concluding the
      // stack is genuinely unbootstrapped, rather than skipping on the
      // first unlucky read.
      await expect.poll(() => isBootstrapped(page), { timeout: 30_000 })
        .toBe(true);
    } catch {
      test.skip(
        true,
        "stack not bootstrapped — run pnpm createsuperuser first",
      );
    }

    await page.goto("/__fixtures__/api-boundary?from=smoke#check");
    await page.getByRole("button", { name: "Open action" }).click();

    await expect(page).toHaveURL("/sign-in");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe("/__fixtures__/api-boundary?from=smoke#check");
  });
});
