import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:6006";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
const { renderedContainmentIssues } = await import(
  "./scripts/capture-stories.mjs"
);
await page.goto(
  `${base}/iframe.html?id=bakery-organisms-messagecomposer--contract&viewMode=story&globals=${
    encodeURIComponent("viewportMode:zoom-200")
  }`,
  { waitUntil: "networkidle" },
);
await page.waitForTimeout(200);
console.log((await page.evaluate(renderedContainmentIssues)).join("\n"));
await browser.close();
