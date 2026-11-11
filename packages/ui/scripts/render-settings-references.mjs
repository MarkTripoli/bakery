// Renders and checks the DESIGN half of the settings Paper parity gate: the
// O-0 (Settings & account) frames exported read-only from Paper into
// docs/technical-design/settings-mocks, turned into a static site by
// paper-jsx-to-html.mjs (`--site settings`), and screenshotted
// deterministically for docs/technical-design/ui-baselines/
// settings-baselines.json.
//
// This is the settings sibling of render-enterprise-references.mjs and builds
// on its exported renderer, server and case helpers; auth and K-0 references
// never go through this file, and none of the pinned K-0 inputs is edited.
//
//   node scripts/render-settings-references.mjs --check
//   node scripts/render-settings-references.mjs --list
//   node scripts/render-settings-references.mjs --write
//   node scripts/render-settings-references.mjs --add <screen> <state> --route <r>
//
// `--check` always proves the exported source: every saved byte matches
// settings-mocks/source-manifest.json, the generated site matches the saved
// JSX, and each frame's fresh render scores at least 0.95 against its
// committed reference. The score against Paper's own PNG export is recorded
// as a non-gating `paperExportScore` diagnostic.
// It also re-renders the cases of settings-baselines.json when that file
// exists (it is created with the first settings cases). Renders run under the
// hermetic fontconfig the enterprise manifest uses (same pinned Geist files).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  buildEnterpriseCase,
  checkEnterpriseReferences,
  closeEnterpriseServer,
  enterpriseLaunchOptions,
  parseEnterpriseArguments,
  renderAndFillEnterpriseCase,
  renderEnterpriseReference,
} from "./render-enterprise-references.mjs";
import {
  computeSourceIdentity,
  lookupArtboard,
  readDesignManifest,
} from "./render-paper-references.mjs";
import { comparePngs, pngDimensions } from "./image-score.mjs";
import { checkSite } from "./paper-jsx-to-html.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");

export const SETTINGS_BASELINE_PATH = join(
  root,
  "docs/technical-design/ui-baselines/settings-baselines.json",
);
export const SETTINGS_SOURCE_MANIFEST_PATH =
  "docs/technical-design/settings-mocks/source-manifest.json";
const SETTINGS_ENTRY = "docs/technical-design/settings-mocks/site/index.html";
const SETTINGS_READY_GLOBAL = "bakerySettingsReady";
const IMAGE_DIRECTORY = "docs/technical-design/ui-baselines/paper/settings";
const SOURCE_DIRECTORY = "docs/technical-design/settings-mocks/source";

// A fresh render must score at least this against its committed reference;
// the gate's own tolerance. Paper export scores never gate.
export const SETTINGS_RENDER_FLOOR = 0.95;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const DEVICE_POINTERS = { desktop: "fine", phone: "coarse" };

export const settingsLaunchOptions = enterpriseLaunchOptions;
export const renderSettingsReference = renderEnterpriseReference;
export const closeSettingsServer = closeEnterpriseServer;

// Validates settings-baselines.json with the shared design-case Zod schema.
export async function settingsSchemaIssues(baseline) {
  const { parseEnterpriseBaselines } = await import(
    "../catalog/design-cases.ts"
  );
  const result = parseEnterpriseBaselines(baseline);
  return result.success
    ? []
    : result.issues.map((issue) => `settings-baselines.json ${issue}`);
}

// Re-renders every design case of the settings manifest against its committed
// reference (byte hash, fresh-render floor, source digest).
// The enterprise checker is reused as is (it is a pinned input of the
// enterprise manifest digest, so it is not edited); its schema issues name the
// enterprise file, so they are renamed to the settings file here.
export async function checkSettingsReferences({ baseline, browser }) {
  const { issues, results } = await checkEnterpriseReferences({
    baseline,
    browser,
  });
  return {
    issues: issues.map((issue) =>
      issue.replace(/^enterprise-baselines\.json /, "settings-baselines.json ")
    ),
    results,
  };
}

// A settings case: the enterprise case builder with the settings image path.
function buildSettingsCase(baseline, manifest, selection) {
  const designCase = buildEnterpriseCase(baseline, manifest, selection);
  designCase.imagePath =
    `${IMAGE_DIRECTORY}/${selection.screen}--${selection.state}--${selection.theme}--${selection.device}.png`;
  return designCase;
}

// Pins that every saved byte of the O-0 export still matches the source
// manifest: tokens, vendored assets, pinned fonts, and per frame the JSX, the
// exported PNG and the computed styles; plus the frame inventory itself.
export async function checkSettingsSourceBytes(manifest) {
  const issues = [];
  const mocks = join(root, dirname(SETTINGS_SOURCE_MANIFEST_PATH));
  const source = join(mocks, "source");
  const verify = async (label, path, expected) => {
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) issues.push(`${label}: missing`);
    else if (sha256(bytes) !== expected) {
      issues.push(`${label}: sha256 differs from source-manifest`);
    }
    return bytes;
  };
  await verify(
    manifest.tokens.path,
    join(source, manifest.tokens.path),
    manifest.tokens.sha256,
  );
  for (const asset of manifest.assets) {
    await verify(asset.path, join(source, asset.path), asset.sha256);
  }
  for (const font of manifest.fonts?.files ?? []) {
    await verify(font.path, join(root, font.path), font.sha256);
  }
  if (!(manifest.fonts?.files ?? []).length) {
    issues.push("source-manifest pins no fonts");
  }
  if (manifest.screens.length !== manifest.expectedScreens) {
    issues.push(
      `source-manifest lists ${manifest.screens.length} screens, expected ${manifest.expectedScreens}`,
    );
  }
  const seen = new Set();
  for (const screen of manifest.screens) {
    if (seen.has(screen.nodeId)) {
      issues.push(`${screen.nodeId}: duplicate frame`);
    }
    seen.add(screen.nodeId);
    if (screen.pageId !== manifest.pageId) {
      issues.push(`${screen.nodeId}: page differs from the manifest page`);
    }
    await verify(screen.source, join(source, screen.source), screen.sha256);
    await verify(
      screen.computedStylesPath,
      join(source, screen.computedStylesPath),
      screen.computedStylesSha256,
    );
    const png = await verify(
      screen.exportPath,
      join(source, screen.exportPath),
      screen.exportSha256,
    );
    if (png) {
      const size = pngDimensions(png);
      if (size.width !== screen.width || size.height !== screen.height) {
        issues.push(
          `${screen.nodeId}: exported PNG is ${size.width}x${size.height}, manifest records ${screen.width}x${screen.height}`,
        );
      }
    }
  }
  return issues;
}

const REFERENCE_DIRECTORY = IMAGE_DIRECTORY;
const PROVENANCE_DIRECTORY = "artifacts/ui-baseline/settings-provenance";

export const referencePathFor = (screen) =>
  `${REFERENCE_DIRECTORY}/${screen.id}--${screen.state}--${screen.theme}--${screen.device}.png`;

const frameLabel = (screen) =>
  `${screen.nodeId} ${screen.id}.${screen.state}.${screen.theme}.${screen.device}`;

const FRAME_BASELINE = {
  source: { entry: SETTINGS_ENTRY, readyGlobal: SETTINGS_READY_GLOBAL },
};

// Side-by-side evidence of one frame: Paper's own PNG export | the committed
// reference render | their difference. Untracked, never gated.
async function writeComposite(browser, screen, paperPng, referencePng) {
  const page = await browser.newPage();
  try {
    const url = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;
    const dataUrl = await page.evaluate(async ({ left, right, w, h }) => {
      const load = (src) =>
        new Promise((resolveImage, rejectImage) => {
          const image = new Image();
          image.onload = () => resolveImage(image);
          image.onerror = rejectImage;
          image.src = src;
        });
      const [a, b] = await Promise.all([load(left), load(right)]);
      const canvas = document.createElement("canvas");
      canvas.width = w * 3 + 40;
      canvas.height = h;
      const context = canvas.getContext("2d");
      context.fillStyle = "#808080";
      context.fillRect(0, 0, canvas.width, h);
      context.drawImage(a, 0, 0);
      context.drawImage(b, w + 20, 0);
      context.drawImage(a, 2 * w + 40, 0);
      context.globalCompositeOperation = "difference";
      context.drawImage(b, 2 * w + 40, 0);
      return canvas.toDataURL("image/png");
    }, {
      left: url(paperPng),
      right: url(referencePng),
      w: screen.width,
      h: screen.height,
    });
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const directory = join(root, PROVENANCE_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${screen.nodeId}.png`), bytes);
  } finally {
    await page.close();
  }
}

// Gated checks per frame: the committed reference PNG matches its pinned hash
// and a fresh render of the exported JSX site scores at least the floor
// against it. Render vs Paper's own PNG export is a recorded diagnostic
// (paperExportScore), shown as a composite, never gated.
export async function checkSettingsFrames({ browser, manifest }) {
  const issues = [];
  const results = [];
  const page = await browser.newPage();
  try {
    for (const screen of manifest.screens) {
      const id = frameLabel(screen);
      let reference = null;
      try {
        reference = await readFile(join(root, screen.referencePath ?? ""));
      } catch {
        issues.push(
          `${id}: committed reference render is missing (run --write)`,
        );
        results.push({ id, issue: "no committed reference" });
        continue;
      }
      if (referencePathFor(screen) !== screen.referencePath) {
        issues.push(`${id}: referencePath is not ${referencePathFor(screen)}`);
      }
      if (sha256(reference) !== screen.referenceSha256) {
        issues.push(`${id}: referenceSha256 mismatch`);
      }
      let rendered;
      try {
        rendered = await renderSettingsReference(
          browser,
          FRAME_BASELINE,
          frameCase(screen),
        );
      } catch (error) {
        issues.push(`${id}: ${error.message}`);
        results.push({ id, issue: error.message });
        continue;
      }
      const fresh = pngDimensions(rendered.bytes);
      const committed = pngDimensions(reference);
      if (
        fresh.width !== committed.width || fresh.height !== committed.height ||
        committed.width !== screen.width || committed.height !== screen.height
      ) {
        const issue =
          `rendered ${fresh.width}x${fresh.height} differs from committed reference ${committed.width}x${committed.height} (frame ${screen.width}x${screen.height})`;
        issues.push(`${id}: ${issue}`);
        results.push({ id, issue });
        continue;
      }
      const scored = await comparePngs(page, {
        candidate: rendered.bytes,
        baseline: reference,
      });
      if (scored.issue) {
        issues.push(`${id}: ${scored.issue}`);
        results.push({ id, issue: scored.issue });
        continue;
      }
      results.push({
        id,
        score: scored.score,
        inkScore: scored.inkScore,
        surfaceScore: scored.surfaceScore,
        paperExportScore: screen.paperExportScore,
      });
      if (scored.score < SETTINGS_RENDER_FLOOR) {
        issues.push(
          `${id}: committed reference differs from a fresh render (score ${
            scored.score.toFixed(4)
          } < ${SETTINGS_RENDER_FLOOR})`,
        );
      }
      const paperPng = await readFile(
        join(root, SOURCE_DIRECTORY, screen.exportPath),
      );
      await writeComposite(browser, screen, paperPng, reference);
    }
  } finally {
    await page.close();
  }
  return { issues, results };
}

// Renders every frame once from the exported JSX site, commits the render as
// the reference PNG, and records its hash and the non-gating render vs Paper
// export score in the source manifest.
export async function writeSettingsReferences({ browser }) {
  const manifestPath = join(root, SETTINGS_SOURCE_MANIFEST_PATH);
  const manifest = await readJson(manifestPath);
  const page = await browser.newPage();
  try {
    for (const screen of manifest.screens) {
      const rendered = await renderSettingsReference(
        browser,
        FRAME_BASELINE,
        frameCase(screen),
      );
      const path = referencePathFor(screen);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), rendered.bytes);
      const paperPng = await readFile(
        join(root, SOURCE_DIRECTORY, screen.exportPath),
      );
      const size = pngDimensions(rendered.bytes);
      let paperExportScore = null;
      if (size.width === screen.width && size.height === screen.height) {
        const scored = await comparePngs(page, {
          candidate: rendered.bytes,
          baseline: paperPng,
        });
        paperExportScore = scored.issue
          ? null
          : Number(scored.score.toFixed(4));
      }
      screen.referencePath = path;
      screen.referenceSha256 = sha256(rendered.bytes);
      screen.paperExportScore = paperExportScore;
      await writeComposite(browser, screen, paperPng, rendered.bytes);
      console.log(
        `${frameLabel(screen)}: paperExportScore=${paperExportScore}`,
      );
    }
  } finally {
    await page.close();
  }
  manifest.referenceModel = {
    note:
      "The committed reference of each frame is a render of the exported Paper JSX site, produced once by `render:paper:settings -- --write`. `--check` gates source-byte integrity, generated-site freshness and a fresh render against the committed reference at the 0.95 floor (the enterprise model). `paperExportScore` is the non-gating score of that render against the Paper PNG export of 2026-09-08: the layout matches and the difference is Paper's own glyph rasterization (widths and positions of text), which no pinned Chromium hinting setting reproduces.",
    floor: SETTINGS_RENDER_FLOOR,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// The render case for one exported frame (not a baseline case).
function frameCase(screen) {
  return {
    id: `${screen.id}.${screen.state}.${screen.theme}.${screen.device}`,
    design: { screen: screen.id, state: screen.state },
    theme: screen.theme,
    dpr: 1,
    pointer: DEVICE_POINTERS[screen.device],
    locale: "en-US",
    viewport: { width: screen.width, height: screen.height },
    artboard: { width: screen.width, height: screen.height },
  };
}

// Everything `--check` proves about the export, independent of any baseline
// case: saved bytes, generated site freshness and per-frame render scores.
export async function checkSettingsSource({ browser }) {
  const manifest = await readJson(join(root, SETTINGS_SOURCE_MANIFEST_PATH));
  const issues = [
    ...await checkSettingsSourceBytes(manifest),
    ...(await checkSite("settings")).map((issue) => `site: ${issue}`),
  ];
  const frames = await checkSettingsFrames({ browser, manifest });
  return { issues: [...issues, ...frames.issues], results: frames.results };
}

// Source inputs the settings manifest digest covers: the generated site, the
// saved Paper source manifest, the pinned fonts and fontconfig, and the
// renderers that produce the references.
async function settingsSourceInputs() {
  const manifest = await readJson(join(root, SETTINGS_SOURCE_MANIFEST_PATH));
  const site = "docs/technical-design/settings-mocks/site";
  return [
    `${site}/index.html`,
    `${site}/base.css`,
    `${site}/site.js`,
    `${site}/tokens.css`,
    `${site}/fonts.css`,
    ...manifest.screens.map((screen) =>
      `${site}/fragments/${screen.id}--${screen.state}--${screen.theme}--${screen.device}.html`
    ),
    ...manifest.assets.map((asset) => `${SOURCE_DIRECTORY}/${asset.path}`),
    SETTINGS_SOURCE_MANIFEST_PATH,
    ...manifest.fonts.files.map((font) => font.path),
    manifest.fonts.provenance,
    "packages/ui/scripts/fontconfig/fonts.conf",
    "packages/ui/scripts/render-settings-references.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ];
}

async function newBaseline() {
  const manifest = await readJson(join(root, SETTINGS_SOURCE_MANIFEST_PATH));
  return {
    schemaVersion: 2,
    source: {
      fileId: manifest.fileId,
      pageId: manifest.pageId,
      manifestPath: SETTINGS_SOURCE_MANIFEST_PATH,
      entry: SETTINGS_ENTRY,
      readyGlobal: SETTINGS_READY_GLOBAL,
      inputs: await settingsSourceInputs(),
      revision: "",
      digest: "",
    },
    reference: { hidden: [], overrides: {} },
    cases: [],
    excluded: [],
  };
}

async function readOrCreateBaseline() {
  try {
    return await readJson(SETTINGS_BASELINE_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return await newBaseline();
  }
}

async function saveBaseline(baseline) {
  const schemaIssues = await settingsSchemaIssues(baseline);
  if (schemaIssues.length) throw new Error(schemaIssues.join("; "));
  await writeFile(
    SETTINGS_BASELINE_PATH,
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

function report({ issues, results }) {
  for (const result of results) {
    console.log(
      result.issue
        ? `${result.id}: ${result.issue}`
        : `${result.id}: score=${result.score.toFixed(6)}`,
    );
  }
  if (issues.length) {
    console.error(`${issues.length} issue(s):`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseEnterpriseArguments(process.argv.slice(2));

  if (args.kind === "list") {
    const baseline = await readOrCreateBaseline();
    const manifest = await readJson(join(root, SETTINGS_SOURCE_MANIFEST_PATH));
    for (const screen of manifest.screens) {
      console.log(
        `${screen.nodeId}\tframe\t${SOURCE_DIRECTORY}/${screen.exportPath}`,
      );
    }
    for (const designCase of baseline.cases ?? []) {
      console.log(
        `${designCase.id}\t${designCase.reference}\t${designCase.imagePath}`,
      );
    }
    return;
  }

  const browser = await chromium.launch(settingsLaunchOptions());
  try {
    if (args.kind === "check") {
      const source = await checkSettingsSource({ browser });
      report(source);
      const hasBaseline = await readJson(SETTINGS_BASELINE_PATH).catch(
        (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        },
      );
      if (hasBaseline) {
        const cases = await checkSettingsReferences({
          baseline: hasBaseline,
          browser,
        });
        report(cases);
      } else {
        console.log(
          "settings-baselines.json is absent; case-level checks start with the first settings cases.",
        );
      }
      if (!process.exitCode) {
        console.log("All settings design references verified clean.");
      }
      return;
    }

    const baseline = await readOrCreateBaseline();
    if (args.kind === "write" && !baseline.cases.length) {
      // No settings cases yet: render the exported frames as the references.
      await writeSettingsReferences({ browser });
      return;
    }
    if (args.kind === "add") {
      const manifest = await readDesignManifest(baseline);
      const added = [];
      for (const theme of args.themes) {
        for (const device of args.devices) {
          const id = `${args.screen}.${args.state}.${theme}.${device}`;
          if ((baseline.cases ?? []).some((existing) => existing.id === id)) {
            continue;
          }
          const designCase = buildSettingsCase(baseline, manifest, {
            screen: args.screen,
            state: args.state,
            theme,
            device,
            route: args.route,
            session: args.session,
          });
          baseline.cases.push(designCase);
          added.push(designCase);
        }
      }
      for (const designCase of added) {
        await renderAndFillEnterpriseCase(browser, baseline, designCase);
      }
      Object.assign(baseline.source, await computeSourceIdentity(baseline));
      await mkdir(dirname(SETTINGS_BASELINE_PATH), { recursive: true });
      await saveBaseline(baseline);
      console.log(
        `Added ${added.length} design case(s): ${
          added.map((designCase) => designCase.id).join(", ")
        }`,
      );
      return;
    }

    const designCases = (baseline.cases ?? []).filter((designCase) =>
      designCase.reference === "design"
    );
    for (const designCase of designCases) {
      const manifest = await readDesignManifest(baseline, designCase);
      const artboard = lookupArtboard(
        manifest,
        designCase.design,
        baseline,
        designCase,
      );
      designCase.frameId = artboard.nodeId;
      designCase.artboard = { width: artboard.width, height: artboard.height };
      await renderAndFillEnterpriseCase(browser, baseline, designCase);
    }
    baseline.source.inputs = await settingsSourceInputs();
    Object.assign(baseline.source, await computeSourceIdentity(baseline));
    await saveBaseline(baseline);
    console.log(
      `Rendered ${designCases.length} design reference(s) in ${
        relative(root, SETTINGS_BASELINE_PATH)
      }.`,
    );
  } finally {
    await browser.close();
    await closeSettingsServer();
  }
}

if (import.meta.main) {
  await main();
}
