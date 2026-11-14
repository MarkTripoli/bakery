import type { Page } from "@playwright/test";

/**
 * Evidence stills for a pull request: when BAKERY_STILLS_DIR is set, the page
 * as it stands is written there twice, as `<name>-<desktop|phone>-light.png`
 * and `<name>-<desktop|phone>-dark.png`. It does nothing otherwise, so a normal
 * run never writes a file.
 *
 * The app shell is as tall as the window and scrolls inside, so on a wide
 * screen the window is made tall first and each pane shows whole.
 */
export async function still(page: Page, name: string): Promise<void> {
  const directory = process.env.BAKERY_STILLS_DIR;
  if (directory === undefined || directory === "") return;
  const width = page.viewportSize()?.width ?? 1280;
  const phone = width <= 743;
  if (!phone) await page.setViewportSize({ width, height: 1500 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      fullPage: true,
      path: `${directory}/${name}-${phone ? "phone" : "desktop"}-${scheme}.png`,
    });
  }
}
