import { expect, test } from "@playwright/test";
import { mockBootstrappedInstallation } from "./helpers/mock-session.ts";
import { revealShellNavigation } from "./helpers/shell-navigation.ts";

const AUTH_REQUIRED_PROBLEM = {
  type: "https://bakery.example/problems/auth-required",
  title: "Authentication required",
  status: 401,
  detail: "Authentication is required.",
  code: "AUTH_REQUIRED",
  requestId: "00000000-0000-4000-8000-000000000210",
  traceId: "00000000-0000-4000-8000-000000000211",
  retryable: false,
};

const AUTH_FORBIDDEN_PROBLEM = {
  type: "https://bakery.example/problems/auth-forbidden",
  title: "Forbidden",
  status: 403,
  detail: "This principal cannot access any organization.",
  code: "AUTH_FORBIDDEN",
  requestId: "00000000-0000-4000-8000-000000000212",
  traceId: "00000000-0000-4000-8000-000000000213",
  retryable: false,
};

/**
 * Fixtures-lane proof that a protected route is actually guarded end to end:
 * without this spec, `requireSession` could be deleted and every existing
 * fixtures-lane spec would still pass, since the dev server has no backend
 * and `identity()` fails "unknown" (which is allowed through by design).
 * Mocking `/v1/me` lets an anonymous `AUTH_REQUIRED` Problem reach the guard
 * even with no real API behind the dev server.
 */
test.describe("route guard", () => {
  test("redirects a protected settings page to sign-in and remembers the deep link", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.route(
      "**/v1/me*",
      (route) =>
        route.fulfill({
          status: 401,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(AUTH_REQUIRED_PROBLEM),
        }),
    );

    await page.goto("/settings/appearance");

    await expect(page).toHaveURL("/sign-in");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe("/settings/appearance");
  });

  // The case above loads `/settings/appearance` directly
  // via `page.goto`, so it never exercises the router's own client-side
  // navigation path — `requireSession`'s `beforeLoad` only ever reads the
  // `location` argument TanStack Router passes it (never
  // `globalThis.location`), so it is correct by construction and not
  // black-box distinguishable from a buggy version through the browser.
  // This case instead proves the guard is actually reached by a real in-app
  // transition (not only a fresh page load): starting on the unguarded
  // `/__fixtures__/api-boundary` fixture and clicking the application
  // rail's real "Settings" link — a genuine client-side router navigation,
  // the same mechanism `section-navigation.spec.ts`/`shell.spec.ts` use —
  // still ends up redirected to sign-in with the destination remembered.
  test("guards a route reached by an in-app client-side transition, not just a direct load", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.route(
      "**/v1/me*",
      (route) =>
        route.fulfill({
          status: 401,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(AUTH_REQUIRED_PROBLEM),
        }),
    );

    await page.goto("/__fixtures__/api-boundary");
    await revealShellNavigation(page);
    await page.getByRole("link", { name: "Settings", exact: true }).click();

    await expect(page).toHaveURL("/sign-in");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe("/settings/profile");
  });

  // Complements the loop-guard case below by proving the
  // forward half of the same three-action `AUTH_FORBIDDEN` handling — a
  // forbidden session caught on a route *other than* `/organizations`
  // actually navigates there with `?reason=forbidden` and forgets the
  // stale organization preference (`handleForbidden`'s `clear()`), not
  // just that a second hit on `/organizations` itself doesn't loop.
  // Deleting `ProtectedRouteError`'s forbidden branch, its navigate call,
  // or `handleForbidden` fails this case while leaving the loop-guard case
  // below green.
  test("navigates to /organizations?reason=forbidden when a forbidden session is caught elsewhere", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    // The startup gate holds a page until the organization is known (#343),
    // so the lookup answers: the page then renders and its own `/v1/me`
    // check is the forbidden one this case is about. The list names the
    // organization until the page has forgotten the stale preference: from
    // then on the session is forbidden, so the list is too.
    const organizationId = "00000000-0000-4000-8000-0000000000a1";
    await page.route(
      "**/v1/organizations",
      async (route) =>
        route.request().method() !== "GET"
          ? route.continue()
          // Once the stale preference has been forgotten (the forbidden
          // handling ran), the session is forbidden and so is the list.
          : await page.evaluate(() =>
              localStorage.getItem("bakery.organization.lastSelected.v1") ===
                null
            ).catch(() => false)
          ? route.fulfill({
            status: 403,
            headers: { "content-type": "application/problem+json" },
            body: JSON.stringify(AUTH_FORBIDDEN_PROBLEM),
          })
          : route.fulfill({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              items: [{
                id: organizationId,
                name: "Org A",
                slug: "org-a",
                logo: null,
                defaultLocale: null,
                metadata: {},
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                version: 1,
                role: "admin",
              }],
              nextCursor: null,
            }),
          }),
    );
    await page.addInitScript((id) => {
      localStorage.setItem("bakery.organization.lastSelected.v1", id);
    }, organizationId);
    await page.route(
      "**/v1/me*",
      (route) =>
        route.fulfill({
          status: 403,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(AUTH_FORBIDDEN_PROBLEM),
        }),
    );

    await page.goto("/settings/appearance");

    await expect(page).toHaveURL("/organizations?reason=forbidden");
    await expect(page.getByTestId("forbidden-state")).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() =>
        localStorage.getItem("bakery.organization.lastSelected.v1")
      )
    ).toBeNull();
  });

  // This is the fixtures-lane half of the guard: the plan's three
  // `AUTH_FORBIDDEN` actions (`clear()`, `setIdentity(null)`, navigate to
  // `/organizations?reason=forbidden`) are guarded against a navigate loop by
  // `pathname !== ORGANIZATIONS_PATH` in `ProtectedRouteError`
  // (`auth-required.tsx`). The literal case named in the fix brief — mock the
  // `/organizations` *list* query itself to 403 — cannot reach that guard:
  // `OrganizationsPage` catches its own `listOrganizations` failure locally
  // (sets its own `organizations-error` state) and never throws to the
  // route's `errorComponent`, in this codebase or any other production page
  // (verified: no page uses a throwing/suspense query). The only production
  // path that ever reaches `ProtectedRouteError`'s `AUTH_FORBIDDEN` branch is
  // `requireSession` seeing a `forbidden` session status from `/v1/me`
  // itself, so that is what this case drives, landing directly on
  // `/organizations` (already the "second/current" route) to prove the
  // guard suppresses the navigate rather than looping.
  test("stays on /organizations without looping when the session itself is forbidden", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.route(
      "**/v1/me*",
      (route) =>
        route.fulfill({
          status: 403,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(AUTH_FORBIDDEN_PROBLEM),
        }),
    );

    await page.goto("/organizations");

    await expect(page.getByTestId("forbidden-state")).toBeVisible();
    await expect(page).toHaveURL("/organizations");
  });
});
