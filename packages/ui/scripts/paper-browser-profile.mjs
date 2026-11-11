// Launch-only flags cannot be scoped to a context. Never put K-0 flags on
// the shared V-0 browser. Both production capture paths enter this boundary.
export function paperBrowserLaunchOptions(designCase = {}) {
  if (designCase.sourceProfile === undefined) return { headless: true };
  if (designCase.sourceProfile !== "K-0") {
    throw new Error(`Unknown Paper source profile ${designCase.sourceProfile}`);
  }
  return { headless: true, args: ["--font-render-hinting=none"] };
}

export async function withPaperBrowser(
  browser,
  designCase,
  capture,
  launch = async (options) => {
    const { chromium } = await import("@playwright/test");
    return chromium.launch(options);
  },
) {
  const options = paperBrowserLaunchOptions(designCase);
  if (designCase.sourceProfile === undefined) return capture(browser);
  const scopedBrowser = await launch(options);
  try {
    return await capture(scopedBrowser);
  } finally {
    await scopedBrowser.close();
  }
}

// The admitted convention names the capture policy; the raster helper retains
// its independently versioned implementation. Neither identifies a PNG producer.
export const K0_ADAPTER_VERSION = "paper-k0-centered-canvas-v1";
export function assertK0Environment(record) {
  if (
    record.sourceProfile !== "K-0" || record.browser !== "chromium" ||
    record.browserVersion !== "153.0.8010.12" ||
    record.playwrightVersion !== "1.63.0" ||
    record.dpr !== 1 || record.os !== "linux-x64" ||
    JSON.stringify(record.browserLaunchOptions) !==
      JSON.stringify(paperBrowserLaunchOptions(record))
  ) {
    throw new Error("K-0: incompatible raster environment");
  }
}

/** Canonical raster-affecting browser context, shared by source and candidate. */
export function paperRasterContext(record) {
  return Object.fromEntries([
    "viewport",
    "dpr",
    "browser",
    "browserVersion",
    "playwrightVersion",
    "os",
    "fontDigests",
    "browserLaunchOptions",
    "locale",
    "direction",
    "timezone",
    "reducedMotion",
    "pointer",
    "zoom",
  ].map((key) => [key, record[key]]));
}
