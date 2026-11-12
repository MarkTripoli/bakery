import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * One focus rule for every paged list (design-ux, #202): a keyboard or screen
 * reader user is never left on the page body after a list asks for more.
 *
 *   Load more succeeds, more pages remain  -> the Load more button
 *   Load more succeeds, last page          -> the first row that load added
 *   Load more fails                        -> the control that retries it
 *   Retry succeeds                         -> the button if it is back, else the first new row
 *
 * The audit log and the repository rules History are covered in their own specs.
 */

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

const organization = (index: number) => ({
  id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
  name: `Org ${index}`,
  slug: `org-${index}`,
  logo: null,
  defaultLocale: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  role: "admin",
});

/**
 * Three pages of organizations: `Org 1, Org 2`, then `Org 3, Org 4`, then `Org 5`.
 * `failCursor` makes the first request for that cursor fail once.
 */
async function organizationsFixture(
  page: Page,
  options: { failCursor?: string } = {},
) {
  await mockAuthenticatedSession(page);
  let failures = options.failCursor ? 1 : 0;
  await page.route("**/v1/organizations**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor && cursor === options.failCursor && failures > 0) {
      failures -= 1;
      return route.fulfill(problem(500, "INTERNAL_ERROR"));
    }
    const [items, nextCursor] = cursor === "p2"
      ? [[3, 4], "p3"]
      : cursor === "p3"
      ? [[5], null]
      : [[1, 2], "p2"];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: items.map(organization), nextCursor }),
    });
  });
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: organizations`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("Load more keeps focus on the button while pages remain, then moves it to the first new row", async ({ page }) => {
      await organizationsFixture(page);
      await page.goto("/organizations");
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(page.getByRole("button", { name: /Org 3/ })).toBeVisible();
      // Pages remain: the button that was pressed is the place to be.
      await expect(more).toBeFocused();
      await more.click();
      await expect(page.getByRole("button", { name: /Org 5/ })).toBeVisible();
      await expect(more).toHaveCount(0);
      // The last page: the button is gone, so the first row it added has focus.
      await expect(page.getByRole("button", { name: /Org 5/ })).toBeFocused();
      await shot(page, "organizations-last-page-focus");
    });

    test("a failed Load more puts focus on Retry, and a good Retry puts it back on the button", async ({ page }) => {
      await organizationsFixture(page, { failCursor: "p2" });
      await page.goto("/organizations");
      await page.getByRole("button", { name: "Load more" }).click();
      const retry = page.getByRole("button", { name: "Retry" });
      await expect(retry).toBeVisible();
      await expect(retry).toBeFocused();
      await shot(page, "organizations-retry-focus");
      await retry.click();
      await expect(page.getByRole("button", { name: /Org 3/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Load more" }))
        .toBeFocused();
    });
  });
}

const worker = (index: number) => ({
  id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
  principalId: "00000000-0000-4000-8000-0000000000b0",
  name: `builder-${index}`,
  os: "macos",
  architecture: "arm64",
  capabilities: ["claude"],
  toolchainVersions: {},
  slots: 1,
  status: "online",
  desiredMode: "accepting",
  connectivity: "online",
  readiness: "ready",
  readinessReason: null,
  failedCheckIds: [],
  lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
  credentialGeneration: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});

/**
 * Machines: a chain of twelve one-machine pages. The page collects up to ten
 * pages by itself, so Load more is offered after `builder-10` and reads the
 * rest, `builder-11` and `builder-12`. `failLastPage` fails that request once.
 */
async function machinesFixture(
  page: Page,
  options: { failLastPage?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
  let failures = options.failLastPage ? 1 : 0;
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: "admin",
          capabilities: [],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      const index = cursor ? Number(cursor.slice(1)) : 1;
      if (index === 11 && failures > 0) {
        failures -= 1;
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [worker(index)],
          nextCursor: index < 12 ? `c${index + 1}` : null,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      }),
  );
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: machines`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const added = (page: Page) =>
      viewport.name === "phone"
        ? page.getByRole("listitem").filter({ hasText: "builder-11" })
        : page.getByRole("row").filter({ hasText: "builder-11" });

    test("the last page of machines puts focus on the first machine it added", async ({ page }) => {
      await machinesFixture(page);
      await page.goto("/machines");
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(more).toHaveCount(0);
      await expect(added(page)).toBeFocused();
    });

    test("a failed load of more machines leaves focus on the button that retries it", async ({ page }) => {
      await machinesFixture(page, { failLastPage: true });
      await page.goto("/machines");
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(page.getByText("More records could not be loaded."))
        .toBeVisible();
      await expect(more).toBeFocused();
      await more.click();
      await expect(added(page)).toBeFocused();
    });
  });
}
