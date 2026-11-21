import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:6006";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
await page.goto(
  `${base}/iframe.html?id=bakery-organisms-messagecomposer--contract&viewMode=story&globals=${
    encodeURIComponent("viewportMode:zoom-200")
  }`,
  { waitUntil: "networkidle" },
);
const info = await page.evaluate(() => {
  const mentions = document.querySelector(".ui-message-composer__mentions");
  return [...mentions.children].map((c) => ({
    tag: c.tagName,
    text: c.textContent.slice(0, 40),
    w: c.getBoundingClientRect().width,
    ws: getComputedStyle(c).whiteSpace,
    minW: getComputedStyle(c).minInlineSize,
    badge: c.querySelector(".ui-badge")?.getBoundingClientRect().width ?? null,
  }));
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
