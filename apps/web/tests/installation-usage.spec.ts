import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { usageFixture } from "./helpers/usage-fixture.ts";

registerPageHealth(test);

/** The Usage page (#75): what the installation spent, never an unknown as zero. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: usage`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("spend by provider, with an unknown never shown as zero", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "Usage", level: 1 }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: /^Period:/ }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: /^Provider:/ }))
        .toBeVisible();
      const providers = page.getByRole("heading", { name: "By provider" });
      await expect(providers).toBeVisible();
      // An exact zero reads "None", next to "1 record".
      await expect(page.getByText("None").first()).toBeVisible();
      await expect(page.getByText("1 record").first()).toBeVisible();
      await expect(page.getByText("0", { exact: true })).toHaveCount(0);
      // A cost under a cent is not shown as free.
      await expect(page.getByText("Less than $0.01").first()).toBeVisible();
      if (viewport.name === "phone") {
        // A phone has stacked rows with every value labelled, not a table that splits words.
        await expect(page.getByRole("table")).toHaveCount(0);
        await expect(page.getByText(/^Confirmed:/).first()).toBeVisible();
      } else {
        await expect(page.getByRole("table").first()).toBeVisible();
        // Period and Provider share the title's row.
        const title = await page.getByRole("heading", {
          name: "Usage",
          level: 1,
        })
          .boundingBox();
        const period = await page.getByRole("button", { name: /^Period:/ })
          .boundingBox();
        const provider = await page.getByRole("button", { name: /^Provider:/ })
          .boundingBox();
        expect(Math.abs(period!.y - provider!.y)).toBeLessThan(4);
        expect(period!.y).toBeLessThan(title!.y + title!.height);
      }
      await page.mouse.move(700, 700);
      await still(page, "usage-seeded");
    });

    test("the Provider menu lists each provider once and keeps the others after one is chosen", async ({ page }) => {
      await usageFixture(page, { twoRoutes: true });
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
      await page.getByRole("button", { name: /^Provider:/ }).click();
      const menu = page.getByRole("dialog", { name: "Provider" });
      await expect(menu.getByText("Anthropic", { exact: true })).toHaveCount(1);
      await menu.getByText("Anthropic", { exact: true }).click();
      await expect(page.getByRole("button", { name: "Provider: Anthropic" }))
        .toBeVisible();
      await page.getByRole("button", { name: /^Provider:/ }).click();
      await expect(menu.getByText("OpenAI", { exact: true })).toBeVisible();
      await expect(menu.getByText("Google", { exact: true })).toBeVisible();
    });

    test("a partial total says how many records are unconfirmed and how many have no cost", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(
        page.getByText(
          "3 records are not confirmed by a provider and 1 record has no cost at all.",
        ),
      ).toBeVisible();
    });

    test("Custom asks for From and To, sends exactly those days, and says why a range is refused while keeping the last good one", async ({ page }) => {
      const { seen } = await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
      await page.getByRole("button", { name: /^Period:/ }).click();
      await page.getByRole("dialog", { name: "Period" }).getByText("Custom", {
        exact: true,
      }).click();
      const from = page.getByRole("textbox", { name: "From", exact: true });
      const to = page.getByRole("textbox", { name: "To", exact: true });
      await expect(page.getByRole("dialog", { name: "Period" })).toBeHidden();
      await expect(from).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await expect(to).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await from.fill("2026-10-01");
      await to.fill("2026-10-10");
      await expect.poll(() => {
        const last = seen.at(-1);
        return last === undefined ? null : [
          new Date(last.get("from")!).getDate(),
          new Date(last.get("to")!).getDate(),
        ];
      }).toEqual([1, 10]);
      const reads = seen.length;
      await from.fill("2025-01-01");
      await expect(
        page.getByText("Choose a period of 366 days or less."),
      ).toBeVisible();
      await to.fill("2024-12-01");
      await expect(page.getByText("Choose an end date after the start date."))
        .toBeVisible();
      expect(seen.length).toBe(reads);
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
    });

    test("nothing in the period is said, and the way back is offered only when it helps", async ({ page }) => {
      await usageFixture(page, { empty: true });
      await page.goto("/installation/usage?period=last7");
      await expect(page.getByRole("button", { name: "Show last 30 days" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "usage-empty-last7");
      await page.goto("/installation/usage");
      await expect(
        page.getByRole("heading", { name: "No usage in this period" }),
      )
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Show last 30 days" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "usage-empty");
    });

    test("someone who may not see Usage is shown a not-found page with a headline title", async ({ page }) => {
      await usageFixture(page, { forbidden: true });
      await page.goto("/installation/usage");
      await expect(
        page.getByRole("heading", { name: "This page was not found" }),
      ).toBeVisible();
      await expect(page.locator("[data-ui-component='emptyState']"))
        .toHaveAttribute("data-title-style", "heading");
      // Title and line share one start edge.
      const headline = (await page.getByRole("heading", {
        name: "This page was not found",
      }).boundingBox())!;
      const line = (await page.getByText(
        "It may not exist, or you may not have access to it.",
      ).boundingBox())!;
      expect(Math.abs(headline.x - line.x)).toBeLessThan(2);
      await page.mouse.move(700, 700);
      await still(page, "usage-forbidden");
    });
  });
}
