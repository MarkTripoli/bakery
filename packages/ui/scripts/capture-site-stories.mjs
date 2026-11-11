// Captures the Storybook story candidates of a site-rendered Paper manifest
// (a design case whose `candidate` names a `storyId` and a `wholeArtboard`
// binding, see packages/ui/catalog/design-cases.ts). The semantics follow the
// K-0 whole-artboard contract of the light detail cases:
//
// - the story renders from the built Storybook at the case's own viewport,
//   theme, pointer, locale and direction, with the case's reduced motion;
// - the registered runtime assertions run before and after capture;
// - the qualification region must be visible, accessible and above the
//   artboard, and the artboard element must equal the artboard size
//   (observeWholeArtboard, by import);
// - the complete UI, qualification included, is recorded as a native viewport
//   bundle (captureViewportBundleV2, by import);
// - only the artboard element is scored: it is scrolled to the viewport top
//   and screenshotted at its own integer box.
//
// Unlike K-0, the reference is a Chromium render, not Paper's PNG export, so no
// Paper-export raster reconciliation (paper-k0-raster offset) is applied.
// capture-stories.mjs and the other K-0 modules are pinned: they are only
// imported here, never edited.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { artifactsDirectoryFor, manifestProfile } from "./paper-manifests.mjs";
import { enterpriseLaunchOptions } from "./render-enterprise-references.mjs";
import { fontDigests } from "./render-paper-references.mjs";
import {
  observeWholeArtboard,
  wholeArtboardObservationIssues,
} from "./paper-whole-artboard.mjs";
import { expectedWorkerQualification } from "./native-viewport-bundle-v2.mjs";
import { viewportBundleIdentity } from "./native-viewport-bundle.mjs";
import { pngDimensions } from "./image-score.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const uiRoot = join(root, "packages/ui");
const tokenPath = join(root, "docs/technical-design/ui-baselines/tokens.json");
const runtimePath = join(
  root,
  "docs/technical-design/ui-baselines/runtime-cases.json",
);
const catalogPath = join(
  root,
  "docs/technical-design/ui-baselines/components.json",
);
const ANIMATION_KILL_STYLE =
  "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function isStoryCandidate(designCase) {
  return typeof designCase?.candidate?.storyId === "string" &&
    designCase.candidate.wholeArtboard !== undefined;
}

// The runtime context a story case is captured under: the case's declared
// inputs, its theme as the stored preference, UTC, zoom 1.
export function storyContext(designCase) {
  return {
    viewport: designCase.viewport,
    dpr: designCase.dpr,
    theme: designCase.theme,
    storedPreference: designCase.theme,
    pointer: designCase.pointer,
    locale: designCase.locale,
    direction: designCase.direction,
    timezone: "UTC",
    reducedMotion: designCase.candidate.reducedMotion,
    zoom: 1,
    interaction: "load",
  };
}

// The registered runtime case whose assertions the capture runs: the unique
// runtime case for the same story, args, theme and pointer outside any Paper
// binding. Its id names the assertions; the case's own context is used.
export function runtimeContractFor(designCase, runtime) {
  const matches = runtime.cases.filter((entry) => {
    const context = runtime.contexts[entry.context];
    return entry.storyId === designCase.candidate.storyId &&
      same(entry.args, designCase.candidate.args) &&
      !entry.paperBaselineId && context?.theme === designCase.theme &&
      context?.pointer === designCase.pointer &&
      context?.viewport?.width <= designCase.viewport.width &&
      context?.locale === designCase.locale &&
      context?.direction === designCase.direction && context?.zoom === 1 &&
      context?.interaction === "load";
  });
  if (matches.length !== 1) {
    throw new Error(
      `${designCase.id}: expected one registered runtime case for ${designCase.candidate.storyId} in ${designCase.theme}/${designCase.pointer}, found ${matches.length}`,
    );
  }
  return matches[0];
}

async function storybookBuildDigest(directory) {
  const files = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk(directory);
  const lines = await Promise.all(
    files.sort().map(async (path) =>
      `${relative(directory, path)}\0${sha256(await readFile(path))}\n`
    ),
  );
  return sha256(lines.join(""));
}

async function untrackedSourceMaterial() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  const entries = [];
  for (const path of paths) {
    const details = await stat(join(root, path)).catch(() => null);
    if (!details?.isFile()) continue;
    entries.push(`${path}\0${sha256(await readFile(join(root, path)))}\0`);
  }
  return entries.sort().join("");
}

export function parseStoryCaptureArguments(argv) {
  const args = {
    storybookDirectory: join(uiRoot, "storybook-static"),
    only: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--" || argument === "--all" || argument === "--changed") {
      // Story cases are always captured: a manifest of story candidates is
      // small, and every case scores.
      continue;
    }
    // Accepted so the CI site loop can call every capture alike; story cases
    // never load the web app.
    if (argument === "--web-base-url") index++;
    else if (argument === "--storybook-dir") {
      args.storybookDirectory = resolve(argv[++index]);
    } else if (argument === "--only") args.only.push(argv[++index]);
    else throw new Error(`Unknown capture argument ${argument}`);
  }
  return args;
}

async function captureOne({
  browser,
  baseURL,
  designCase,
  metadata,
  runtime,
  catalog,
  helpers,
  outputDirectory,
}) {
  const { storyUrl, runtimeAssertions } = helpers;
  const contract = runtimeContractFor(designCase, runtime);
  const catalogEntry = catalog.entries.find((entry) =>
    entry.id === contract.catalogId
  );
  if (!catalogEntry) {
    throw new Error(`${designCase.id}: unknown catalog ${contract.catalogId}`);
  }
  const context = storyContext(designCase);
  const binding = designCase.candidate.wholeArtboard;
  const story = {
    storyId: designCase.candidate.storyId,
    args: designCase.candidate.args,
  };
  const url = storyUrl(baseURL, story, context);
  const record = {
    id: designCase.id,
    kind: "story",
    catalogId: contract.catalogId,
    requiredCaseId: contract.requiredCaseId,
    runtimeCaseId: contract.id,
    storyId: story.storyId,
    storyURL: url,
    paperBaselineId: designCase.id,
    sourceCommit: metadata.sourceCommit,
    sourceDirty: metadata.sourceDirty,
    sourceDiffDigest: metadata.sourceDiffDigest,
    storybookBuildDigest: metadata.storybookBuildDigest,
    componentSourceDigest: null,
    tokenRevision: metadata.tokenRevision,
    tokenDigest: metadata.tokenDigest,
    browser: "chromium",
    browserVersion: metadata.browserVersion,
    playwrightVersion: metadata.playwrightVersion,
    os: metadata.os,
    viewport: context.viewport,
    dpr: context.dpr,
    pointer: context.pointer,
    colorScheme: context.theme,
    storedPreference: context.storedPreference,
    locale: context.locale,
    direction: context.direction,
    timezone: context.timezone,
    reducedMotion: context.reducedMotion,
    zoom: context.zoom,
    animationDisabled: true,
    fontDigests: metadata.fontDigests,
    assertions: contract.assertions ?? [],
  };
  const runtimeCase = { ...contract, id: contract.id };
  const caseDirectory = join(outputDirectory, "images");
  const bundleDirectory = join(caseDirectory, `${designCase.id}.full-ui`);
  const parityPath = join(caseDirectory, `${designCase.id}.whole-artboard.png`);
  await mkdir(caseDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const browserContext = await browser.newContext({
    viewport: context.viewport,
    deviceScaleFactor: context.dpr,
    colorScheme: context.theme,
    locale: context.locale,
    timezoneId: context.timezone,
    reducedMotion: context.reducedMotion,
    hasTouch: context.pointer === "coarse",
  });
  await browserContext.addInitScript(({ key, value }) => {
    localStorage.setItem(key, value);
  }, { key: "bakery.theme.v1", value: context.storedPreference });
  const page = await browserContext.newPage();
  let fullUIBundle;
  let parity;
  let observation;
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".storybook-story").waitFor({ state: "visible" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.documentElement.dataset.runtimeCase = "true";
    });
    await page.addStyleTag({ content: ANIMATION_KILL_STYLE });
    await runtimeAssertions(page, runtimeCase, context, catalogEntry);
    const artboard = designCase.artboard;
    observation = await observeWholeArtboard(page, binding);
    const observationIssues = wholeArtboardObservationIssues(
      observation,
      artboard,
    );
    if (observationIssues.length) {
      throw new Error(`Whole artboard: ${observationIssues.join("; ")}`);
    }
    const identity = viewportBundleIdentity(record);
    fullUIBundle = (await helpers.captureViewportBundleV2(page, {
      root,
      directory: bundleDirectory,
      identity,
      expectedQualification: await expectedWorkerQualification(record),
      qualificationSelector: binding.qualificationSelector,
    })).reference;
    const original = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    try {
      await page.evaluate((selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        scrollTo(0, box.y + scrollY);
      }, binding.targetSelector);
      const state = await page.evaluate(({ selector, pointer }) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          viewport: { width: innerWidth, height: innerHeight },
          pointer: matchMedia(`(pointer: ${pointer})`).matches,
        };
      }, { selector: binding.targetSelector, pointer: context.pointer });
      if (
        !same(state.box, { x: 0, y: 0, ...artboard }) ||
        state.viewport.width < artboard.width ||
        state.viewport.height < artboard.height || !state.pointer
      ) {
        throw new Error(
          `Whole artboard: target must fill the viewport origin at its natural size with the declared pointer; observed ${
            JSON.stringify(state)
          }`,
        );
      }
      parity = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, ...artboard },
        scale: "css",
      });
    } finally {
      await page.evaluate(({ x, y }) => scrollTo(x, y), original);
    }
    await runtimeAssertions(page, runtimeCase, context, catalogEntry);
    const after = await observeWholeArtboard(page, binding);
    if (!same(observation, after)) {
      throw new Error(
        "Whole artboard: DOM/layout/font/state changed during capture",
      );
    }
  } finally {
    await page.close();
    await browserContext.close();
  }
  await writeFile(parityPath, parity);
  const dimensions = pngDimensions(parity);
  return {
    ...record,
    status: "passed",
    description: {
      expected:
        `Story ${story.storyId} renders the ${designCase.id} whole artboard at its natural size with its qualification visible, and produces a complete UI bundle and the artboard image.`,
      observed:
        `Runtime assertions passed; complete UI bundle at ${fullUIBundle.manifestPath}; artboard image at ${
          relative(root, parityPath)
        }.`,
    },
    outputPath: fullUIBundle.manifestPath,
    outputSha256: fullUIBundle.manifestSha256,
    outputScope: "full-ui-bundle",
    outputAdapter: "none",
    fullUIBundle,
    storyArtboard: {
      targetSelector: binding.targetSelector,
      qualificationSelector: binding.qualificationSelector,
      parity: {
        path: relative(root, parityPath),
        sha256: sha256(parity),
        width: dimensions.width,
        height: dimensions.height,
      },
      observationSha256: sha256(JSON.stringify(observation)),
      qualificationTextSha256: sha256(observation.qualification.text),
    },
    captureStartedAt: startedAt,
    captureFinishedAt: new Date().toISOString(),
  };
}

export async function captureSiteStoryCases({
  manifestName,
  args = parseStoryCaptureArguments(process.argv.slice(2)),
}) {
  const profile = manifestProfile(manifestName);
  if (!profile.siteRendered) {
    throw new Error(`${manifestName} is not a site-rendered manifest`);
  }
  const artifacts = artifactsDirectoryFor(
    resolve(
      root,
      process.env.BAKERY_UI_ARTIFACTS_DIR || "artifacts/ui-baseline",
    ),
    manifestName,
  );
  // capture-stories.mjs reads BAKERY_UI_ARTIFACTS_DIR at import; point it at
  // this manifest's tree before the dynamic import.
  process.env.BAKERY_UI_ARTIFACTS_DIR = artifacts;
  const {
    runtimeAssertions,
    sourceIdentity,
    startStaticStorybook,
    storyUrl,
  } = await import("./capture-stories.mjs");
  const { captureViewportBundleV2 } = await import(
    "./native-viewport-bundle-v2.mjs"
  );
  const baseline = await readJson(profile.baselinePath);
  const routeCases = (baseline.cases ?? []).filter((entry) =>
    !isStoryCandidate(entry)
  );
  if (routeCases.length) {
    throw new Error(
      `${manifestName}: route cases (${
        routeCases.map((entry) => entry.id).join(", ")
      }) are captured by capture-enterprise.mjs, not by the story capture`,
    );
  }
  const designCases = baseline.cases.filter((entry) =>
    args.only.length === 0 ||
    args.only.some((prefix) => entry.id.startsWith(prefix))
  );
  const outputDirectory = join(artifacts, "runtime");
  const manifestPath = join(outputDirectory, "manifest.json");
  await mkdir(outputDirectory, { recursive: true });
  const [runtime, catalog, tokens] = await Promise.all([
    readJson(runtimePath),
    readJson(catalogPath),
    readJson(tokenPath),
  ]);
  const storybook = await startStaticStorybook(args.storybookDirectory);
  const browser = await chromium.launch({
    headless: true,
    ...enterpriseLaunchOptions(),
  });
  const metadata = {
    ...sourceIdentity(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      execFileSync("git", ["diff", "--binary", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 256,
      }),
      await untrackedSourceMaterial(),
    ),
    storybookBuildDigest: await storybookBuildDigest(args.storybookDirectory),
    tokenRevision: tokens.source.revision,
    tokenDigest: tokens.source.digest,
    fontDigests: await fontDigests(),
    browserVersion: browser.version(),
    playwrightVersion: (await readJson(
      join(uiRoot, "node_modules/@playwright/test/package.json"),
    )).version,
    os: `${process.platform}-${process.arch}`,
  };
  const records = [];
  try {
    for (const designCase of designCases) {
      try {
        records.push(
          await captureOne({
            browser,
            baseURL: storybook.baseURL,
            designCase,
            metadata,
            runtime,
            catalog,
            helpers: { storyUrl, runtimeAssertions, captureViewportBundleV2 },
            outputDirectory,
          }),
        );
      } catch (error) {
        records.push({
          id: designCase.id,
          kind: "story",
          storyId: designCase.candidate.storyId,
          paperBaselineId: designCase.id,
          status: error?.status ?? "failed",
          reason: error?.reason ?? "story-capture-error",
          description: {
            expected:
              `Story ${designCase.candidate.storyId} renders the ${designCase.id} whole artboard.`,
            observed: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  } finally {
    await browser.close();
    await new Promise((done) => storybook.server.close(done));
  }
  const count = (status) =>
    records.filter((record) => record.status === status).length;
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        selection: { mode: "all", caseIds: [] },
        coverage: {
          expected: designCases.length,
          selected: designCases.length,
          observed: records.length,
          passed: count("passed"),
          failed: count("failed"),
          blocked: count("blocked"),
          missing: [],
          routes: 0,
        },
        cases: records,
      },
      null,
      2,
    ) + "\n",
  );
  const failed = records.filter((record) => record.status !== "passed");
  if (failed.length) {
    throw new Error(
      `Story capture failed closed: ${
        failed.map((record) => `${record.id}: ${record.description.observed}`)
          .join("; ")
      }`,
    );
  }
  console.log(
    `Captured ${records.length} story cases to ${
      relative(root, manifestPath)
    }.`,
  );
  return records;
}
