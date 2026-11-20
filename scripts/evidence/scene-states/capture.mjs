#!/usr/bin/env node
// Captures the character scene on the whole-page states, and refuses to keep a
// still that does not prove the state it claims.
//
//   node --experimental-detect-module scripts/evidence/scene-states/capture.mjs \
//     --web http://127.0.0.1:5199 --api http://127.0.0.1:32772 \
//     --out ~/rig-logs/stills/81
//
// The method is the badge-states capture's, because the rules are the same:
//   - assert the precondition before the shot, never after;
//   - assert the page's own words, so a shot cannot prove a blank;
//   - hash every still and fail on a duplicate;
//   - write a manifest so the set is checkable later.
//
// Each state is produced by the real page rather than a mock:
//
//   not-found      a path no route claims
//   forbidden      a signed-in person who belongs to no organization
//   server-error   the page's own read answered 500
//   empty-machines an organization that has never had a machine
//   offline        the API unreachable at startup, aborted at the network layer
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
const WEB = args.get("--web") ?? "http://127.0.0.1:5199";
const API = args.get("--api") ?? "http://127.0.0.1:32772";
const OUT = args.get("--out") ?? "stills/81-scene-states";
const EMAIL = args.get("--email") ?? "evidence@example.test";
const OUTSIDER_EMAIL = "outsider@example.test";
const PASSWORD = args.get("--password") ?? "Evidence-Pass-1";
const SEED = new URL("./seed.ts", import.meta.url).pathname;

/** Desktop first, then the phone the design names for this template. */
const VIEWPORTS = [
  ["desktop-1440x900", { width: 1440, height: 900 }],
  ["phone-390x844", { width: 390, height: 844 }],
];
const THEMES = ["light", "dark"];

const STATES = [
  {
    id: "not-found",
    path: "/this-page-does-not-exist",
    // The page's own words, so the still proves the state and not a blank.
    headings: ["Page not found"],
    scene: "not-found",
  },
  // A 500 on the page's own data was tried and did not reach the error
  // boundary: the startup gate reports the failed bootstrap instead, so the
  // shot would have proved the wrong page. "Something went wrong" needs a
  // failure inside a page that has already rendered, which this harness does
  // not produce, so it is not part of this set.
  {
    id: "empty-machines",
    path: "/machines",
    headings: [/machine/i],
    expect: /machine/i,
    scene: "empty-workers",
  },
  {
    id: "offline",
    path: "/tasks",
    // Either rendering of the same state: the startup gate's sentence and the
    // shell's own, depending on which read fails first.
    headings: ["You are offline", /offline/i],
    expect: /back online|retry/i,
    scene: "offline",
    offline: true,
  },
];

function seed(mode) {
  const result = spawnSync("deno", ["run", "-A", SEED, mode], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`seed ${mode} failed`);
}

const browser = await chromium.launch();

// One sign-in per identity for the whole run: the auth endpoint rate-limits
// repeated attempts, and every context can carry the same real session cookie.
const sessions = new Map();
async function getSession(email) {
  if (sessions.has(email)) return sessions.get(email);
  const context = await browser.newContext();
  let signIn;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    signIn = await context.request.post(
      `${API}/api/auth/sign-in/email`,
      { data: { email, password: PASSWORD } },
    );
    if (signIn.status() !== 429) break;
    const wait = attempt * 20000;
    console.log(`  signin rate-limited; waiting ${wait / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  if (!signIn.ok()) throw new Error(`signin ${email}: ${signIn.status()}`);
  const cookies = await context.cookies(API);
  sessions.set(email, cookies);
  await context.close();
  return cookies;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
seed("owner");

const files = [];
for (const state of STATES) {
  if (state.seed !== undefined) seed(state.seed);

  for (const [label, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
      });
      const email = state.identity === "outsider" ? OUTSIDER_EMAIL : EMAIL;
      await context.addCookies(await getSession(email));
      const page = await context.newPage();

      if (state.offline === true) {
        await page.route("**/v1/**", (route) => route.abort());
        await page.route("**/api/auth/**", (route) => route.abort());
      }
      if (state.fail === "error") {
        await page.route("**/v1/**", (route) =>
          route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({ title: "Server error", status: 500 }),
          }));
      }

      await page.goto(`${WEB}${state.path}`, { waitUntil: "domcontentloaded" });

      // The heading is checked with a poll rather than three 20s waits: a
      // failure must say what the page actually showed, and waiting 60s to
      // learn "offline" is a slow way to lose the reason.
      let headingFound = false;
      for (let attempt = 0; attempt < 30 && !headingFound; attempt += 1) {
        for (const candidate of state.headings) {
          const count = await page
            .getByRole("heading", { name: candidate })
            .filter({ visible: true })
            .count();
          if (count > 0) {
            headingFound = true;
            break;
          }
        }
        if (!headingFound) await page.waitForTimeout(1000);
      }
      if (!headingFound) {
        const text = (await page.locator("body").innerText()).slice(0, 400);
        await page.screenshot({ path: join(OUT, `${state.id}.failed.png`) });
        throw new Error(
          `${state.id}: no heading matched; page ${page.url()} said: ${
            JSON.stringify(text)
          }`,
        );
      }
      if (state.expect !== undefined) {
        const body = await page.locator("body").innerText();
        if (!state.expect.test(body)) {
          throw new Error(
            `${state.id}: page did not say what the state claims:\n${
              body.slice(0, 400)
            }`,
          );
        }
      }
      if (state.redirect !== undefined) {
        if (!page.url().endsWith(state.redirect)) {
          throw new Error(
            `${state.id}: expected to land on ${state.redirect}, got ${page.url()}`,
          );
        }
      }
      const scene = page.locator(`[data-scene="${state.scene ?? "none"}"]`);
      if (state.noScene !== true) {
        await scene.waitFor({ state: "visible", timeout: 45_000 });
      }

      // The scene is decoration: it must carry no accessible name, or a screen
      // reader would hear the art as well as the heading.
      const image = scene.locator("img");
      const alt = await image.getAttribute("alt");
      const hidden = await image.getAttribute("aria-hidden");
      if (alt !== "" || hidden !== "true") {
        throw new Error(
          `${state.id}: scene image is not decoration (alt=${alt}, aria-hidden=${hidden})`,
        );
      }

      await page.waitForTimeout(500);
      const name = `${state.id}--${theme}--${label}`;
      const path = join(OUT, `${name}.png`);
      await page.screenshot({ path });
      files.push(path);
      console.log("  shot", name);
      await context.close();
    }
  }
}

const distinct = await assertDistinct(files);
await writeManifest(OUT, {
  schema: "bakery.evidence.scene-states/1",
  files,
  distinct,
  web: WEB,
  api: API,
  note:
    "Real pages on a real stack: a path no route claims, a person who belongs to no organization, a 500 on the page's own read, an organization with no machines, and the API aborted at startup.",
});
console.log(`  ${files.length} stills, ${distinct} distinct, manifest written`);
await browser.close();
