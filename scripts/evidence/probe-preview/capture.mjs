#!/usr/bin/env node
// Captures what a file's bytes are on the real file page, and refuses to keep a
// still that does not prove the state it claims.
//
//   node scripts/evidence/probe-preview/capture.mjs \
//     --web http://127.0.0.1:5199 --api http://127.0.0.1:32807 \
//     --out ~/rig-logs/stills/437-slice3
//
// One page, the states a probe answer can earn, seeded by seed.ts:
//
//   described-text    a markdown file the sandbox counted: "42 lines", cut under a fade
//                     (Download and the tabs stay above the fold, asserted, not assumed)
//   described-image   a PNG the sandbox measured 2 x 2
//   refused           a refusal about the file: no Try again
//   host-unavailable  a refusal about the host: Try again, and only here
//   too-large         a refusal at a limit: the file's size and the limit, two numbers
//   older-version     ?version=1: the older version's own facts line
//
// The method is the badge- and scene-state captures', because the rules are the same:
// assert the precondition before the shot, never after; assert the page's own words,
// so a shot cannot prove a blank; hash every still and fail on a duplicate.
//
// What this set is not: it is not a proof that the sandbox can measure anything. The
// answers are rows in `blob_probes`, written by the seed, because building a sandbox
// unit needs a systemd user bus this host cannot give (mini1 can, and the integration
// lane does). These stills are about what the page does with an answer.
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
const API = args.get("--api") ?? "http://127.0.0.1:32807";
const OUT = args.get("--out") ?? "stills/437-slice3";
const EMAIL = args.get("--email") ?? "evidence@example.test";
const PASSWORD = args.get("--password") ?? "Evidence-Pass-1";
const SEED = new URL("./seed.ts", import.meta.url).pathname;

const DESKTOP = ["desktop-1440x900", { width: 1440, height: 900 }];
const PHONE = ["phone-390x844", { width: 390, height: 844 }];
const LIGHT = "light";
const DARK = "dark";

/**
 * Each state names what its words must say. The numbers are the point: "42 lines"
 * and "2 x 2" are measurements, and a still showing the word "Image" alone would
 * look right and prove nothing.
 */
const STATES = [
  // The four states the page has always had, on the whole matrix.
  {
    // The text is cut at the panel's cap, under a fade, so Download and the tabs
    // stay above the fold; the still has to show the cut and the button.
    id: "described-text",
    file: "release-notes.md",
    says: /42 lines/,
    assert: async (page) => {
      const cut = page.locator('[data-cut="panel"]').first();
      const box = await cut.boundingBox();
      if (box === null || box.height > 320) {
        throw new Error(`no cut preview: ${box?.height ?? "absent"}px tall`);
      }
      // Download is the promise: on the first screen, not below it.
      const download = page.getByText(/download/i).first();
      const at = await download.boundingBox();
      if (at === null || at.y > 900) {
        throw new Error(`Download at ${at?.y ?? "absent"}px`);
      }
    },
    views: [[DESKTOP, LIGHT], [DESKTOP, DARK], [PHONE, LIGHT], [PHONE, DARK]],
  },
  {
    id: "described-image",
    file: "pixel.png",
    says: /2\s*×\s*2/,
    views: [[DESKTOP, LIGHT], [DESKTOP, DARK], [PHONE, LIGHT], [PHONE, DARK]],
  },
  {
    // A refusal that is the file's own: the sandbox looked and would not go on.
    // Nothing here is worth trying again, so no button offers to.
    id: "refused",
    file: "scan.dat",
    says: /could not be read\./,
    absent: /try again/i,
    views: [[DESKTOP, LIGHT], [DESKTOP, DARK], [PHONE, LIGHT], [PHONE, DARK]],
  },
  // The states design asked for at this head (#437, UX review).
  {
    // A refusal that is the host's: the only state that earns "Try again".
    id: "host-unavailable",
    file: "stalled.bin",
    says: /previews are not available right now/i,
    present: /try again/i,
    views: [[DESKTOP, LIGHT]],
  },
  {
    // The file's size and the limit are two numbers, not one repeated.
    id: "too-large",
    file: "huge.log",
    says: /64 B; the limit is 32 B/,
    views: [[DESKTOP, LIGHT]],
  },
  {
    // An older version carries its own answer: 12 lines, not the current 42.
    id: "older-version",
    file: "changelog.md",
    version: 1,
    says: /12 lines/,
    absent: /42 lines/,
    views: [[DESKTOP, LIGHT]],
  },
];

/** Runs the seed and returns the file ids it wrote, keyed by name. */
function seed() {
  const result = spawnSync("deno", ["run", "-A", SEED], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("seed failed");
  const line = (result.stdout ?? "").trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line);
  const byName = {};
  for (const [key, value] of Object.entries(parsed.files ?? {})) {
    byName[value.name] = value.id;
    console.error(`  seed ${key}: ${value.path} ${value.id}`);
  }
  // The folder is the first segment of the seeded path, which is where the page
  // must be opened for the file to be in the list it searches.
  const first = Object.values(parsed.files ?? {})[0];
  if (first === undefined) throw new Error("seed wrote no files");
  const folder = first.path.split("/").filter((part) => part !== "")[0];
  return { ids: byName, folder };
}

async function signIn(context) {
  let response;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    response = await context.request.post(`${API}/api/auth/sign-in/email`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    if (response.status() !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 20000));
  }
  if (!response?.ok()) throw new Error(`signin: ${response?.status()}`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const seeded = seed();
const ids = seeded.ids;
const folder = seeded.folder;

const browser = await chromium.launch();
const files = [];
for (const state of STATES) {
  const context = await browser.newContext({
    viewport: DESKTOP[1],
    colorScheme: LIGHT,
    deviceScaleFactor: 1,
  });
  await signIn(context);
  const page = await context.newPage();
  for (const [viewport, theme] of state.views) {
    await page.setViewportSize(viewport[1]);
    await page.emulateMedia({ colorScheme: theme });
    // The file page selects by id, so the seed's path becomes the file's id.
    const fileId = ids[state.file];
    if (fileId === undefined) {
      throw new Error(`seed did not name ${state.file}`);
    }
    const query = state.version === undefined
      ? `file=${fileId}`
      : `file=${fileId}&version=${state.version}`;
    await page.goto(
      `${WEB}/files/${encodeURIComponent(folder)}?${query}`,
      { waitUntil: "load" },
    );
    await page.waitForLoadState("networkidle").catch(() => {});

    // The state's own sentence, polled: a page that is still loading must not be
    // photographed as if it were a result.
    let body = "";
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      body = await page.locator("body").innerText();
      found = state.says.test(body);
      // A dev server that re-optimises dependencies reloads the page under the
      // capture, leaving an empty body. Reload once rather than photograph it.
      if (!found && attempt === 10) {
        await page.reload({ waitUntil: "load" }).catch(() => {});
      }
      if (!found) await page.waitForTimeout(1000);
    }
    if (!found) {
      await page.screenshot({ path: join(OUT, `${state.id}.failed.png`) });
      throw new Error(
        `${state.id}: page did not say ${state.says}; it said ${
          JSON.stringify(body.slice(0, 400))
        }`,
      );
    }
    // A sentence that must not be there, checked while the whole body is in hand:
    // "Try again" on a damaged file and "42 lines" on an older version are both
    // mistakes a still would not reveal.
    if (state.present !== undefined && !state.present.test(body)) {
      throw new Error(`${state.id}: page never said ${state.present}`);
    }
    if (state.absent !== undefined && state.absent.test(body)) {
      throw new Error(`${state.id}: page said ${state.absent}, and must not`);
    }
    // The facts line sits under the preview, and the details panel is its own
    // scroller: a still that stops above it shows the file and not the point.
    const fact = page.getByText(state.says).first();
    if (await fact.count() > 0) {
      await fact.scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.waitForTimeout(400);
    if (state.assert !== undefined) await state.assert(page);
    const name = `${state.id}--${theme}--${viewport[0]}`;
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    files.push(path);
    console.log("  shot", name);
  }
  await context.close();
}

const distinct = await assertDistinct(files);
await writeManifest(OUT, {
  schema: "bakery.evidence.probe-preview/1",
  files,
  distinct,
  web: WEB,
  api: API,
  note:
    "The file page on a real stack, over seeded answers: 42 lines counted from a markdown file, a PNG measured 2 x 2, a refusal about the file (no Try again), a refusal about the host (Try again), a refusal at a limit (size and limit as two numbers), and an older version showing its own 12 lines. The answers are rows the seed writes; measuring them for real needs a systemd user bus this host cannot build (mini1 can).",
});
console.log(`  ${files.length} stills, ${distinct} distinct, manifest written`);
await browser.close();
