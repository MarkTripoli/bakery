import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockBootstrappedInstallation,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";

registerPageHealth(test);

test.describe("protected scope and auth boundary", () => {
  test("redirects the Settings index to Profile", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await firstRender(
      () => page.goto("/settings"),
      (timeout) => expect(page).toHaveURL("/settings/profile", { timeout }),
    );
    await expect(
      page.locator('nav.bakery-application-rail a[aria-current="page"]'),
    ).toHaveText("Settings");
    await expect(
      page.locator(
        '.bakery-section-navigation a[aria-current="page"][href="/settings/profile"]',
      ),
    ).toHaveCount(1);
  });

  test("partitions the protected cache when organization identity changes", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.goto("/__fixtures__/cache-scope");
    // This route has no `requireSession` guard (`router.tsx`) — the
    // bootstrapped-only mock above exists solely so a *fresh* database
    // (`bootstrapped:false`) doesn't bounce this `page.goto` to `/setup`
    // before the fixture ever renders; identity itself resolves against the
    // real backend, unmocked, and its starting generation is genuinely
    // lane-dependent: in the fixtures lane (no backend behind the proxy)
    // `/v1/me` fails as a transport error, `identity()` returns early
    // without a resolved session, and `QueryScopeController.reset()` never
    // fires — generation stays `0`. Against the real API
    // (`BAKERY_REAL_API=1`) the very first resolved session — authenticated
    // or anonymous alike — resets the scope exactly once
    // (`session.ts:125-137`), so generation starts at `1`. Asserting the
    // delta across the two organization switches below proves the same
    // partition claim in both lanes without hard-coding either start value.
    const generation = page.getByTestId("cache-scope-generation");
    const initialGeneration = Number(
      (await generation.innerText()).replace("sessionGeneration=", ""),
    );
    await expect(page.getByTestId("cache-scope-value"))
      .toHaveText("tasks for no organization");

    await page.getByTestId("switch-organization-Northwind").click();
    await expect(generation).toHaveText(
      `sessionGeneration=${initialGeneration + 1}`,
    );
    await expect(page.getByTestId("cache-scope-value"))
      .toHaveText("tasks for Northwind");

    await page.getByTestId("switch-organization-Contoso").click();
    await expect(generation).toHaveText(
      `sessionGeneration=${initialGeneration + 2}`,
    );
    await expect(page.getByTestId("cache-scope-value"))
      .toHaveText("tasks for Contoso");
    await expect(page.getByText("Current organization: Contoso")).toBeVisible();
  });

  test("preserves the deep link for an AUTH_REQUIRED Problem", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.route(
      "**/api/auth/organization/get-invitation*",
      (route) =>
        route.fulfill({
          status: 401,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify({
            type: "https://bakery.example/problems/auth-required",
            title: "Authentication required",
            status: 401,
            detail: "Authentication is required.",
            code: "AUTH_REQUIRED",
            requestId: "00000000-0000-4000-8000-000000000124",
            traceId: "00000000-0000-4000-8000-000000000125",
            retryable: false,
          }),
        }),
    );

    await page.goto("/__fixtures__/api-boundary?from=deep#section");
    await page.getByRole("button", { name: "Open action" }).click();
    await expect(page).toHaveURL("/sign-in");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe("/__fixtures__/api-boundary?from=deep#section");
  });

  test("reports transport failure without inventing a Problem", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.route(
      "**/api/auth/organization/get-invitation*",
      (route) => route.abort("connectionrefused"),
    );
    await page.goto("/__fixtures__/api-boundary");
    await page.getByRole("button", { name: "Open action" }).click();
    await expect(page.getByTestId("api-boundary-error"))
      .toContainText("Bakery could not reach the service.");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
  });
});
