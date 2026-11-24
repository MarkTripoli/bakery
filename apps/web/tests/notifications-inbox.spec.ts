import { expect, test } from "@playwright/test";
import {
  inboxFixture,
  inboxRowId,
  inboxRowSelector,
} from "./helpers/inbox-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: notifications page`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const rowsOf = (page: import("@playwright/test").Page) =>
      page.locator("[data-ui-component=notificationRow]");

    test("Show more adds the next rows under the ones already read", async ({ page }) => {
      await inboxFixture(page);
      await page.goto("/notifications");
      await expect(rowsOf(page)).toHaveCount(30);
      await page.getByRole("button", { name: "Show more" }).click();
      await expect(rowsOf(page)).toHaveCount(60);
      await expect(page.locator(inboxRowSelector(0))).toBeVisible();
      await page.getByRole("button", { name: "Show more" }).click();
      await expect(rowsOf(page)).toHaveCount(70);
      await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(
        0,
      );
    });

    test("marking a row read changes it and the Unread count at once", async ({ page }) => {
      const { calls } = await inboxFixture(page);
      await page.goto("/notifications");
      await expect(page.getByRole("tab", { name: "Unread (3)" })).toBeVisible();
      await page.locator(inboxRowSelector(0)).getByRole("button", {
        name: "More for this notification",
      }).click();
      await page.getByRole("button", { name: "Mark read" }).click();
      await expect(page.getByRole("tab", { name: "Unread (2)" })).toBeVisible();
      expect(calls.patches).toHaveLength(1);
    });

    test("the row menu has one item: Mark read on an unread row, Mark unread on a read one", async ({ page }) => {
      await inboxFixture(page);
      await page.goto("/notifications");
      await page.locator(inboxRowSelector(0)).getByRole("button", {
        name: "More for this notification",
      }).click();
      await expect(page.getByRole("button", { name: "Mark read" })).toHaveCount(
        1,
      );
      await expect(page.getByRole("button", { name: "Mark unread" }))
        .toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.locator(inboxRowSelector(5)).getByRole("button", {
        name: "More for this notification",
      }).click();
      await expect(page.getByRole("button", { name: "Mark unread" }))
        .toHaveCount(
          1,
        );
      await page.mouse.move(700, 800);
      await still(page, "notifications-row-menu");
    });

    test("a row never prints an anchor: a step reads A step failed, a version reads Version 3", async ({ page }) => {
      await inboxFixture(page, { unavailable: [8] });
      await page.goto("/notifications");
      await expect(page.getByText("A step failed", { exact: true }).first())
        .toBeVisible();
      await expect(page.getByText("Task 2", { exact: true })).toBeVisible();
      await expect(page.getByText("Task 3 · Version 3")).toBeVisible();
      await expect(page.getByText("step:")).toHaveCount(0);
      await expect(page.getByText("version:")).toHaveCount(0);
      const unavailable = page.locator(inboxRowSelector(8));
      await expect(unavailable.getByText("No longer available")).toBeVisible();
      await expect(unavailable.getByText(/Version \d/)).toHaveCount(0);
      await page.mouse.move(700, 800);
      await still(page, "notifications-row-words");
    });

    test("a row that could not be saved says so", async ({ page }) => {
      await inboxFixture(page, { failRead: true });
      await page.goto("/notifications");
      await page.locator(inboxRowSelector(0)).getByRole("button", {
        name: "More for this notification",
      }).click();
      await page.getByRole("button", { name: "Mark read" }).click();
      await expect(page.getByText("That could not be saved. Try again."))
        .toBeVisible();
    });

    test("Mark all read offers Undo for ten seconds and Undo restores exactly what it marked", async ({ page }) => {
      const { calls } = await inboxFixture(page);
      await page.goto("/notifications");
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(page.getByText("Marked 3 read.")).toBeVisible();
      await expect(page.getByRole("tab", { name: "Unread", exact: true }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "notifications-undo-toast");
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("Restored 3 notifications to unread."))
        .toBeVisible();
      await expect(page.getByRole("tab", { name: "Unread (3)" })).toBeVisible();
      expect(calls.undo).toHaveLength(1);
    });

    test("offline, the list says it may be out of date", async ({ page, context }) => {
      await inboxFixture(page);
      await page.goto("/notifications");
      await expect(rowsOf(page).first()).toBeVisible();
      await context.setOffline(true);
      await expect(
        page.getByText("You are offline. This list may be out of date."),
      ).toBeVisible({ timeout: 20000 });
    });

    test("an address with ?item= scrolls to that row and outlines it", async ({ page }) => {
      await inboxFixture(page);
      await page.goto(`/notifications?item=${inboxRowId(25)}`);
      await expect(page.locator(inboxRowSelector(25))).toBeInViewport();
      await expect(page.locator(inboxRowSelector(25))).toHaveAttribute(
        "data-highlighted",
        "true",
      );
      await expect(page.locator(inboxRowSelector(25))).not.toHaveAttribute(
        "data-highlighted",
        "true",
        { timeout: 10000 },
      );
    });

    test("times read in words from the translations", async ({ page }) => {
      await inboxFixture(page);
      await page.goto("/notifications");
      await expect(page.getByText("5 min ago").first()).toBeVisible();
      await expect(page.getByText("45 min ago").first()).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "notifications-all");
    });

    test("an item that is gone puts Back to notifications first, with Mark read beside it", async ({ page }) => {
      const { calls } = await inboxFixture(page, { targetGone: true });
      await page.goto(`/notifications?open=${inboxRowId(0)}&r=1`);
      const back = page.getByRole("button", { name: "Back to notifications" });
      await expect(back).toBeVisible();
      const markRead = page.getByRole("button", { name: "Mark read" });
      await expect(markRead).toBeVisible();
      const [backBox, markBox] = await Promise.all([
        back.boundingBox(),
        markRead.boundingBox(),
      ]);
      expect(backBox!.x).toBeLessThan(markBox!.x);
      await still(page, "notifications-gone");
      await markRead.click();
      await expect(page.getByText("Marked read.")).toBeVisible();
      expect(calls.patches).toHaveLength(1);
    });

    test("Back from an opened row returns to the rows already read, where they were", async ({ page }) => {
      await inboxFixture(page, { targetGone: true });
      await page.goto("/notifications");
      await page.getByRole("button", { name: "Show more" }).click();
      await expect(rowsOf(page)).toHaveCount(60);
      const row = page.locator(inboxRowSelector(45));
      await row.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => globalThis.scrollY);
      await row.getByRole("link").first().click();
      await expect(
        page.getByRole("button", { name: "Back to notifications" }),
      ).toBeVisible();
      await page.goBack();
      await expect(rowsOf(page)).toHaveCount(60);
      await expect(page.locator(inboxRowSelector(45))).toBeInViewport();
      const after = await page.evaluate(() => globalThis.scrollY);
      expect(Math.abs(after - before)).toBeLessThan(200);
    });
  });
}
