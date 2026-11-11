// Renders the DESIGN half of the enterprise Paper parity gate: deterministic
// screenshots of the generated enterprise-mocks site
// (docs/technical-design/enterprise-mocks/site, built from the committed Paper
// JSX by paper-jsx-to-html.mjs) for docs/technical-design/ui-baselines/
// enterprise-baselines.json.
//
// This is the enterprise sibling of render-paper-references.mjs. That script
// and the helpers it exports (artboard lookup, source identity, font digests)
// are pinned inputs of the K-0 source profile and are immutable, so the
// enterprise manifest lives here and only READS the pinned helpers. Auth and
// K-0 references never go through this file.
//
//   node scripts/render-enterprise-references.mjs --check
//   node scripts/render-enterprise-references.mjs --write
//   node scripts/render-enterprise-references.mjs --add <screen> <state> --route <r>
//   node scripts/render-enterprise-references.mjs --list
//
// Enterprise renders run under the hermetic fontconfig in ./fontconfig so
// glyph rasterisation does not depend on the host's fonts.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { chromium } from "@playwright/test";
import {
  computeSourceIdentity,
  fontDigests,
  lookupArtboard,
  readDesignManifest,
} from "./render-paper-references.mjs";
import { comparePngs, pngDimensions } from "./image-score.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const designRoot = join(root, "docs/technical-design");

export const ENTERPRISE_BASELINE_PATH = join(
  root,
  "docs/technical-design/ui-baselines/enterprise-baselines.json",
);
const IMAGE_DIRECTORY = "docs/technical-design/ui-baselines/paper/enterprise";
const fontconfigPath = join(scriptDirectory, "fontconfig/fonts.conf");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CONTENT_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

// A fresh render of the pinned mock must score at least this against the
// committed PNG; the gate's own tolerance, matching render-paper-references.
const REFERENCE_RENDER_FLOOR = 0.95;

// Chromium launch options for every enterprise render and capture: only the
// enterprise manifest gets the hermetic FONTCONFIG_FILE.
export function enterpriseLaunchOptions() {
  return { env: { ...process.env, FONTCONFIG_FILE: fontconfigPath } };
}

// Entry path (relative to docs/technical-design, the HTTP root) and ready
// global come from the manifest's own `source`.
export function enterpriseRender(baseline) {
  const { entry, readyGlobal } = baseline.source ?? {};
  if (!entry || !readyGlobal) {
    throw new Error(
      "enterprise-baselines.json source must name entry and readyGlobal",
    );
  }
  return {
    entryPath: relative(designRoot, join(root, entry)),
    mountSelector: "#app",
    readyGlobal,
    imageSelector: "#app img",
  };
}

export function enterpriseReferenceUrl(baseUrl, baseline, designCase) {
  const { entryPath } = enterpriseRender(baseline);
  const { screen, state } = designCase.design;
  const hash = state === "default" ? `#${screen}` : `#${screen}/${state}`;
  return `${baseUrl}/${entryPath}?screen=1&theme=${designCase.theme}${hash}`;
}

let serverState = null;

// One static server on an ephemeral 127.0.0.1 port, reused for every artboard
// in a run; docs/technical-design is the HTTP root so the site's relative
// `../fonts` references resolve.
async function ensureServer() {
  if (serverState) return serverState.baseUrl;
  const server = createServer(async (request, response) => {
    const requestPath = normalize(
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    try {
      const bytes = await readFile(join(designRoot, requestPath));
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(requestPath)] ??
          "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  serverState = { server, baseUrl: `http://127.0.0.1:${port}` };
  return serverState.baseUrl;
}

export async function closeEnterpriseServer() {
  if (!serverState) return;
  const { server } = serverState;
  serverState = null;
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

// Renders one artboard: fresh context per artboard, explicit theme, reduced
// motion, fonts.ready, every `#app img` decoded, then a fullPage screenshot at
// the case's viewport. Throws on height drift: a wrong height means the layout
// disagrees with Paper, not just pixels.
export async function renderEnterpriseReference(browser, baseline, designCase) {
  const render = enterpriseRender(baseline);
  const baseUrl = await ensureServer();
  const context = await browser.newContext({
    deviceScaleFactor: designCase.dpr,
    reducedMotion: "reduce",
    locale: designCase.locale,
    colorScheme: designCase.theme,
    hasTouch: designCase.pointer === "coarse",
    viewport: designCase.viewport,
  });
  try {
    const page = await context.newPage();
    const { screen, state } = designCase.design;
    const url = enterpriseReferenceUrl(baseUrl, baseline, designCase);
    try {
      await page.goto(url);
    } catch (error) {
      // Transient socket exhaustion on a busy machine; the render itself is
      // deterministic, so one retry only recovers it.
      if (!/ERR_INSUFFICIENT_RESOURCES/.test(String(error))) throw error;
      await page.goto(url);
    }
    await page.waitForFunction(
      ({ id, expectedState, mountSelector, readyGlobal }) => {
        const app = document.querySelector(mountSelector);
        return Boolean(globalThis[readyGlobal]) &&
          app?.dataset.screen === id && app?.dataset.state === expectedState;
      },
      { id: screen, expectedState: state, ...render },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((selector) =>
      Promise.all(
        [...document.querySelectorAll(selector)].map((image) => image.decode()),
      ), render.imageSelector);
    const height = await page.evaluate(
      (selector) =>
        Math.max(document.querySelector(selector).scrollHeight, innerHeight),
      render.mountSelector,
    );
    if (height !== designCase.artboard.height) {
      throw new Error(
        `height drift: expected ${designCase.artboard.height} got ${height}`,
      );
    }
    // A phone frame's first child under the frame root is the device status
    // bar Paper draws; its rendered height is what `deviceChrome.top` must be.
    const chrome = designCase.deviceChrome
      ? await page.evaluate((selector) => {
        const element = document.querySelector(selector)?.firstElementChild
          ?.firstElementChild;
        return element
          ? {
            height: element.getBoundingClientRect().height,
            text: element.textContent ?? "",
          }
          : null;
      }, render.mountSelector)
      : null;
    const bytes = await page.screenshot({ fullPage: true });
    return {
      bytes,
      height,
      chromeHeight: chrome ? chrome.height : null,
      chromeText: chrome ? chrome.text : null,
    };
  } finally {
    await context.close();
  }
}

// The recorded `deviceChrome.top` must equal the measured height of the status
// bar element in the rendered reference, so the excluded band cannot drift from
// the design (a taller bar would leak chrome into the score, a shorter one
// would hide real UI rows). The element must also carry the status-bar clock
// text, so a different 62px first child cannot pass on height alone.
// Returns an issue string or null.
export const STATUS_BAR_TIME_TEXT = "9:41";

export function deviceChromeDrift(designCase, chromeHeight, chromeText) {
  const chrome = designCase.deviceChrome;
  if (!chrome) return null;
  if (chromeHeight === null || chromeHeight === undefined) {
    return `deviceChrome: the status bar element (first child of the frame root) was not found`;
  }
  if (chromeHeight !== chrome.top) {
    return `deviceChrome.top ${chrome.top} differs from the measured status bar height ${chromeHeight}`;
  }
  if (!String(chromeText ?? "").includes(STATUS_BAR_TIME_TEXT)) {
    return `deviceChrome: the measured element (first child of the frame root) does not contain the status bar time text "${STATUS_BAR_TIME_TEXT}"; it is not the status bar`;
  }
  return null;
}

// Validates the manifest with the Zod schema. Loaded lazily: it is TypeScript,
// and this module is also imported by Playwright-run comparison code.
export async function enterpriseSchemaIssues(baseline) {
  const { parseEnterpriseBaselines } = await import(
    "../catalog/design-cases.ts"
  );
  const result = parseEnterpriseBaselines(baseline);
  return result.success
    ? []
    : result.issues.map((issue) => `enterprise-baselines.json ${issue}`);
}

// Re-renders every design case of the enterprise manifest and proves three
// independent things about the committed PNG: it is byte-identical to what
// ships (imageSha256), a fresh render of the same inputs still scores at least
// the floor against it, and the manifest inputs that produced it have not
// silently changed (source.digest).
export async function checkEnterpriseReferences({ baseline, browser }) {
  const issues = [];
  const results = [];

  const identity = await computeSourceIdentity(baseline);
  if (identity.digest !== baseline.source.digest) {
    issues.push(
      `source.digest mismatch (manifest ${
        baseline.source.digest.slice(0, 8)
      } vs inputs ${identity.digest.slice(0, 8)})`,
    );
  }

  issues.push(...await enterpriseSchemaIssues(baseline));

  const designCases = (baseline.cases ?? []).filter((designCase) =>
    designCase.reference === "design"
  );
  const page = await browser.newPage();
  try {
    for (const designCase of designCases) {
      let artboard;
      try {
        const manifest = await readDesignManifest(baseline, designCase);
        artboard = lookupArtboard(
          manifest,
          designCase.design,
          baseline,
          designCase,
        );
      } catch (error) {
        issues.push(`${designCase.id}: ${error.message}`);
      }
      if (artboard) {
        if (
          artboard.width !== designCase.artboard.width ||
          artboard.height !== designCase.artboard.height
        ) {
          issues.push(
            `${designCase.id}: artboard differs from paper-manifest (${designCase.artboard.width}x${designCase.artboard.height} vs ${artboard.width}x${artboard.height})`,
          );
        }
        if (artboard.nodeId !== designCase.frameId) {
          issues.push(`${designCase.id}: frameId differs from paper-manifest`);
        }
      }

      let committedBytes = null;
      try {
        committedBytes = await readFile(join(root, designCase.imagePath));
      } catch {
        issues.push(`${designCase.id}: committed reference image is missing`);
      }
      if (committedBytes && sha256(committedBytes) !== designCase.imageSha256) {
        issues.push(`${designCase.id}: imageSha256 mismatch`);
      }

      let rendered = null;
      try {
        rendered = await renderEnterpriseReference(
          browser,
          baseline,
          designCase,
        );
      } catch (error) {
        issues.push(`${designCase.id}: ${error.message}`);
      }

      if (rendered) {
        const drift = deviceChromeDrift(
          designCase,
          rendered.chromeHeight,
          rendered.chromeText,
        );
        if (drift) issues.push(`${designCase.id}: ${drift}`);
      }

      if (!committedBytes || !rendered) {
        results.push({ id: designCase.id, issue: "not compared" });
        continue;
      }

      const committed = pngDimensions(committedBytes);
      const fresh = pngDimensions(rendered.bytes);
      if (
        committed.width !== designCase.image?.width ||
        committed.height !== designCase.image?.height
      ) {
        issues.push(
          `${designCase.id}: recorded image dimensions (${designCase.image?.width}x${designCase.image?.height}) differ from the committed reference (${committed.width}x${committed.height})`,
        );
      }
      if (
        committed.width !== fresh.width || committed.height !== fresh.height
      ) {
        const issue =
          `rendered dimensions differ from committed reference (${fresh.width}x${fresh.height} vs ${committed.width}x${committed.height})`;
        issues.push(`${designCase.id}: ${issue}`);
        results.push({ id: designCase.id, issue });
        continue;
      }

      const scoreResult = await comparePngs(page, {
        candidate: rendered.bytes,
        baseline: committedBytes,
      });
      if (scoreResult.issue) {
        issues.push(`${designCase.id}: ${scoreResult.issue}`);
        results.push({ id: designCase.id, issue: scoreResult.issue });
        continue;
      }
      results.push({
        id: designCase.id,
        score: scoreResult.score,
        inkScore: scoreResult.inkScore,
        surfaceScore: scoreResult.surfaceScore,
        inkCoverage: scoreResult.inkCoverage,
        surfaceCoverage: scoreResult.surfaceCoverage,
      });
      if (scoreResult.score < REFERENCE_RENDER_FLOOR) {
        issues.push(
          `${designCase.id}: committed reference differs from a fresh render (score ${
            scoreResult.score.toFixed(4)
          })`,
        );
      }
    }
  } finally {
    await page.close();
  }

  return { issues, results };
}

const DEVICE_POINTERS = { desktop: "fine", phone: "coarse" };

function designCaseId(screen, state, theme, device) {
  return `${screen}.${state}.${theme}.${device}`;
}

// A new enterprise case: the viewport is the Paper frame itself (enterprise
// frames are not the auth 1440x960 / 390x844 viewports).
export function buildEnterpriseCase(
  baseline,
  manifest,
  { screen, state, theme, device, route, session },
) {
  const artboard = lookupArtboard(
    manifest,
    { screen, state, theme, device },
    baseline,
  );
  return {
    id: designCaseId(screen, state, theme, device),
    reference: "design",
    frameId: artboard.nodeId,
    pageId: baseline.source.pageId,
    design: { screen, state, theme, device },
    imagePath:
      `${IMAGE_DIRECTORY}/${screen}--${state}--${theme}--${device}.png`,
    imageSha256: "",
    viewport: { width: artboard.width, height: artboard.height },
    artboard: { width: artboard.width, height: artboard.height },
    image: { width: artboard.width, height: artboard.height },
    dpr: 1,
    theme,
    pointer: DEVICE_POINTERS[device],
    locale: "en-US",
    direction: "ltr",
    browser: "chromium",
    os: "linux-x64",
    fontDigests: {},
    candidate: { route, session },
  };
}

export async function renderAndFillEnterpriseCase(
  browser,
  baseline,
  designCase,
) {
  const { bytes, chromeHeight } = await renderEnterpriseReference(
    browser,
    baseline,
    designCase,
  );
  // `top` is derived, not authored: --write re-measures the status bar.
  if (designCase.deviceChrome && chromeHeight !== null) {
    if (designCase.deviceChrome.top !== chromeHeight) {
      console.warn(
        `WARNING ${designCase.id}: deviceChrome.top changed ${designCase.deviceChrome.top} -> ${chromeHeight}; review the status bar change`,
      );
    }
    designCase.deviceChrome.top = chromeHeight;
    console.log(`${designCase.id}: deviceChrome.top = ${chromeHeight}`);
  }
  const absolutePath = join(root, designCase.imagePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  designCase.imageSha256 = sha256(bytes);
  designCase.image = pngDimensions(bytes);
  designCase.fontDigests = await fontDigests(baseline, designCase);
}

async function saveBaseline(baseline) {
  const schemaIssues = await enterpriseSchemaIssues(baseline);
  if (schemaIssues.length) throw new Error(schemaIssues.join("; "));
  await writeFile(
    ENTERPRISE_BASELINE_PATH,
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

function ensureMigrated(baseline) {
  if (baseline.schemaVersion !== 2) {
    throw new Error(
      `enterprise-baselines.json is schemaVersion ${baseline.schemaVersion}; design references require the schemaVersion 2 migration`,
    );
  }
}

export function parseEnterpriseArguments(rawArgv) {
  const argv = rawArgv.filter((argument) => argument !== "--");
  const [first, ...rest] = argv;
  if (first === undefined || first === "--write") return { kind: "write" };
  if (first === "--check") return { kind: "check" };
  if (first === "--list") return { kind: "list" };
  if (first === "--add") {
    const [screen, state, ...flags] = rest;
    let route;
    let session = "anonymous";
    let themes = ["light", "dark"];
    let devices = ["desktop", "phone"];
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      if (flag === "--route") route = flags[++index];
      else if (flag === "--session") session = flags[++index];
      else if (flag === "--themes") themes = flags[++index].split(",");
      else if (flag === "--devices") devices = flags[++index].split(",");
      else throw new Error(`unknown --add argument ${flag}`);
    }
    if (!screen || !state || !route) {
      throw new Error(
        "usage: --add <screen> <state> --route <route> [--session anonymous|authenticated] [--themes light,dark] [--devices desktop,phone]",
      );
    }
    return { kind: "add", screen, state, route, session, themes, devices };
  }
  throw new Error(`unknown argument ${first}`);
}

async function main() {
  const args = parseEnterpriseArguments(process.argv.slice(2));

  if (args.kind === "list") {
    const baseline = await readJson(ENTERPRISE_BASELINE_PATH);
    for (const designCase of baseline.cases ?? []) {
      console.log(
        `${designCase.id}\t${designCase.reference}\t${designCase.imagePath}`,
      );
    }
    return;
  }

  const browser = await chromium.launch(enterpriseLaunchOptions());
  try {
    const baseline = await readJson(ENTERPRISE_BASELINE_PATH);
    if (args.kind === "check") {
      const { issues, results } = await checkEnterpriseReferences({
        baseline,
        browser,
      });
      for (const result of results) {
        console.log(
          result.issue
            ? `${result.id}: ${result.issue}`
            : `${result.id}: score=${result.score.toFixed(6)} ink=${
              result.inkScore.toFixed(4)
            } surface=${result.surfaceScore.toFixed(4)}`,
        );
      }
      if (issues.length) {
        console.error(`${issues.length} issue(s):`);
        for (const issue of issues) console.error(`  - ${issue}`);
        process.exitCode = 1;
      } else {
        console.log("All design references verified clean.");
      }
      return;
    }

    ensureMigrated(baseline);
    if (args.kind === "add") {
      const manifest = await readDesignManifest(baseline);
      const added = [];
      for (const theme of args.themes) {
        for (const device of args.devices) {
          const id = designCaseId(args.screen, args.state, theme, device);
          if ((baseline.cases ?? []).some((existing) => existing.id === id)) {
            continue;
          }
          const designCase = buildEnterpriseCase(baseline, manifest, {
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
    Object.assign(baseline.source, await computeSourceIdentity(baseline));
    await saveBaseline(baseline);
    console.log(`Rendered ${designCases.length} design reference(s).`);
  } finally {
    await browser.close();
    await closeEnterpriseServer();
  }
}

if (import.meta.main) {
  await main();
}
