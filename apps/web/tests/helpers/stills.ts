import type { Page } from "@playwright/test";

/**
 * Evidence stills for a pull request: when BAKERY_STILLS_DIR is set, the page
 * as it stands is written there as `<name>-<desktop|phone>-<light|dark>.png`
 * (BAKERY_STILLS_SCHEME=dark picks the dark scheme). It does nothing otherwise,
 * so the spec's own run never writes a file.
 */
export async function still(page: Page, name: string): Promise<void> {
  const directory = process.env.BAKERY_STILLS_DIR;
  if (directory === undefined || directory === "") return;
  const dark = process.env.BAKERY_STILLS_SCHEME === "dark";
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  const phone = (page.viewportSize()?.width ?? 1280) <= 743;
  await page.screenshot({
    fullPage: true,
    path: `${directory}/${name}-${phone ? "phone" : "desktop"}-${
      dark ? "dark" : "light"
    }.png`,
  });
}
