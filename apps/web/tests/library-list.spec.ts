import { expect, type Page, test } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
} from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Library list (design-ux, #66, slice 1): the built-in workflows and the
 * organization's own, each with one badge, and the same for agents. Read-only
 * until the workflow and agent pages arrive.
 */
const WORLD: Options = {
  workflows: [
    definition(10, "Release train"),
    definition(11, "Nightly audit", { description: null }),
    definition(12, "Docs refresh", { enabled: false }),
    definition(13, "Hotfix", { activeVersionId: null }),
  ],
  agents: [
    definition(20, "Code writer"),
    definition(21, "Reviewer", { enabled: false }),
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: library list`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (
      page: Page,
      options: Options = WORLD,
      path = "/library",
    ) => {
      const seen = await libraryFixture(page, options);
      await page.goto(path);
      return seen;
    };
    const section = (page: Page, id: string) => page.getByTestId(id);

    test("Workflows lists what is built in and what the organization has, one badge each", async ({ page }) => {
      await open(page);
      await expect(page.getByRole("heading", { name: "Library", level: 1 }))
        .toBeVisible();
      await expect(page.getByText(
        "The workflows, agents, skills and remembered facts Bakery uses to do work.",
      )).toBeVisible();
      const builtIn = section(page, "library-built-in");
      await expect(builtIn).toContainText("Built in");
      await expect(builtIn).toContainText("Maintained by Bakery.");
      const fixed = builtIn.locator("[data-library-id=fixed-coding]");
      await expect(fixed).toContainText("Fixed coding");
      // The heading says Built in; the rows do not say it again.
      await expect(fixed).not.toContainText("Built in");
      await expect(fixed).toContainText("Version 2 · 2 steps");
      await expect(builtIn.locator("[data-library-id=fixed-coding-reviewed]"))
        .toContainText("Version 3 · 3 steps");
      const own = section(page, "library-organization");
      await expect(own).toContainText("Your organization");
      const row = (id: number) =>
        own.locator(
          `[data-library-id="00000000-0000-4000-8000-${
            String(id).padStart(12, "0")
          }"]`,
        );
      await expect(row(10)).toContainText("Release train");
      await expect(row(10)).toContainText("In use");
      await expect(row(11)).toContainText("No description.");
      await expect(row(12)).toContainText("Turned off");
      await expect(row(13)).toContainText("No version in use");
      await page.mouse.move(700, 700);
      await shot(page, "library-workflows");
    });

    test("the title, the section headings and the rows share one left edge, and a list ends in one rule", async ({ page }) => {
      await open(page);
      await expect(page.getByTestId("library-built-in")).toBeVisible();
      const left = async (locator: ReturnType<Page["locator"]>) =>
        Math.round((await locator.boundingBox())!.x);
      const title = await left(page.getByRole("heading", {
        name: "Library",
        level: 1,
      }));
      const heading = await left(
        page.getByRole("heading", { name: "Built in" }),
      );
      const rowTitle = await left(
        page.locator("[data-library-id=fixed-coding] .ui-stacked-row__title"),
      );
      const own = await left(page.getByRole("heading", {
        name: "Your organization",
      }));
      expect([heading, rowTitle, own]).toEqual([title, title, title]);
      // Tabs that lead to their own content close with no rule of their own;
      // the last row's rule is the only one.
      expect(
        await page.locator(".ui-tabs").evaluate((element) =>
          getComputedStyle(element).borderBlockEndWidth
        ),
      ).toBe("0px");
    });

    test("an organization with no workflows of its own says so, and the built-in ones stay", async ({ page }) => {
      await open(page, { workflows: [], agents: [] });
      await expect(page.getByText("No workflows of your own yet"))
        .toBeVisible();
      await expect(section(page, "library-built-in")).toContainText(
        "Fixed coding",
      );
      await page.mouse.move(700, 700);
      await shot(page, "library-empty");
    });

    test("the Agents tab lists the organization's agents, and says so when there are none", async ({ page }) => {
      await open(page);
      await page.getByRole("tab", { name: "Agents" }).click();
      await expect(page).toHaveURL(/\/library\?tab=agents$/);
      const own = section(page, "library-organization");
      await expect(own).toContainText("Code writer");
      await expect(own).toContainText("In use");
      await expect(own).toContainText("Reviewer");
      await expect(own).toContainText("Turned off");
      await expect(section(page, "library-built-in")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "library-agents");
      // Back to Workflows drops the query.
      await page.getByRole("tab", { name: "Workflows" }).click();
      await expect(page).toHaveURL(/\/library$/);
      await expect(section(page, "library-built-in")).toBeVisible();
    });

    test("a deep link to ?tab=agents opens the Agents tab, and an empty list says so", async ({ page }) => {
      await open(page, { agents: [] }, "/library?tab=agents");
      await expect(page.getByRole("tab", { name: "Agents", selected: true }))
        .toBeVisible();
      await expect(page.getByText("No agents of your own yet")).toBeVisible();
    });

    test("a failed read is an error with Try again, and Try again recovers", async ({ page }) => {
      const seen = await open(page, { ...WORLD, failing: "workflows" });
      await expect(page.getByText("The library could not be loaded."))
        .toBeVisible();
      await expect(page.locator("[data-library-id]")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "library-error");
      seen.failing = null;
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("The library could not be loaded."))
        .toHaveCount(0);
      await expect(section(page, "library-organization")).toContainText(
        "Release train",
      );
    });

    test("while the library is read, a status line and placeholders stand in, with no rows", async ({ page }) => {
      const seen = await libraryFixture(page, { ...WORLD, hold: true });
      await page.goto("/library");
      await expect(
        page.getByRole("status").filter({
          hasText: "Loading the library.",
        }),
      ).toBeVisible();
      await expect(page.locator("[data-ui-component=skeleton]").first())
        .toBeVisible();
      await expect(page.locator("[data-library-id]")).toHaveCount(0);
      seen.release();
      await expect(section(page, "library-organization")).toContainText(
        "Release train",
      );
      await expect(page.getByText("Loading the library.")).toHaveCount(0);
    });

    test("an unreachable read says the device is offline, with Try again and no rows", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, offline: true });
      await page.goto("/library");
      await expect(page.getByText("You are offline")).toBeVisible();
      await expect(page.getByText(
        "Bakery will load the library when you are back online.",
      )).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await expect(page.locator("[data-library-id]")).toHaveCount(0);
    });

    test("a list longer than five pages says it was cut short; one that ends early does not", async ({ page }) => {
      const seen = await libraryFixture(page, { ...WORLD, endless: true });
      await page.goto("/library");
      await expect(page.getByText("Only the first 500 are shown."))
        .toBeVisible();
      // Five pages of 100 are read, no more.
      await expect.poll(() => seen.workflowReads).toBeGreaterThanOrEqual(5);
      expect(seen.workflowReads).toBeLessThanOrEqual(10);
      await expect(page.getByText("Page 5", { exact: true })).toBeVisible();
    });

    test("a list that ends early has no cut-short warning", async ({ page }) => {
      await open(page);
      await expect(section(page, "library-organization")).toContainText(
        "Release train",
      );
      await expect(page.getByText("Only the first 500 are shown."))
        .toHaveCount(0);
    });

    test("a member who cannot see the library is told so", async ({ page }) => {
      await open(page, { ...WORLD, forbidden: true });
      await expect(page.getByText("You cannot see the library")).toBeVisible();
      await expect(page.locator("[data-library-id]")).toHaveCount(0);
    });

    test("Library is in the main navigation and names the page", async ({ page }) => {
      await open(page);
      if (viewport.name === "phone") {
        await expect(
          page.getByRole("banner").getByText("Library", {
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("link", { name: "Library", exact: true }))
          .toHaveAttribute("aria-current", "page");
      }
      await expect(page.getByText("Library · Soon")).toHaveCount(0);
    });
  });
}
