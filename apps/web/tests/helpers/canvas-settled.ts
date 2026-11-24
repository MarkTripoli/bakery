import type { Page } from "@playwright/test";

export async function canvasSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  await page.waitForFunction(
    () => {
      if (document.querySelector(".ui-canvas-frame__loading") !== null) {
        return false;
      }
      const canvas = document.querySelector(
        '[data-ui-region="workflow-canvas"]',
      );
      return canvas === null || canvas.getAttribute("data-layout") === "ready";
    },
    undefined,
    { timeout: 30_000 },
  );
}
