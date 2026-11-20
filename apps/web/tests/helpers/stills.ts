import type { Locator, Page } from "@playwright/test";

/**
 * Evidence stills for a pull request: when BAKERY_STILLS_DIR is set, the page
 * (or `target`, when the change is one card) is written there twice, as
 * `<name>-<desktop|phone>-light.png` and `<name>-<desktop|phone>-dark.png`. It
 * does nothing otherwise, so a normal run never writes a file.
 *
 * The app shell is as tall as the window and scrolls inside, so on a wide
 * screen the window is made tall first and every pane is scrolled to its top,
 * which shows each whole.
 */
export async function still(
  page: Page,
  name: string,
  target?: Locator,
  /** `scrollTo` frames the shot on one region instead of the whole window. */
  options: { scrollTo?: Locator } = {},
): Promise<void> {
  // The evidence pass names the directory BAKERY_EVIDENCE_DIR; the longer
  // standing name stays supported so older runs and habits keep working.
  const directory = process.env.BAKERY_EVIDENCE_DIR ??
    process.env.BAKERY_STILLS_DIR;
  if (directory === undefined || directory === "") return;
  const width = page.viewportSize()?.width ?? 1280;
  const phone = width <= 743;
  // A card can be taller than a window-high pane that scrolls it, so a target
  // gets a window tall enough for the longest card.
  if (!phone) {
    await page.setViewportSize({ width, height: target ? 3200 : 1500 });
  }
  // The shell is as tall as the window and scrolls inside: grow the window by
  // what its scrolling panes hide, so the sidebar and the page end together.
  if (target === undefined && options.scrollTo === undefined) {
    const hidden = await page.evaluate(() => {
      // A page that scrolls as a whole hides what is below the window too.
      let extra = document.documentElement.scrollHeight -
        document.documentElement.clientHeight;
      for (const element of document.querySelectorAll("*")) {
        const overflow = getComputedStyle(element).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        extra = Math.max(extra, element.scrollHeight - element.clientHeight);
      }
      return extra;
    });
    if (hidden > 0) {
      const size = page.viewportSize();
      if (size !== null) {
        await page.setViewportSize({
          width: size.width,
          height: Math.min(size.height + hidden, 6000),
        });
      }
    }
  }
  if (options.scrollTo === undefined) {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollTop > 0) element.scrollTop = 0;
      }
      globalThis.scrollTo(0, 0);
    });
  } else {
    // A card below the fold is only in the shot once its heading is in view;
    // the window is not scrolled as a whole, the app shell is.
    await options.scrollTo.scrollIntoViewIfNeeded();
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The logo picks its art after a theme change (observer, render, image
    // load); a shot taken before then shows the other theme's art.
    await page.waitForFunction(
      (expected) =>
        Array.from(document.querySelectorAll("img[data-logo-variant]")).every(
          (image) =>
            image instanceof HTMLImageElement && image.complete &&
            image.dataset.logoVariant?.endsWith(expected),
        ),
      scheme,
    );
    const path = `${directory}/${name}-${
      phone ? "phone" : "desktop"
    }-${scheme}.png`;
    if (target) await target.screenshot({ path });
    else {
      await page.screenshot({
        fullPage: options.scrollTo === undefined,
        path,
      });
    }
  }
}
