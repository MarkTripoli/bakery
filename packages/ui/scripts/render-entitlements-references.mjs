// Renders and checks the DESIGN half of the entitlements Paper parity gate: the
// p-17-0 (Access, licence & entitlements) frames exported read-only from Paper into
// docs/technical-design/entitlements-mocks, turned into a static site by
// paper-jsx-to-html.mjs (`--site entitlements`), and screenshotted
// deterministically for docs/technical-design/ui-baselines/
// entitlements-baselines.json.
//
// This is the entitlements sibling of render-settings-references.mjs (a pinned
// settings input, so copied rather than parameterized) and builds on
// render-enterprise-references.mjs's exported renderer, server and case
// helpers; auth and K-0 references never go through this file, and none of the
// pinned K-0 inputs is edited. Paper cannot export PNGs on this host, so the
// source manifest records `exportedPng: null` and no frame has an export to
// verify; the export checks stay mandatory whenever `exportedPng` is set.
//
//   node scripts/render-entitlements-references.mjs --check
//   node scripts/render-entitlements-references.mjs --list
//   node scripts/render-entitlements-references.mjs --write
//   node scripts/render-entitlements-references.mjs --add <screen> <state> --route <r>
//
// `--check` always proves the exported source: every saved byte matches
// entitlements-mocks/source-manifest.json, the generated site matches the saved
// JSX, and each frame's fresh render scores at least 0.95 against its
// committed reference. The score against Paper's own PNG export is recorded
// as a non-gating `paperExportScore` diagnostic.
// It also re-renders the cases of entitlements-baselines.json when that file
// exists (it is created with the first entitlements cases). Renders run under the
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
import { checkSite, frameParts } from "./paper-jsx-to-html.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");

export const ENTITLEMENTS_BASELINE_PATH = join(
  root,
  "docs/technical-design/ui-baselines/entitlements-baselines.json",
);
export const ENTITLEMENTS_SOURCE_MANIFEST_PATH =
  "docs/technical-design/entitlements-mocks/source-manifest.json";
const ENTITLEMENTS_ENTRY =
  "docs/technical-design/entitlements-mocks/site/index.html";
const ENTITLEMENTS_READY_GLOBAL = "bakeryEntitlementsReady";
const IMAGE_DIRECTORY = "docs/technical-design/ui-baselines/paper/entitlements";
const SOURCE_DIRECTORY = "docs/technical-design/entitlements-mocks/source";

// A fresh render must score at least this against its committed reference;
// the gate's own tolerance. Paper export scores never gate.
export const ENTITLEMENTS_RENDER_FLOOR = 0.95;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const DEVICE_POINTERS = { desktop: "fine", phone: "coarse" };

export const entitlementsLaunchOptions = enterpriseLaunchOptions;
export const renderEntitlementsReference = renderEnterpriseReference;
export const closeEntitlementsServer = closeEnterpriseServer;

// Validates entitlements-baselines.json with the shared design-case Zod schema.
export async function entitlementsSchemaIssues(baseline) {
  const { parseEnterpriseBaselines } = await import(
    "../catalog/design-cases.ts"
  );
  const result = parseEnterpriseBaselines(baseline);
  return result.success
    ? []
    : result.issues.map((issue) => `entitlements-baselines.json ${issue}`);
}

// Re-renders every design case of the entitlements manifest against its committed
// reference (byte hash, fresh-render floor, source digest).
// The enterprise checker is reused as is (it is a pinned input of the
// enterprise manifest digest, so it is not edited); its schema issues name the
// enterprise file, so they are renamed to the entitlements file here.
export async function checkEntitlementsReferences({ baseline, browser }) {
  const { issues, results } = await checkEnterpriseReferences({
    baseline,
    browser,
  });
  return {
    issues: issues.map((issue) =>
      issue.replace(
        /^enterprise-baselines\.json /,
        "entitlements-baselines.json ",
      )
    ),
    results,
  };
}

// A entitlements case: the enterprise case builder with the entitlements image path.
function buildEntitlementsCase(baseline, manifest, selection) {
  const designCase = buildEnterpriseCase(baseline, manifest, selection);
  designCase.imagePath =
    `${IMAGE_DIRECTORY}/${selection.screen}--${selection.state}--${selection.theme}--${selection.device}.png`;
  return designCase;
}

// Pins that every saved byte of the p-17-0 export still matches the source
// manifest: tokens, vendored assets, pinned fonts, and per frame the JSX, the
// exported PNG and the computed styles; plus the frame inventory itself.
// An export PNG is mandatory when the manifest records `exportedPng` and
// absent only when it is null; `repoRoot` exists so a test can point at a
// scratch tree.
export const hasPaperExport = (manifest) => manifest.exportedPng !== null;

export async function checkEntitlementsSourceBytes(
  manifest,
  repoRoot = root,
) {
  const issues = [];
  const mocks = join(repoRoot, dirname(ENTITLEMENTS_SOURCE_MANIFEST_PATH));
  const exported = hasPaperExport(manifest);
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
    await verify(font.path, join(repoRoot, font.path), font.sha256);
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
    if (!exported) continue;
    if (!screen.exportPath || !screen.exportSha256) {
      issues.push(
        `${screen.nodeId}: manifest records exportedPng but the frame has no exportPath/exportSha256`,
      );
      continue;
    }
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
const PROVENANCE_DIRECTORY = "artifacts/ui-baseline/entitlements-provenance";

// Frames share a screen id across states, themes and devices, so the frame key
// (also the reference file name) is `<screen>--<state>--<theme>--<device>`.
const frameKey = (screen) => {
  const { screen: name, state } = frameParts(screen);
  return `${name}--${state}--${screen.theme}--${screen.device}`;
};

export const referencePathFor = (screen) => {
  const key = frameKey(screen);
  const successorKeys = new Set([
    "installation-settings--default--dark--desktop",
    "installation-settings--default--dark--phone",
    "installation-settings--default--light--desktop",
    "installation-settings--default--light--phone",
    "installation-settings--save-conflict--light--desktop",
    "installation-settings--save-conflict--light--phone",
    "installation-settings--save-error--light--desktop",
    "installation-settings--save-error--light--phone",
  ]);
  // v3 supersedes v2 for the desktop frames: the section nav gained Licence and
  // Audit log in E16. v2 references stay committed; phone frames stay on v2.
  const successorV3Keys = new Set([
    "installation-settings--default--dark--desktop",
    "installation-settings--default--light--desktop",
    "installation-settings--save-conflict--light--desktop",
    "installation-settings--save-error--light--desktop",
  ]);
  const successorV3 =
    `${REFERENCE_DIRECTORY}/installation-settings-v3/${key}.png`;
  if (successorV3Keys.has(key) && screen.referencePath === successorV3) {
    return successorV3;
  }
  const successor =
    `${REFERENCE_DIRECTORY}/installation-settings-v2/${key}.png`;
  return successorKeys.has(key) && screen.referencePath === successor
    ? successor
    : `${REFERENCE_DIRECTORY}/${key}.png`;
};

const frameLabel = (screen) => `${screen.nodeId} ${frameKey(screen)}`;

const FRAME_BASELINE = {
  source: { entry: ENTITLEMENTS_ENTRY, readyGlobal: ENTITLEMENTS_READY_GLOBAL },
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
export async function checkEntitlementsFrames({ browser, manifest }) {
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
        rendered = await renderEntitlementsReference(
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
      if (scored.score < ENTITLEMENTS_RENDER_FLOOR) {
        issues.push(
          `${id}: committed reference differs from a fresh render (score ${
            scored.score.toFixed(4)
          } < ${ENTITLEMENTS_RENDER_FLOOR})`,
        );
      }
      if (screen.exportPath) {
        const paperPng = await readFile(
          join(root, SOURCE_DIRECTORY, screen.exportPath),
        );
        await writeComposite(browser, screen, paperPng, reference);
      }
    }
  } finally {
    await page.close();
  }
  return { issues, results };
}

// Renders every frame once from the exported JSX site, commits the render as
// the reference PNG, and records its hash and the non-gating render vs Paper
// export score in the source manifest.
export async function writeEntitlementsReferences({ browser }) {
  const manifestPath = join(root, ENTITLEMENTS_SOURCE_MANIFEST_PATH);
  const manifest = await readJson(manifestPath);
  const page = await browser.newPage();
  try {
    for (const screen of manifest.screens) {
      const rendered = await renderEntitlementsReference(
        browser,
        FRAME_BASELINE,
        frameCase(screen),
      );
      const path = referencePathFor(screen);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), rendered.bytes);
      // No Paper export on this host: no score and no composite to record.
      const paperPng = screen.exportPath
        ? await readFile(join(root, SOURCE_DIRECTORY, screen.exportPath))
        : null;
      const size = pngDimensions(rendered.bytes);
      let paperExportScore = null;
      if (
        paperPng && size.width === screen.width && size.height === screen.height
      ) {
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
      if (paperPng) {
        await writeComposite(browser, screen, paperPng, rendered.bytes);
      }
      console.log(
        `${frameLabel(screen)}: paperExportScore=${paperExportScore}`,
      );
    }
  } finally {
    await page.close();
  }
  manifest.referenceModel = {
    note:
      "The committed reference of each frame is a render of the exported Paper JSX site, produced once by `render:paper:entitlements -- --write`. `--check` gates source-byte integrity, generated-site freshness and a fresh render against the committed reference at the 0.95 floor (the enterprise model). Paper PNG export is unavailable on this host, so there is no paperExportScore diagnostic.",
    floor: ENTITLEMENTS_RENDER_FLOOR,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// The render case for one exported frame (not a baseline case).
function frameCase(screen) {
  return {
    id: frameKey(screen),
    design: frameParts(screen),
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
export async function checkEntitlementsSource({ browser }) {
  const manifest = await readJson(
    join(root, ENTITLEMENTS_SOURCE_MANIFEST_PATH),
  );
  const issues = [
    ...await checkEntitlementsSourceBytes(manifest),
    ...(await checkSite("entitlements")).map((issue) => `site: ${issue}`),
  ];
  const frames = await checkEntitlementsFrames({ browser, manifest });
  return { issues: [...issues, ...frames.issues], results: frames.results };
}

// Source inputs the entitlements manifest digest covers: the generated site, the
// saved Paper source manifest, the pinned fonts and fontconfig, and the
// renderers that produce the references.
async function entitlementsSourceInputs() {
  const manifest = await readJson(
    join(root, ENTITLEMENTS_SOURCE_MANIFEST_PATH),
  );
  const site = "docs/technical-design/entitlements-mocks/site";
  return [
    `${site}/index.html`,
    `${site}/base.css`,
    `${site}/site.js`,
    `${site}/tokens.css`,
    `${site}/fonts.css`,
    ...manifest.screens.map((screen) =>
      `${site}/fragments/${frameParts(screen).screen}--${
        frameParts(screen).state
      }--${screen.theme}--${screen.device}.html`
    ),
    ...manifest.assets.map((asset) => `${SOURCE_DIRECTORY}/${asset.path}`),
    ENTITLEMENTS_SOURCE_MANIFEST_PATH,
    ...manifest.fonts.files.map((font) => font.path),
    manifest.fonts.provenance,
    "packages/ui/scripts/fontconfig/fonts.conf",
    "packages/ui/scripts/render-entitlements-references.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ];
}

async function newBaseline() {
  const manifest = await readJson(
    join(root, ENTITLEMENTS_SOURCE_MANIFEST_PATH),
  );
  return {
    schemaVersion: 2,
    source: {
      fileId: manifest.fileId,
      pageId: manifest.pageId,
      manifestPath: ENTITLEMENTS_SOURCE_MANIFEST_PATH,
      entry: ENTITLEMENTS_ENTRY,
      readyGlobal: ENTITLEMENTS_READY_GLOBAL,
      inputs: await entitlementsSourceInputs(),
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
    return await readJson(ENTITLEMENTS_BASELINE_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return await newBaseline();
  }
}

async function saveBaseline(baseline) {
  const schemaIssues = await entitlementsSchemaIssues(baseline);
  if (schemaIssues.length) throw new Error(schemaIssues.join("; "));
  await writeFile(
    ENTITLEMENTS_BASELINE_PATH,
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
    const manifest = await readJson(
      join(root, ENTITLEMENTS_SOURCE_MANIFEST_PATH),
    );
    for (const screen of manifest.screens) {
      console.log(
        `${screen.nodeId}\tframe\t${
          screen.exportPath
            ? `${SOURCE_DIRECTORY}/${screen.exportPath}`
            : screen.source
        }`,
      );
    }
    for (const designCase of baseline.cases ?? []) {
      console.log(
        `${designCase.id}\t${designCase.reference}\t${designCase.imagePath}`,
      );
    }
    return;
  }

  const browser = await chromium.launch(entitlementsLaunchOptions());
  try {
    if (args.kind === "check") {
      const source = await checkEntitlementsSource({ browser });
      report(source);
      const hasBaseline = await readJson(ENTITLEMENTS_BASELINE_PATH).catch(
        (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        },
      );
      if (hasBaseline) {
        const cases = await checkEntitlementsReferences({
          baseline: hasBaseline,
          browser,
        });
        report(cases);
      } else {
        console.log(
          "entitlements-baselines.json is absent; case-level checks start with the first entitlements cases.",
        );
      }
      if (!process.exitCode) {
        console.log("All entitlements design references verified clean.");
      }
      return;
    }

    const baseline = await readOrCreateBaseline();
    if (args.kind === "write" && !baseline.cases.length) {
      // No entitlements cases yet: render the exported frames as the references.
      await writeEntitlementsReferences({ browser });
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
          const designCase = buildEntitlementsCase(baseline, manifest, {
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
      await mkdir(dirname(ENTITLEMENTS_BASELINE_PATH), { recursive: true });
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
    baseline.source.inputs = await entitlementsSourceInputs();
    Object.assign(baseline.source, await computeSourceIdentity(baseline));
    await saveBaseline(baseline);
    console.log(
      `Rendered ${designCases.length} design reference(s) in ${
        relative(root, ENTITLEMENTS_BASELINE_PATH)
      }.`,
    );
  } finally {
    await browser.close();
    await closeEntitlementsServer();
  }
}

if (import.meta.main) {
  await main();
}
