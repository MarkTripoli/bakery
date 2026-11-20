#!/usr/bin/env node
// Captures the Usage page, and refuses to keep a still that does not prove the
// state it claims: the same method as the badge-states and scene-states sets.
//
//   node scripts/evidence/usage-page/capture.mjs \
//     --web http://127.0.0.1:5200 --api http://127.0.0.1:32772 \
//     --out ~/rig-logs/stills/75 --mode seeded
//
// Modes:
//   empty   run the seed's `clear` first; the page has nothing to report
//   seeded  run the seed's `usage` first; the page has reported costs and one
//           unknown measurement
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { assertDistinct, writeManifest } from "../stills.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const WEB = args.get("--web") ?? "http://127.0.0.1:5200";
const API = args.get("--api") ?? "http://127.0.0.1:32772";
const OUT = args.get("--out") ?? "stills/75-usage";
const MODE = args.get("--mode") ?? "seeded";
const EMAIL = args.get("--email") ?? "evidence@example.test";
const PASSWORD = args.get("--password") ?? "Evidence-Pass-1";
const SEED = new URL("./seed.ts", import.meta.url).pathname;

const VIEWPORTS = [
  ["desktop-1440x900", { width: 1440, height: 900 }],
  ["phone-390x844", { width: 390, height: 844 }],
];
const THEMES = ["light", "dark"];

const seed = spawnSync("deno", [
  "run",
  "-A",
  SEED,
  MODE === "empty" ? "clear" : "usage",
], {
  stdio: "inherit",
});
if (seed.status !== 0) throw new Error("seed failed");

const browser = await chromium.launch();

let session;
async function getSession() {
  if (session !== undefined) return session;
  const context = await browser.newContext();
  let signIn;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    signIn = await context.request.post(
      `${API}/api/auth/sign-in/email`,
      { data: { email: EMAIL, password: PASSWORD } },
    );
    if (signIn.status() !== 429) break;
    const wait = attempt * 20000;
    console.log(`  signin rate-limited; waiting ${wait / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  if (!signIn.ok()) throw new Error(`signin ${signIn.status()}`);
  session = await context.cookies(API);
  await context.close();
  return session;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const files = [];
for (const [label, viewport] of VIEWPORTS) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport,
      colorScheme: theme,
      deviceScaleFactor: 1,
    });
    await context.addCookies(await getSession());
    const page = await context.newPage();
    await page.goto(`${WEB}/installation/usage`, {
      waitUntil: "domcontentloaded",
    });

    // The page's own words, so a still cannot prove a blank or a spinner.
    const heading = page.getByRole("heading", { name: /Usage/i }).first();
    await heading.waitFor({ state: "visible", timeout: 45_000 });
    // Network idle is not "settled": the first answer can arrive after the
    // page has finished loading, and a still of the loading state proves
    // nothing about the design. Wait for the state the run is claiming.
    await page.waitForLoadState("networkidle").catch(() => {});
    if (MODE === "empty") {
      await page.getByRole("heading", { name: /No usage in this period/i })
        .first().waitFor({ state: "visible", timeout: 45_000 });
    } else {
      await page.getByText("Total", { exact: true }).first()
        .waitFor({ state: "visible", timeout: 45_000 });
    }

    const body = await page.locator("body").innerText();
    if (MODE === "empty") {
      if (!/no usage|nothing|yet/i.test(body)) {
        throw new Error(
          `empty: page does not say it has no usage:\n${body.slice(0, 400)}`,
        );
      }
    } else {
      // The contract this evidence exists for: a reported cost that no receipt
      // confirms is said in words, never drawn as a settled figure.
      if (!/reported|not confirmed|unverified/i.test(body)) {
        throw new Error(
          `seeded: page does not name the unconfirmed cost:\n${
            body.slice(0, 600)
          }`,
        );
      }
      if (/\$0\.00/.test(body)) {
        const at = body.indexOf("$0.00");
        throw new Error(
          `seeded: page drew \$0.00, which the rule forbids:\n` +
            JSON.stringify(body.slice(Math.max(0, at - 240), at + 120)),
        );
      }
    }

    const name = `${MODE}--${theme}--${label}`;
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    files.push(path);
    console.log("  shot", name);
    await context.close();
  }
}

const distinct = await assertDistinct(files);
await writeManifest(OUT, {
  schema: "bakery.evidence.usage-page/1",
  files,
  distinct,
  web: WEB,
  api: API,
  mode: MODE,
  note:
    "The real /installation/usage page on a real stack. Reported-but-unconfirmed costs are named in words; no still draws $0.00 for a subscription.",
});
console.log(`  ${files.length} stills, ${distinct} distinct, manifest written`);
await browser.close();
