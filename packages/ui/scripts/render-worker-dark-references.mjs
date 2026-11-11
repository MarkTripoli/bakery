// Worker-dark references: the dark phone Machines detail artboard, DERIVED
// from the approved light K-0 export 90D-0 by a token map recomputed from the
// approved K-0 light/dark list pairs (derive-worker-dark-source.mjs). No Paper
// export is claimed. The candidate is the same Storybook story the K-0 light
// phone case scores (bakery-templates-workerreadonlydetail--contract, state
// ready) in dark, captured by its whole-artboard element
// (capture-worker-dark.mjs).
//
// Rendering reuses the pinned K-0 JSX renderer `workerReadinessMarkup` by
// import only, and the enterprise site renderer for the reference PNG and the
// 0.95 re-render floor. The pinned K-0 inputs are only read.
//
//   node scripts/render-worker-dark-references.mjs --write
//   node scripts/render-worker-dark-references.mjs --check
//   node scripts/render-worker-dark-references.mjs --list
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  buildEnterpriseCase,
  checkEnterpriseReferences,
  closeEnterpriseServer,
  enterpriseLaunchOptions,
  renderAndFillEnterpriseCase,
} from "./render-enterprise-references.mjs";
import { computeSourceIdentity } from "./render-paper-references.mjs";
import { workerReadinessMarkup } from "./worker-readiness-reference.mjs";
import { WHOLE_ARTBOARD_BINDING } from "./paper-whole-artboard.mjs";
import {
  DERIVED_SOURCE,
  deriveDarkSource,
  LIGHT_SOURCE,
  PAIRS,
} from "./derive-worker-dark-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mocks = "docs/technical-design/worker-dark-mocks";
const k0 = "docs/technical-design/worker-readiness";
const manifestPath = `${mocks}/paper-manifest.json`;
const sourceManifestPath = `${mocks}/source-manifest.json`;
const themePath = `${mocks}/theme-values.json`;
const fragmentPath =
  `${mocks}/site/fragments/detail--default--dark--phone.html`;
const fontsDirectory = "docs/technical-design/enterprise-mocks/fonts";
export const WORKER_DARK_BASELINE_PATH = join(
  root,
  "docs/technical-design/ui-baselines/worker-dark-baselines.json",
);
export const closeWorkerDarkServer = closeEnterpriseServer;

const FILE_ID = "bakery-repo-worker-dark";
const PAGE_ID = "worker-dark-derived";
const FRAME_ID = "derived-90D-0-dark";
const LIGHT_FRAME_ID = "90D-0";
const STORY_ID = "bakery-templates-workerreadonlydetail--contract";
// The runtime context the approved light phone case is captured under; the
// dark case uses it with only the theme changed.
const LIGHT_CONTEXT = "paper-detail-light-phone";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFile(join(root, path));
const readJson = async (path) => JSON.parse(await read(path));
const json = (value) => JSON.stringify(value, null, 2) + "\n";

const SITE_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Bakery worker dark reference (derived, not a Paper export)</title></head>
<body style="margin:0">
<div id="app"></div>
<script src="site.js"></script>
</body></html>
`;

const SITE_JS = `(async () => {
  const theme = new URLSearchParams(location.search).get("theme");
  const [screen, state = "default"] = location.hash.slice(1).split("/");
  const response = await fetch(
    "fragments/" + screen + "--" + state + "--" + theme + "--phone.html",
  );
  if (!response.ok) throw new Error("no derived frame for " + location.hash);
  const app = document.getElementById("app");
  app.innerHTML = await response.text();
  app.dataset.screen = screen;
  app.dataset.state = state;
  await document.fonts.ready;
  globalThis.bakeryWorkerDarkReady = true;
})();
`;

// Every committed byte under worker-dark-mocks, generated from the pinned K-0
// inputs. --write writes them; --check requires the committed bytes to match.
export async function generateWorkerDarkFiles() {
  const derived = await deriveDarkSource();
  const k0Manifest = await readJson(`${k0}/paper-manifest.json`);
  const light = k0Manifest.screens.find((entry) =>
    entry.nodeId === LIGHT_FRAME_ID
  );
  if (!light || light.sourcePath !== LIGHT_SOURCE.slice(k0.length + 1)) {
    throw new Error(`K-0 manifest does not list ${LIGHT_SOURCE}`);
  }
  const themeBytes = await read(`${k0}/theme-values.json`);
  const derivedBytes = Buffer.from(derived.text);
  const sourceName = DERIVED_SOURCE.slice(mocks.length + 1);
  const paperManifest = {
    fileId: FILE_ID,
    pageId: PAGE_ID,
    note:
      "Renderer manifest for a DERIVED artboard; not a Paper export. See source-manifest.json.",
    screens: [{
      id: "detail",
      state: "default",
      theme: "dark",
      device: "phone",
      nodeId: FRAME_ID,
      width: light.width,
      height: light.height,
      sourcePath: sourceName,
    }],
    inputs: [
      { path: sourceName, sha256: sha256(derivedBytes) },
      { path: "theme-values.json", sha256: sha256(themeBytes) },
    ],
    publicImages: [],
  };
  const fonts = [];
  for (const family of ["geist", "geist-mono"]) {
    for (const weight of [400, 500, 600]) {
      const path = `${fontsDirectory}/${family}-${weight}.ttf`;
      fonts.push({ path, sha256: sha256(await read(path)) });
    }
  }
  const sourceManifest = {
    fileId: FILE_ID,
    pageId: PAGE_ID,
    pageName: "Machines detail, dark phone (derived reference)",
    source: {
      tool: "repository-derived-token-map",
      claim:
        "No Paper export is claimed. Paper K-0 has no dark detail phone frame; this artboard is derived from the approved light frame.",
      derivedFrom: {
        fileId: k0Manifest.fileId,
        pageId: k0Manifest.pageId,
        frameId: LIGHT_FRAME_ID,
        path: LIGHT_SOURCE,
      },
      method:
        "Align the approved K-0 light/dark list pairs token by token (every light token maps to exactly one dark token in both pairs), then substitute that map into the light detail phone JSX. Fonts, radii, text sizes and transparent are theme-invariant and kept.",
      script: "packages/ui/scripts/derive-worker-dark-source.mjs",
      pairs: PAIRS.map(([lightPath, darkPath]) => ({
        light: lightPath,
        dark: darkPath,
      })),
      inputs: derived.hashes,
      map: Object.fromEntries(
        [...derived.map].filter(([from, to]) => from !== to),
      ),
    },
    theme: {
      path: "theme-values.json",
      copiedFrom: `${k0}/theme-values.json`,
      sha256: sha256(themeBytes),
    },
    fonts: {
      note:
        "Geist and Geist Mono; the enterprise-mocks files are byte-identical to the K-0 worker-readiness fonts.",
      files: fonts,
    },
    screens: [{
      id: "detail",
      state: "default",
      theme: "dark",
      device: "phone",
      width: light.width,
      height: light.height,
      nodeId: FRAME_ID,
      source: sourceName,
      sha256: sha256(derivedBytes),
    }],
  };
  const files = new Map([
    [DERIVED_SOURCE, derivedBytes],
    [themePath, themeBytes],
    [manifestPath, Buffer.from(json(paperManifest))],
    [sourceManifestPath, Buffer.from(json(sourceManifest))],
    [`${mocks}/site/index.html`, Buffer.from(SITE_INDEX)],
    [`${mocks}/site/site.js`, Buffer.from(SITE_JS)],
  ]);
  return files;
}

// The fragment needs the generated manifest and theme on disk, because the
// pinned renderer reads its directory; it is checked after them.
async function fragmentBytes() {
  const markup = await workerReadinessMarkup(join(root, mocks), FRAME_ID);
  // site/index.html is two levels below docs/technical-design.
  return Buffer.from(
    markup.replaceAll(
      "url(fonts/",
      "url(../../enterprise-mocks/fonts/",
    ) + "\n",
  );
}

export async function checkWorkerDarkSource() {
  const issues = [];
  const files = await generateWorkerDarkFiles();
  for (const [path, bytes] of files) {
    const committed = await read(path).catch(() => null);
    if (!committed || !committed.equals(bytes)) {
      issues.push(`${path}: differs from a fresh derivation`);
    }
  }
  if (!issues.length) {
    const committed = await read(fragmentPath).catch(() => null);
    if (!committed || !committed.equals(await fragmentBytes())) {
      issues.push(`${fragmentPath}: differs from a fresh render of the JSX`);
    }
  }
  return issues;
}

export async function workerDarkSchemaIssues(baseline) {
  const { parseEnterpriseBaselines } = await import(
    "../catalog/design-cases.ts"
  );
  const result = parseEnterpriseBaselines(baseline);
  return result.success
    ? []
    : result.issues.map((issue) => `worker-dark-baselines.json ${issue}`);
}

export async function checkWorkerDarkReferences({ baseline, browser }) {
  const sourceIssues = await checkWorkerDarkSource();
  const result = await checkEnterpriseReferences({ baseline, browser });
  const expected = [FRAME_ID];
  const actual = (baseline.cases ?? []).map((entry) => entry.frameId);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    sourceIssues.push("baseline cases differ from the derived frame inventory");
  }
  return {
    issues: [
      ...sourceIssues,
      ...result.issues.map((issue) =>
        issue.replace(
          /^enterprise-baselines\.json /,
          "worker-dark-baselines.json ",
        )
      ),
    ],
    results: result.results,
  };
}

async function writeReferences(browser) {
  const files = await generateWorkerDarkFiles();
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await mkdir(dirname(join(root, fragmentPath)), { recursive: true });
  await writeFile(join(root, fragmentPath), await fragmentBytes());
  const runtime = await readJson(
    "docs/technical-design/ui-baselines/runtime-cases.json",
  );
  const lightContext = runtime.contexts[LIGHT_CONTEXT];
  if (!lightContext) {
    throw new Error(`missing runtime context ${LIGHT_CONTEXT}`);
  }
  const baseline = {
    schemaVersion: 2,
    source: {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      manifestPath,
      entry: `${mocks}/site/index.html`,
      readyGlobal: "bakeryWorkerDarkReady",
      inputs: [
        manifestPath,
        sourceManifestPath,
        DERIVED_SOURCE,
        themePath,
        `${mocks}/site/index.html`,
        `${mocks}/site/site.js`,
        fragmentPath,
        ...PAIRS.flat(),
        LIGHT_SOURCE,
        `${k0}/theme-values.json`,
        `${k0}/paper-manifest.json`,
        ...JSON.parse(files.get(sourceManifestPath)).fonts.files.map((font) =>
          font.path
        ),
        "docs/technical-design/ui-baselines/runtime-cases.json",
        "packages/ui/scripts/fontconfig/fonts.conf",
        "packages/ui/scripts/derive-worker-dark-source.mjs",
        "packages/ui/scripts/render-worker-dark-references.mjs",
        "packages/ui/scripts/render-enterprise-references.mjs",
        "packages/ui/scripts/worker-readiness-reference.mjs",
      ],
      revision: "",
      digest: "",
    },
    reference: { hidden: [], overrides: {} },
    cases: [],
    excluded: [],
  };
  const paperManifest = JSON.parse(files.get(manifestPath));
  const designCase = buildEnterpriseCase(baseline, paperManifest, {
    screen: "detail",
    state: "default",
    theme: "dark",
    device: "phone",
    route: "/",
    session: "anonymous",
  });
  designCase.imagePath =
    "docs/technical-design/ui-baselines/paper/worker-dark/detail--default--dark--phone.png";
  designCase.pointer = lightContext.pointer;
  designCase.candidate = {
    storyId: STORY_ID,
    args: { state: "ready" },
    reducedMotion: lightContext.reducedMotion,
    wholeArtboard: {
      targetSelector: WHOLE_ARTBOARD_BINDING.targetSelector,
      qualificationSelector: WHOLE_ARTBOARD_BINDING.qualificationSelector,
    },
  };
  await renderAndFillEnterpriseCase(browser, baseline, designCase);
  baseline.cases.push(designCase);
  console.log(`${designCase.id}: rendered`);
  Object.assign(baseline.source, await computeSourceIdentity(baseline));
  const issues = await workerDarkSchemaIssues(baseline);
  if (issues.length) throw new Error(issues.join("\n"));
  await writeFile(WORKER_DARK_BASELINE_PATH, json(baseline));
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.length !== 1 || !["--write", "--check", "--list"].includes(args[0])
  ) {
    throw new Error(
      "usage: render-worker-dark-references.mjs --write|--check|--list",
    );
  }
  if (args[0] === "--list") {
    console.log(`${FRAME_ID}\t${DERIVED_SOURCE}`);
    return;
  }
  const browser = await chromium.launch(enterpriseLaunchOptions());
  try {
    if (args[0] === "--write") return await writeReferences(browser);
    const baseline = JSON.parse(
      await readFile(WORKER_DARK_BASELINE_PATH, "utf8"),
    );
    const { issues, results } = await checkWorkerDarkReferences({
      baseline,
      browser,
    });
    for (const result of results) {
      console.log(
        `${result.id}: ${result.issue ?? `score=${result.score.toFixed(6)}`}`,
      );
    }
    for (const issue of issues) console.error(issue);
    if (issues.length) process.exitCode = 1;
    else {
      console.log(
        `All ${results.length} worker-dark references verified clean (floor 0.95).`,
      );
    }
  } finally {
    await browser.close();
    await closeWorkerDarkServer();
  }
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
