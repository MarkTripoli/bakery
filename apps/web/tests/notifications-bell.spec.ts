import { expect, type Page, test } from "@playwright/test";
import {
  INBOX_PRINCIPAL_ID,
  inboxFixture,
  inboxStream,
} from "./helpers/inbox-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const popoverOf = (page: Page) =>
  page.locator('[data-ui-component="notificationPopover"]');

const bell = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name });

test.describe("desktop: bell and popover", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the badge reads 99+ from 100 and 99 at 99, and the name keeps the true count", async ({ page }) => {
    await inboxFixture(page, { total: 120, unread: 100 });
    await page.goto("/notifications");
    const full = bell(page, "Notifications, 100 unread");
    await expect(full).toBeVisible();
    await expect(full).toContainText("99+");
  });

  test("at 99 unread the badge reads 99 exactly", async ({ page }) => {
    await inboxFixture(page, { total: 120, unread: 99 });
    await page.goto("/notifications");
    const nearly = bell(page, "Notifications, 99 unread");
    await expect(nearly).toBeVisible();
    await expect(nearly).not.toContainText("+");
  });

  test("with nothing unread the name says so", async ({ page }) => {
    await inboxFixture(page, { unread: 0 });
    await page.goto("/notifications");
    await expect(bell(page, "Notifications, none unread")).toBeVisible();
  });

  test("Mark all read in the popover acts in place, and its toast outlives the popover", async ({ page }) => {
    const { calls } = await inboxFixture(page);
    await page.goto("/notifications?view=mentions");
    await bell(page, "Notifications, 3 unread").click();
    await page.mouse.move(40, 800);
    await still(page, "bell-popover");
    const popover = popoverOf(page);
    await popover.getByRole("button", { name: "Mark all read" }).click();
    const noneUnread = bell(page, "Notifications, none unread");
    await expect(noneUnread).toBeVisible();
    await expect(popover).toHaveCount(0);
    await expect(noneUnread).toBeFocused();
    await expect(page.getByText("Marked 3 read.")).toBeVisible();
    await page.mouse.move(40, 800);
    await still(page, "bell-popover-success-toast");
    await noneUnread.click();
    await expect(popover.getByText("You're all caught up.")).toBeVisible();
    await expect(popover.getByRole("button", { name: "Mark all read" }))
      .toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Restored 3 notifications to unread."))
      .toBeVisible();
    await expect(bell(page, "Notifications, 3 unread")).toBeVisible();
    expect(calls.markAll).toHaveLength(1);
    expect(calls.undo).toHaveLength(1);
    expect(new URL(page.url()).searchParams.get("view")).toBe("mentions");
  });

  test("a failed Mark all read says so above the rows it could not mark, and Try again sends it again", async ({ page }) => {
    const { calls } = await inboxFixture(page, { failMarkAll: true });
    await page.goto("/notifications");
    await bell(page, "Notifications, 3 unread").click();
    const popover = popoverOf(page);
    await expect(popover.getByText("Task 0", { exact: true })).toBeVisible();
    await expect(popover.getByText("Task 5", { exact: true })).toHaveCount(0);
    await popover.getByRole("button", { name: "Mark all read" }).click();
    await expect(popover.getByText("Could not mark all as read."))
      .toBeVisible();
    await expect(page.getByText("Could not mark all as read.")).toHaveCount(1);
    await expect(popover.getByText("Notifications could not load."))
      .toHaveCount(0);
    await expect(popover.getByText("Task 0", { exact: true })).toBeVisible();
    await page.mouse.move(40, 800);
    await still(page, "bell-popover-failed");
    await popover.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => calls.markAll.length).toBe(2);
    await expect(popover.getByText("Task 0", { exact: true })).toBeVisible();
  });

  test("a popover list that could not load says so and Try again reloads it", async ({ page }) => {
    const { control } = await inboxFixture(page, { failList: true });
    await page.goto("/tasks");
    await bell(page, /^Notifications/).click();
    const popover = popoverOf(page);
    await expect(popover.getByText("Notifications could not load."))
      .toBeVisible();
    control.failList = false;
    await popover.getByRole("button", { name: "Try again" }).click();
    await expect(popover.getByText("Task 0")).toBeVisible();
  });

  test("a notifications.inbox_changed signal updates the count and the list without a reload", async ({ page }) => {
    const { rows } = await inboxFixture(page);
    const stream = await inboxStream(page);
    await page.goto("/notifications");
    await expect(page.getByRole("tab", { name: "Unread (3)" })).toBeVisible();
    expect(stream.subscribes[0]?.scopes).toEqual([
      { type: "inbox", id: INBOX_PRINCIPAL_ID },
    ]);
    rows[10].read = false;
    stream.push();
    await expect(page.getByRole("tab", { name: "Unread (4)" })).toBeVisible();
    await expect(bell(page, "Notifications, 4 unread")).toBeVisible();
  });
});

test.describe("phone: bell", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the bell is a link into the inbox that does not reload the app", async ({ page }) => {
    await inboxFixture(page);
    await page.goto("/tasks");
    await page.evaluate(() => {
      (globalThis as unknown as { keep: boolean }).keep = true;
    });
    await bell(page, "Notifications, 3 unread").click();
    await expect(page).toHaveURL(/\/notifications$/);
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { keep?: boolean }).keep
      ),
    ).toBe(true);
  });
});
