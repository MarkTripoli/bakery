import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
const require = createRequire("/home/marktripoli/Development/bakery-wt/rig-73-b/apps/web/package.json");
const { chromium } = require("@playwright/test");
const base = "http://127.0.0.1:40837";
const out = "/home/marktripoli/Development/bakery-wt/_notes/pr996-999-stills/stack73/rec";
mkdirSync(out, { recursive: true });
const log = [];
const t0 = Date.now();
const note = (event, extra = {}) => log.push({ at: ((Date.now() - t0) / 1000).toFixed(1), event, ...extra });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: out, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
page.on("request", (request) => {
  const url = new URL(request.url());
  if (/\/messages$/.test(url.pathname)) note("messages request", { cursor: url.searchParams.get("cursor") ?? "first" });
  if (request.method() === "PATCH" && /\/notifications\//.test(url.pathname)) note("notification marked read");
  if (/\/notifications\/[0-9a-f-]+\/target$/.test(url.pathname)) note("target resolved");
});
page.on("response", async (response) => {
  const request = response.request();
  if (request.method() === "PATCH" && /\/notifications\//.test(response.url())) {
    note("read response", { status: response.status(), body: (await response.text()).slice(0, 300), sent: request.postData() });
  }
});
await page.goto(base + "/sign-in");
await page.getByLabel("Email").fill("recipient@example.test");
await page.getByLabel("Password", { exact: true }).fill("Mention-Landing-Passw0rd-1");
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30000 });
note("signed in", { path: new URL(page.url()).pathname });
await page.goto(base + "/notifications");
await page.getByRole("tab", { name: /^Mentions/ }).click();
const rows = page.locator("[data-ui-component=notificationRow]");
await rows.first().waitFor({ timeout: 30000 });
note("mentions inbox", { rows: await rows.count() });
await page.waitForTimeout(1500);
await page.screenshot({ path: out + "/1-inbox-mentions.png" });
await rows.first().getByRole("link").first().click();
const landed = page.locator("[data-message-id][data-landed='true']");
await landed.waitFor({ timeout: 30000 });
note("landed", { text: (await landed.first().innerText()).replace(/\s+/g, " "), outlines: await page.locator("[data-landed]").count(), url: new URL(page.url()).pathname });
await page.waitForTimeout(1200);
await page.screenshot({ path: out + "/2-landed.png" });
await page.waitForTimeout(1500);
await page.goBack();
await page.getByRole("tab", { name: /^Mentions/ }).waitFor();
await rows.first().waitFor();
note("back on inbox", { mentionsSelected: await page.getByRole("tab", { name: /^Mentions/ }).getAttribute("aria-selected"), rows: await rows.count() });
await page.waitForTimeout(1500);
await page.screenshot({ path: out + "/3-back.png" });
const video = await page.video().path();
await context.close();
await browser.close();
writeFileSync(out + "/transcript.json", JSON.stringify(log, null, 2));
console.log(JSON.stringify({ video, log }, null, 2));
