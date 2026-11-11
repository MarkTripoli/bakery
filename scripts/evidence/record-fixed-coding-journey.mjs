#!/usr/bin/env node
// Records the fixed coding preset journey as PR evidence.
//
// It runs the phase-5 journey e2e (real API, Inngest, production worker, web
// dev server) with `BAKERY_JOURNEY_RECORD_DIR` set, so the shared browser
// driver (apps/web/tests/helpers/fixed-coding-journey-browser.mjs) records one
// video per phase plus screenshots. This script then stitches the journey
// videos, builds the Paper side-by-sides and writes a manifest with sha256
// values. It uploads nothing.
//
// Run it under the shared verification lock with DOCKER_HOST and a private
// TMPDIR set (scripts/dev/compose-up.sh):
//   node scripts/evidence/record-fixed-coding-journey.mjs --out <dir>

import process from "node:process";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MOCKS = join(ROOT, "docs/technical-design/enterprise-mocks");
const JOURNEY_TEST = "tests/e2e/fixed-coding-preset-journey_test.ts";

const CAPTION =
  "TEST-ONLY SCRIPTED HARNESS: this completed run uses the test-only scripted harness. " +
  'Production shows the honest "no coding harness" failure when no harness is configured.';

// Narrative order of the journey: submit, run, controls, artifact. Phases are
// separate browsers on separate tasks, so the stitched video is a sequence of
// the same flow's parts, labeled by phase in the manifest.
const DESKTOP_JOURNEY = [
  "submit",
  "progress",
  "reconnect",
  "pauseResume",
  "race",
  "artifact",
];
const PHONE_JOURNEY = ["phoneCreate", "phoneReload"];
const STATE_VIDEOS = {
  "blocked-run": "blocked",
  "reconnect-after-offline": "reconnect",
  "cancel-race-server-winner": "race",
};
const CAPTION_FREE_SHOTS = [
  "desktop-queue.png",
  "desktop-session.png",
  "phone-queue.png",
  "phone-session.png",
];
const FRAME_FPS = 4;
const SIDE_BY_SIDES = [
  ["queue-desktop", "desktop-queue.png", "paper-queue.jpg"],
  ["session-desktop", "desktop-session.png", "paper-session.jpg"],
  ["queue-phone", "phone-queue.png", "paper-phoneQueue.jpg"],
  ["session-phone", "phone-session.png", "paper-phoneSession.jpg"],
];

function parseArgs(argv) {
  const args = { out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") args.out = argv[++index];
    else if (flag.startsWith("--out=")) args.out = flag.slice("--out=".length);
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!args.out) throw new Error("Usage: --out <output directory>");
  return { out: resolve(args.out) };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const log = options.logPath ? createWriteStream(options.logPath) : null;
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const sink = (chunk) => {
      output += chunk;
      log?.write(chunk);
      process.stderr.write(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", sink);
    child.stderr.setEncoding("utf8").on("data", sink);
    child.on("error", fail);
    child.on("close", (code) => {
      log?.end();
      done({ code: code ?? 1, output });
    });
  });
}

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr}`);
  }
}

/** Raw phase videos are named `NN-phase-viewport.webm` by the shared driver. */
async function phaseVideos(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".webm"))
    .sort();
  return names.map((name) => {
    const [, phase, viewport] = /^\d+-(.+)-(desktop|phone)\.webm$/.exec(name) ??
      [];
    return { name, path: join(dir, name), phase, viewport };
  }).filter((entry) => entry.phase);
}

async function stitch(videos, phases, viewport, target) {
  const parts = phases.flatMap((phase) => {
    const found = videos.filter((video) =>
      video.phase === phase && video.viewport === viewport
    );
    // Repeated phases (the blocked check runs twice) keep only the first.
    return found.length > 0 ? [found[0]] : [];
  });
  if (parts.length === 0) throw new Error(`no ${viewport} journey videos`);
  const list = `${target}.list.txt`;
  await writeFile(
    list,
    parts.map((part) => `file '${part.path.replaceAll("'", "'\\''")}'`)
      .join("\n"),
  );
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "28",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-movflags",
    "+faststart",
    target,
  ]);
  await rm(list);
  return parts.map((part) => part.phase);
}

function transcode(source, target) {
  ffmpeg([
    "-i",
    source,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "28",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-movflags",
    "+faststart",
    target,
  ]);
}

async function sideBySide(browser, target, label, livePath, paperPath) {
  const page = await browser.newPage({
    viewport: { width: 2600, height: 1100 },
  });
  try {
    const html = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;background:#222;color:#fff;font:600 16px system-ui,sans-serif}
  main{display:flex;gap:16px;padding:16px;align-items:flex-start}
  figure{margin:0}figcaption{padding:0 0 8px}
  img{display:block;max-height:1000px;max-width:1260px;width:auto;height:auto;background:#fff}
</style>
<main>
  <figure><figcaption>Paper reference: ${basename(paperPath)}</figcaption>
    <img src="${pathToFileURL(paperPath)}" alt="Paper reference"></figure>
  <figure><figcaption>Bakery live: ${label} (real e2e stack, test-only scripted harness; caption removed to match Paper framing)</figcaption>
    <img src="${pathToFileURL(livePath)}" alt="Bakery live"></figure>
</main>`;
    const htmlPath = `${target}.html`;
    await writeFile(htmlPath, html);
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction(() =>
      [...document.images].every((image) =>
        image.complete && image.naturalWidth > 0
      )
    );
    await page.screenshot({ path: target, fullPage: true });
    await rm(htmlPath);
  } finally {
    await page.close();
  }
}

/**
 * Fraction-tested caption band: the bottom 4 px of the viewport sit inside
 * the caption's padding, a flat red (about rgb 131,39,39). A frame passes when
 * at least 80 percent of that strip matches.
 */
function bandFrames(path, sampleFps) {
  const probe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width",
    "-of",
    "csv=p=0",
    path,
  ], { encoding: "utf8" });
  const width = Number.parseInt(probe.stdout, 10);
  if (probe.status !== 0 || !(width > 0)) {
    throw new Error(`ffprobe failed for ${path}`);
  }
  const vf = `${sampleFps ? `fps=${sampleFps},` : ""}crop=iw:4:0:ih-4`;
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    path,
    "-vf",
    vf,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ], { maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg frame check failed: ${result.stderr}`);
  }
  const frameBytes = width * 3 * 4;
  const data = result.stdout;
  const frames = Math.floor(data.length / frameBytes);
  let withBand = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let match = 0;
    const base = frame * frameBytes;
    for (let offset = 0; offset < frameBytes; offset += 3) {
      const r = data[base + offset];
      const g = data[base + offset + 1];
      const b = data[base + offset + 2];
      if (r >= 100 && r <= 165 && g <= 80 && b <= 80 && r - g >= 50) {
        match += 1;
      }
    }
    if (match >= (width * 4) * 0.8) withBand += 1;
  }
  return { frames, withCaption: withBand, withoutCaption: frames - withBand };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  if (!process.env.DOCKER_HOST?.trim()) {
    throw new Error("DOCKER_HOST_REQUIRED");
  }
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) {
    throw new Error(`Output directory is not empty: ${out}`);
  }
  const dirs = {
    raw: join(out, "raw"),
    videos: join(out, "videos"),
    screenshots: join(out, "screenshots"),
    sideBySide: join(out, "side-by-side"),
    logs: join(out, "logs"),
  };
  await Promise.all(
    Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })),
  );

  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim().length > 0;

  // The shared driver writes into raw/{videos,screenshots}.
  const e2e = await run(
    "pnpm",
    ["test:e2e", "--", JOURNEY_TEST],
    {
      logPath: join(dirs.logs, "e2e-journey.log"),
      env: {
        BAKERY_JOURNEY_RECORD_DIR: dirs.raw,
        BAKERY_JOURNEY_CAPTION: CAPTION,
      },
    },
  );
  const phases = [...e2e.output.matchAll(/JOURNEY_PHASE=([A-Za-z]+):passed/g)]
    .map((match) => match[1]);
  if (e2e.code !== 0) {
    throw new Error(
      `JOURNEY_E2E_FAILED:${e2e.code} (see logs/e2e-journey.log)`,
    );
  }

  const raw = await phaseVideos(join(dirs.raw, "videos"));
  const files = [];
  const add = (path, kind, extra = {}) => files.push({ path, kind, ...extra });

  // Journey videos: submit, run, controls, artifact on desktop; phone create and reload.
  const desktopPhases = await stitch(
    raw,
    DESKTOP_JOURNEY,
    "desktop",
    join(dirs.videos, "journey-desktop.mp4"),
  );
  add(join(dirs.videos, "journey-desktop.mp4"), "journey-video", {
    viewport: "desktop",
    phases: desktopPhases,
  });
  const phonePhases = await stitch(
    raw,
    PHONE_JOURNEY,
    "phone",
    join(dirs.videos, "journey-phone.mp4"),
  );
  add(join(dirs.videos, "journey-phone.mp4"), "journey-video", {
    viewport: "phone",
    phases: phonePhases,
  });

  // State videos: one per notable state.
  for (const [state, phase] of Object.entries(STATE_VIDEOS)) {
    const source = raw.find((video) =>
      video.phase === phase && video.viewport === "desktop"
    );
    if (!source) throw new Error(`no video for state ${state}`);
    const target = join(dirs.videos, `state-${state}.mp4`);
    transcode(source.path, target);
    add(target, "state-video", { state, phase });
  }

  // Screenshots, then Paper side-by-sides.
  const shots = join(dirs.raw, "screenshots");
  const shotNames = (await readdir(shots)).filter((name) =>
    name.endsWith(".png")
  ).sort();
  for (const name of shotNames) {
    await copyFile(join(shots, name), join(dirs.screenshots, name));
    add(join(dirs.screenshots, name), "screenshot");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [label, shot, paper] of SIDE_BY_SIDES) {
      const live = join(dirs.screenshots, shot);
      const reference = join(MOCKS, paper);
      if (!(await exists(live))) throw new Error(`missing screenshot ${shot}`);
      if (!(await exists(reference))) {
        throw new Error(`missing Paper reference ${paper}`);
      }
      const target = join(dirs.sideBySide, `${label}.png`);
      await sideBySide(browser, target, label, live, reference);
      add(target, "side-by-side", { live: shot, paper });
    }
  } finally {
    await browser.close();
  }
  add(join(dirs.logs, "e2e-journey.log"), "terminal-log");

  // Self-check: every sampled video frame and every captioned screenshot must
  // carry the scripted-harness band.
  const captionChecks = { fps: FRAME_FPS, videos: [], screenshots: [] };
  for (const file of files.filter((f) => f.kind.endsWith("video"))) {
    const counts = bandFrames(file.path, FRAME_FPS);
    captionChecks.videos.push({ path: relative(out, file.path), ...counts });
  }
  for (const file of files.filter((f) => f.kind === "screenshot")) {
    const free = CAPTION_FREE_SHOTS.includes(basename(file.path));
    const counts = bandFrames(file.path);
    const ok = free ? counts.withCaption === 0 : counts.withCaption === 1;
    captionChecks.screenshots.push({
      path: relative(out, file.path),
      expected: free ? "caption-free" : "caption",
      withCaption: counts.withCaption === 1,
      ok,
    });
  }
  console.log(`CAPTION_CHECKS=${JSON.stringify(captionChecks)}`);
  const badVideos = captionChecks.videos.filter((v) =>
    v.frames === 0 || v.withoutCaption > 0
  );
  const badShots = captionChecks.screenshots.filter((s) => !s.ok);
  if (badVideos.length > 0 || badShots.length > 0) {
    await writeFile(
      join(out, "caption-check-failed.json"),
      `${JSON.stringify({ badVideos, badShots, captionChecks }, null, 2)}\n`,
    );
    throw new Error(
      `CAPTION_CHECK_FAILED videos=${badVideos.length} screenshots=${badShots.length}`,
    );
  }
  await rm(dirs.raw, { recursive: true, force: true });

  const entries = [];
  for (const file of files) {
    const info = await stat(file.path);
    entries.push({
      ...file,
      path: relative(out, file.path),
      bytes: info.size,
      sha256: await sha256(file.path),
    });
  }
  const manifest = {
    schema: "bakery.fixed-coding-journey-evidence/v1",
    generatedAt: new Date().toISOString(),
    head,
    workingTreeDirty: dirty,
    caption: CAPTION,
    harness: "test-only scripted harness (BAKERY_WORKER_SCRIPTED_HARNESS_DIR)",
    command: `pnpm test:e2e -- ${JOURNEY_TEST}`,
    phasesPassed: [...new Set(phases)],
    captionChecks,
    captionFreeScreenshots: CAPTION_FREE_SHOTS.map((name) => ({
      path: `screenshots/${name}`,
      reason:
        "kept caption-free to match the Paper framing; its side-by-side label names the test-only scripted harness",
    })),
    files: entries,
  };
  await writeFile(
    join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `EVIDENCE_MANIFEST=${join(out, "manifest.json")} files=${entries.length}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
