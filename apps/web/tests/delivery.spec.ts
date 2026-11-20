import { expect, test } from "@playwright/test";
import { deliveryFixture } from "./helpers/delivery-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/** The Delivery page (#75): what was delivered, how long a task took, where the time went. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: delivery`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the page says how long a task took and where the time went", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      await expect(page.getByRole("heading", { name: "Delivery", level: 1 }))
        .toBeVisible();
      const time = page.getByTestId("delivery-time");
      await expect(time.getByRole("heading", { name: "How long a task took" }))
        .toBeVisible();
      await expect(time.getByText(/^Typical:/)).toBeVisible();
      await expect(time.getByText(/9 in 10 took less than/)).toBeVisible();
      // Two tasks reached a completed run, so the sentence names both delivery points.
      await expect(time.getByText(/for the 2 of 8 tasks with no pull request/))
        .toBeVisible();
      // The bar's key lists every part with its time, and Not accounted for is its own part.
      const bar = time.getByRole("img", { name: /^Where the time went:/ });
      await expect(bar).toBeVisible();
      for (
        const label of [
          "Agent working",
          "Waiting in queue",
          "In review",
          "Waiting for a person",
          "Not accounted for",
        ]
      ) await expect(time.getByText(label, { exact: true })).toBeVisible();
      // Blocked is not a part of the bar: Bakery keeps no history of it.
      await expect(time.getByText(/^Blocked: Unknown\./)).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "delivery-time");
    });

    test("the task records show where each task stopped and what no record covers", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery?show=tasks");
      const records = page.getByTestId("delivery-records");
      await expect(
        records.getByRole("columnheader", { name: "Not accounted for" }),
      )
        .toBeVisible();
      await expect(records.getByText("merged pull request").first())
        .toBeVisible();
      await expect(records.getByText("completed run").first()).toBeVisible();
      // No Blocked column while nothing records it.
      await expect(records.getByRole("columnheader", { name: "Blocked" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "delivery-records-tasks");
    });

    test("fewer than five tasks are listed, not summarised", async ({ page }) => {
      await deliveryFixture(page, { merged: 2, runs: 1 });
      await page.goto("/delivery");
      const time = page.getByTestId("delivery-time");
      await expect(time.getByText("Too few tasks to summarise (3)."))
        .toBeVisible();
      await expect(time.getByText(/^Typical:/)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "delivery-too-few");
    });
  });
}
