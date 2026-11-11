import { expect, test } from "@playwright/test";
import {
  canonicalStories,
  specimenTimeout,
  storyPath,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("Storybook specimen wait", () => {
  test("recovers once when the preview bundle never arrives", async ({ page }) => {
    // The first wait has to expire before the reload, so this test costs the
    // shared budget by design.
    test.setTimeout(specimenTimeout * 3);
    let aborted = 0;
    await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
      if (aborted > 0) return await route.continue();
      aborted += 1;
      // The failure observed on a saturated host: the bundle request dies at
      // the network layer, so the iframe stays blank however long we wait.
      await route.abort("connectionfailed");
    });
    const [story] = await canonicalStories(page);
    await page.goto(storyPath(story.id));
    const specimen = await waitForSpecimen(page);
    await expect(specimen).toBeVisible();
    expect(aborted, "the bundle request must actually have been aborted")
      .toBe(1);
  });

  test("still fails when no story ever mounts", async ({ page }) => {
    test.setTimeout(specimenTimeout * 4);
    await page.route(
      /\/assets\/[^/]+\.js$/,
      (route) => route.abort("connectionfailed"),
    );
    const [story] = await canonicalStories(page);
    await page.goto(storyPath(story.id));
    await expect(waitForSpecimen(page)).rejects.toThrow(/storybook-story/);
  });
});
