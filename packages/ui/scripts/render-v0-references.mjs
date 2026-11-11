// Re-renders the V-0 (auth-mocks) design references after the mock source
// changes. `render-paper-references.mjs --write` also touches K-0 and is
// pinned; this script is not. It selects only `reference === "design"` cases
// with no `sourceProfile`, re-renders each through the exported
// `renderAndFillCase`, and restamps `baseline.source` from
// `computeSourceIdentity(baseline, {})`. K-0 cases, `sourceProfiles` and every
// other manifest key are left exactly as they were. New cases still come from
// `render-paper-references.mjs --add`.
//
// Usage: node scripts/render-v0-references.mjs [--manifest <path>]
// `--manifest` points at another baseline file (tests use a temp copy); the
// default is docs/technical-design/ui-baselines/paper-baselines.json.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  closeServer,
  computeSourceIdentity,
  renderAndFillCase,
} from "./render-paper-references.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultManifestPath = resolve(
  scriptDirectory,
  "../../../docs/technical-design/ui-baselines/paper-baselines.json",
);

/** The V-0 cases: design references that carry no K-0 (or other) source profile. */
export function selectV0Cases(baseline) {
  return (baseline.cases ?? []).filter((designCase) =>
    designCase.reference === "design" && designCase.sourceProfile === undefined
  );
}

/**
 * Refreshes `baseline` in place and returns the cases it re-rendered. The
 * collaborators are parameters so a test can run the whole flow against a
 * temp manifest without launching a browser or writing reference PNGs.
 */
export async function refreshV0References(baseline, browser, {
  render = renderAndFillCase,
  identity = computeSourceIdentity,
} = {}) {
  if (baseline.schemaVersion !== 2) {
    throw new Error(
      `paper-baselines.json is schemaVersion ${baseline.schemaVersion}; V-0 references require schemaVersion 2`,
    );
  }
  const designCases = selectV0Cases(baseline);
  for (const designCase of designCases) {
    await render(browser, baseline, designCase);
  }
  Object.assign(baseline.source, await identity(baseline, {}));
  return designCases;
}

/** Serializes a baseline exactly the way `render-paper-references.mjs` saves it. */
export const serializeBaseline = (baseline) =>
  JSON.stringify(baseline, null, 2) + "\n";

function manifestPathFrom(rawArgv) {
  const argv = rawArgv.filter((argument) => argument !== "--");
  if (argv.length === 0) return defaultManifestPath;
  if (argv[0] === "--manifest" && argv[1] !== undefined && argv.length === 2) {
    return resolve(argv[1]);
  }
  throw new Error("usage: render-v0-references.mjs [--manifest <path>]");
}

async function main() {
  const manifestPath = manifestPathFrom(process.argv.slice(2));
  const baseline = JSON.parse(await readFile(manifestPath, "utf8"));
  const browser = await chromium.launch();
  try {
    const rendered = await refreshV0References(baseline, browser);
    await writeFile(manifestPath, serializeBaseline(baseline));
    console.log(`Rendered ${rendered.length} V-0 design reference(s).`);
  } finally {
    await browser.close();
    await closeServer();
  }
}

if (import.meta.main) {
  await main();
}
