import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { openAccountMenu } from "./helpers/shell-navigation.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * Startup (design-ux, #312): a page's content waits until the organization is
 * known, shows its skeleton only when that takes over 200 ms, renders once, and
 * is never torn down by a later reload. Edits made in a form survive a
 * background reload, and leaving for another organization with unsaved input
 * asks first.
 */

const organization = {
  id: MOCK_ORGANIZATION_ID,
  name: "Fixture Org",
  slug: "fixture-org",
  logo: null,
  defaultLocale: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  role: "admin",
};

const profile = (name: string, version: number) => ({
  principalId: "00000000-0000-4000-8000-000000000001",
  name,
  firstName: "Mark",
  lastName: "Tripoli",
  title: null,
  image: null,
  email: "me@marktripoli.com",
  emailVerified: true,
  version,
  updatedAt: "2026-01-02T00:00:00.000Z",
});

/** How the organization lookup behaves; mutate it while the page runs. */
type Lookup = { delayMs: number; failing: boolean; requests: number };

async function stubOrganizations(page: Page, lookup: Lookup) {
  await page.route("**/v1/organizations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    lookup.requests += 1;
    if (lookup.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, lookup.delayMs));
    }
    if (lookup.failing) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/INTERNAL_ERROR",
          title: "INTERNAL_ERROR",
          detail: "INTERNAL_ERROR",
          status: 500,
          code: "INTERNAL_ERROR",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [organization], nextCursor: null }),
    });
  });
}

async function stubProfile(page: Page, state: { name: string; reads: number }) {
  await page.route("**/v1/me/profile", (route) => {
    if (route.request().method() === "GET") state.reads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(profile(state.name, 3 + state.reads)),
    });
  });
}

/** Records every time the page heading or the startup skeleton enters or leaves the DOM. */
async function watchStartup(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (globalThis as unknown as { __startup: string[] }).__startup = log;
    const note = (kind: string, node: Node) => {
      if (!(node instanceof Element)) return;
      const hits = (selector: string) =>
        node.matches(selector) || node.querySelector(selector) !== null;
      if (hits('[data-testid="startup-skeleton"]')) {
        log.push(`skeleton-${kind}`);
      }
      if (hits("#profile-display-name, [id^='profile-']")) {
        log.push(`content-${kind}`);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => note("added", node));
        record.removedNodes.forEach((node) => note("removed", node));
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

const startupLog = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as { __startup: string[] }).__startup
  );

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: startup`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a slow organization answer shows the skeleton once, then the content once, and never takes it back", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await stubProfile(page, { name: "Mark Tripoli", reads: 0 });
      const lookup: Lookup = { delayMs: 1500, failing: false, requests: 0 };
      await stubOrganizations(page, lookup);
      await watchStartup(page);
      await page.goto("/settings/profile");
      const skeleton = page.getByTestId("startup-skeleton");
      await expect(skeleton).toBeVisible();
      // The content area is busy and holds no page content yet.
      await expect(page.getByTestId("startup-pending")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      await expect(page.getByLabel("Display name")).toHaveCount(0);
      await shot(page, "startup-skeleton");
      await expect(page.getByLabel("Display name")).toBeVisible();
      await expect(skeleton).toHaveCount(0);
      await page.waitForTimeout(400);
      await expect(page.getByLabel("Display name")).toBeVisible();
      const log = await startupLog(page);
      expect(log.filter((entry) => entry === "skeleton-added")).toHaveLength(1);
      expect(log.filter((entry) => entry === "content-added").length)
        .toBeGreaterThan(0);
      // Content appears after the skeleton and nothing is ever removed after it.
      expect(log.indexOf("skeleton-added")).toBeLessThan(
        log.indexOf("content-added"),
      );
      expect(log.slice(log.indexOf("content-added")))
        .not.toContain("content-removed");
    });

    test("a fast organization answer shows no skeleton at all", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await stubProfile(page, { name: "Mark Tripoli", reads: 0 });
      const lookup: Lookup = { delayMs: 0, failing: false, requests: 0 };
      await stubOrganizations(page, lookup);
      await watchStartup(page);
      await page.goto("/settings/profile");
      await expect(page.getByLabel("Display name")).toBeVisible();
      expect(await startupLog(page)).not.toContain("skeleton-added");
      await expect(page.getByTestId("startup-skeleton")).toHaveCount(0);
    });

    test("a long wait says it is taking longer than usual", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await stubProfile(page, { name: "Mark Tripoli", reads: 0 });
      await stubOrganizations(page, {
        delayMs: 9_500,
        failing: false,
        requests: 0,
      });
      await page.goto("/settings/profile");
      await expect(page.getByTestId("startup-skeleton")).toBeVisible();
      const slow = page.getByRole("status").filter({
        hasText: "This is taking longer than usual.",
      });
      await expect(slow).toBeVisible({ timeout: 12_000 });
      await shot(page, "startup-slow");
      await expect(page.getByLabel("Display name")).toBeVisible({
        timeout: 12_000,
      });
    });

    test("a failed organization lookup says so, keeps the shell and recovers with Try again", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await stubProfile(page, { name: "Mark Tripoli", reads: 0 });
      const lookup: Lookup = { delayMs: 0, failing: true, requests: 0 };
      await stubOrganizations(page, lookup);
      await page.goto("/settings/profile");
      const error = page.getByTestId("startup-error");
      await expect(error).toBeVisible();
      await expect(error.getByRole("heading", {
        name: "Bakery could not load your organization",
      })).toBeVisible();
      await expect(error.getByText("Check your connection, then try again."))
        .toBeVisible();
      await expect(error.getByRole("link", { name: "Sign out" })).toBeVisible();
      // The shell stays: the page title bar is still there.
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByLabel("Display name")).toHaveCount(0);
      await shot(page, "startup-organization-error");
      lookup.failing = false;
      await error.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByLabel("Display name")).toBeVisible();
      await expect(error).toHaveCount(0);
    });

    test("typed input survives a background reload of the page's data", async ({ page }) => {
      await mockAuthenticatedSession(page);
      const state = { name: "Mark Tripoli", reads: 0 };
      await stubProfile(page, state);
      await stubOrganizations(page, {
        delayMs: 0,
        failing: false,
        requests: 0,
      });
      await page.goto("/settings/profile");
      const name = page.getByLabel("Display name");
      await expect(name).toHaveValue("Mark Tripoli");
      await name.fill("Mark T.");
      const before = state.reads;
      // The server's copy changes elsewhere and the page reloads in the background.
      state.name = "Mark Tripoli (changed elsewhere)";
      await page.evaluate(() => {
        globalThis.dispatchEvent(new Event("offline"));
        globalThis.dispatchEvent(new Event("online"));
      });
      await expect.poll(() => state.reads).toBeGreaterThan(before);
      await expect(name).toHaveValue("Mark T.");
    });

    test("leaving for another organization with unsaved input asks first, and Stay keeps the input", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await stubProfile(page, { name: "Mark Tripoli", reads: 0 });
      await stubOrganizations(page, {
        delayMs: 0,
        failing: false,
        requests: 0,
      });
      await page.goto("/settings/profile");
      const name = page.getByLabel("Display name");
      await name.fill("Mark T.");
      await (await openAccountMenu(page, "Fixture Admin"))
        .getByRole("button", { name: "Switch organization" }).click();
      const dialog = page.getByRole("alertdialog", {
        name: "Leave without saving?",
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Your changes on this page will be lost."))
        .toBeVisible();
      await shot(page, "startup-leave-dialog");
      await dialog.getByRole("button", { name: "Stay" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings\/profile/);
      await expect(name).toHaveValue("Mark T.");
      // Leaving on purpose goes through.
      await (await openAccountMenu(page, "Fixture Admin"))
        .getByRole("button", { name: "Switch organization" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Leave" })
        .click();
      await expect(page).toHaveURL(/\/organizations/);
    });
  });
}
