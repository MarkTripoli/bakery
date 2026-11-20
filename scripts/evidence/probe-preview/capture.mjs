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
// `--only artifact` re-shoots just that group into the same folder, so a single
// failing state does not cost the whole matrix a second sign-in.
const ONLY = args.get("--only") ?? "all";
const KEEP = args.has("--keep");

const DESKTOP = ["desktop-1440x900", { width: 1440, height: 900 }];
const PHONE = ["phone-390x844", { width: 390, height: 844 }];
const LIGHT = "light";
const DARK = "dark";

/** The artifact page's own states, keyed by which seeded artifact they show. */
const ARTIFACT_STATES = [
  {
    // A stored video plays, and its facts line names the length it measured.
    id: "artifact-video",
    artifact: "videoArtifactId",
    // Under a minute there is no zero to state, and the size is the same size the
    // facts line states (#437, UX review).
    says: /Video · 2 s · 310\.3 KB/,
    absent: /0 min 2 s|317705 bytes/,
    views: [[DESKTOP, LIGHT]],
  },
  {
    // The same refusal as the Files panel, on the page that also offered Download
    // in its header: the header must lose that button too (#437).
    id: "artifact-mismatch",
    artifact: "damagedArtifactId",
    says: /does not match its record/i,
    present: /Ask an organization Admin to check it/,
    absent: /try again/i,
    assert: async (page) => {
      if (await page.getByText(/^download/i).count() > 0) {
        throw new Error("artifact page still offers Download");
      }
    },
    views: [[DESKTOP, LIGHT], [PHONE, LIGHT]],
  },
];

/** The task pane's own states: one artifact per seeded task, so the pane picks it. */
const PANE_STATES = [
  {
    // The pane caps the text and fades the cut, so its Open stays above the fold.
    id: "pane-text",
    task: "textTaskId",
    says: /line 1 of a file whose bytes nobody opened/,
    assert: async (page) => {
      const cut = page.locator('[data-cut="panel"]').first();
      const box = await cut.boundingBox();
      if (box === null || box.height > 320) {
        throw new Error(`no pane cut: ${box?.height ?? "absent"}px tall`);
      }
    },
    views: [[DESKTOP, LIGHT]],
  },
  {
    // A file nothing could read, in the pane that has no Download of its own: the
    // sentence is the whole answer, and no button offers what the file cannot give.
    id: "pane-unreadable",
    task: "unreadableTaskId",
    says: /could not be read\./,
    assert: async (page) => {
      const pane = page.locator('[aria-label="Artifact"]').first();
      const scope = (await pane.count()) > 0 ? pane : page;
      if (await scope.getByText(/try again/i).count() > 0) {
        throw new Error("pane offers Try again for a damaged file");
      }
      if (await scope.getByText(/^download/i).count() > 0) {
        throw new Error("pane offers Download for a damaged file");
      }
    },
    views: [[DESKTOP, LIGHT]],
  },
];

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
    // The bytes and the record disagree. Design's answer is the Banner and nothing
    // else: no preview and no Download, because the file is not the file (#437).
    id: "mismatch",
    file: "corrupt.png",
    says: /does not match its record/i,
    present: /Ask an organization Admin to check it/,
    absent: /try again/i,
    assert: async (page) => {
      if (await page.getByText(/^download/i).count() > 0) {
        throw new Error("mismatch still offers Download");
      }
    },
    views: [[DESKTOP, LIGHT], [PHONE, LIGHT]],
  },
  {
    // A video the panel plays, with the length the sandbox measured under it. The
    // facts line is the promise: without it the panel has a player and no answer.
    id: "panel-video",
    file: "walkthrough.mp4",
    play: true,
    says: /Video · 2 s · 310\.3 KB/,
    assert: async (page) => {
      const player = page.locator("video").first();
      if (await player.count() === 0) throw new Error("no player in the panel");
      const box = await player.boundingBox();
      if (box === null || box.height < 40) {
        throw new Error(`player is ${box?.height ?? "absent"}px tall`);
      }
      // A frame only comes from the bytes themselves: HAVE_CURRENT_DATA means the
      // element decoded one, where a black rectangle could be any failure at all.
      // The clip is small but the decode is not instant, so this waits for it.
      let ready = 0;
      for (let wait = 0; wait < 20; wait += 1) {
        ready = await player.evaluate((node) => node.readyState);
        if (ready >= 2) break;
        await player.evaluate((node) => node.play().catch(() => {}))
          .catch(() => {});
        await page.waitForTimeout(500);
      }
      if (ready < 2) {
        throw new Error(`the player never decoded a frame (${ready})`);
      }
    },
    views: [[DESKTOP, LIGHT]],
  },
  {
    // A damaged video in the panel, met through Download rather than Play: the
    // panel's own read is refused, and the preview must say the same thing the
    // player would have said -- banner, no player, and nothing offered that the
    // file cannot give (#437). Both paths end in this one picture, so one still
    // proves it; a second, identical still would prove neither.
    id: "panel-video-download-mismatch",
    file: "walkthrough-cut.mp4",
    download: true,
    says: /does not match its record/i,
    assert: async (page) => {
      if (await page.locator("video").count() > 0) {
        throw new Error("damaged video still rendered a player");
      }
      for (const label of [/^download/i, /^open/i]) {
        if (await page.getByText(label).count() > 0) {
          throw new Error(`damaged video offers ${label}`);
        }
      }
    },
    views: [[DESKTOP, LIGHT]],
  },
  {
    // The same refusal, then a healthy file chosen from the same panel: the
    // refusal belongs to the bytes it was found on, so the next file must show
    // its own preview and not be blamed for them (#437 review).
    id: "panel-mismatch-then-another-file",
    file: "walkthrough-cut.mp4",
    download: true,
    says: /does not match its record/i,
    then: { file: "walkthrough.mp4", says: /Video · 2 s · 310\.3 KB/ },
    assert: async (page) => {
      if (await page.getByText(/does not match its record/i).count() > 0) {
        throw new Error("the next file kept the previous file's refusal");
      }
    },
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
  return {
    ids: byName,
    folder,
    task: parsed.task ?? {},
    pane: parsed.pane ?? {},
  };
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

if (!KEEP) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const seeded = seed();
const ids = seeded.ids;
const folder = seeded.folder;

// A player is asked to play by the capture, not by a person, so the browser's
// autoplay policy would otherwise refuse the play() that fetches the bytes.
const browser = await chromium.launch({
  // A download would land in a file picker; keep it off the disk.
  downloadsPath: OUT,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
/**
 * Do what a person does before the state exists: press Download, or press Play.
 * Both are retried by the poll below, because the element and the button arrive
 * with the preview query's answer, and a click that lands too early is lost.
 */
async function trigger(page, state) {
  if (state.download === true) {
    const button = page.getByRole("button", { name: /^download/i }).first();
    if (await button.count() > 0) await button.click().catch(() => {});
  }
  if (state.play === true) {
    const player = page.locator("video, audio").first();
    if (await player.count() > 0) {
      await player.evaluate((node) => node.play().catch(() => {}))
        .catch(() => {});
    }
  }
}

const files = [];
for (const state of ONLY === "artifact" ? [] : STATES) {
  const context = await browser.newContext({
    viewport: DESKTOP[1],
    colorScheme: LIGHT,
    deviceScaleFactor: 1,
    acceptDownloads: true,
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
    // A player is given its address with preload="none": nothing is fetched until
    // someone asks it to play, so a still of a video that was never played would
    // show a black rectangle and prove nothing about the bytes.
    await trigger(page, state);

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
      // A click or a play that landed before the element existed is lost, so the
      // gesture is repeated while the sentence is still missing.
      if (!found && attempt > 0 && attempt % 3 === 0) {
        await trigger(page, state);
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
    // A state may name a second file to select afterwards: the panel keeps its
    // flag across a file change, which is exactly what is being proved.
    if (state.then !== undefined) {
      const nextId = ids[state.then.file];
      if (nextId === undefined) {
        throw new Error(`seed did not name ${state.then.file}`);
      }
      await page.goto(
        `${WEB}/files/${encodeURIComponent(folder)}?file=${nextId}`,
        { waitUntil: "load" },
      );
      await page.waitForLoadState("networkidle").catch(() => {});
      body = "";
      let next = false;
      for (let attempt = 0; attempt < 30 && !next; attempt += 1) {
        body = await page.locator("body").innerText();
        next = state.then.says.test(body);
        if (!next) await page.waitForTimeout(1000);
      }
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

for (
  const state of ONLY === "pane" || ONLY === "files" ? [] : ARTIFACT_STATES
) {
  const artifactId = seeded.task[state.artifact];
  const taskId = seeded.task.taskId;
  if (artifactId === undefined || taskId === undefined) {
    throw new Error(`seed did not name ${state.artifact}`);
  }
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
    await page.goto(`${WEB}/tasks/${taskId}/artifacts/${artifactId}`, {
      waitUntil: "load",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    let body = "";
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      body = await page.locator("body").innerText();
      found = state.says.test(body);
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
    if (state.present !== undefined && !state.present.test(body)) {
      throw new Error(`${state.id}: page never said ${state.present}`);
    }
    if (state.absent !== undefined && state.absent.test(body)) {
      throw new Error(`${state.id}: page said ${state.absent}, and must not`);
    }
    if (state.assert !== undefined) await state.assert(page);
    const name = `${state.id}--${theme}--${viewport[0]}`;
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    files.push(path);
    console.log("  shot", name);
  }
  await context.close();
}

for (
  const state of ONLY === "files" || ONLY === "artifact" ? [] : PANE_STATES
) {
  const taskId = seeded.pane[state.task];
  if (taskId === undefined) throw new Error(`seed did not name ${state.task}`);
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
    await page.goto(`${WEB}/tasks/${taskId}`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => {});
    let body = "";
    let found = false;
    for (let attempt = 0; attempt < 40 && !found; attempt += 1) {
      body = await page.locator("body").innerText();
      found = state.says.test(body);
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
    if (state.assert !== undefined) await state.assert(page);
    const name = `${state.id}--${theme}--${viewport[0]}`;
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    files.push(path);
    console.log("  shot", name);
  }
  await context.close();
}

// A partial run reports only what it shot, so the manifest never claims more
// than the folder holds.
const shot = KEEP
  ? (await Promise.all([])).length === 0 ? files : files
  : files;
const distinct = await assertDistinct(shot);
await writeManifest(OUT, {
  schema: "bakery.evidence.probe-preview/1",
  files: shot,
  distinct,
  // The commit the stills were taken from, so the set can be checked against the
  // diff it is evidence for.
  head: args.get("--head") ?? "",
  web: WEB,
  api: API,
  note:
    "The file page on a real stack, over seeded answers: 42 lines counted from a markdown file, a PNG measured 2 x 2, a refusal about the file (no Try again), a refusal about the host (Try again), a refusal at a limit (size and limit as two numbers), and an older version showing its own 12 lines. The answers are rows the seed writes; measuring them for real needs a systemd user bus this host cannot build (mini1 can).",
});
console.log(`  ${files.length} stills, ${distinct} distinct, manifest written`);
await browser.close();
