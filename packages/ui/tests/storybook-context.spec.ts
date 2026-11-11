import { expect, test } from "@playwright/test";
import {
  canonicalStories,
  storyPath,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("Storybook context contracts", () => {
  test("renders every canonical story under RTL without a document direction leak", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 744, height: 900 });
    for (const story of await canonicalStories(page)) {
      await page.goto(
        `${storyPath(story.id)}&globals=${
          encodeURIComponent("direction:rtl;viewportMode:pane")
        }`,
      );
      const specimen = await waitForSpecimen(page);
      await expect(specimen).toHaveAttribute("dir", "rtl");
      expect(
        await page.locator("html").getAttribute("dir"),
        `${story.title} leaked direction to the document root`,
      ).not.toBe("rtl");
      await expect.poll(
        () =>
          page.evaluate(() =>
            document.documentElement.scrollWidth <=
              document.documentElement.clientWidth
          ),
        { message: story.title },
      ).toBe(true);
    }
  });

  test("expands every copy-bearing canonical story under the deterministic pseudo-locale", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 744, height: 900 });
    for (const story of await canonicalStories(page)) {
      await page.goto(
        `${storyPath(story.id)}&globals=${
          encodeURIComponent("locale:pseudo;viewportMode:pane")
        }`,
      );
      const specimen = await waitForSpecimen(page);
      await expect(specimen.locator("xpath=.."))
        .toHaveAttribute("lang", "en-XA");
      const expandedNodes = await specimen.evaluate((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let expanded = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          const copy = node.textContent?.trim() ?? "";
          if (
            !parent || !/[\p{L}\p{N}]/u.test(copy) ||
            parent.closest("script, style, svg, [aria-hidden='true']") ||
            getComputedStyle(parent).display === "none" ||
            getComputedStyle(parent).visibility === "hidden"
          ) continue;
          node.textContent = `[!! ${copy.replace(/[aeiou]/gi, "$&$&")} !!]`;
          expanded += 1;
        }
        return expanded;
      });
      if (expandedNodes > 0) {
        await expect.poll(
          () =>
            page.evaluate(() =>
              document.documentElement.scrollWidth <=
                document.documentElement.clientWidth
            ),
          { message: story.title },
        ).toBe(true);
      }
    }
  });

  test("applies the reduced-motion contract to every canonical story", async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const story of await canonicalStories(page)) {
      await page.goto(
        `${storyPath(story.id)}&globals=${
          encodeURIComponent("reducedMotion:reduce")
        }`,
      );
      const specimen = await waitForSpecimen(page);
      const observed = await specimen.evaluate((root) => {
        const milliseconds = (value: string) =>
          value.split(",").map((part) => part.trim()).reduce(
            (maximum, part) => {
              const amount = Number.parseFloat(part);
              if (!Number.isFinite(amount)) return maximum;
              return Math.max(
                maximum,
                part.endsWith("ms") ? amount : amount * 1_000,
              );
            },
            0,
          );
        const violations = Array.from(root.querySelectorAll("*"))
          .flatMap((element) => {
            const style = getComputedStyle(element);
            return milliseconds(style.animationDuration) <= 1 &&
                milliseconds(style.transitionDuration) <= 1 &&
                style.animationIterationCount === "1" &&
                style.scrollBehavior === "auto"
              ? []
              : [element.outerHTML.slice(0, 120)];
          });
        return {
          context: root.getAttribute("data-reduced-motion"),
          media: matchMedia("(prefers-reduced-motion: reduce)").matches,
          violations,
        };
      });
      expect(observed.context, story.title).toBe("true");
      expect(observed.media, story.title).toBe(true);
      expect(observed.violations, story.title).toEqual([]);
    }
  });
});
