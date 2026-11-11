import { expect, test } from "@playwright/test";
import { openByTitle } from "./storybook-harness.ts";

test("bounded output preserves text and supports keyboard jump and archive recovery", async ({ page }) => {
  await openByTitle(page, "Bakery/Organisms/RunOutputPanel");
  const live = page.getByRole("region", { name: "Live", exact: true });
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute("data-state", "live");
  const viewer = live.locator('[data-ui-component="logViewer"]');
  await expect(viewer).toHaveCount(1);
  await expect(viewer.locator("li")).toHaveCount(24);
  await expect(viewer.locator("time")).toHaveCount(0);
  await expect(viewer.locator("img")).toHaveCount(0);
  await expect(viewer.locator("li").first()).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(live).toContainText("Saved through sequence 128");
  await live.getByRole("button", { name: "Jump to latest" }).press("Enter");
  await expect(viewer).toBeFocused();
  expect(
    await viewer.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1
    ),
  ).toBe(true);
  const reset = page.locator(
    '[data-ui-component="runOutputPanel"][data-state="reset"]',
  );
  await expect(reset.getByRole("link", { name: "Open archived output" }))
    .toHaveAttribute("href", "#archive");
  await expect(
    page.locator(
      '[data-ui-component="runOutputPanel"][data-state="interrupted"]',
    ),
  )
    .toContainText("Previously saved output remains available");
});

test("missing trusted identity stays unknown and revisions remain candidates", async ({ page }) => {
  await openByTitle(page, "Bakery/Organisms/RunIdentity");
  const unknown = page.locator(
    '[data-ui-component="runIdentity"][data-state="unknown"]',
  );
  await expect(unknown).toContainText("No trusted worker record is available.");
  await expect(unknown.locator(".ui-run-card__badge")).toHaveText([
    "Unknown",
    "Unknown",
    "Unknown",
  ]);
  await openByTitle(page, "Bakery/Organisms/RevisionSummary");
  const revision = page.locator(
    '[data-ui-component="revisionSummary"][data-state="candidate"]',
  );
  await expect(revision).toContainText("8ac02e1 → 5d138ac");
  await expect(revision).toContainText("No review or merge decision recorded.");
  await expect(revision.getByRole("link", { name: "View diff" }))
    .toHaveAttribute("href", "#diff");
  await expect(
    page.locator(
      '[data-ui-component="revisionSummary"][data-state="unknown"] a',
    ),
  ).toHaveCount(0);
});

for (const theme of ["light", "dark"]) {
  for (const width of [390, 1440]) {
    test(
      `run components reflow ${theme} ${width}`,
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 960 });
        for (
          const component of [
            "RunIdentity",
            "RevisionSummary",
            "RunOutputPanel",
          ]
        ) {
          await page.goto(
            `/iframe.html?id=bakery-organisms-${component.toLowerCase()}--contract&viewMode=story&globals=theme:${theme}`,
          );
          const owner = page.locator(
            `[data-ui-component="${component[0]?.toLowerCase()}${
              component.slice(1)
            }"]`,
          ).first();
          await expect(owner).toBeVisible();
          expect(
            await page.evaluate(() =>
              document.documentElement.scrollWidth <= innerWidth
            ),
          ).toBe(true);
          await owner.screenshot({
            path: testInfo.outputPath(`${component}-${theme}-${width}.png`),
          });
        }
      },
    );
  }
}
