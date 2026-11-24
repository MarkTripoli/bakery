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
      await still(page, "usage-provider-menu");
    });

    test("the Period and Provider menus open inside the screen", async ({ page }) => {
      await usageFixture(page, { twoRoutes: true });
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
      for (const name of ["Period", "Provider"]) {
        await page.getByRole("button", { name: new RegExp(`^${name}:`) })
          .click();
        const menu = page.getByRole("dialog", { name });
        await expect(menu).toBeVisible();
        const items = menu.getByRole("button");
        const count = await items.count();
        expect(count).toBeGreaterThan(1);
        for (let index = 0; index < count; index += 1) {
          const box = (await items.nth(index).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        }
        await page.mouse.move(viewport.width / 2, viewport.height - 20);
        await still(page, `usage-${name.toLowerCase()}-menu-open`);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
    });

    test("Custom puts From and To on one row on a wide screen and a full row each on a phone", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await page.getByRole("button", { name: /^Period:/ }).click();
      await page.getByRole("dialog", { name: "Period" }).getByText("Custom", {
        exact: true,
      }).click();
      const from = (await page.getByRole("textbox", {
        name: "From",
        exact: true,
      }).boundingBox())!;
      const to = (await page.getByRole("textbox", { name: "To", exact: true })
        .boundingBox())!;
      if (viewport.name === "phone") {
        expect(to.y).toBeGreaterThan(from.y + from.height - 1);
        expect(from.x + from.width).toBeLessThanOrEqual(viewport.width);
        expect(from.width).toBeGreaterThan(viewport.width - 48);
        expect(to.width).toBeGreaterThan(viewport.width - 48);
      } else {
        expect(Math.abs(to.y - from.y)).toBeLessThan(4);
      }
      await page.mouse.move(viewport.width / 2, viewport.height - 20);
      await still(page, "usage-custom-fields");
    });

    test("a clause that counts nothing is left out of the partial banner, and budgets say they cover every provider", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      const banner = page.getByText("These totals are partial").locator("..");
      await expect(banner).toContainText(
        "3 records are not confirmed by a provider and 1 record has no cost at all.",
      );
      await expect(page.getByText(/^Budgets count every provider/)).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: /^Provider:/ }).click();
      await page.getByRole("dialog", { name: "Provider" }).getByText(
        "Anthropic",
        { exact: true },
      ).click();
      await expect(banner).toContainText(
        "3 records are not confirmed by a provider.",
      );
      await expect(banner).not.toContainText("no cost at all");
      await expect(
        page.getByText("Budgets count every provider, not only Anthropic."),
      ).toBeVisible();
      await page.mouse.move(viewport.width / 2, viewport.height - 20);
      await still(page, "usage-provider-filtered");
      await page.getByRole("button", { name: /^Provider:/ }).click();
      await page.getByRole("dialog", { name: "Provider" }).getByText("OpenAI", {
        exact: true,
      }).click();
      await expect(banner).toContainText("1 record has no cost at all.");
      await expect(banner).not.toContainText("not confirmed by a provider");
    });

    test("a failed read is an error state with Try again, not a blank page", async ({ page }) => {
      await usageFixture(page, { failing: true });
      await page.goto("/installation/usage");
      await expect(page.getByText("Usage could not be loaded.")).toBeVisible({
        timeout: 20000,
      });
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await expect(page.locator('[data-ui-component="errorState"]'))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "usage-error");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toHaveCount(0);
    });

    test("while the first read is in flight the page shows skeleton tiles and rows, not an empty table", async ({ page }) => {
      await usageFixture(page, { delayMs: 1500 });
      await page.goto("/installation/usage");
      const loading = page.getByRole("status", { name: "Loading usage…" });
      await expect(loading).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "usage-loading");
      await expect(loading.locator("[data-ui-component=skeleton]")).toHaveCount(
        7,
      );
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible({ timeout: 20000 });
    });

    test("offline, the page says when its figures were last updated", async ({ page, context }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
      await expect(page.getByText(/^Last updated/)).toHaveCount(0);
      await context.setOffline(true);
      await expect(page.getByText(/^Last updated \d/)).toBeVisible({
        timeout: 20000,
      });
      await page.mouse.move(700, 700);
      await still(page, "usage-offline");
    });

    test("each figure is a named group and Total is a row header", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(page.getByRole("heading", { name: "By provider" }))
        .toBeVisible();
      await expect(page.getByRole("region", { name: "Confirmed cost" }))
        .toBeVisible();
      if (viewport.name === "desktop") {
        await expect(page.getByRole("rowheader", { name: "Total" }))
          .toBeVisible();
        await expect(page.getByRole("rowheader", { name: "Anthropic" }))
          .toBeVisible();
      }
    });

    test("a partial total says how many records are unconfirmed and how many have no cost", async ({ page }) => {
      await usageFixture(page);
      await page.goto("/installation/usage");
      await expect(
        page.getByText(
          "3 records are not confirmed by a provider and 1 record has no cost at all.",
        ),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "usage-partial");
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
      await page.mouse.move(700, 700);
      await still(page, "usage-custom-error");
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
