import { expect, test } from "@playwright/test";
import { baseURL } from "./storybook-harness.ts";

const stories = [
  ["bakery-brand-logo--variants-on-surfaces", 55],
  ["bakery-brand-logo--recommended-per-surface", 22],
  ["bakery-brand-logo--sizes", 6],
  ["bakery-brand-logo--tiles", 4],
  ["bakery-brand-scenes--all-scenes", 30],
] as const;

for (const theme of ["light", "dark"]) {
  for (const [id, count] of stories) {
    test(`${id} renders every image in ${theme}`, async ({ page }) => {
      await page.goto(
        `${baseURL}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`,
      );
      const images = page.locator("#storybook-root img");
      await expect(images).toHaveCount(count);
      await expect.poll(() =>
        images.evaluateAll((nodes) =>
          nodes.filter((node) =>
            !(node as HTMLImageElement).complete ||
            (node as HTMLImageElement).naturalWidth === 0
          ).length
        )
      ).toBe(0);
    });
  }
}
