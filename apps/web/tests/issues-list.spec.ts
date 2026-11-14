import { expect, type Page, test } from "@playwright/test";
import {
  issuesFixture,
  OPEN,
  ready,
  type Seed,
  uuid,
} from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Issues list (design-ux, #56): the saved copy of the organization's GitHub
 * issues, one status and one control per row, Can start by default.
 */

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: issues list`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    // A row, on a wide screen or a phone, by the issue it shows.
    const row = (page: Page, number: number) =>
      page.locator(`[data-issue-id="${uuid(number)}"]`);

    test("shows only what can start by default, and everything open under All open, each row with one status and one reason", async ({ page }) => {
      await issuesFixture(page);
      await page.goto("/issues");
      await expect(page.getByRole("heading", { name: "Issues", level: 1 }))
        .toBeVisible();
      await expect(page.getByText(
        "Issues from your connected GitHub repositories, and whether Bakery can start on each.",
      )).toBeVisible();
      await expect(row(page, 201)).toContainText("Can start");
      // Every row's line starts with its repository.
      await expect(row(page, 201)).toContainText("acme/web");
      await expect(row(page, 202)).toHaveCount(0);
      // The age of the saved copy.
      await expect(page.getByText("Updated from GitHub 5 minutes ago"))
        .toBeVisible();
      await page.getByRole("radio", { name: "All open" }).click({
        force: true,
      });
      await expect(row(page, 202)).toContainText("Waiting");
      await expect(row(page, 202)).toContainText(
        "acme/web · Depends on #201, which is still open.",
      );
      await expect(row(page, 203)).toContainText("Cannot start");
      await expect(row(page, 203)).toContainText(
        "acme/web · The issue has no acceptance criteria.",
      );
      await expect(row(page, 204)).toContainText("In progress");
      await expect(row(page, 204)).toContainText(
        "acme/web · Bakery is working on this.",
      );
      await expect(row(page, 205)).toContainText("Not checked");
      await expect(row(page, 205)).toContainText(
        "acme/web · Bakery has not checked this issue yet.",
      );
      // The title is a link to the issue's page, named with its status and reason.
      await expect(
        row(page, 202).getByRole("link", {
          name:
            "#202 Show the export button, Waiting, acme/web · Depends on #201, which is still open.",
        }),
      ).toHaveAttribute("href", `/issues/${uuid(202)}`);
      // The title keeps the strong text colour it had before it became a link.
      const ink = (locator: ReturnType<typeof page.locator>) =>
        locator.evaluate((node) => getComputedStyle(node).color);
      expect(
        await ink(row(page, 201).getByRole("link")),
      ).toBe(
        await ink(page.getByRole("heading", { name: "Issues", level: 1 })),
      );
      // One control per row: Start work on what can start, Open on the rest.
      await expect(
        row(page, 201).getByRole("button", {
          name: "Start work on #201 Add invoice export",
        }),
      ).toBeVisible();
      // The one primary action must look primary beside the quiet Open buttons.
      const fill = (name: string, number: number) =>
        row(page, number).getByRole("button", { name }).evaluate((node) =>
          getComputedStyle(node).backgroundColor
        );
      expect(await fill("Start work on #201 Add invoice export", 201))
        .not.toBe(await fill("Open #202 Show the export button", 202));
      for (const number of [202, 203, 204, 205]) {
        await expect(row(page, number).getByRole("button")).toHaveCount(1);
        await expect(row(page, number).getByRole("button")).toHaveText("Open");
      }
      // The pointer rests away from the rail, so no item looks hovered.
      await page.mouse.move(700, 700);
      await shot(page, "issues-list");
    });

    test("the title starts where the filters below it start", async ({ page }) => {
      await issuesFixture(page);
      await page.goto("/issues");
      const title = page.getByRole("heading", { name: "Issues", level: 1 });
      await expect(title).toBeVisible();
      await expect(page.getByRole("radio", { name: "Can start" }))
        .toBeAttached();
      const [titleBox, filterBox] = await Promise.all([
        title.boundingBox(),
        page.locator("fieldset").first().boundingBox(),
      ]);
      expect(Math.round(titleBox!.x)).toBe(Math.round(filterBox!.x));
    });

    test("In progress shows what Bakery is working on, and Closed asks for closed issues", async ({ page }) => {
      const seen = await issuesFixture(page);
      await page.goto("/issues");
      await page.getByRole("radio", { name: "In progress" }).click({
        force: true,
      });
      await expect(row(page, 204)).toContainText("In progress");
      await expect(row(page, 201)).toHaveCount(0);
      await page.getByRole("radio", { name: "Closed" }).click();
      await expect(row(page, 190)).toContainText("Closed");
      await expect(row(page, 190)).toContainText("Closed on GitHub.");
      expect(seen.lists.some((query) => query.includes("state=closed")))
        .toBe(true);
    });

    test("nothing ready says why and offers All open", async ({ page }) => {
      await issuesFixture(page, { open: OPEN.slice(1, 3) });
      await page.goto("/issues");
      await expect(
        page.getByRole("heading", { name: "No issue is ready to start" }),
      )
        .toBeVisible();
      await shot(page, "issues-none-ready");
      await page.getByRole("button", { name: "All open" }).click();
      await expect(row(page, 202)).toBeVisible();
    });

    test("with no repository to take issues from, an administrator is told to choose one", async ({ page }) => {
      await issuesFixture(page, { sources: "none" });
      await page.goto("/issues");
      await expect(page.getByRole("heading", {
        name: "Choose where Bakery takes issues from",
      })).toBeVisible();
      // The way forward is the Choose repositories sheet.
      await expect(page.getByRole("button", { name: "Choose repositories" }))
        .first().toBeVisible();
      await shot(page, "issues-no-sources");
    });

    test("trouble reading GitHub is said at the top, with how old the list is", async ({ page }) => {
      await issuesFixture(page, { sources: "degraded" });
      await page.goto("/issues");
      await expect(page.getByText(
        "Bakery is having trouble reading GitHub. This list may be out of date.",
      )).toBeVisible();
      // The age is said once, under the filter.
      await expect(page.getByText("Updated from GitHub 5 minutes ago"))
        .toBeVisible();
      await shot(page, "issues-degraded");
    });

    test("Refresh asks the server to read GitHub again and says so", async ({ page }) => {
      const seen = await issuesFixture(page);
      await page.goto("/issues");
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByText(
        "Bakery is reading GitHub. The list updates when it is done.",
      )).toBeVisible();
      expect(seen.syncs).toBe(1);
    });

    test("Load more adds the next page and puts focus on the first issue it added", async ({ page }) => {
      const many: Seed[] = Array.from({ length: 30 }, (_, index) => ({
        number: 300 + index,
        title: `Issue number ${index + 1}`,
        verdict: "ready",
        checks: ready,
      }));
      await issuesFixture(page, { open: many });
      await page.goto("/issues");
      await expect(row(page, 324)).toBeVisible();
      await expect(row(page, 325)).toHaveCount(0);
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(more).toHaveCount(0);
      await expect(row(page, 325)).toBeFocused();
      await expect(row(page, 329)).toBeVisible();
    });

    const rejected = (count: number, from: number): Seed[] =>
      Array.from({ length: count }, (_, index) => ({
        number: from + index,
        title: `Needs criteria ${index + 1}`,
        verdict: "rejected" as const,
        checks: [{
          id: "acceptance_present",
          status: "reject",
          reason: "acceptance_missing",
        }],
      }));

    test("Can start keeps reading pages until it finds an issue, never saying nothing over a Load more button", async ({ page }) => {
      // 25 issues that cannot start, then one that can on the next page.
      await issuesFixture(page, {
        open: [...rejected(25, 1000), {
          number: 2000,
          title: "Ready on the second page",
          verdict: "ready",
          checks: ready,
        }],
      });
      await page.goto("/issues");
      await expect(row(page, 2000)).toContainText("Can start");
      await expect(page.getByText("No issue is ready to start")).toHaveCount(0);
    });

    test("In progress looks past the first page too", async ({ page }) => {
      await issuesFixture(page, {
        open: [...rejected(25, 1000), {
          number: 2001,
          title: "Running on the second page",
          verdict: "ready",
          checks: ready,
          request: { disposition: "active" },
        }],
      });
      await page.goto("/issues");
      await page.getByRole("radio", { name: "In progress" }).click({
        force: true,
      });
      await expect(row(page, 2001)).toContainText("In progress");
    });

    test("when the search gives up at 200 issues, it says how far it looked and offers Load more", async ({ page }) => {
      await issuesFixture(page, {
        open: [...rejected(200, 1000), {
          number: 2002,
          title: "Ready on the ninth page",
          verdict: "ready",
          checks: ready,
        }],
      });
      await page.goto("/issues");
      await expect(page.getByText(
        "None of the issues loaded so far can start. Load more to look further.",
      )).toBeVisible();
      await expect(page.getByText("No issue is ready to start")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "issues-list-searched-partly");
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(row(page, 2002)).toContainText("Can start");
    });
  });
}
