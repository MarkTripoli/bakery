import { expect, test } from "@playwright/test";
import {
  analyzeAxe,
  canonicalStories,
  openByTitle,
  storyPath,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("Storybook navigation layouts", () => {
  test("keeps the Paper SectionNavigation story accessible in both themes", async ({ page }) => {
    const stories = await canonicalStories(page);
    const story = stories.find((entry) =>
      entry.title === "Bakery/Organisms/SectionNavigation"
    );
    if (!story) throw new Error("missing SectionNavigation Storybook story");
    for (const theme of ["light", "dark"]) {
      await page.goto(
        `${storyPath(story.id)}&globals=${
          encodeURIComponent(
            `theme:${theme};direction:ltr;locale:en-US;pointer:coarse`,
          )
        }`,
      );
      await waitForSpecimen(page);
      const results = await analyzeAxe(page);
      expect(results.violations, theme).toEqual([]);
    }
  });

  test("keeps Paper navigation links independently hit-testable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openByTitle(
      page,
      "Bakery/Organisms/SectionNavigation",
      "theme:light;direction:ltr;locale:en-US;pointer:coarse;viewportMode:narrow",
    );
    const links = page.locator(
      ".section-navigation-paper-contract__sidebar .bakery-section-navigation__link:visible",
    );
    await expect(links).toHaveCount(2);
    const hitTest = await links.evaluateAll((elements) => {
      const rectangles = elements.map((element) => {
        const rectangle = element.getBoundingClientRect();
        const point = {
          x: rectangle.left + rectangle.width / 2,
          y: rectangle.bottom - 1,
        };
        return {
          bottom: rectangle.bottom,
          nextTop: undefined as number | undefined,
          hit: document.elementFromPoint(point.x, point.y)?.closest("a") ===
            element,
        };
      });
      for (let index = 0; index + 1 < rectangles.length; index += 1) {
        rectangles[index].nextTop =
          elements[index + 1].getBoundingClientRect().top;
      }
      return rectangles;
    });
    expect(hitTest.every(({ hit }) => hit)).toBe(true);
    const first = hitTest[0];
    if (!first || first.nextTop === undefined) {
      throw new Error(
        "SectionNavigation links did not produce adjacent geometry",
      );
    }
    expect(first.bottom).toBeLessThanOrEqual(first.nextTop);
  });

  test("makes the narrow Storybook viewport narrower than desktop", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Button", "viewportMode:narrow");
    const narrow = await page.locator(".storybook-story").evaluate((element) =>
      element.getBoundingClientRect().width
    );
    await openByTitle(page, "Bakery/Atoms/Button", "viewportMode:desktop");
    const desktop = await page.locator(".storybook-story").evaluate((element) =>
      element.getBoundingClientRect().width
    );
    expect(narrow).toBeLessThan(desktop);
  });

  test("updates the mounted provider from the theme toolbar", async ({ page }) => {
    await page.goto(
      "/?path=/story/bakery-atoms-button--contract&globals=theme:light",
    );
    const preview = page.frameLocator("#storybook-preview-iframe");
    const specimen = await waitForSpecimen(preview);
    await expect.poll(() =>
      specimen.evaluate((element) =>
        element.closest("[data-theme]")?.getAttribute("data-theme")
      )
    ).toBe("light");
    await page.getByRole("button", { name: /Color theme/i }).click();
    await page.getByRole("option", { name: "dark" }).click();
    await expect.poll(() =>
      specimen.evaluate((element) =>
        element.closest("[data-theme]")?.getAttribute("data-theme")
      )
    ).toBe("dark");
  });
});
