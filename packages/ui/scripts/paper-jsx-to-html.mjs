// Deterministic Paper JSX -> static HTML generator for the enterprise mock
// site (docs/technical-design/enterprise-mocks/site) and the settings mock
// site (docs/technical-design/settings-mocks/site, `--site settings`).
//
// Input is the committed, verbatim Paper `get_jsx` (inline-styles) output in
// the site's source directory (enterprise-mocks/paper-source,
// settings-mocks/source) plus `source-manifest.json` (which frame is
// which screen) and `paper-tokens.json` (the Paper token snapshot). Output is
// a static site that mirrors the auth-mocks contract: open
// `site/index.html?screen=1&theme=light#<screen>` and `#app` carries
// `data-screen`/`data-state` once the site's ready global
// (`bakeryEnterpriseReady`, `bakerySettingsReady`) is true.
//
// No Paper MCP, no network: a frame is esbuild-transformed, rendered with
// react-dom/server `renderToStaticMarkup`, and written as a fragment. Run with
// no argument to write; `--check` regenerates in memory and byte-compares with
// the committed site, so a hand edit or a stale site fails.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");

// The generated sites. Everything that differs between them is data here, so
// the enterprise output stays byte-identical to what it was before settings.
const SITES = {
  artifacts: {
    label: "artifacts",
    mocksDirectory: join(root, "docs/technical-design/artifacts-mocks"),
    sourceName: "source",
    manifestName: "source-manifest.json",
    readyGlobal: "bakeryArtifactsReady",
    fontsPath: "../../enterprise-mocks/fonts/",
  },
  enterprise: {
    label: "enterprise",
    mocksDirectory: join(root, "docs/technical-design/enterprise-mocks"),
    sourceName: "paper-source",
    manifestName: "paper-source/source-manifest.json",
    readyGlobal: "bakeryEnterpriseReady",
    fontsPath: "../fonts/",
  },
  settings: {
    label: "settings",
    mocksDirectory: join(root, "docs/technical-design/settings-mocks"),
    sourceName: "source",
    manifestName: "source-manifest.json",
    readyGlobal: "bakerySettingsReady",
    // Settings reuses the pinned Geist files of the enterprise mocks.
    fontsPath: "../../enterprise-mocks/fonts/",
  },
  entitlements: {
    label: "entitlements",
    mocksDirectory: join(root, "docs/technical-design/entitlements-mocks"),
    sourceName: "source",
    manifestName: "source-manifest.json",
    readyGlobal: "bakeryEntitlementsReady",
    // Entitlements reuses the pinned Geist files of the enterprise mocks.
    fontsPath: "../../enterprise-mocks/fonts/",
  },
};

// The screen and state a frame is addressed by in `#<screen>/<state>` and in
// its fragment name. Enterprise and settings frames carry them as `id` and
// `state`. Entitlements frames carry the whole fragment key in `id`
// (`<screen>--<state>--<theme>--<device>`) and a display `state`, so the key is
// split instead.
export function frameParts({ id, state, theme, device }) {
  const suffix = `--${theme}--${device}`;
  if (!id.endsWith(suffix)) return { screen: id, state };
  const key = id.slice(0, -suffix.length);
  const cut = key.lastIndexOf("--");
  return cut < 0
    ? { screen: key, state: "default" }
    : { screen: key.slice(0, cut), state: key.slice(cut + 2) };
}

function siteLayout(siteName) {
  const site = SITES[siteName];
  if (!site) {
    throw new Error(
      `unknown site "${siteName}" (expected ${Object.keys(SITES).join("|")})`,
    );
  }
  return {
    ...site,
    sourceDirectory: join(site.mocksDirectory, site.sourceName),
    manifestPath: join(site.mocksDirectory, site.manifestName),
    siteDirectory: join(site.mocksDirectory, "site"),
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Fonts the mock sites declare: [family, weight, file under enterprise-mocks/fonts].
const FONT_FACES = [
  ["Geist", 400, "geist-400.ttf"],
  ["Geist", 500, "geist-500.ttf"],
  ["Geist", 600, "geist-600.ttf"],
  ["Geist Mono", 400, "geist-mono-400.ttf"],
  ["Geist Mono", 500, "geist-mono-500.ttf"],
  ["Geist Mono", 600, "geist-mono-600.ttf"],
];

const indexHtml = ({ label }) =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Bakery ${label} mocks (generated from Paper)</title><link rel="stylesheet" href="fonts.css"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="base.css"></head>
<body>
<main id="app"></main>
<script src="site.js"></script>
</body></html>
`;

const BASE_CSS = `*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--color-surface);font-family:var(--font-sans)}
#app{display:block}
`;

// Picks the Paper frame for \`#<screen>[/<state>]\`: phone below the pane
// breakpoint (744px), desktop otherwise, because Paper draws them as separate
// frames rather than one responsive layout. Sets the ready flag only after the
// fragment is in the DOM, fonts are loaded and every background image decoded.
const siteJs = ({ readyGlobal }) =>
  `(async () => {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  const [screen, state = "default"] = location.hash.slice(1).split("/");
  const device = matchMedia("(max-width: 743px)").matches ? "phone" : "desktop";
  const app = document.getElementById("app");
  const response = await fetch(
    "fragments/" + screen + "--" + state + "--" + theme + "--" + device + ".html",
  );
  if (!response.ok) throw new Error("no Paper frame for " + screen + "/" + state + "/" + theme + "/" + device);
  app.innerHTML = await response.text();
  app.dataset.screen = screen;
  app.dataset.state = state;
  await document.fonts.ready;
  const urls = new Set();
  for (const element of app.querySelectorAll("*")) {
    for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\\("?([^")]+)"?\\)/g)) urls.add(match[1]);
  }
  await Promise.all([...urls].map(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
  }));
  globalThis.${readyGlobal} = true;
})();
`;

function tokensCss(tokens) {
  const lines = tokens.tokens.map((token) =>
    `  ${token.name}: ${token.value};`
  );
  return `/* Generated by packages/ui/scripts/paper-jsx-to-html.mjs from paper-source/paper-tokens.json (Paper tokens contentHash ${tokens.contentHash.tokens}). Do not edit. */\n:root {\n${
    lines.join("\n")
  }\n}\n`;
}

function fontsCss({ fontsPath }) {
  const faces = FONT_FACES.map(([family, weight, file]) =>
    `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: block;\n  src: url(${fontsPath}${file}) format('truetype');\n}\n`
  );
  return faces.join("");
}

async function renderFrame(jsxSource, assetPrefix, { sourceName }) {
  const localised = jsxSource.replaceAll(
    assetPrefix,
    `../${sourceName}/assets/`,
  );
  const { code } = await transform(
    `const Frame = () => ${localised.trim()};\nmodule.exports = Frame;\n`,
    {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      format: "cjs",
      target: "es2022",
    },
  );
  const module = { exports: {} };
  new Function("React", "module", code)(
    { createElement, Fragment },
    module,
  );
  return renderToStaticMarkup(createElement(module.exports)) + "\n";
}

// Returns Map<repo-relative path, string> of every generated site file, plus
// the list of problems found in the committed inputs.
export async function generateSite(siteName = "enterprise") {
  const layout = siteLayout(siteName);
  const { sourceDirectory, siteDirectory } = layout;
  const manifest = await readJson(layout.manifestPath);
  const tokens = await readJson(join(sourceDirectory, "paper-tokens.json"));
  const problems = [];
  const files = new Map();
  const put = (name, content) =>
    files.set(relative(root, join(siteDirectory, name)), content);

  if (tokens.contentHash?.tokens !== manifest.tokens.contentHash) {
    problems.push(
      `paper-tokens.json contentHash ${tokens.contentHash?.tokens} differs from source-manifest ${manifest.tokens.contentHash}`,
    );
  }
  const tokenBytes = await readFile(
    join(sourceDirectory, manifest.tokens.path),
  );
  if (sha256(tokenBytes) !== manifest.tokens.sha256) {
    problems.push(
      `${manifest.tokens.path}: sha256 differs from source-manifest`,
    );
  }
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(sourceDirectory, asset.path)).catch(
      () => null,
    );
    if (!bytes) problems.push(`${asset.path}: asset is missing`);
    else if (sha256(bytes) !== asset.sha256) {
      problems.push(`${asset.path}: sha256 differs from source-manifest`);
    }
  }
  if (manifest.screens.length !== manifest.expectedScreens) {
    problems.push(
      `source-manifest lists ${manifest.screens.length} screens, expected ${manifest.expectedScreens}`,
    );
  }

  put("index.html", indexHtml(layout));
  put("base.css", BASE_CSS);
  put("site.js", siteJs(layout));
  put("tokens.css", tokensCss(tokens));
  put("fonts.css", fontsCss(layout));

  for (const screen of manifest.screens) {
    const jsxBytes = await readFile(join(sourceDirectory, screen.source));
    if (sha256(jsxBytes) !== screen.sha256) {
      problems.push(`${screen.source}: sha256 differs from source-manifest`);
    }
    const html = await renderFrame(
      jsxBytes.toString("utf8"),
      manifest.assetUrlPrefix,
      layout,
    );
    if (html.includes("://app.paper.design")) {
      problems.push(
        `${screen.source}: remote Paper asset URL survived rendering`,
      );
    }
    const { screen: name, state } = frameParts(screen);
    put(
      `fragments/${name}--${state}--${screen.theme}--${screen.device}.html`,
      html,
    );
  }
  return { files, problems };
}

async function committedSiteFiles({ siteDirectory }) {
  const found = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(siteDirectory);
  return found.sort();
}

export async function checkSite(siteName = "enterprise") {
  const { files, problems } = await generateSite(siteName);
  const issues = [...problems];
  for (const [path, content] of files) {
    const committed = await readFile(join(root, path), "utf8").catch(() =>
      null
    );
    if (committed === null) issues.push(`${path}: missing (run the generator)`);
    else if (committed !== content) {
      issues.push(`${path}: differs from generator output`);
    }
  }
  for (const path of await committedSiteFiles(siteLayout(siteName))) {
    if (!files.has(path)) issues.push(`${path}: not produced by the generator`);
  }
  return issues;
}

async function main() {
  const flags = process.argv.slice(2).filter((argument) => argument !== "--");
  let siteName = "enterprise";
  let check = false;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "--check") check = true;
    else if (flags[index] === "--site") siteName = flags[++index];
    else throw new Error(`unknown argument ${flags[index]}`);
  }
  const { label, siteDirectory } = siteLayout(siteName);

  if (check) {
    const issues = await checkSite(siteName);
    if (issues.length) {
      console.error(`${issues.length} issue(s):`);
      for (const issue of issues) console.error(`  - ${issue}`);
      process.exitCode = 1;
    } else {
      console.log(
        `${label[0].toUpperCase()}${
          label.slice(1)
        } mock site matches the committed Paper source.`,
      );
    }
    return;
  }

  const { files, problems } = await generateSite(siteName);
  if (problems.length) {
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  await rm(siteDirectory, { recursive: true, force: true });
  for (const [path, content] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  console.log(`Wrote ${files.size} ${label} mock site file(s).`);
}

if (import.meta.main) {
  await main();
}
