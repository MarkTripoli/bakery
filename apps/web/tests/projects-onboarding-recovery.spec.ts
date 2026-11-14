import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

// Denial/reconnect fixture only: the real shared page, resolver and auth
// routes run unchanged. This is not live repository/onboarding acceptance.
// A repository's setup page: the page without a repository is the Projects list.
const REPOSITORY = "00000000-0000-4000-8000-000000000102";
const path =
  `/projects/onboarding?repository=${REPOSITORY}&source=bookmark#repositories`;
const returnKey = "bakery.auth.returnTo.v1";
const preferenceKey = "bakery.organization.lastSelected.v1";
const organizationId = "00000000-0000-4000-8000-000000000003";

async function fixture(page: Page) {
  const errors: string[] = [];
  const protectedReads: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/v1\/(applications|repositories)(?:\/|$)/.test(pathname)) {
      protectedReads.push(pathname);
    }
  });
  await mockAuthenticatedSession(page);
  for (const resource of ["applications", "repositories"]) {
    await page.route(`**/v1/${resource}*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      }));
  }
  return { errors, protectedReads };
}

async function deny(page: Page, status: number, code: string) {
  await page.route("**/v1/organizations", (route) =>
    route.fulfill({
      status,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: code,
        status,
        code,
        detail: `Stubbed ${code}.`,
        requestId: "00000000-0000-4000-8000-000000000301",
        traceId: "00000000-0000-4000-8000-000000000302",
        retryable: false,
      }),
    }));
}

async function savedDestination(page: Page) {
  return await page.evaluate((key) => sessionStorage.getItem(key), returnKey);
}

test.describe("projects onboarding scope recovery", () => {
  for (const failure of ["500", "network"] as const) {
    test(`keeps the destination and retries ${failure} before protected reads`, async ({ page }) => {
      const observed = await fixture(page);
      let requests = 0;
      await page.route("**/v1/organizations", (route) => {
        requests += 1;
        return failure === "network" ? route.abort("failed") : route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Unavailable",
            status: 500,
            code: "INTERNAL_ERROR",
            detail: "Stubbed outage.",
            requestId: "00000000-0000-4000-8000-000000000301",
            traceId: "00000000-0000-4000-8000-000000000302",
            retryable: false,
          }),
        });
      });
      await page.goto(path);
      await expect(page.getByTestId("startup-error")).toBeVisible();
      if (failure === "network") {
        await expect(page.getByTestId("startup-error")).toContainText(
          "You are offline",
        );
      }
      expect(new URL(page.url()).pathname).toBe("/projects/onboarding");
      expect(observed.protectedReads).toEqual([]);
      expect(observed.errors).toEqual([]);
      const failedRequests = requests;
      await page.waitForTimeout(200);
      expect(requests).toBe(failedRequests);
      // Restore the stated sole-membership fixture, not a replacement page.
      await page.unroute("**/v1/organizations");
      await mockAuthenticatedSession(page);
      await page.getByRole("button", { name: "Try again", exact: true })
        .click();
      // The dev root runs StrictMode: each read mounts, aborts, then remounts,
      // so recovery reads each endpoint exactly twice (the two lists, and the
      // repository the address names) and nothing else, and no further read
      // follows once the page has settled.
      await expect.poll(() => observed.protectedReads.length).toBe(6);
      await page.waitForTimeout(500);
      expect([...observed.protectedReads].sort()).toEqual([
        "/v1/applications",
        "/v1/applications",
        "/v1/repositories",
        "/v1/repositories",
        `/v1/repositories/${REPOSITORY}`,
        `/v1/repositories/${REPOSITORY}`,
      ]);
      await expect(page.getByTestId("startup-error")).toHaveCount(0);
      expect(new URL(page.url()).search + new URL(page.url()).hash).toBe(
        `?repository=${REPOSITORY}&source=bookmark#repositories`,
      );
      expect(await savedDestination(page)).toBeNull();
      expect(observed.errors).toEqual([]);
    });
  }

  for (
    const [status, code, action, destination] of [
      [401, "AUTH_REQUIRED", "Sign in", "/sign-in"],
      [401, "AUTH_EXPIRED", "Sign in", "/sign-in?reason=expired"],
      [401, "AUTH_INVALID", "Sign in", "/sign-in?reason=expired"],
      [
        403,
        "AUTH_FACTOR_REQUIRED",
        "Verify and sign in",
        "/sign-in/two-factor",
      ],
      [
        403,
        "AUTH_FORBIDDEN",
        "Where are we working?",
        "/organizations?reason=forbidden",
      ],
    ] as const
  ) {
    test(`classifies ${code} and preserves the protected destination`, async ({ page }) => {
      const observed = await fixture(page);
      await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [
        preferenceKey,
        organizationId,
      ]);
      await deny(page, status, code);
      await page.goto(path);
      await expect(page.getByTestId("startup-error")).toBeVisible();
      expect(observed.protectedReads).toEqual([]);
      expect(observed.errors).toEqual([]);
      await page.getByTestId("startup-error").getByRole("button", {
        name: action,
        exact: true,
      }).click();
      await expect.poll(() =>
        new URL(page.url()).pathname + new URL(page.url()).search
      ).toBe(destination);
      expect(await savedDestination(page)).toBe(path);
      if (code === "AUTH_FORBIDDEN") {
        expect(
          await page.evaluate(
            (key) => localStorage.getItem(key),
            preferenceKey,
          ),
        ).toBeNull();
      }
      expect(observed.protectedReads).toEqual([]);
      expect(observed.errors).toEqual([]);
    });
  }

  test("factor denial offers backup-code recovery without losing the destination", async ({ page }) => {
    const observed = await fixture(page);
    await deny(page, 403, "AUTH_FACTOR_REQUIRED");
    await page.goto(path);
    await page.getByRole("link", { name: "Use a backup code" }).click();
    await expect(page).toHaveURL(/\/sign-in\/recovery-code$/);
    expect(await savedDestination(page)).toBe(path);
    expect(observed.protectedReads).toEqual([]);
    expect(observed.errors).toEqual([]);
  });

  test("silently aborts late resolution on escape without scope or destination writes", async ({ page }) => {
    const observed = await fixture(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route("**/v1/organizations", async (route) => {
      requests += 1;
      await pending;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: organizationId,
            name: "Late Org",
            slug: "late-org",
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
      });
    });
    await page.goto(path);
    await expect.poll(() => requests).toBeGreaterThan(0);
    // Client-side escape keeps the same runtime, so an uncaught abort cannot
    // disappear with the old document as it would with page.goto().
    await page.evaluate(() => {
      history.pushState({}, "", "/sign-in");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("button", { name: "Sign in", exact: true }))
      .toBeVisible();
    release();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/sign-in");
    expect(await savedDestination(page)).toBeNull();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), preferenceKey),
    ).toBeNull();
    expect(observed.protectedReads).toEqual([]);
    expect(observed.errors).toEqual([]);
  });
  test("same-path replacement aborts the old membership and remembers only the new destination", async ({ page }) => {
    const observed = await fixture(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replaced = false;
    let requests = 0;
    await page.route("**/v1/organizations", async (route) => {
      requests += 1;
      if (replaced) {
        await route.fulfill({
          status: 401,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "AUTH_REQUIRED",
            status: 401,
            code: "AUTH_REQUIRED",
            detail: "Stubbed replacement denial.",
            requestId: "00000000-0000-4000-8000-000000000301",
            traceId: "00000000-0000-4000-8000-000000000302",
            retryable: false,
          }),
        });
        return;
      }
      await pending;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: organizationId,
            name: "Old Org",
            slug: "old-org",
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
      });
    });
    await page.goto(path);
    await expect.poll(() => requests).toBeGreaterThan(0);
    replaced = true;
    const replacement =
      `/projects/onboarding?repository=${REPOSITORY}&source=replacement#current`;
    await page.evaluate((destination) => {
      history.pushState({}, "", destination);
      dispatchEvent(new PopStateEvent("popstate"));
    }, replacement);
    await expect(page.getByTestId("startup-error")).toContainText(
      "Sign in required",
    );
    release();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("startup-error")).toContainText(
      "Sign in required",
    );
    expect(await savedDestination(page)).toBeNull();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), preferenceKey),
    ).toBeNull();
    expect(observed.protectedReads).toEqual([]);
    await page.getByTestId("startup-error").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(await savedDestination(page)).toBe(replacement);
    expect(observed.protectedReads).toEqual([]);
    expect(observed.errors).toEqual([]);
  });
});
