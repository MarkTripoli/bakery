// Renders the DESIGN half of the Paper parity gate: deterministic
// screenshots of docs/technical-design/auth-mocks (the committed design
// source) taken through the exact recipe paper-export.cjs used to export the
// Paper file itself. compare-paper.mjs's design-case path imports
// `checkDesignReferences` from here to prove a committed reference PNG still
// matches a fresh render of the same mock inputs before ever comparing it
// against the app; a stale or hand-edited reference cannot pass unnoticed.
//
// This script never renders the APP side (the candidate) — that is
// capture-stories.mjs's job. It only knows about the auth-mocks static site
// and docs/technical-design/ui-baselines/paper-baselines.json.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
  assertK0Environment,
  K0_ADAPTER_VERSION,
  paperBrowserLaunchOptions,
  paperRasterContext,
  withPaperBrowser,
} from "./paper-browser-profile.mjs";
import {
  captureK0Raster,
  deriveK0RasterProfile,
  K0_RASTER_VERSION,
  verifyK0RasterProfile,
} from "./paper-k0-raster.mjs";
import { workerReadinessMarkup } from "./worker-readiness-reference.mjs";
import { comparePngs, pngDimensions } from "./image-score.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const designRoot = join(root, "docs/technical-design");
const designManifestPath = join(
  designRoot,
  "auth-mocks/paper-manifest.json",
);
const baselinePath = join(
  root,
  "docs/technical-design/ui-baselines/paper-baselines.json",
);
const designImageDirectory = "docs/technical-design/ui-baselines/paper/design";
const fontsDirectory = join(
  root,
  "docs/technical-design/enterprise-mocks/fonts",
);

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

// Explicit per-case selection; never infer K-0 or normalize V-0 inputs.
export function resolveSourceProfile(baseline, designCase = {}) {
  if (designCase.sourceProfile === undefined) {
    if (designCase.pageId === "K-0") {
      throw new Error("K-0: missing source profile");
    }
    return {
      source: baseline.source,
      render: {
        entryPath: "auth-mocks/index.html",
        mountSelector: "#app",
        readyGlobal: "bakeryAuthReady",
        imageSelector: "#app img",
      },
    };
  }
  const profile = baseline.sourceProfiles?.[designCase.sourceProfile];
  if (designCase.sourceProfile !== "K-0" || !profile) {
    throw new Error(`Unknown Paper source profile ${designCase.sourceProfile}`);
  }
  if (
    profile.source?.fileId !== "01M1X504XVC45FC0VDK857A37D" ||
    profile.source?.pageId !== "K-0" ||
    profile.source?.manifestPath !==
      "docs/technical-design/worker-readiness/paper-manifest.json" ||
    !profile.source.inputs?.length || !profile.source.revision ||
    !/^[a-f0-9]{64}$/.test(profile.source.digest ?? "") ||
    profile.raster?.version !== K0_ADAPTER_VERSION ||
    profile.raster?.helperVersion !== K0_RASTER_VERSION ||
    !/^[a-f0-9]{64}$/.test(profile.raster?.implementationDigest ?? "") ||
    profile.render?.entryPath !== "worker-readiness/index.html" ||
    profile.render?.mountSelector !== "#app" ||
    profile.render?.readyGlobal !== "bakeryWorkerReadinessReady" ||
    profile.render?.imageSelector !== "#app img"
  ) {
    throw new Error("Invalid K-0 source profile");
  }
  return profile;
}

// Revalidate original bytes and implementation at each capture boundary.
export async function loadK0RasterProfile(baseline, designCase) {
  const { source, raster } = resolveSourceProfile(baseline, designCase);
  if (
    designCase.sourceProfile !== "K-0" ||
    designCase.sourceDigest !== source.digest
  ) {
    throw new Error("K-0: source.digest mismatch");
  }
  if (
    designCase.comparisonRegion || designCase.comparisonMask ||
    designCase.dpr !== 1
  ) throw new Error("K-0: partial reference or unsupported DPR");
  if (
    JSON.stringify(designCase.fontDigests) !==
      JSON.stringify(await fontDigests(baseline, designCase))
  ) throw new Error("K-0: stale or missing font digests");
  const bytes = await readFile(join(root, designCase.imagePath));
  const profile = deriveK0RasterProfile(bytes, {
    sha256: designCase.imageSha256,
    ...designCase.artboard,
    sourceIdentity: source.digest,
  });
  if (
    profile.implementationDigest !== raster.implementationDigest ||
    JSON.stringify(profile) !== JSON.stringify(designCase.rasterProfile)
  ) {
    throw new Error("K-0: missing or stale raster profile");
  }
  return verifyK0RasterProfile(bytes, designCase.rasterProfile);
}

export function designReferenceUrl(baseUrl, baseline, designCase) {
  const { render } = resolveSourceProfile(baseline, designCase);
  const { screen, state } = designCase.design;
  const hash = state === "default" ? `#${screen}` : `#${screen}/${state}`;
  const capabilities = designCase.sourceProfile
    ? undefined
    : baseline.reference?.capabilities;
  const query = `screen=1&theme=${designCase.theme}${
    capabilities ? `&caps=${capabilities}` : ""
  }`;
  return `${baseUrl}/${render.entryPath}?${query}${hash}`;
}

let serverState = null;

// One static server, lazily started on an ephemeral 127.0.0.1 port and
// reused for every artboard in a run: docs/technical-design is the HTTP
// root so index.html's `../enterprise-mocks/fonts` reference resolves
// exactly as it does for paper-export.cjs.
async function ensureServer() {
  if (serverState) return serverState.baseUrl;
  const server = createServer(async (request, response) => {
    const requestPath = normalize(
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    try {
      if (requestPath === "/worker-readiness/reference.html") {
        const frame = new URL(request.url, "http://localhost").searchParams.get(
          "frame",
        );
        const markup = await workerReadinessMarkup(
          join(designRoot, "worker-readiness"),
          frame,
        );
        response.writeHead(200, { "content-type": "text/html" });
        response.end(markup);
        return;
      }
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

export async function closeServer() {
  if (!serverState) return;
  const { server } = serverState;
  serverState = null;
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

export async function readDesignManifest(baseline, designCase = {}) {
  return await readJson(
    baseline
      ? join(
        root,
        resolveSourceProfile(baseline, designCase).source.manifestPath,
      )
      : designManifestPath,
  );
}

// Looks up the exact Paper artboard a DesignCase's (screen, state, theme,
// device) tuple was exported from. Throws with every valid state for that
// screen id so a typo in --add fails loudly instead of silently rendering
// the wrong artboard.
export function lookupArtboard(
  manifest,
  { screen, state, theme, device },
  baseline,
  designCase = {},
) {
  if (baseline) {
    const { source } = resolveSourceProfile(baseline, designCase);
    if (
      manifest.fileId !== source.fileId || manifest.pageId !== source.pageId
    ) throw new Error("Paper manifest source profile mismatch");
  }
  const entry = manifest.screens.find((candidate) =>
    candidate.id === screen &&
    candidate.state === state &&
    candidate.theme === theme &&
    candidate.device === device
  );
  if (entry) {
    return { nodeId: entry.nodeId, width: entry.width, height: entry.height };
  }
  const validStates = [
    ...new Set(
      manifest.screens.filter((candidate) => candidate.id === screen).map((
        candidate,
      ) => candidate.state),
    ),
  ];
  if (validStates.length === 0) {
    throw new Error(
      `no artboard for screen "${screen}" in paper-manifest.json (no screens with that id)`,
    );
  }
  throw new Error(
    `no artboard for ${screen}/${state}/${theme}/${device} in paper-manifest.json; valid states for "${screen}": ${
      validStates.join(", ")
    }`,
  );
}

// Builds the `<style>` injected before capture: `reference.hidden`
// selectors become `visibility:hidden` (never `display:none`, which would
// shift `.form-pane`'s centered content — see
// reports/fidelity-scout-mock-anatomy.md §2) and `reference.overrides` pins
// CSS custom properties on `:root` (light) or `:root[data-theme=dark]`
// (dark) for the artboard's theme only.
function referenceStyle(reference, theme) {
  if (!reference) return null;
  const rules = [];
  if (reference.hidden?.length) {
    rules.push(`${reference.hidden.join(",")}{visibility:hidden}`);
  }
  const overridesForTheme = reference.overrides?.[theme];
  if (overridesForTheme && Object.keys(overridesForTheme).length) {
    const declarations = Object.entries(overridesForTheme)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    const selector = theme === "dark" ? ":root[data-theme=dark]" : ":root";
    rules.push(`${selector}{${declarations}}`);
  }
  return rules.length ? rules.join("\n") : null;
}

// Renders one artboard by the recipe verified deterministic in
// reports/fidelity-scout-mock-anatomy.md §2-3: fresh context+page per
// artboard (no carried module state), explicit theme (never "system"),
// reduced motion, fonts.ready, every `#app img`'s decode() settled, then a
// fullPage screenshot at the case's own viewport. Throws on height drift
// before ever taking the screenshot, since a wrong height means the layout
// itself disagrees with Paper, not just pixels.
export async function renderDesignReference(browser, baseline, designCase) {
  resolveSourceProfile(baseline, designCase);
  return await withPaperBrowser(
    browser,
    designCase,
    (scopedBrowser) =>
      renderDesignReferenceOnce(scopedBrowser, baseline, designCase),
  );
}

async function renderDesignReferenceOnce(browser, baseline, designCase) {
  const { render } = resolveSourceProfile(baseline, designCase);
  if (designCase.sourceProfile) {
    const identity = await computeSourceIdentity(baseline, designCase);
    if (
      identity.digest !==
        resolveSourceProfile(baseline, designCase).source.digest
    ) throw new Error("K-0: source.digest mismatch");
  }
  const rasterProfile = designCase.sourceProfile === undefined
    ? null
    : await loadK0RasterProfile(baseline, designCase);
  if (rasterProfile) {
    assertK0Environment({
      ...designCase,
      browserVersion: browser.version(),
      playwrightVersion: (await readJson(
        join(root, "packages/ui/node_modules/@playwright/test/package.json"),
      )).version,
    });
  }
  const baseUrl = await ensureServer();
  const context = await browser.newContext({
    ...(rasterProfile ? { timezoneId: "UTC" } : {}),
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
    const capabilities = designCase.sourceProfile
      ? undefined
      : baseline.reference?.capabilities;
    const url = designReferenceUrl(baseUrl, baseline, designCase);
    try {
      await page.goto(url);
    } catch (error) {
      // Chromium reports transient socket exhaustion on a busy machine as a
      // navigation error; the render itself is deterministic, so one retry
      // cannot change the result, only recover it.
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
    const style = referenceStyle(
      designCase.sourceProfile ? undefined : baseline.reference,
      designCase.theme,
    );
    if (style) await page.addStyleTag({ content: style });
    const height = await page.evaluate(
      (selector) =>
        Math.max(document.querySelector(selector).scrollHeight, innerHeight),
      render.mountSelector,
    );
    // The mock must reproduce Paper's frame height exactly: a different
    // height means the layout itself disagrees with Paper, not just pixels.
    // Only a screen the capability derivation actually edits
    // (`reference.derived`) may come out shorter — omitted blocks release
    // vertical space — and never taller; the height it did produce is
    // recorded per case as `image` so --check can hold it fixed.
    const derived = capabilities !== undefined &&
      (baseline.reference?.derived ?? []).includes(screen);
    if (!derived && height !== designCase.artboard.height) {
      throw new Error(
        `height drift: expected ${designCase.artboard.height} got ${height}`,
      );
    }
    if (derived && height > designCase.artboard.height) {
      throw new Error(
        `derived render taller than the artboard: ${height} > ${designCase.artboard.height}`,
      );
    }
    // A `comparisonRegion.measure` selector pins the region to one element's
    // page box (the settings content column), so the manifest records the
    // design's real content extent rather than a hand-typed rectangle.
    const measure = designCase.comparisonRegion?.measure;
    const measured = measure
      ? await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.left + scrollX),
          y: Math.round(rect.top + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }, measure)
      : null;
    if (measure && !measured) {
      throw new Error(`comparison region selector ${measure} matched nothing`);
    }
    const bytes = rasterProfile
      ? await captureK0Raster(page, render.mountSelector, rasterProfile)
      : await page.screenshot({ fullPage: true });
    return {
      bytes,
      height,
      measured,
      ...(designCase.sourceProfile === undefined ? {} : {
        rasterProfile,
        rasterContract: {
          sourceProfile: designCase.sourceProfile,
          sourceDigest: designCase.sourceDigest,
          originalPng: rasterProfile.reference,
          adapter: {
            version: K0_ADAPTER_VERSION,
            implementationDigest: rasterProfile.implementationDigest,
            ...rasterProfile.offset,
          },
          contextDigest: sha256(JSON.stringify(paperRasterContext({
            ...designCase,
            browserVersion: browser.version(),
            playwrightVersion: (await readJson(
              join(
                root,
                "packages/ui/node_modules/@playwright/test/package.json",
              ),
            )).version,
            browserLaunchOptions: paperBrowserLaunchOptions(designCase),
            timezone: "UTC",
            reducedMotion: "reduce",
            zoom: 1,
          }))),
        },
        playwrightVersion: (await readJson(
          join(
            root,
            "packages/ui/node_modules/@playwright/test/package.json",
          ),
        )).version,
        browserLaunchOptions: paperBrowserLaunchOptions(designCase),
        browserVersion: browser.version(),
        os: `${process.platform}-${process.arch}`,
      }),
    };
  } finally {
    await context.close();
  }
}

async function filesIn(path) {
  const details = await stat(path);
  if (details.isFile()) return [path];
  const children = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const child of children) {
    files.push(...await filesIn(join(path, child.name)));
  }
  return files.sort();
}

// Same font set, same relative-path keys, same digest as
// capture-stories.mjs's own `fontDigests()` — a DesignCase and the runtime
// candidate it is compared against must agree on which font bytes rendered
// the text, or a font substitution could pass as a pixel-identical layout.
export async function fontDigests(baseline, designCase = {}) {
  const directory = baseline && designCase.sourceProfile
    ? join(
      root,
      dirname(resolveSourceProfile(baseline, designCase).source.manifestPath),
      "fonts",
    )
    : fontsDirectory;
  const fonts = (await filesIn(directory)).filter((path) =>
    path.endsWith(".ttf")
  );
  return Object.fromEntries(
    await Promise.all(fonts.map(async (path) => [
      relative(root, path),
      sha256(await readFile(path)),
    ])),
  );
}

// The Paper source identity: one SHA-256 over every mock input plus the
// manifest that maps them to Paper node IDs, in the fixed order
// `baseline.source.inputs` declares. `revision` records both the bare
// manifest hash ("paper:") and the full identity ("mock:") so a reviewer
// can tell a Paper-only re-export from a mock-source edit at a glance.
export async function computeSourceIdentity(baseline, designCase = {}) {
  const { source } = resolveSourceProfile(baseline, designCase);
  const parts = [];
  for (const relativePath of source.inputs) {
    const bytes = await readFile(join(root, relativePath));
    parts.push(`${relativePath}\0${sha256(bytes)}\n`);
  }
  if (designCase.sourceProfile !== undefined) {
    parts.push(
      `browserLaunchOptions\0${
        JSON.stringify(paperBrowserLaunchOptions(designCase))
      }\n`,
    );
  }
  const digest = sha256(parts.join(""));
  const manifestBytes = await readFile(
    source.manifestPath ? join(root, source.manifestPath) : designManifestPath,
  );
  const paperHash = sha256(manifestBytes).slice(0, 8);
  const rendered = new Date().toISOString().slice(0, 10);
  const revision = `paper:${paperHash}; mock:${
    digest.slice(0, 8)
  }; rendered:${rendered}`;
  return { digest, revision };
}

// Re-renders every `reference: "design"` case and proves three independent
// things about the committed PNG before the gate is allowed to trust it as
// "the design": (1) it is byte-identical to what ships (imageSha256), (2) a
// fresh render of the same mock inputs still produces the same pixels
// (score >= REFERENCE_RENDER_FLOOR — the gate's own tolerance, because a
// fresh render on a different machine differs from the committed pixels by
// glyph rasterisation alone: the CI runner scores 0.984-0.995 against
// references rendered on a workstation, while a 6px shift of one heading
// scores 0.93), and (3) the manifest inputs that produced it have not
// silently changed underneath it (source.digest). `imageSha256` already pins
// the bytes exactly; this floor bounds how far a manifest could be stamped
// away from a true render of its source.
const REFERENCE_RENDER_FLOOR = 0.95;
export async function checkDesignReferences({ baseline, browser }) {
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

  const designCases = (baseline.cases ?? []).filter((designCase) =>
    designCase.reference === "design"
  );
  const page = await browser.newPage();
  try {
    for (const designCase of designCases) {
      let artboard;
      try {
        const { source } = resolveSourceProfile(baseline, designCase);
        if (designCase.sourceProfile) {
          const identity = await computeSourceIdentity(baseline, designCase);
          if (identity.digest !== source.digest) {
            throw new Error(
              `${designCase.sourceProfile}: source.digest mismatch`,
            );
          }
        }
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
        rendered = await renderDesignReference(browser, baseline, designCase);
      } catch (error) {
        issues.push(`${designCase.id}: ${error.message}`);
      }
      if (rendered?.measured) {
        const region = designCase.comparisonRegion;
        const same = ["x", "y", "width", "height"].every((key) =>
          region?.[key] === rendered.measured[key]
        );
        if (!same) {
          issues.push(
            `${designCase.id}: measured comparison region ${
              JSON.stringify(rendered.measured)
            } differs from the recorded one`,
          );
        }
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
        ...(rendered.rasterContract
          ? {
            rasterContract: rendered.rasterContract,
            rasterProfile: rendered.rasterProfile,
          }
          : {}),
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

const DEVICE_VIEWPORTS = {
  desktop: { width: 1440, height: 960 },
  phone: { width: 390, height: 844 },
};
const DEVICE_POINTERS = { desktop: "fine", phone: "coarse" };

function designCaseId(screen, state, theme, device) {
  return `${screen}.${state}.${theme}.${device}`;
}

export function buildDesignCase(
  baseline,
  manifest,
  { screen, state, theme, device, route, session, sourceProfile },
) {
  const selection = sourceProfile === undefined ? {} : { sourceProfile };
  const { source } = resolveSourceProfile(baseline, selection);
  const artboard = lookupArtboard(
    manifest,
    { screen, state, theme, device },
    baseline,
    selection,
  );
  return {
    ...selection,
    ...(sourceProfile === undefined ? {} : {
      browserLaunchOptions: paperBrowserLaunchOptions(selection),
      sourceDigest: source.digest,
    }),
    id: designCaseId(screen, state, theme, device),
    reference: "design",
    frameId: artboard.nodeId,
    pageId: source.pageId,
    design: { screen, state, theme, device },
    imagePath:
      `${designImageDirectory}/${screen}--${state}--${theme}--${device}.png`,
    imageSha256: "",
    viewport: DEVICE_VIEWPORTS[device],
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
    ...(sourceProfile === undefined ? {} : (() => {
      const pinned = baseline.cases.find((entry) =>
        entry.sourceProfile === sourceProfile &&
        entry.frameId === artboard.nodeId
      );
      if (!pinned?.rasterProfile || !pinned.imageSha256) {
        throw new Error("K-0: original PNG profile is not registered");
      }
      return {
        imagePath: pinned.imagePath,
        imageSha256: pinned.imageSha256,
        rasterProfile: pinned.rasterProfile,
        viewport: pinned.viewport,
        fontDigests: pinned.fontDigests,
      };
    })()),
  };
}

export async function renderAndFillCase(browser, baseline, designCase) {
  if (designCase.sourceProfile !== undefined) {
    throw new Error("K-0 originals are immutable; use --check, never refill");
  }
  const { bytes, height, measured } = await renderDesignReference(
    browser,
    baseline,
    designCase,
  );
  const absolutePath = join(root, designCase.imagePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  designCase.imageSha256 = sha256(bytes);
  designCase.image = pngDimensions(bytes);
  if (measured) {
    designCase.comparisonRegion = {
      ...designCase.comparisonRegion,
      ...measured,
    };
  }
  designCase.fontDigests = await fontDigests(baseline, designCase);
  if (height !== designCase.artboard.height) {
    console.log(
      `${designCase.id}: derived height ${height} (artboard ${designCase.artboard.height})`,
    );
  }
}

async function loadBaseline() {
  return await readJson(baselinePath);
}

async function saveBaseline(baseline) {
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

function ensureMigrated(baseline) {
  if (baseline.schemaVersion !== 2) {
    throw new Error(
      `paper-baselines.json is schemaVersion ${baseline.schemaVersion}; design references require the schemaVersion 2 migration`,
    );
  }
}

function parseArguments(rawArgv) {
  const argv = rawArgv.filter((argument) => argument !== "--");
  const [first, ...rest] = argv;
  if (first === undefined || first === "--write") return { kind: "write" };
  if (first === "--check") return { kind: "check" };
  if (first === "--list") return { kind: "list" };
  if (first === "--add") {
    const [screen, state, ...flags] = rest;
    let route;
    let sourceProfile;
    let session = "anonymous";
    let themes = ["light", "dark"];
    let devices = ["desktop", "phone"];
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      if (flag === "--source-profile") sourceProfile = flags[++index];
      else if (flag === "--route") route = flags[++index];
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
    return {
      kind: "add",
      screen,
      state,
      route,
      session,
      themes,
      devices,
      sourceProfile,
    };
  }
  throw new Error(`unknown argument ${first}`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));

  if (args.kind === "list") {
    const baseline = await loadBaseline();
    for (const designCase of baseline.cases ?? []) {
      console.log(
        `${designCase.id}\t${designCase.reference}\t${designCase.imagePath}`,
      );
    }
    return;
  }

  const browser = await chromium.launch();
  try {
    if (args.kind === "check") {
      const baseline = await loadBaseline();
      const { issues, results } = await checkDesignReferences({
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

    if (args.kind === "add") {
      const baseline = await loadBaseline();
      ensureMigrated(baseline);
      const manifest = await readDesignManifest(baseline, args);
      const added = [];
      for (const theme of args.themes) {
        for (const device of args.devices) {
          const id = designCaseId(args.screen, args.state, theme, device);
          if ((baseline.cases ?? []).some((existing) => existing.id === id)) {
            continue;
          }
          const designCase = buildDesignCase(baseline, manifest, {
            sourceProfile: args.sourceProfile,
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
        await renderAndFillCase(browser, baseline, designCase);
      }
      Object.assign(
        resolveSourceProfile(baseline, args).source,
        await computeSourceIdentity(baseline, args),
      );
      await saveBaseline(baseline);
      console.log(
        `Added ${added.length} design case(s): ${
          added.map((designCase) => designCase.id).join(", ")
        }`,
      );
      return;
    }

    if (args.kind === "write") {
      const baseline = await loadBaseline();
      ensureMigrated(baseline);
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
        designCase.artboard = {
          width: artboard.width,
          height: artboard.height,
        };
        await renderAndFillCase(browser, baseline, designCase);
      }
      for (const selection of [{}, ...designCases]) {
        Object.assign(
          resolveSourceProfile(baseline, selection).source,
          await computeSourceIdentity(baseline, selection),
        );
      }
      await saveBaseline(baseline);
      console.log(`Rendered ${designCases.length} design reference(s).`);
      return;
    }
  } finally {
    await browser.close();
    await closeServer();
  }
}

if (import.meta.main) {
  await main();
}
