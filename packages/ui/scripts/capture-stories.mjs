import {
  captureViewportBundleV2,
  expectedWorkerQualification,
} from "./native-viewport-bundle-v2.mjs";
import {
  assertK0Environment,
  K0_ADAPTER_VERSION,
  paperBrowserLaunchOptions,
  withPaperBrowser,
} from "./paper-browser-profile.mjs";
import { captureK0Raster } from "./paper-k0-raster.mjs";
import { viewportBundleIdentity } from "./native-viewport-bundle.mjs";
import {
  captureWholeArtboardPair,
  metadataDigest,
  pairedIdentity,
  WHOLE_ARTBOARD_VERSION,
  wholeArtboardBindingIssues,
} from "./paper-whole-artboard.mjs";
import { pngDimensions } from "./image-score.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const uiRoot = join(root, "packages/ui");
const storybookDirectory = join(uiRoot, "storybook-static");
const runtimePath = join(
  root,
  "docs/technical-design/ui-baselines/runtime-cases.json",
);
const catalogPath = join(
  root,
  "docs/technical-design/ui-baselines/components.json",
);
const tokenPath = join(root, "docs/technical-design/ui-baselines/tokens.json");
const paperBaselinesPath = join(
  root,
  "docs/technical-design/ui-baselines/paper-baselines.json",
);
// BAKERY_UI_ARTIFACTS_DIR relocates the whole artifact tree (default
// artifacts/ui-baseline) so parallel development loops on different screens
// do not overwrite each other's candidate manifest; CI leaves it unset.
const artifactsDirectory = resolve(
  root,
  process.env.BAKERY_UI_ARTIFACTS_DIR || "artifacts/ui-baseline",
);
const outputDirectory = join(artifactsDirectory, "runtime");
const outputManifestPath = join(outputDirectory, "manifest.json");

const ANIMATION_KILL_STYLE =
  "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }";

// Byte-for-byte copy of the fixture Problem `apps/web/tests/auth-guard.spec.ts`
// uses for an anonymous `GET /v1/me` — the shape a real API returns for an
// unauthenticated principal.
const AUTH_REQUIRED_PROBLEM = {
  type: "https://bakery.example/problems/auth-required",
  title: "Authentication required",
  status: 401,
  detail: "Authentication is required.",
  code: "AUTH_REQUIRED",
  requestId: "00000000-0000-4000-8000-000000000210",
  traceId: "00000000-0000-4000-8000-000000000211",
  retryable: false,
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sourceIdentity(sourceCommit, sourceDiff, untrackedSource = "") {
  const sourceMaterial = `${sourceDiff}\0${untrackedSource}`;
  const sourceDirty = sourceMaterial.length > 1;
  return {
    sourceCommit,
    sourceDirty,
    sourceDiffDigest: sourceDirty ? sha256(sourceMaterial) : null,
  };
}

async function untrackedSourceMaterial() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).map(normalizePath);
  const entries = [];
  for (const path of paths) {
    const absolutePath = join(root, path);
    // `git ls-files` normally only reports files, but an untracked directory
    // that itself contains a `.git` (a nested repo, e.g. a stray worktree)
    // is reported as a single opaque entry rather than recursed into.
    const details = await stat(absolutePath).catch(() => null);
    if (!details?.isFile()) continue;
    entries.push(`${path}\0${sha256(await readFile(absolutePath))}\0`);
  }
  return entries.sort().join("");
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

async function digestFiles(paths) {
  const files = (await Promise.all(paths.map(filesIn))).flat().sort();
  const payload = [];
  for (const path of files) {
    payload.push(relative(root, path), sha256(await readFile(path)));
  }
  return sha256(payload.join("\0"));
}

async function fontDigests() {
  const directory = join(root, "docs/technical-design/enterprise-mocks/fonts");
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

function storyIndexEntries(index) {
  return Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
}

export function runtimeGlobalQuery(context) {
  const viewportMode = context.zoom === 2
    ? "zoom-200"
    : context.viewport.width <= 390
    ? "narrow"
    : context.viewport.width < 1280
    ? "pane"
    : "desktop";
  return [
    `theme:${context.storedPreference}`,
    `direction:${context.direction}`,
    `locale:${context.locale === "en-XA" ? "pseudo" : context.locale}`,
    `pointer:${context.pointer}`,
    `reducedMotion:${context.reducedMotion}`,
    `viewportMode:${viewportMode}`,
  ].join(";");
}

export function storyUrl(baseURL, runtimeCase, context) {
  const url = new URL("/iframe.html", baseURL);
  url.searchParams.set("id", runtimeCase.storyId);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", runtimeGlobalQuery(context));
  if (runtimeCase.args) {
    const args = Object.entries(runtimeCase.args).map(([key, value]) => {
      if (
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ||
        typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)
      ) {
        throw new Error("Runtime story args must be finite identifier strings");
      }
      return `${key}:${value}`;
    });
    url.searchParams.set("args", args.join(";"));
  }
  return url.toString();
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sourcePathForCase(catalogEntry, story) {
  const storyPath = normalizePath(story.importPath ?? "");
  const storySource = storyPath.startsWith("../../")
    ? normalizePath(join("packages/ui", storyPath))
    : normalizePath(join("packages/ui", storyPath));
  if (catalogEntry.level === "page") return [storySource];
  const directory = {
    atom: "atoms",
    molecule: "molecules",
    organism: "organisms",
    template: "templates",
  }[catalogEntry.level];
  return [
    `packages/ui/src/${directory}/${catalogEntry.name}.tsx`,
    storySource,
  ];
}

async function waitForServer(baseURL) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL("/index.json", baseURL));
      if (response.ok) return;
    } catch {
      // The static server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Storybook did not become ready at ${baseURL}`);
}

const contentTypes = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function startStaticStorybook(directory = storybookDirectory) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
      let filePath = resolve(directory, `.${pathname}`);
      if (
        filePath !== directory &&
        !filePath.startsWith(`${directory}${sep}`)
      ) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(filePath)).isDirectory()) {
        filePath = join(filePath, "index.html");
      }
      // Read before the header: a directory without index.html, a deleted
      // file, or any unreadable asset must still answer 404. Writing the 200
      // first makes the failure path call writeHead on a sent response, and
      // that ERR_HTTP_HEADERS_SENT escapes this async handler and kills the
      // whole capture run.
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(filePath)] ??
          "application/octet-stream",
      });
      response.end(body);
    } catch {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(404).end();
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw new Error("Static Storybook did not expose a TCP port");
  }
  return { server, baseURL: `http://127.0.0.1:${address.port}` };
}

export function servedBuildIdentityIssues(localFiles, servedFiles) {
  return Object.entries(localFiles).flatMap(([path, digest]) =>
    servedFiles[path] === undefined
      ? [`Served Storybook is missing ${path}`]
      : servedFiles[path] !== digest
      ? [`Served Storybook differs from build at ${path}`]
      : []
  );
}

export function renderedContainmentIssues() {
  const root = document.querySelector(".storybook-story") ?? document.body;
  const tolerance = 2;
  const describe = (element) => {
    const identity = element.id
      ? `#${element.id}`
      : [...element.classList].slice(0, 2).map((name) => `.${name}`).join("");
    return `${element.tagName.toLowerCase()}${identity}`;
  };
  const visibleElements = [root, ...root.querySelectorAll("*")].filter(
    (element) => {
      const style = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rectangle.width > tolerance &&
        rectangle.height > tolerance;
    },
  );
  const clippingBoundary = (element, axis) => {
    let parent = element.parentElement;
    while (parent) {
      const overflow = getComputedStyle(parent)[
        axis === "x" ? "overflowX" : "overflowY"
      ];
      if (["hidden", "clip", "auto", "scroll"].includes(overflow)) {
        return {
          element: parent,
          nativeScroll: overflow === "auto" || overflow === "scroll",
        };
      }
      if (parent === root) break;
      parent = parent.parentElement;
    }
    return { element: root, nativeScroll: false };
  };
  const issues = [];
  if (
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  ) {
    issues.push(
      `document overflow ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`,
    );
  }
  if (root.scrollWidth > root.clientWidth) {
    issues.push(
      `story overflow ${root.scrollWidth} > ${root.clientWidth}`,
    );
  }
  for (const element of visibleElements) {
    const style = getComputedStyle(element);
    const browserScrollsValue = element.matches(
      "input, textarea, select, option",
    );
    const marked = element.getAttribute("data-rail") === "truncation-allowed";
    const allowsTruncation = marked &&
      ((style.overflowX === "hidden" &&
        style.textOverflow === "ellipsis" &&
        style.whiteSpace === "nowrap") ||
        // A line clamp shows its first lines and clips the rest on purpose.
        (style.overflowY === "hidden" &&
          style.webkitLineClamp !== "none" &&
          style.webkitLineClamp !== ""));
    const elementRectangle = element.getBoundingClientRect();
    const isOutOfFlow = (descendant) => {
      if (
        ["absolute", "fixed", "sticky"].includes(
          getComputedStyle(descendant).position,
        )
      ) return true;
      let parent = descendant.parentElement;
      while (parent && parent !== element) {
        if (
          ["absolute", "fixed", "sticky"].includes(
            getComputedStyle(parent).position,
          )
        ) return true;
        parent = parent.parentElement;
      }
      return false;
    };
    const hasInFlowOverflow = (axis) => {
      const textOverflow = [...element.childNodes].some((child) => {
        if (
          child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()
        ) return false;
        const range = document.createRange();
        range.selectNodeContents(child);
        const rectangle = range.getBoundingClientRect();
        return axis === "x"
          ? rectangle.left < elementRectangle.left - tolerance ||
            rectangle.right > elementRectangle.right + tolerance
          : rectangle.top < elementRectangle.top - tolerance ||
            rectangle.bottom > elementRectangle.bottom + tolerance;
      });
      if (textOverflow) return true;
      return [...element.querySelectorAll("*")].some((descendant) => {
        if (isOutOfFlow(descendant)) return false;
        const rectangle = descendant.getBoundingClientRect();
        return axis === "x"
          ? rectangle.left < elementRectangle.left - tolerance ||
            rectangle.right > elementRectangle.right + tolerance
          : rectangle.top < elementRectangle.top - tolerance ||
            rectangle.bottom > elementRectangle.bottom + tolerance;
      });
    };
    const horizontalOwner = clippingBoundary(element, "x");
    const verticalOwner = clippingBoundary(element, "y");
    const hasHorizontalNativeScrollOwner = horizontalOwner.element !== root &&
      horizontalOwner.nativeScroll;
    const hasVerticalNativeScrollOwner = verticalOwner.element !== root &&
      verticalOwner.nativeScroll;
    if (
      !browserScrollsValue &&
      element.scrollWidth > element.clientWidth + tolerance &&
      !["auto", "scroll"].includes(style.overflowX) &&
      !allowsTruncation &&
      hasInFlowOverflow("x") &&
      !hasHorizontalNativeScrollOwner
    ) {
      issues.push(
        `${
          describe(element)
        } content escapes horizontally ${element.scrollWidth} > ${element.clientWidth}`,
      );
    }
    if (
      !browserScrollsValue &&
      element.scrollHeight > element.clientHeight + tolerance &&
      !["auto", "scroll"].includes(style.overflowY) &&
      !allowsTruncation &&
      hasInFlowOverflow("y") &&
      !hasVerticalNativeScrollOwner
    ) {
      issues.push(
        `${
          describe(element)
        } content escapes vertically ${element.scrollHeight} > ${element.clientHeight}`,
      );
    }
  }
  for (const element of root.querySelectorAll("*")) {
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= tolerance || rectangle.height <= tolerance) continue;
    const horizontalBoundary = clippingBoundary(element, "x");
    const verticalBoundary = clippingBoundary(element, "y");
    const horizontalRectangle = horizontalBoundary.element
      .getBoundingClientRect();
    const verticalRectangle = verticalBoundary.element.getBoundingClientRect();
    if (!horizontalBoundary.nativeScroll) {
      if (rectangle.left < horizontalRectangle.left - tolerance) {
        issues.push(
          `${
            describe(horizontalBoundary.element)
          } content escapes horizontally ${rectangle.left} < ${horizontalRectangle.left}`,
        );
      }
      if (rectangle.right > horizontalRectangle.right + tolerance) {
        issues.push(
          `${
            describe(horizontalBoundary.element)
          } content escapes horizontally ${rectangle.right} > ${horizontalRectangle.right}`,
        );
      }
    }
    if (!verticalBoundary.nativeScroll) {
      if (rectangle.top < verticalRectangle.top - tolerance) {
        issues.push(
          `${
            describe(verticalBoundary.element)
          } content escapes vertically ${rectangle.top} < ${verticalRectangle.top}`,
        );
      }
      if (rectangle.bottom > verticalRectangle.bottom + tolerance) {
        issues.push(
          `${
            describe(verticalBoundary.element)
          } content escapes vertically ${rectangle.bottom} > ${verticalRectangle.bottom}`,
        );
      }
    }
  }
  for (const parent of [root, ...visibleElements]) {
    const children = [...parent.children].filter((element) => {
      if (!visibleElements.includes(element)) return false;
      // Vector art is drawing, not layout: a glyph's shapes share one box.
      if (element.ownerSVGElement) return false;
      const position = getComputedStyle(element).position;
      return position !== "absolute" && position !== "fixed" &&
        position !== "sticky";
    });
    for (let firstIndex = 0; firstIndex < children.length; firstIndex += 1) {
      const first = children[firstIndex];
      const firstRectangle = first.getBoundingClientRect();
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < children.length;
        secondIndex += 1
      ) {
        const second = children[secondIndex];
        const secondRectangle = second.getBoundingClientRect();
        const overlapWidth =
          Math.min(firstRectangle.right, secondRectangle.right) -
          Math.max(firstRectangle.left, secondRectangle.left);
        const overlapHeight =
          Math.min(firstRectangle.bottom, secondRectangle.bottom) -
          Math.max(firstRectangle.top, secondRectangle.top);
        if (overlapWidth > tolerance && overlapHeight > tolerance) {
          issues.push(
            `${describe(first)} overlaps sibling ${
              describe(second)
            } by ${overlapWidth}x${overlapHeight}`,
          );
        }
      }
    }
  }
  return issues;
}

async function verifiedServedBuildDigest(baseURL) {
  const files = await filesIn(storybookDirectory);
  const payload = [];
  const localFiles = {};
  const servedFiles = {};
  for (const path of files) {
    const servedPath = relative(storybookDirectory, path).split(sep).map(
      encodeURIComponent,
    ).join("/");
    const response = await fetch(new URL(servedPath, `${baseURL}/`));
    const localDigest = sha256(await readFile(path));
    localFiles[servedPath] = localDigest;
    if (response.ok) {
      servedFiles[servedPath] = sha256(
        Buffer.from(await response.arrayBuffer()),
      );
    }
    payload.push(relative(root, path), localDigest);
  }
  const issues = servedBuildIdentityIssues(localFiles, servedFiles);
  if (issues.length) throw new Error(issues.join("\n"));
  return sha256(payload.join("\0"));
}

function assertionFailure(reason, message) {
  return Object.assign(new Error(message), { reason });
}

export async function fullFrameRasterTarget(page) {
  const selector = ".storybook-story .bakery-app-shell";
  const shell = page.locator(selector);
  const story = page.locator(".storybook-story");
  const bounds = await story.boundingBox();
  if (
    await shell.count() !== 1 || !bounds ||
    JSON.stringify(await shell.boundingBox()) !== JSON.stringify(bounds)
  ) {
    throw new Error("K-0: complete shell must equal the full story bounds");
  }
  return selector;
}

/** Semantic targets only; preview markers never grant a size exemption. */
export function coarseTargetCheck(root) {
  const elements = root.querySelectorAll(
    "a, button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [tabindex], [onclick], [onkeydown], [contenteditable=true], label:has(input:not([type=hidden]))",
  );
  const visible = [...elements].flatMap((element) => {
    if (
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type) && element.closest("label")
    ) return [];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      !rect.width || !rect.height || style.visibility === "hidden" ||
      style.display === "none" || Number(style.opacity) === 0
    ) return [];
    return [{
      description: element.outerHTML.slice(0, 120),
      width: rect.width,
      height: rect.height,
    }];
  });
  return {
    visibleCount: visible.length,
    undersized: visible.filter(({ width, height }) => width < 44 || height < 44)
      .map(({ description, width, height }) =>
        `${description} (${width}x${height})`
      ),
  };
}

/** Independent inertness proof, including non-attribute DOM handlers. */
export function detailInertnessIssues(root) {
  const issues = [];
  if (
    root.querySelector(
      "a, button, input, select, textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [tabindex], [contenteditable=true], [onclick], [onkeydown], [onkeyup], [onkeypress]",
    )
  ) issues.push("interactive detail descendant");
  const previews = [...root.querySelectorAll('[data-ui-component="button"]')];
  const illustrated = ["ready", "worstcase"].includes(
    root.getAttribute("data-state"),
  );
  if (previews.length !== (illustrated ? 4 : 3)) {
    issues.push("missing detail artwork");
  }
  for (const element of root.querySelectorAll("*")) {
    if (
      element.onclick || element.onkeydown || element.onkeyup ||
      element.onkeypress
    ) issues.push("detail event handler");
  }
  for (const element of previews) {
    if (
      element.tagName !== "SPAN" || element.hasAttribute("role") ||
      element.hasAttribute("tabindex")
    ) issues.push("non-inert preview");
  }
  return issues;
}

export async function runtimeAssertions(
  page,
  runtimeCase,
  context,
  catalogEntry,
) {
  const readOnlyDetail =
    runtimeCase.catalogId === "template.workerReadOnlyDetail";
  if (readOnlyDetail) {
    const detail = page.locator('[data-ui-component="workerReadOnlyDetail"]');
    if (
      await detail.count() !== 1 || !await detail.isVisible() ||
      (await detail.evaluate(detailInertnessIssues)).length
    ) {
      throw assertionFailure(
        "detail-interaction",
        `${runtimeCase.id}: detail must remain visible and inert`,
      );
    }
    if (context.locale === "en-XA") {
      const catalog = await readJson(
        join(root, "packages/i18n/locales/en-XA.json"),
      );
      const copy = await detail.locator(".ui-worker-detail__boundary")
        .textContent();
      if (
        !copy?.includes(catalog["workerDetail.disclaimer"]) ||
        !copy.includes(catalog["workerDetail.boundary"])
      ) {
        throw assertionFailure(
          "pseudo-locale-mismatch",
          `${runtimeCase.id}: detail qualification is not localized`,
        );
      }
    }
  }
  const observed = await page.evaluate(() => {
    const storyRoot = document.querySelector(".storybook-story");
    const themedRoot = storyRoot?.closest("[data-theme]");
    return {
      documentTheme: document.documentElement.dataset.theme,
      theme: themedRoot?.getAttribute("data-theme"),
      direction: storyRoot?.getAttribute("dir"),
      pointer: storyRoot?.getAttribute("data-pointer"),
      reducedMotion: storyRoot?.getAttribute("data-reduced-motion"),
      locale: themedRoot?.getAttribute("lang"),
      viewport: { width: innerWidth, height: innerHeight },
      pointerMedia: matchMedia(
        `(pointer: ${storyRoot?.getAttribute("data-pointer")})`,
      ).matches,
      reducedMotionMedia: matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      targetMinimum: Number.parseFloat(
        getComputedStyle(storyRoot).getPropertyValue("--target-min"),
      ),
      pseudoCopy: document.querySelector(
        '[data-pseudo-locale="true"] [data-testid="text-specimen-copy"], [data-pseudo-locale="true"] [data-ui-component="workerReadOnlyDetail"] .ui-worker-detail__boundary, [data-pseudo-locale="true"] .ui-worker-catalog__ownership, [data-pseudo-locale="true"] .ui-worker-enrollment__hint',
      )?.textContent ?? null,
      zoom: Number(storyRoot?.style.zoom || 1),
    };
  });
  if (catalogEntry) {
    const partition = catalogEntry.requiredCaseCoverage === "partitioned"
      ? catalogEntry.requiredCases.find((entry) =>
        entry.id === runtimeCase.requiredCaseId
      )
      : undefined;
    if (catalogEntry.requiredCaseCoverage === "partitioned" && !partition) {
      throw new Error(
        `Missing catalog partition: ${runtimeCase.requiredCaseId}`,
      );
    }
    const expectedVariants = partition?.variants ??
      runtimeCase.semanticCoverage?.variants ?? catalogEntry.variants ?? [];
    const expectedStates = partition?.states ??
      runtimeCase.semanticCoverage?.states ?? catalogEntry.states ?? [];
    const componentName = catalogEntry.id.split(".").at(-1);
    const ownerSelector = `[data-ui-component="${componentName}"]`;
    const noEvidence = () =>
      page.locator("css=.__bakery_no_semantic_evidence__");
    const isCanonicalEvidence = async (candidate) =>
      await candidate.evaluate((element, name) => {
        const owner = element.closest(`[data-ui-component="${name}"]`);
        const storyRoot = owner?.closest(".storybook-story");
        const nestedOwner = owner?.parentElement?.closest(
          `[data-ui-component="${name}"]`,
        );
        return Boolean(
          owner &&
            (!nestedOwner || !storyRoot?.contains(nestedOwner)),
        );
      }, componentName);
    const firstCanonicalEvidence = async (candidates) => {
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        const isCanonical = await isCanonicalEvidence(candidate);
        if (isCanonical) return candidate;
      }
      return noEvidence();
    };
    const exercisedStates = new Set();
    const measuredStates = new Set([
      "copied",
      "long-content",
      "overflowing",
      "pressed",
      "sorting",
      "truncated",
    ]);
    const probedStates = new Set([
      "dismissed",
      "focus",
      "focused",
      "hover",
      ...measuredStates,
      "visited",
      "wrapped",
    ]);
    if (
      ["alertDialog", "dialog", "popover", "sheet", "tooltip"].includes(
        componentName,
      )
    ) probedStates.add("open");
    const exercisedVariants = new Set();
    const initialOwners = page.locator(ownerSelector);
    for (let index = 0; index < await initialOwners.count(); index += 1) {
      const owner = initialOwners.nth(index);
      const semanticallyPresent = await owner.evaluate(
        (element, name) => {
          if (element.closest("[hidden]")) return false;
          if (element instanceof HTMLDialogElement && !element.open) {
            return false;
          }
          const storyRoot = element.closest(".storybook-story");
          const nestedOwner = element.parentElement?.closest(
            `[data-ui-component="${name}"]`,
          );
          if (nestedOwner && storyRoot?.contains(nestedOwner)) return false;
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        },
        componentName,
      );
      if (!semanticallyPresent) continue;
      const variant = await owner.getAttribute("data-variant");
      if (variant) exercisedVariants.add(variant);
      const state = await owner.getAttribute("data-state");
      if (state && !probedStates.has(state)) exercisedStates.add(state);
    }
    if (componentName === "runTimeline") {
      const timelineStates = page.locator(
        `${ownerSelector} > li[data-state]`,
      );
      for (let index = 0; index < await timelineStates.count(); index += 1) {
        const state = await timelineStates.nth(index).getAttribute(
          "data-state",
        );
        if (state) exercisedStates.add(state);
      }
    }
    for (const state of expectedStates) {
      if (state === "dismissed") {
        const dismissibleOwner = await firstCanonicalEvidence(
          page.locator(`${ownerSelector}:visible`)
            .filter({ has: page.locator('button[aria-label^="Dismiss"]') }),
        );
        const dismissButton = dismissibleOwner.locator(
          'button[aria-label^="Dismiss"]',
        ).first();
        if (await dismissButton.count()) {
          await dismissButton.click();
          const dismissedOwner = await firstCanonicalEvidence(
            page.locator(`${ownerSelector}[data-state="dismissed"]`),
          );
          if (await dismissedOwner.count()) exercisedStates.add(state);
        }
      }
      if (state === "open") {
        const closedOwner = await firstCanonicalEvidence(
          page.locator(
            `${ownerSelector}[data-state="closed"]:not([hidden])`,
          ),
        );
        const openTrigger = closedOwner.locator(
          'button[aria-expanded="false"]',
        ).first();
        if (await openTrigger.count()) {
          await openTrigger.click();
          const openedOwner = await firstCanonicalEvidence(
            page.locator(`${ownerSelector}[data-state="open"]`)
              .filter({ has: page.locator('[role="dialog"]') }),
          );
          const surface = openedOwner.locator('[role="dialog"]').first();
          await surface.waitFor({ state: "visible" }).catch(() => {});
          if (await surface.count() && await surface.isVisible()) {
            exercisedStates.add(state);
          }
        }
      }
      const explicitInteraction = page.locator(
        `${ownerSelector}[data-semantic-interaction="${state}"], ${ownerSelector} [data-semantic-interaction="${state}"]`,
      );
      const fallbackInteraction = state === "focus" || state === "focused"
        ? page.locator(
          `${ownerSelector}:not([hidden]) input, ${ownerSelector}:not([hidden]) button, ${ownerSelector}:not([hidden]) select, ${ownerSelector}:not([hidden]) textarea, ${ownerSelector}:not([hidden]) a[href], ${ownerSelector}:not([hidden]) [tabindex]:not([tabindex="-1"])`,
        )
        : page.locator("css=.__bakery_no_semantic_interaction__");
      const measurableOwner = measuredStates.has(state)
        ? page.locator(
          `${ownerSelector}[data-state="${state}"]:not([hidden])`,
        )
        : noEvidence();
      const interaction = await firstCanonicalEvidence(
        explicitInteraction.or(fallbackInteraction).or(measurableOwner),
      );
      if (await interaction.count()) {
        if (state === "hover" || state === "open") {
          await interaction.hover();
          const owner = interaction.locator(
            `xpath=ancestor-or-self::*[@data-ui-component="${componentName}"][1]`,
          );
          const surface = owner.locator('[role="tooltip"], [role="dialog"]')
            .first();
          const showsSurface = !await surface.count() ||
            await surface.isVisible();
          if (
            await interaction.evaluate((element) =>
              element.matches(":hover")
            ) &&
            showsSurface
          ) exercisedStates.add(state);
        } else if (state === "focus" || state === "focused") {
          await interaction.focus();
          const owner = interaction.locator(
            `xpath=ancestor-or-self::*[@data-ui-component="${componentName}"][1]`,
          );
          const surface = owner.locator('[role="tooltip"], [role="dialog"]')
            .first();
          const showsSurface = !await surface.count() ||
            await surface.isVisible();
          if (
            await interaction.evaluate((element) =>
              document.activeElement === element
            ) && showsSurface
          ) exercisedStates.add(state);
        } else if (state === "visited") {
          const link = interaction.locator(
            "xpath=ancestor-or-self::a[@href][1]",
          );
          if (await link.count()) {
            const owner = link.locator(
              `xpath=ancestor-or-self::*[@data-ui-component="${componentName}"][1]`,
            );
            const before = await owner.getAttribute("data-state");
            await link.click();
            const navigated = await link.evaluate((element) => {
              const destination = new URL(
                element.href,
                globalThis.location.href,
              );
              return destination.origin === globalThis.location.origin &&
                destination.pathname === globalThis.location.pathname &&
                destination.search === globalThis.location.search &&
                Boolean(destination.hash) &&
                globalThis.location.hash === destination.hash;
            });
            if (
              before !== "visited" && navigated &&
              await owner.getAttribute("data-state") === "visited"
            ) exercisedStates.add(state);
          }
        } else if (state === "pressed") {
          const pressed = interaction.locator(
            "xpath=ancestor-or-self::*[@aria-pressed][1]",
          );
          if (await pressed.count()) {
            const before = await pressed.getAttribute("aria-pressed");
            await interaction.click();
            if (
              before !== "true" &&
              await pressed.getAttribute("aria-pressed") === "true"
            ) exercisedStates.add(state);
          }
        } else if (state === "copied") {
          const announcement = interaction.locator("[aria-live]").filter({
            hasText: "Copied",
          }).first();
          if (await announcement.count() && await announcement.isVisible()) {
            exercisedStates.add(state);
          }
        } else if (state === "truncated") {
          const truncated = await interaction.evaluate((element) => {
            const style = getComputedStyle(element);
            return style.overflow === "hidden" &&
              style.textOverflow === "ellipsis" &&
              style.whiteSpace === "nowrap" &&
              element.scrollWidth > element.clientWidth;
          });
          if (truncated) exercisedStates.add(state);
        } else if (state === "overflowing") {
          const overflows = await interaction.evaluate((element) =>
            element.scrollWidth > element.clientWidth ||
            element.scrollHeight > element.clientHeight
          );
          if (overflows) exercisedStates.add(state);
        } else if (state === "sorting") {
          if (await interaction.locator("[aria-sort]").count()) {
            exercisedStates.add(state);
          }
        } else if (state === "wrapped" || state === "long-content") {
          const wraps = await interaction.evaluate((element, state) => {
            const childRows = new Set(
              [...element.children].map((child) =>
                Math.round(child.getBoundingClientRect().top)
              ),
            );
            const lineHeight = Number.parseFloat(
              getComputedStyle(element).lineHeight,
            );
            const hasMultipleLines = childRows.size > 1 ||
              Number.isFinite(lineHeight) &&
                element.getBoundingClientRect().height > lineHeight * 1.5;
            return state === "wrapped"
              ? hasMultipleLines
              : (element.textContent?.trim().length ?? 0) >= 80 &&
                (hasMultipleLines ||
                  element.scrollWidth > element.clientWidth ||
                  element.scrollHeight > element.clientHeight);
          }, state);
          if (wraps) exercisedStates.add(state);
        }
      }
      const trigger = page.locator(
        `[data-semantic-state-trigger="${state}"]`,
      ).first();
      if (!await trigger.count()) continue;
      await trigger.click();
      const candidates = page.locator(
        `${ownerSelector}[data-state="${state}"]`,
      );
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (!await isCanonicalEvidence(candidate)) continue;
        if (!await candidate.isVisible()) continue;
        exercisedStates.add(state);
        const variant = await candidate.getAttribute("data-variant");
        if (variant) exercisedVariants.add(variant);
        break;
      }
      await page.keyboard.press("Escape");
    }
    const semanticCoverage = await page.evaluate(
      (
        {
          componentName,
          exercisedStates,
          exercisedVariants,
          variants,
          states,
        },
      ) => {
        const storyRoot = document.querySelector(".storybook-story");
        const elements = storyRoot
          ? [storyRoot, ...storyRoot.querySelectorAll("*")]
          : [];
        const isVisible = (element) => {
          if (element.closest("[hidden]")) return false;
          if (element instanceof HTMLDialogElement && !element.open) {
            return false;
          }
          const style = getComputedStyle(element);
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            element.getClientRects().length > 0;
        };
        const ownsEvidence = (element) => {
          if (
            componentName === "runTimeline" &&
            element.matches("li[data-state]") &&
            element.parentElement?.getAttribute("data-ui-component") ===
              componentName
          ) return true;
          if (element.getAttribute("data-ui-component") !== componentName) {
            return false;
          }
          const nestedOwner = element.parentElement?.closest(
            `[data-ui-component="${componentName}"]`,
          );
          return !(nestedOwner && storyRoot?.contains(nestedOwner));
        };
        const hasVisibleValue = (attribute, value) =>
          elements.some((element) =>
            ownsEvidence(element) && isVisible(element) &&
            element.getAttribute(attribute) === value
          );
        const hasAbsentState = (value) =>
          (value === "closed" || value === "dismissed") &&
          elements.some((element) =>
            ownsEvidence(element) &&
            element.getAttribute("data-state") === value &&
            (element.hasAttribute("hidden") ||
              element instanceof HTMLDialogElement && !element.open)
          );
        return {
          variants: variants.filter((value) =>
            exercisedVariants.includes(value) ||
            hasVisibleValue("data-variant", value)
          ),
          states: states.filter((value) =>
            exercisedStates.includes(value) || hasAbsentState(value)
          ),
        };
      },
      {
        componentName,
        exercisedStates: [...exercisedStates],
        exercisedVariants: [...exercisedVariants],
        variants: expectedVariants,
        states: expectedStates,
      },
    );
    const missingVariants = expectedVariants.filter((value) =>
      !semanticCoverage.variants.includes(value)
    );
    const missingStates = expectedStates.filter((value) =>
      !semanticCoverage.states.includes(value)
    );
    if (missingVariants.length || missingStates.length) {
      throw assertionFailure(
        "semantic-coverage",
        `${runtimeCase.id}: rendered specimen omits ${
          [
            missingVariants.length
              ? `variants ${missingVariants.join(", ")}`
              : "",
            missingStates.length ? `states ${missingStates.join(", ")}` : "",
          ].filter(Boolean).join("; ")
        }`,
      );
    }
  }
  if (observed.theme !== context.theme) {
    throw assertionFailure(
      "theme-mismatch",
      `${runtimeCase.id}: expected ${context.theme} theme, observed ${observed.theme}`,
    );
  }
  if (observed.direction !== context.direction) {
    throw assertionFailure(
      "direction-mismatch",
      `${runtimeCase.id}: expected ${context.direction} direction`,
    );
  }
  if (observed.pointer !== context.pointer) {
    throw assertionFailure(
      "pointer-mismatch",
      `${runtimeCase.id}: expected ${context.pointer} pointer`,
    );
  }
  if (!observed.pointerMedia) {
    throw assertionFailure(
      "pointer-media-mismatch",
      `${runtimeCase.id}: pointer media does not match context`,
    );
  }
  if (
    (context.locale === "en-XA" && observed.locale !== "en-XA") ||
    (context.locale === "en-US" && observed.locale !== "en-US")
  ) {
    throw assertionFailure(
      "locale-mismatch",
      `${runtimeCase.id}: expected ${context.locale} locale`,
    );
  }
  if (
    observed.reducedMotion !==
      (context.reducedMotion === "reduce" ? "true" : "false") ||
    observed.reducedMotionMedia !== (context.reducedMotion === "reduce")
  ) {
    throw assertionFailure(
      "reduced-motion-mismatch",
      `${runtimeCase.id}: reduced-motion context was not applied`,
    );
  }
  if (
    observed.viewport.width !== context.viewport.width ||
    observed.viewport.height !== context.viewport.height
  ) {
    throw assertionFailure(
      "viewport-mismatch",
      `${runtimeCase.id}: viewport does not match context`,
    );
  }
  if (
    observed.targetMinimum !== (context.pointer === "coarse" ? 44 : 28)
  ) {
    throw assertionFailure(
      "target-token-mismatch",
      `${runtimeCase.id}: pointer target token is incorrect`,
    );
  }
  if (
    (context.locale === "en-XA" && (observed.pseudoCopy?.length ?? 0) <= 100) ||
    (context.locale === "en-US" && observed.pseudoCopy !== null)
  ) {
    throw assertionFailure(
      "pseudo-locale-mismatch",
      `${runtimeCase.id}: pseudo-locale copy was not applied`,
    );
  }
  if (observed.zoom !== context.zoom) {
    throw assertionFailure(
      "zoom-mismatch",
      `${runtimeCase.id}: zoom context was not applied`,
    );
  }
  if (
    runtimeCase.assertions?.includes("containment")
  ) {
    const containmentIssues = await page.evaluate(renderedContainmentIssues);
    if (containmentIssues.length) {
      throw assertionFailure(
        "containment",
        `${runtimeCase.id}: ${containmentIssues.join(", ")}`,
      );
    }
  }
  if (runtimeCase.assertions?.includes("target-size")) {
    const targetCheck = await page.locator(".storybook-story").evaluate(
      coarseTargetCheck,
    );
    // Zero targets is valid only after the independent detail inertness proof above.
    if (!targetCheck.visibleCount && !readOnlyDetail) {
      throw assertionFailure(
        "target-size",
        `${runtimeCase.id}: no visible interactive targets to measure`,
      );
    }
    if (targetCheck.undersized.length) {
      throw assertionFailure(
        "target-size",
        `${runtimeCase.id}: undersized targets ${
          targetCheck.undersized.join(", ")
        }`,
      );
    }
  }
  if (runtimeCase.assertions?.includes("focus")) {
    await page.keyboard.press("Tab");
    if (readOnlyDetail) {
      if (
        await page.locator('[data-ui-component="workerReadOnlyDetail"]')
          .evaluate((element) => element.contains(document.activeElement))
      ) {
        throw assertionFailure(
          "detail-interaction",
          `${runtimeCase.id}: inert detail received keyboard focus`,
        );
      }
    } else {
      const focusVisible = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return false;
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      });
      if (!focusVisible) {
        throw assertionFailure(
          "focus-indicator",
          `${runtimeCase.id}: keyboard focus is not visible`,
        );
      }
    }
  }
  if (runtimeCase.assertions?.includes("axe")) {
    const results = await new AxeBuilder({ page }).include("body").analyze();
    if (results.violations.length) {
      throw assertionFailure(
        "axe",
        `${runtimeCase.id}: Axe violations ${
          results.violations.map((violation) => violation.id).join(", ")
        }`,
      );
    }
  }
}

async function componentExtent(page, selector, dpr) {
  return await page.evaluate(({ query, scale }) => {
    const boxes = [...document.querySelectorAll(query)]
      .map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display === "none" || style.visibility === "hidden" ||
            rect.width <= 0 || rect.height <= 0
          ? null
          : rect;
      })
      .filter(Boolean);
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      x: Math.round(left * scale),
      y: Math.round(top * scale),
      width: Math.round((right - left) * scale),
      height: Math.round((bottom - top) * scale),
    };
  }, { query: selector, scale: dpr });
}

async function captureCase(
  browser,
  baseURL,
  runtimeCase,
  context,
  catalogEntry,
  story,
  metadata,
  paperBaseline,
) {
  if (
    paperBaseline?.pageId === "K-0" && paperBaseline.sourceProfile !== "K-0"
  ) throw new Error("K-0: missing source profile");
  const bindingIssues = wholeArtboardBindingIssues(
    paperBaseline ?? {},
    runtimeCase.wholeArtboardCapture,
  );
  if (
    bindingIssues.length ||
    JSON.stringify(runtimeCase.wholeArtboardCapture) !==
      JSON.stringify(paperBaseline?.wholeArtboardCapture)
  ) {
    throw new Error(
      `Whole artboard binding: ${
        bindingIssues.join("; ") || "runtime/baseline mismatch"
      }`,
    );
  }
  const paired = paperBaseline?.wholeArtboardCapture;
  const detail = runtimeCase.catalogId === "template.workerReadOnlyDetail";
  let pairedCapture;
  let fullUIBundle;
  if (paperBaseline?.sourceProfile) {
    assertK0Environment({
      ...context,
      ...metadata,
      sourceProfile: paperBaseline.sourceProfile,
      browser: "chromium",
      browserVersion: browser.version(),
      browserLaunchOptions: paperBrowserLaunchOptions(paperBaseline),
    });
  }
  const componentMeasure = paperBaseline?.reference === "specimen"
    ? paperBaseline.comparisonRegion?.measure
    : undefined;
  let measuredComponentExtent = null;
  const caseDirectory = join(outputDirectory, "images");
  await mkdir(caseDirectory, { recursive: true });
  const bundleDirectory = join(caseDirectory, `${runtimeCase.id}.full-ui`);
  const outputPath = detail
    ? join(bundleDirectory, "manifest.json")
    : join(caseDirectory, `${runtimeCase.id}.png`);
  const failedOutputPath = join(caseDirectory, `failed-${runtimeCase.id}.png`);
  const sourcePaths = sourcePathForCase(catalogEntry, story);
  const absoluteSourcePaths = sourcePaths.map((path) => join(root, path));
  const componentSourceDigest = await digestFiles(absoluteSourcePaths);
  const baseRecord = {
    id: runtimeCase.id,
    kind: "story",
    catalogId: runtimeCase.catalogId,
    requiredCaseId: runtimeCase.requiredCaseId,
    storyId: runtimeCase.storyId,
    storyURL: storyUrl(baseURL, runtimeCase, context),
    sourceCommit: metadata.sourceCommit,
    sourceDirty: metadata.sourceDirty,
    sourceDiffDigest: metadata.sourceDiffDigest,
    storybookBuildDigest: metadata.storybookBuildDigest,
    componentSourceDigest,
    fixtureRevision: componentSourceDigest,
    tokenRevision: metadata.tokenRevision,
    tokenDigest: metadata.tokenDigest,
    paperBaselineId: runtimeCase.paperBaselineId ?? null,
    browser: "chromium",
    ...(paperBaseline?.sourceProfile === undefined ? {} : {
      rasterProfile: metadata.rasterProfile,
      sourceProfile: paperBaseline.sourceProfile,
      sourceDigest: metadata.sourceDigest,
      browserLaunchOptions: paperBrowserLaunchOptions(paperBaseline),
    }),
    browserVersion: browser.version(),
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
    assertions: runtimeCase.assertions ?? [],
  };
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
  try {
    await page.goto(storyUrl(baseURL, runtimeCase, context), {
      waitUntil: "networkidle",
    });
    await page.locator(".storybook-story").waitFor({ state: "visible" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.documentElement.dataset.runtimeCase = "true";
    });
    await page.addStyleTag({ content: ANIMATION_KILL_STYLE });
    try {
      await runtimeAssertions(page, runtimeCase, context, catalogEntry);
    } catch (error) {
      await page.screenshot({ path: failedOutputPath });
      throw Object.assign(
        new Error(error instanceof Error ? error.message : String(error)),
        {
          status: "failed",
          reason: error?.reason ?? "runtime-assertion",
          evidencePath: relative(root, failedOutputPath),
        },
      );
    }
    if (componentMeasure) {
      measuredComponentExtent = await componentExtent(
        page,
        componentMeasure,
        context.dpr,
      );
      if (!measuredComponentExtent) {
        throw new Error(
          `Paper specimen measure matched no visible elements: ${componentMeasure}`,
        );
      }
    }
    const captureFullUI = async (snapshotNonce) =>
      captureViewportBundleV2(page, {
        expectedQualification: await expectedWorkerQualification(baseRecord),
        root,
        nonce: snapshotNonce,
        directory: bundleDirectory,
        identity: viewportBundleIdentity(baseRecord),
      });
    if (paired) {
      pairedCapture = await captureWholeArtboardPair(
        page,
        paired,
        metadata.rasterProfile,
        detail
          ? captureFullUI
          : () => page.screenshot({ path: outputPath, fullPage: true }),
        () => runtimeAssertions(page, runtimeCase, context, catalogEntry),
      );
      if (detail) fullUIBundle = pairedCapture.fullUI.reference;
    } else if (detail) {
      fullUIBundle = (await captureFullUI()).reference;
    } else if (paperBaseline?.sourceProfile) {
      await writeFile(
        outputPath,
        await captureK0Raster(
          page,
          await fullFrameRasterTarget(page),
          metadata.rasterProfile,
        ),
      );
    } else {
      await page.screenshot({ path: outputPath, fullPage: detail });
    }
  } finally {
    await page.close();
    await browserContext.close();
  }
  const record = {
    ...baseRecord,
    ...(measuredComponentExtent === null
      ? {}
      : { componentExtent: measuredComponentExtent }),
    status: "passed",
    description: {
      expected: detail
        ? `Rendered ${catalogEntry.name} specimen satisfies its declared runtime assertions and produces a validated complete UI bundle.`
        : `Rendered ${catalogEntry.name} specimen satisfies its declared runtime assertions and produces a deterministic candidate image.`,
      observed: detail
        ? `All runtime assertions passed; complete UI bundle validated at ${fullUIBundle.manifestPath}.`
        : `All runtime assertions passed; candidate image written to ${
          relative(root, outputPath)
        }.`,
    },
    outputPath: fullUIBundle?.manifestPath ?? relative(root, outputPath),
    outputSha256: fullUIBundle?.manifestSha256 ??
      sha256(await readFile(outputPath)),
    captureStartedAt: startedAt,
    captureFinishedAt: new Date().toISOString(),
    ...(detail
      ? { outputScope: "full-ui-bundle", outputAdapter: "none", fullUIBundle }
      : {}),
  };
  if (pairedCapture) {
    const parityPath = join(
      caseDirectory,
      `${runtimeCase.id}.whole-artboard-parity.png`,
    );
    await writeFile(parityPath, pairedCapture.parity);
    const file = (bytes, path, scope) => ({
      scope,
      path: relative(root, path),
      sha256: sha256(bytes),
      ...pngDimensions(bytes),
    });
    const fullUI = fullUIBundle ?? {
      ...file(pairedCapture.fullUI, outputPath, "full-ui"),
      adapter: "none",
    };
    const parity = file(
      pairedCapture.parity,
      parityPath,
      "whole-artboard-parity",
    );
    const identity = pairedIdentity(record, paperBaseline);
    const adapter = {
      version: K0_ADAPTER_VERSION,
      implementationDigest: metadata.rasterProfile.implementationDigest,
      ...metadata.rasterProfile.offset,
    };
    const receipt = {
      identity,
      snapshotGeneration: pairedCapture.snapshotGeneration,
      snapshotNonce: pairedCapture.snapshotNonce,
      adapter,
      fullUI,
      parity,
      captureStartedAt: record.captureStartedAt,
      captureFinishedAt: record.captureFinishedAt,
      assertions: record.assertions,
      status: "passed",
      checks: [
        "runtime-assertions-before",
        "runtime-assertions-after",
        "unchanged-dom-layout-fonts",
        "whole-artboard-bounds",
      ],
      observation: pairedCapture.observation,
    };
    const receiptBytes = JSON.stringify(receipt, null, 2) + "\n";
    await writeFile(`${parityPath}.browser.json`, receiptBytes);
    record.wholeArtboardCapture = {
      contractVersion: WHOLE_ARTBOARD_VERSION,
      ...identity,
      snapshotGeneration: pairedCapture.snapshotGeneration,
      adapter,
      target: {
        selector: paired.targetSelector,
        naturalWidth: pairedCapture.observation.target.box.width,
        naturalHeight: pairedCapture.observation.target.box.height,
        completeArtwork: true,
      },
      fullUI,
      parity,
      browserContract: { passed: true, receiptSha256: sha256(receiptBytes) },
      qualification: {
        visible: true,
        accessible: true,
        textDigest: sha256(pairedCapture.observation.qualification.text),
      },
    };
    record.wholeArtboardCaptureSha256 = metadataDigest(
      record.wholeArtboardCapture,
    );
  }
  return record;
}

// Route stubs for the fixtures-lane web dev server, mirroring
// `apps/web/tests/helpers/mock-session.ts` byte-for-byte so a design
// route-candidate capture renders the exact same deterministic app state a
// Playwright spec would see. Kept as data (not live Playwright `route()`
// registrations) so the stub set is a plain, testable value.
export function webRouteStubs(session) {
  const stubs = [
    {
      pattern: "**/v1/installation/status",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ bootstrapped: true }),
      },
    },
  ];
  if (session === "anonymous") {
    stubs.push({
      pattern: "**/v1/me*",
      fulfill: {
        status: 401,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify(AUTH_REQUIRED_PROBLEM),
      },
    });
    return stubs;
  }
  stubs.push(
    {
      pattern: "**/v1/me",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          principalId: "00000000-0000-4000-8000-000000000001",
          principalType: "human",
          displayName: "Fixture Admin",
          locale: "en",
          direction: "ltr",
          catalogVersion: "2",
          twoFactorEnabled: false,
          email: "fixture-admin@example.test",
          backupCodesRemaining: null,
        }),
      },
    },
    {
      pattern: "**/v1/me/sessions",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: "00000000-0000-4000-8000-000000000002",
            current: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z",
            userAgent: "Fixture Browser/1.0",
            ipAddress: "127.0.0.1",
          }],
        }),
      },
    },
    {
      pattern: "**/v1/organizations",
      method: "GET",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: "00000000-0000-4000-8000-000000000003",
            name: "Fixture Org",
            slug: "fixture-org",
            logo: null,
            metadata: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
            role: "admin",
          }],
          nextCursor: null,
        }),
      },
    },
  );
  return stubs;
}

// Captures a `reference: "design"` Paper baseline case against the running
// web dev server, per the candidate recipe in
// docs/technical-design/ui-baselines/paper-baselines.json's contract: same
// context knobs as the design reference render (viewport, dpr, colorScheme,
// hasTouch, locale) so the two screenshots are comparable, but pointed at
// the real app behind deterministic fixture stubs instead of the static
// mock server.
// Design routes are captured serially by default. Each scheduler worker reuses
// a small browser-context pool so Vite's module graph stays cached; explicit
// BAKERY_CAPTURE_JOBS can opt into at most four parallel workers on a
// provisioned development server.
export function captureConcurrency(env = process.env) {
  const requested = Number.parseInt(env.BAKERY_CAPTURE_JOBS ?? "", 10);
  if (Number.isInteger(requested) && requested > 0) {
    return Math.min(requested, 4);
  }
  return 1;
}

function createDesignContextPool(browser) {
  const contexts = new Map();

  return {
    async acquire(designCase) {
      // Theme must be part of the pool key: pages inside one context share
      // origin storage, and a light page's persisted theme must never bleed
      // into a dark case's first paint under parallel workers.
      const key = JSON.stringify([
        designCase.dpr,
        designCase.pointer,
        designCase.locale,
        designCase.theme,
      ]);
      let context = contexts.get(key);
      if (!context) {
        context = await browser.newContext({
          deviceScaleFactor: designCase.dpr,
          colorScheme: designCase.theme,
          hasTouch: designCase.pointer === "coarse",
          locale: designCase.locale,
          timezoneId: "UTC",
          reducedMotion: "reduce",
        });
        contexts.set(key, context);
      }
      return context;
    },
    async close() {
      await Promise.all(
        [...contexts.values()].map((context) => context.close()),
      );
    },
  };
}

async function captureDesignCaseOnce(
  browser,
  webBaseUrl,
  designCase,
  metadata,
  contextPool,
) {
  const caseDirectory = join(outputDirectory, "images");
  await mkdir(caseDirectory, { recursive: true });
  const outputPath = join(caseDirectory, `${designCase.id}.png`);
  const failedOutputPath = join(
    caseDirectory,
    `failed-${designCase.id}.png`,
  );
  const browserContext = contextPool
    ? await contextPool.acquire(designCase)
    : await browser.newContext({
      viewport: designCase.viewport,
      deviceScaleFactor: designCase.dpr,
      colorScheme: designCase.theme,
      hasTouch: designCase.pointer === "coarse",
      locale: designCase.locale,
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
  const ownsContext = !contextPool;
  const page = await browserContext.newPage();
  let contentBox = null;
  const safeUrl = (value) => {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) &&
          url.origin.length <= 256
        ? url.origin
        : null;
    } catch {
      return null;
    }
  };
  const appendDiagnostic = (items, value) => {
    if (items.length < 8) items.push(value);
  };
  let routeUrl;
  const diagnostics = {
    route: null,
    document: null,
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
    failedRequests: [],
  };
  page.on("pageerror", (error) => {
    const frame = error.stack?.slice(0, 2048).match(
      /(https?:\/\/\S+):(\d+):(\d+)/,
    );
    appendDiagnostic(diagnostics.pageErrors, {
      name:
        ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError"]
            .includes(error.name)
          ? error.name
          : "Error",
      source: frame ? safeUrl(frame[1]) : null,
      line: frame ? Number(frame[2]) : null,
    });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    appendDiagnostic(diagnostics.consoleErrors, {
      source: safeUrl(location.url),
      line: location.lineNumber || null,
    });
  });
  page.on("response", (response) => {
    const resourceType = response.request().resourceType();
    if (
      response.status() < 400 ||
      !["document", "script", "fetch", "xhr"].includes(resourceType)
    ) return;
    appendDiagnostic(diagnostics.failedResponses, {
      resourceType,
      status: response.status(),
      url: safeUrl(response.url()),
    });
  });
  page.on("requestfailed", (request) => {
    const resourceType = request.resourceType();
    if (!["document", "script", "fetch", "xhr"].includes(resourceType)) return;
    const failure = request.failure()?.errorText ?? "";
    const method = request.method();
    appendDiagnostic(diagnostics.failedRequests, {
      resourceType,
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
          .includes(method)
        ? method
        : "OTHER",
      url: safeUrl(request.url()),
      failure: failure.length <= 80 &&
          /^net::ERR_[A-Z_]{1,64}$/.test(failure)
        ? failure
        : null,
    });
  });
  try {
    await page.setViewportSize(designCase.viewport);
    await page.emulateMedia({
      colorScheme: designCase.theme,
      reducedMotion: "reduce",
    });
    await page.addInitScript(({ key, value }) => {
      localStorage.setItem(key, value);
    }, { key: "bakery.theme.v1", value: designCase.theme });
    for (const stub of webRouteStubs(designCase.candidate.session)) {
      await page.route(stub.pattern, (route) => {
        if (stub.method && route.request().method() !== stub.method) {
          return route.continue();
        }
        return route.fulfill(stub.fulfill);
      });
    }
    routeUrl = new URL(designCase.candidate.route, webBaseUrl);
    diagnostics.route = safeUrl(routeUrl.toString());
    const response = await page.goto(routeUrl.toString(), {
      waitUntil: "networkidle",
    });
    diagnostics.document = response
      ? { status: response.status(), url: safeUrl(response.url()) }
      : null;
    // `networkidle` only proves the module graph has arrived. Under the Vite
    // dev server the app evaluates hundreds of unbundled modules after that,
    // so on a slow runner the page is still blank or mid-layout when the
    // network goes quiet; the CI runner shot ~80% of design routes that way
    // while every one of them rendered correctly given another second. Wait
    // for the app's <main> landmark, then for the document height to hold
    // still across frames, and fail the capture rather than record a page
    // without <main> as a candidate.
    await page.waitForSelector("main", { state: "attached", timeout: 60_000 });
    // The app applies the resolved theme asynchronously at boot; under
    // parallel capture the first paint can still show the previous scheme
    // while the height-stability probe already passes. Require the applied
    // document theme before recording a candidate.
    if (designCase.theme === "light" || designCase.theme === "dark") {
      await page.waitForFunction(
        (expected) => document.documentElement.dataset.theme === expected,
        designCase.theme,
        { timeout: 30_000 },
      );
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      const frame = () => new Promise((next) => requestAnimationFrame(next));
      let stable = 0;
      let previous = -1;
      for (let index = 0; index < 120 && stable < 5; index += 1) {
        await frame();
        const height = document.documentElement.scrollHeight;
        stable = height === previous ? stable + 1 : 0;
        previous = height;
      }
    });
    await page.addStyleTag({ content: ANIMATION_KILL_STYLE });
    if (designCase.sourceProfile) {
      assertK0Environment({
        ...designCase,
        ...metadata,
        browser: "chromium",
        browserVersion: browser.version(),
        browserLaunchOptions: paperBrowserLaunchOptions(designCase),
      });
      if (designCase.comparisonRegion || designCase.wholeArtboardCapture) {
        throw new Error(
          "K-0 route cannot request a partial or story-paired capture",
        );
      }
      await writeFile(
        outputPath,
        await captureK0Raster(page, "#root", metadata.rasterProfile),
      );
    } else await page.screenshot({ path: outputPath, fullPage: true });
    // The app's <main> box in page coordinates: compare-paper.mjs aligns a
    // design case's `comparisonRegion` (candidateOrigin "main") to it.
    contentBox = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      return {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    if (!contentBox) {
      throw Object.assign(new Error("page has no <main> landmark"), {
        reason: "route-missing-main",
      });
    }
  } catch (error) {
    await page.screenshot({ path: failedOutputPath }).catch(() => {});
    const observed = (
      error instanceof Error ? error.message : String(error)
    )
      .slice(0, 2048)
      .replace(/https?:\/\/[^\s"'<>]+/g, (value) => safeUrl(value) ?? "[url]")
      .slice(0, 1200);
    throw Object.assign(
      new Error(
        `${observed}\nCapture diagnostics: ${JSON.stringify(diagnostics)}`,
      ),
      {
        status: "failed",
        reason: error?.reason ?? "route-capture-error",
        evidencePath: relative(root, failedOutputPath),
      },
    );
  } finally {
    await page.close();
    if (ownsContext) await browserContext.close();
  }
  return {
    id: designCase.id,
    kind: "route",
    route: designCase.candidate.route,
    paperBaselineId: designCase.id,
    status: "passed",
    description: {
      expected:
        `Route ${designCase.candidate.route} renders the ${designCase.id} design fixture deterministically and produces a candidate image.`,
      observed: `Candidate image written to ${relative(root, outputPath)}.`,
    },
    outputPath: relative(root, outputPath),
    outputSha256: sha256(await readFile(outputPath)),
    contentBox,
    viewport: designCase.viewport,
    dpr: designCase.dpr,
    colorScheme: designCase.theme,
    pointer: designCase.pointer,
    locale: designCase.locale,
    direction: designCase.direction,
    fontDigests: metadata.fontDigests,
    ...(designCase.sourceProfile === undefined ? {} : {
      rasterProfile: metadata.rasterProfile,
      playwrightVersion: metadata.playwrightVersion,
      sourceProfile: designCase.sourceProfile,
      browserLaunchOptions: paperBrowserLaunchOptions(designCase),
      browserVersion: browser.version(),
      sourceDigest: metadata.sourceDigest,
    }),
    os: metadata.os,
    browser: "chromium",
    capturedAt: new Date().toISOString(),
  };
}

// A transient blank page can still occur while a dev-server module graph is
// being evaluated. Retry only the observed missing-main condition; deterministic
// navigation errors still fail closed.
export async function designCaptureMetadata(baseline, designCase, metadata) {
  if (designCase.sourceProfile === undefined) return metadata;
  const {
    resolveSourceProfile,
    computeSourceIdentity,
    fontDigests,
    loadK0RasterProfile,
  } = await import("./render-paper-references.mjs");
  const { source } = resolveSourceProfile(baseline, designCase);
  const identity = await computeSourceIdentity(baseline, designCase);
  if (
    identity.digest !== source.digest ||
    designCase.sourceDigest !== source.digest
  ) {
    throw new Error("K-0: source.digest mismatch");
  }
  return {
    ...metadata,
    sourceDigest: source.digest,
    rasterProfile: await loadK0RasterProfile(baseline, designCase),
    fontDigests: await fontDigests(baseline, designCase),
  };
}

export async function captureDesignCase(
  browser,
  webBaseUrl,
  designCase,
  metadata,
  contextPool,
) {
  return await withPaperBrowser(
    browser,
    designCase,
    (scopedBrowser) =>
      captureDesignCaseWithBrowser(
        scopedBrowser,
        webBaseUrl,
        designCase,
        metadata,
        designCase.sourceProfile === undefined ? contextPool : undefined,
      ),
  );
}

async function captureDesignCaseWithBrowser(
  browser,
  webBaseUrl,
  designCase,
  metadata,
  contextPool,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await captureDesignCaseOnce(
        browser,
        webBaseUrl,
        designCase,
        metadata,
        contextPool,
      );
    } catch (error) {
      const retryable = error instanceof Error &&
        error.message.includes("waiting for locator('main')");
      if (!retryable || attempt === 1) throw error;
    }
  }
  throw new Error("unreachable capture retry state");
}

export function changedPaths({
  baseRef = process.env.GITHUB_BASE_REF,
  baseSha = process.env.BAKERY_CAPTURE_BASE_SHA,
  git = execFileSync,
} = {}) {
  if (baseSha && !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error("BAKERY_CAPTURE_BASE_SHA_INVALID");
  }
  const range = baseSha
    ? `${baseSha}...HEAD`
    : baseRef
    ? `origin/${baseRef}...HEAD`
    : "HEAD";
  try {
    return git("git", ["diff", "--name-only", range], {
      cwd: root,
      encoding: "utf8",
    })
      .trim().split("\n").filter(Boolean).map(normalizePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to discover changed paths for ${range}: ${message}`,
    );
  }
}

export function selectCases(
  runtime,
  catalog,
  stories,
  args,
  paths = changedPaths(),
) {
  if (args.caseIds.length) {
    const selected = runtime.cases.filter((runtimeCase) =>
      args.caseIds.includes(runtimeCase.id)
    );
    if (selected.length !== args.caseIds.length) {
      throw new Error("Unknown runtime case selected");
    }
    return selected;
  }
  if (!args.changed) return runtime.cases;
  const globalChange = paths.some((path) =>
    path.startsWith("docs/technical-design/ui-baselines/") ||
    path.startsWith("docs/technical-design/auth-mocks/") ||
    path.startsWith("packages/ui/.storybook/") ||
    path.startsWith("packages/ui/scripts/") ||
    path === "packages/ui/package.json" ||
    path === "packages/ui/playwright.config.ts" ||
    path.startsWith("packages/ui/src/foundations/") ||
    (path.startsWith("packages/ui/src/") && !path.endsWith(".stories.tsx")) ||
    path === "scripts/verify-ui-stories.ts" ||
    path === "scripts/check-ui-architecture.mjs" ||
    path.startsWith("apps/web/src/fixtures/") ||
    path === "pnpm-lock.yaml" ||
    path === "turbo.json" ||
    path === ".github/workflows/ci.yml"
  );
  if (globalChange) return runtime.cases;
  const catalogById = new Map(
    catalog.entries.map((entry) => [entry.id, entry]),
  );
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const selected = runtime.cases.filter((runtimeCase) => {
    const entry = catalogById.get(runtimeCase.catalogId);
    const story = storiesById.get(runtimeCase.storyId);
    const sourcePaths = story ? sourcePathForCase(entry, story) : [];
    return sourcePaths.some((path) => paths.includes(normalizePath(path)));
  });
  const selectedSourcePaths = new Set(
    selected.flatMap((runtimeCase) => {
      const entry = catalogById.get(runtimeCase.catalogId);
      const story = storiesById.get(runtimeCase.storyId);
      return story ? sourcePathForCase(entry, story) : [];
    }).map(normalizePath),
  );
  if (
    paths.some((path) => path.startsWith("packages/ui/")) &&
    paths.some((path) => !selectedSourcePaths.has(path))
  ) {
    return runtime.cases;
  }
  return includePaperCases(runtime.cases, selected);
}

export function includePaperCases(runtimeCases, selectedCases) {
  const selectedIds = new Set(
    selectedCases.map((runtimeCase) => runtimeCase.id),
  );
  return runtimeCases.filter((runtimeCase) =>
    selectedIds.has(runtimeCase.id) || runtimeCase.paperBaselineId
  );
}

function parseArguments(argv) {
  const args = {
    changed: false,
    caseIds: [],
    only: [],
    webBaseUrl: process.env.BAKERY_WEB_BASE_URL || null,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--changed") args.changed = true;
    else if (argument === "--case") args.caseIds.push(argv[++index]);
    else if (argument === "--all") args.changed = false;
    else if (argument === "--web-base-url") args.webBaseUrl = argv[++index];
    // Development loop only: capture just the design cases whose id starts
    // with a prefix (e.g. `--only login. --only expired.`) and skip stories.
    else if (argument === "--only") args.only.push(argv[++index]);
    else throw new Error(`Unknown capture argument ${argument}`);
  }
  if (args.only.length && !args.webBaseUrl) {
    throw new Error("--only requires --web-base-url");
  }
  return args;
}

export async function captureRuntimeCases(
  {
    baseURL = process.env.BASE_URL,
    args = parseArguments(process.argv.slice(2)),
  } = {},
) {
  const runtime = await readJson(runtimePath);
  const catalog = await readJson(catalogPath);
  const tokenManifest = await readJson(tokenPath);
  const paperManifest = await readJson(paperBaselinesPath);
  let resolvedBaseURL = baseURL;
  let server;
  if (!resolvedBaseURL) {
    const started = await startStaticStorybook();
    server = started.server;
    resolvedBaseURL = started.baseURL;
  }
  try {
    await waitForServer(resolvedBaseURL);
    const storybookBuildDigest = await verifiedServedBuildDigest(
      resolvedBaseURL,
    );
    const index = await (await fetch(new URL("/index.json", resolvedBaseURL)))
      .json();
    const stories = storyIndexEntries(index).filter((story) =>
      story.type === "story"
    );
    const selectedCases = args.only.length
      ? []
      : selectCases(runtime, catalog, stories, args);
    await mkdir(outputDirectory, { recursive: true });
    const browser = await chromium.launch({ headless: true });
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
      storybookBuildDigest,
      tokenRevision: tokenManifest.source.revision,
      tokenDigest: tokenManifest.source.digest,
      fontDigests: await fontDigests(),
      browserVersion: browser.version(),
      playwrightVersion: (await readJson(
        join(uiRoot, "node_modules/@playwright/test/package.json"),
      )).version,
      os: `${process.platform}-${process.arch}`,
    };
    const coverageFor = (records, selected) => {
      const observedIds = new Set(records.map((record) => record.id));
      return {
        expected: runtime.cases.length,
        selected: selected.length,
        observed: records.length,
        passed: records.filter((record) => record.status === "passed").length,
        failed: records.filter((record) => record.status === "failed").length,
        blocked: records.filter((record) => record.status === "blocked").length,
        missing: selected.map((runtimeCase) => runtimeCase.id).filter((id) =>
          !observedIds.has(id)
        ),
        routes: records.filter((record) => record.kind === "route").length,
      };
    };
    const writeCandidateManifest = async (records, selected) => {
      await writeFile(
        outputManifestPath,
        JSON.stringify(
          {
            schemaVersion: 2,
            selection: {
              mode: args.caseIds.length
                ? "explicit"
                : args.changed
                ? "changed"
                : "all",
              caseIds: selected.map((runtimeCase) => runtimeCase.id),
            },
            coverage: coverageFor(records, selected),
            cases: records,
          },
          null,
          2,
        ) + "\n",
      );
    };
    const records = [];
    try {
      // Manifest writes serialize: parallel capture workers complete cases
      // concurrently, and concurrent writers of the same manifest path would
      // interleave.
      let manifestChain = Promise.resolve();
      const writeManifestSnapshot = () => {
        const task = manifestChain.then(() =>
          writeCandidateManifest(records, selectedCases)
        );
        manifestChain = task.catch(() => {});
        return task;
      };
      let nextStoryCase = 0;
      const captureStoryCase = async () => {
        while (nextStoryCase < selectedCases.length) {
          const runtimeCase = selectedCases[nextStoryCase];
          nextStoryCase += 1;
          const context = runtime.contexts[runtimeCase.context];
          const catalogEntry = catalog.entries.find((entry) =>
            entry.id === runtimeCase.catalogId
          );
          const paperBaseline = (paperManifest.cases ?? []).find((baseline) =>
            baseline.id === runtimeCase.paperBaselineId
          );
          const story = stories.find((entry) =>
            entry.id === runtimeCase.storyId
          );
          if (!context || !catalogEntry || !story) {
            const missing = [
              !context && "context",
              !catalogEntry && "catalog entry",
              !story && "story",
            ].filter(Boolean).join(", ");
            records.push({
              id: runtimeCase.id,
              kind: "story",
              catalogId: runtimeCase.catalogId,
              requiredCaseId: runtimeCase.requiredCaseId,
              storyId: runtimeCase.storyId,
              paperBaselineId: runtimeCase.paperBaselineId ?? null,
              status: "blocked",
              reason: "unresolved-input",
              description: {
                expected:
                  `Runtime case ${runtimeCase.id} resolves its declared context, catalog entry, and Storybook story before capture.`,
                observed:
                  `Capture blocked because the ${missing} could not be resolved.`,
              },
            });
            await writeManifestSnapshot();
            continue;
          }
          try {
            records.push(
              await withPaperBrowser(
                browser,
                paperBaseline ?? {},
                async (scopedBrowser) =>
                  captureCase(
                    scopedBrowser,
                    resolvedBaseURL,
                    runtimeCase,
                    context,
                    catalogEntry,
                    story,
                    paperBaseline?.sourceProfile === undefined
                      ? metadata
                      : await designCaptureMetadata(
                        paperManifest,
                        paperBaseline,
                        metadata,
                      ),
                    paperBaseline,
                  ),
              ),
            );
          } catch (error) {
            records.push({
              id: runtimeCase.id,
              kind: "story",
              catalogId: runtimeCase.catalogId,
              requiredCaseId: runtimeCase.requiredCaseId,
              storyId: runtimeCase.storyId,
              paperBaselineId: runtimeCase.paperBaselineId ?? null,
              status: error?.status ?? "blocked",
              reason: error?.reason ?? "capture-error",
              evidencePath: error?.evidencePath ?? null,
              description: {
                expected:
                  `Rendered ${catalogEntry.name} specimen satisfies its declared runtime assertions and produces a deterministic candidate image.`,
                observed: error instanceof Error
                  ? error.message
                  : String(error),
              },
            });
          }
          await writeManifestSnapshot();
        }
      };
      // Story cases are independent (each opens its own browser context), so
      // the same supported worker bound as the design routes applies here.
      await Promise.all(
        Array.from(
          { length: Math.min(captureConcurrency(), selectedCases.length) },
          () => captureStoryCase(),
        ),
      );
      if (args.webBaseUrl) {
        const { resolveSourceProfile } = await import(
          "./render-paper-references.mjs"
        );
        const paperBaselines = await readJson(paperBaselinesPath);
        const designCases = (paperBaselines.cases ?? []).filter(
          (baselineCase) =>
            baselineCase.reference === "design" &&
            !baselineCase.candidate?.storyId &&
            (args.only.length === 0 ||
              args.only.some((prefix) => baselineCase.id.startsWith(prefix))),
        );
        // Each scheduler worker keeps a small context pool keyed by immutable
        // device settings. Pages are still isolated per case, while the
        // browser cache is reused instead of reloading Vite's full module
        // graph for every route.
        for (const designCase of designCases) {
          resolveSourceProfile(paperBaselines, designCase);
        }
        const routeRecords = new Array(designCases.length);
        let next = 0;
        const captureNext = async () => {
          const contextPool = createDesignContextPool(browser);
          try {
            while (next < designCases.length) {
              const index = next;
              next += 1;
              const designCase = designCases[index];
              try {
                routeRecords[index] = await captureDesignCase(
                  browser,
                  args.webBaseUrl,
                  designCase,
                  await designCaptureMetadata(
                    paperBaselines,
                    designCase,
                    metadata,
                  ),
                  contextPool,
                );
              } catch (error) {
                routeRecords[index] = {
                  id: designCase.id,
                  kind: "route",
                  route: designCase.candidate?.route ?? null,
                  paperBaselineId: designCase.id,
                  status: error?.status ?? "failed",
                  reason: error?.reason ?? "route-capture-error",
                  evidencePath: error?.evidencePath ?? null,
                  description: {
                    expected:
                      `Route ${designCase.candidate?.route} renders the ${designCase.id} design fixture deterministically and produces a candidate image.`,
                    observed: error instanceof Error
                      ? error.message
                      : String(error),
                  },
                };
              }
              await writeCandidateManifest(
                [...records, ...routeRecords.filter(Boolean)],
                selectedCases,
              );
            }
          } finally {
            await contextPool.close();
          }
        };
        await Promise.all(
          Array.from(
            {
              length: Math.min(
                designCases.some((entry) => entry.sourceProfile !== undefined)
                  ? 1
                  : captureConcurrency(),
                designCases.length,
              ),
            },
            captureNext,
          ),
        );
        records.push(...routeRecords);
      }
    } finally {
      await browser.close();
      await writeCandidateManifest(records, selectedCases);
    }
    const coverage = coverageFor(records, selectedCases);
    if (
      coverage.failed + coverage.blocked + coverage.missing.length > 0
    ) {
      throw new Error(
        `Runtime capture failed closed: ${coverage.failed} failed, ${coverage.blocked} blocked, ${coverage.missing.length} missing; see ${
          relative(root, outputManifestPath)
        }`,
      );
    }
    console.log(
      `Captured ${records.length} runtime cases to ${
        relative(root, outputManifestPath)
      }.`,
    );
    return records;
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  }
}

if (import.meta.main) await captureRuntimeCases();
