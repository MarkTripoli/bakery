import { expect as baseExpect, type Page, test } from "@playwright/test";
import {
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { still } from "./helpers/stills.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: laneBudgetMs(90_000) });
test.use({ timezoneId: "UTC", locale: "en-US" });

// Desktop stills are taken at 1440x900, the size the evidence rule names.
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

// #59 slice 5 (design-ux rev 3): what everyone sees during and after an update
// of the Bakery server. The shell reads the public installation status every
// 15 seconds while the server answers and every 5 while it is away; the clock
// is faked so those reads happen on demand.

const START = new Date("2026-11-22T14:02:00.000Z");

const WORDS = {
  pausedTitle: "Bakery is about to be updated.",
  pausedText: "New work waits and starts by itself afterwards.",
  updatingTitle: "Bakery is being updated",
  updatingText:
    "This usually takes a few minutes. Your work is paused and carries on by itself afterwards. This page reloads when Bakery is back.",
  longer:
    "This is taking longer than usual. If it lasts, tell whoever runs your Bakery server.",
  updated: "Bakery was updated.",
  notUpdated: "Bakery is back. The update did not go through.",
  held: "Bakery is held after a restore.",
};

type World = {
  paused: boolean;
  held: boolean;
  release: string;
  /** The server does not answer at all. */
  away: boolean;
  /** Pages the server does not answer yet, though it answers others. */
  stillAway: Set<Page>;
};

async function updateWorld(
  page: Page,
  overrides: Partial<World> = {},
  shared?: World,
): Promise<World> {
  const world: World = shared ?? {
    paused: false,
    held: false,
    release: "bakery@1111111",
    away: false,
    stillAway: new Set(),
    ...overrides,
  };
  const away = () => world.away || world.stillAway.has(page);
  await page.clock.install({ time: START });
  await mockAuthenticatedSession(page);
  await page.route(
    "**/v1/me/profile",
    (route) =>
      away() ? route.abort("connectionrefused") : route.fulfill({
        json: {
          principalId: MOCK_PRINCIPAL_ID,
          name: "Alex Morgan",
          firstName: "Alex",
          lastName: "Morgan",
          title: null,
          image: null,
          email: "alex.morgan@example.com",
          emailVerified: true,
          version: 3,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
  );
  // Registered last, so it wins over the session helper's status route.
  await page.route(
    "**/v1/installation/status",
    (route) =>
      away() ? route.abort("connectionrefused") : route.fulfill({
        json: {
          bootstrapped: true,
          restoreHeld: world.held,
          updatePaused: world.paused,
          release: world.release,
        },
      }),
  );
  return world;
}

const open = async (page: Page) => {
  await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Display name")).toBeVisible();
};
/** Lets the shell's next status read happen. */
const nextRead = (page: Page, ms = 15_000) => page.clock.runFor(ms);

const bar = (page: Page) => page.locator('[data-ui-region="update-paused"]');
const updating = (page: Page) => page.getByTestId("updating-page");
const announcement = (page: Page) => page.getByTestId("update-announcement");
const toast = (page: Page) => page.getByTestId("update-toast");

test("before the switch: a bar says Bakery is about to be updated, with nothing to press", async ({ page }) => {
  const world = await updateWorld(page);
  await open(page);
  await expect(bar(page)).toHaveCount(0);
  world.paused = true;
  await nextRead(page);
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveAttribute("role", "status");
  await expect(bar(page)).toContainText(WORDS.pausedTitle);
  await expect(bar(page)).toContainText(WORDS.pausedText);
  await expect(bar(page).getByRole("button")).toHaveCount(0);
  await expect(bar(page).getByRole("link")).toHaveCount(0);
  await expect(page.getByLabel("Display name")).toBeVisible();
  await still(page, "update-paused-bar");
  // The pause is released without a switch: the bar goes with it.
  world.paused = false;
  await nextRead(page);
  await expect(bar(page)).toHaveCount(0);
});

test("a held restore wins the slot over the update bar", async ({ page }) => {
  await updateWorld(page, { paused: true, held: true });
  await open(page);
  await expect(page.locator('[data-ui-region="restore-held"]'))
    .toContainText(WORDS.held);
  await expect(bar(page)).toHaveCount(0);
});

test("away after the pause: the being-updated page, typed text kept, then Bakery was updated once", async ({ page }) => {
  const world = await updateWorld(page, { paused: true });
  await open(page);
  await expect(bar(page)).toBeVisible();
  const name = page.getByLabel("Display name");
  await name.fill("Alex M. typed before the pause");
  world.away = true;
  await nextRead(page);
  await expect(updating(page)).toBeVisible();
  await expect(updating(page).getByRole("heading", { level: 2 }))
    .toHaveText(WORDS.updatingTitle);
  await expect(updating(page)).toContainText(WORDS.updatingText);
  await expect(page.getByTestId("updating-check")).toHaveText(
    /^Started 2:02\sPM · checking again in [1-5] seconds?$/,
  );
  await expect(updating(page).locator("img")).toBeVisible();
  // The page under it is hidden, not gone; the bar is gone with the server.
  await expect(name).toBeHidden();
  await expect(name).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
  // One polite announcement; the countdown is not in any live region.
  await expect(announcement(page)).toHaveText(WORDS.updatingTitle);
  await expect(announcement(page)).toHaveAttribute("aria-live", "polite");
  await expect(page.locator('[aria-live] [data-testid="updating-check"]'))
    .toHaveCount(0);
  await expect(updating(page).locator('[role="status"], [aria-live]'))
    .toHaveCount(0);
  await still(page, "updating");
  // After ten minutes the last line changes.
  await nextRead(page, 10 * 60_000);
  await expect(page.getByTestId("updating-check")).toHaveText(WORDS.longer);
  await still(page, "updating-longer");
  // Back on a new release: the page carries on, the toast says so once.
  world.away = false;
  world.paused = false;
  world.release = "bakery@2222222";
  await nextRead(page, 5_000);
  await expect(updating(page)).toHaveCount(0);
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("Alex M. typed before the pause");
  await expect(toast(page)).toContainText(WORDS.updated);
  await expect(toast(page)).toHaveAttribute("role", "status");
  // The toast is the announcement of the return; the region says nothing more.
  await expect(announcement(page)).toHaveText("");
  await still(page, "toast-updated");
});

test("Bakery was updated is said once per person: a second tab only announces it", async ({ page }) => {
  const world = await updateWorld(page, { paused: true });
  const other = await page.context().newPage();
  await updateWorld(other, {}, world);
  await open(page);
  await open(other);
  await expect(bar(page)).toBeVisible();
  await expect(bar(other)).toBeVisible();
  world.away = true;
  await nextRead(page);
  await nextRead(other);
  await expect(updating(page)).toBeVisible();
  await expect(updating(other)).toBeVisible();
  // The second tab finds the server back only after the first tab has spoken.
  world.stillAway.add(other);
  world.away = false;
  world.paused = false;
  world.release = "bakery@2222222";
  await nextRead(page, 5_000);
  await expect(toast(page)).toContainText(WORDS.updated);
  // Tabs share the browser's storage a moment later, not at once.
  await expect.poll(() =>
    other.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("bakery.updated."))
    )
  ).toBe(true);
  world.stillAway.delete(other);
  await nextRead(other, 5_000);
  await expect(updating(other)).toHaveCount(0);
  await expect(toast(other)).toHaveCount(0);
  await expect(announcement(other)).toHaveText(WORDS.updated);
  await other.close();
});

test("back on the same release: Bakery is back and the update did not go through", async ({ page }) => {
  const world = await updateWorld(page, { paused: true });
  await open(page);
  await expect(bar(page)).toBeVisible();
  world.away = true;
  await nextRead(page);
  await expect(updating(page)).toBeVisible();
  world.away = false;
  world.paused = false;
  await nextRead(page, 5_000);
  await expect(updating(page)).toHaveCount(0);
  await expect(toast(page)).toContainText(WORDS.notUpdated);
  await still(page, "toast-not-updated");
});

test("away with no pause seen first: no being-updated page, the page stays as it was", async ({ page }) => {
  const world = await updateWorld(page);
  await open(page);
  world.away = true;
  await nextRead(page);
  await nextRead(page);
  await expect(updating(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Display name")).toBeVisible();
  await expect(announcement(page)).toHaveText("");
  await still(page, "away-without-pause");
  // Back: nothing to say about an update that never was.
  world.away = false;
  await nextRead(page);
  await expect(toast(page)).toHaveCount(0);
  await expect(announcement(page)).toHaveText("");
});

test("the wrapper around the page has no box of its own until Bakery is being updated", async ({ page }) => {
  const world = await updateWorld(page, { paused: true });
  await open(page);
  // Not updating: the page lays out exactly as if nothing wrapped it, so a
  // child sized by a percentage of the shell's main area still is.
  const cover = page.locator("[data-update-cover]");
  await expect(cover).toHaveCount(1);
  await expect(cover).toHaveCSS("display", "contents");
  world.away = true;
  await nextRead(page);
  await expect(updating(page)).toBeVisible();
  await expect(cover).toHaveAttribute("hidden", "");
  await expect(cover).toHaveCSS("display", "none");
});
