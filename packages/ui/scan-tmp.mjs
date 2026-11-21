import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const catalog = JSON.parse(
  readFileSync(
    "/home/marktripoli/Development/bakery-wt/rig-415-slack-milestones/docs/technical-design/ui-baselines/components.json",
    "utf8",
  ),
);
const base = "http://127.0.0.1:6006";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
const index = await (await page.request.get(`${base}/index.json`)).json();
const titles = new Set(catalog.entries.map((e) => e.storyTitle));
const stories = Object.values(index.entries).filter((e) =>
  e.type === "story" && titles.has(e.title)
);
const { renderedContainmentIssues } = await import(
  "./scripts/capture-stories.mjs"
);
let bad = 0;
for (const story of stories) {
  const id = story.id;
  await page.goto(
    `${base}/iframe.html?id=${id}&viewMode=story&globals=${
      encodeURIComponent("viewportMode:zoom-200")
    }`,
    { waitUntil: "networkidle" },
  );
  await page.waitForTimeout(120);
  const issues = await page.evaluate(renderedContainmentIssues);
  if (issues.length) {
    bad += 1;
    console.log(story.title, "=>", issues.slice(0, 3).join(" | "));
  }
}
console.log("stories with issues:", bad, "of", stories.length);
await browser.close();
