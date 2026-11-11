// E05 repo-authored references use the existing site renderer and scoring gate.
// No Paper export is claimed; --write is the only PNG producer.
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
import { checkSite } from "./paper-jsx-to-html.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mocks = "docs/technical-design/artifacts-mocks";
const manifestPath = `${mocks}/source-manifest.json`;
export const ARTIFACTS_BASELINE_PATH = join(
  root,
  "docs/technical-design/ui-baselines/artifacts-baselines.json",
);
export const closeArtifactsServer = closeEnterpriseServer;
const readJson = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function artifactsSchemaIssues(baseline) {
  const { parseEnterpriseBaselines } = await import(
    "../catalog/design-cases.ts"
  );
  const result = parseEnterpriseBaselines(baseline);
  return result.success
    ? []
    : result.issues.map((issue) => `artifacts-baselines.json ${issue}`);
}

export async function checkArtifactsSourceBytes(manifest) {
  const issues = [];
  const inputs = [
    [`${mocks}/source/${manifest.tokens.path}`, manifest.tokens.sha256],
    ...manifest.fonts.files.map((font) => [font.path, font.sha256]),
    ...manifest.screens.map((
      screen,
    ) => [`${mocks}/source/${screen.source}`, screen.sha256]),
  ];
  for (const [path, expected] of inputs) {
    const bytes = await readFile(join(root, path)).catch(() => null);
    if (!bytes || hash(bytes) !== expected) {
      issues.push(`${path}: missing or source hash mismatch`);
    }
  }
  if (manifest.screens.length !== manifest.expectedScreens) {
    issues.push("source frame inventory mismatch");
  }
  if (
    new Set(manifest.screens.map((screen) => screen.nodeId)).size !==
      manifest.screens.length
  ) issues.push("duplicate source frame id");
  return issues;
}

export async function checkArtifactsReferences({ baseline, browser }) {
  const manifest = await readJson(manifestPath);
  const sourceIssues = await checkArtifactsSourceBytes(manifest);
  const result = await checkEnterpriseReferences({ baseline, browser });
  const expected = manifest.screens.map((screen) =>
    `${screen.id}.${screen.state}.${screen.theme}.${screen.device}`
  ).sort();
  const actual = baseline.cases.map((entry) => entry.id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    sourceIssues.push("baseline cases differ from source frame inventory");
  }
  return {
    issues: [
      ...sourceIssues,
      ...await checkSite("artifacts"),
      ...result.issues.map((issue) =>
        issue.replace(
          /^enterprise-baselines\.json /,
          "artifacts-baselines.json ",
        )
      ),
    ],
    results: result.results,
  };
}

async function writeReferences(browser) {
  const manifest = await readJson(manifestPath);
  const problems = [
    ...await checkArtifactsSourceBytes(manifest),
    ...await checkSite("artifacts"),
  ];
  if (problems.length) throw new Error(problems.join("\n"));
  const baseline = {
    schemaVersion: 2,
    source: {
      fileId: manifest.fileId,
      pageId: manifest.pageId,
      manifestPath,
      entry: `${mocks}/site/index.html`,
      readyGlobal: "bakeryArtifactsReady",
      inputs: [
        manifestPath,
        `${mocks}/source/paper-tokens.json`,
        ...["index.html", "base.css", "site.js", "tokens.css", "fonts.css"].map(
          (name) => `${mocks}/site/${name}`,
        ),
        ...manifest.screens.flatMap((screen) => [
          `${mocks}/source/${screen.source}`,
          `${mocks}/site/fragments/${screen.id}--${screen.state}--${screen.theme}--${screen.device}.html`,
        ]),
        ...manifest.fonts.files.map((font) => font.path),
        manifest.fonts.provenance,
        "packages/ui/scripts/fontconfig/fonts.conf",
        "packages/ui/scripts/render-artifacts-references.mjs",
        "packages/ui/scripts/render-enterprise-references.mjs",
      ],
      revision: "",
      digest: "",
    },
    reference: { hidden: [], overrides: {} },
    cases: [],
    excluded: [],
  };
  for (const screen of manifest.screens) {
    const designCase = buildEnterpriseCase(baseline, manifest, {
      screen: screen.id,
      state: screen.state,
      theme: screen.theme,
      device: screen.device,
      route: `/__fixtures__/artifacts/${screen.id}/${screen.state}`,
      session: "authenticated",
    });
    designCase.imagePath =
      `docs/technical-design/ui-baselines/paper/artifacts/${screen.id}--${screen.state}--${screen.theme}--${screen.device}.png`;
    await renderAndFillEnterpriseCase(browser, baseline, designCase);
    baseline.cases.push(designCase);
    console.log(`${designCase.id}: rendered`);
  }
  Object.assign(baseline.source, await computeSourceIdentity(baseline));
  const issues = await artifactsSchemaIssues(baseline);
  if (issues.length) throw new Error(issues.join("\n"));
  await mkdir(dirname(ARTIFACTS_BASELINE_PATH), { recursive: true });
  await writeFile(
    ARTIFACTS_BASELINE_PATH,
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.length !== 1 || !["--write", "--check", "--list"].includes(args[0])
  ) {
    throw new Error(
      "usage: render-artifacts-references.mjs --write|--check|--list",
    );
  }
  if (args[0] === "--list") {
    const manifest = await readJson(manifestPath);
    for (const screen of manifest.screens) {
      console.log(`${screen.nodeId}\t${screen.source}`);
    }
    return;
  }
  const browser = await chromium.launch(enterpriseLaunchOptions());
  try {
    if (args[0] === "--write") return await writeReferences(browser);
    const baseline = JSON.parse(
      await readFile(ARTIFACTS_BASELINE_PATH, "utf8"),
    );
    const { issues, results } = await checkArtifactsReferences({
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
    else {console.log(
        `All ${results.length} artifacts references verified clean (floor 0.95).`,
      );}
  } finally {
    await browser.close();
    await closeArtifactsServer();
  }
}
if (import.meta.main) await main();
