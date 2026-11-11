// Shared by capture-stories.mjs and compare-paper.mjs: which Paper baseline
// manifest a run targets (`--manifest auth|enterprise|settings|entitlements|artifacts|worker-dark`, default auth), where
// that run keeps its artifacts, and which cases the route reference ledger
// (docs/technical-design/ui-baselines/route-references.json) marks `planned`.
// The ledger is validated by scripts/check-ui-architecture.mjs; this file only
// reads it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const LEDGER_PATH =
  "docs/technical-design/ui-baselines/route-references.json";

// `artifactSubdirectory` keeps a non-default manifest's candidate capture and
// comparison report beside, not over, the auth artifacts CI already records.
//
// `siteRendered` manifests (enterprise, settings, entitlements) take their references from a
// static site generated from committed Paper JSX, not from the pinned auth/K-0
// renderer; they share one renderer module family, the hermetic fontconfig,
// phone `deviceChrome` and ledger `baselined` handling. `defersScoring`
// manifests may additionally mark a route `planned` or `debt` in the route
// reference ledger so its cases are reported, not scored; settings never may:
// every settings case scores from the first commit that names it. Entitlements
// may: its routes ship across E16 phases, so each stays `planned` until its
// route exists.
const PROFILES = {
  artifacts: {
    baselinePath: "docs/technical-design/ui-baselines/artifacts-baselines.json",
    artifactSubdirectory: "artifacts",
    siteRendered: true,
    defersScoring: true,
  },
  auth: {
    baselinePath: "docs/technical-design/ui-baselines/paper-baselines.json",
    artifactSubdirectory: "",
    siteRendered: false,
    defersScoring: false,
  },
  enterprise: {
    baselinePath:
      "docs/technical-design/ui-baselines/enterprise-baselines.json",
    artifactSubdirectory: "enterprise",
    siteRendered: true,
    defersScoring: true,
  },
  settings: {
    baselinePath: "docs/technical-design/ui-baselines/settings-baselines.json",
    artifactSubdirectory: "settings",
    siteRendered: true,
    defersScoring: false,
  },
  entitlements: {
    baselinePath:
      "docs/technical-design/ui-baselines/entitlements-baselines.json",
    artifactSubdirectory: "entitlements",
    siteRendered: true,
    defersScoring: true,
  },
  // Story candidates scored against a reference derived from approved K-0
  // sources (see render-worker-dark-references.mjs); every case scores.
  "worker-dark": {
    baselinePath:
      "docs/technical-design/ui-baselines/worker-dark-baselines.json",
    artifactSubdirectory: "worker-dark",
    siteRendered: true,
    defersScoring: false,
  },
};

export const MANIFEST_NAMES = Object.keys(PROFILES);

export function manifestProfile(name = "auth") {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `unknown manifest "${name}" (expected ${MANIFEST_NAMES.join("|")})`,
    );
  }
  return {
    name,
    baselineRepoPath: profile.baselinePath,
    baselinePath: join(root, profile.baselinePath),
    artifactSubdirectory: profile.artifactSubdirectory,
    siteRendered: profile.siteRendered,
    defersScoring: profile.defersScoring,
  };
}

// True for manifests whose references are rendered from a Paper-JSX site.
export function isSiteManifest(name = "auth") {
  return manifestProfile(name).siteRendered;
}

// True for manifests whose ledger entries may defer scoring (`planned`/`debt`).
export function defersScoring(name = "auth") {
  return manifestProfile(name).defersScoring;
}

export function artifactsDirectoryFor(artifactsDirectory, name = "auth") {
  const { artifactSubdirectory } = manifestProfile(name);
  return artifactSubdirectory
    ? join(artifactsDirectory, artifactSubdirectory)
    : artifactsDirectory;
}

export async function readRouteLedger() {
  return JSON.parse(await readFile(join(root, LEDGER_PATH), "utf8"));
}

// Case id -> the planned ledger entry that owns it, for one manifest. A case
// belongs to a ledger entry through the entry's `cases` plus its `manifest`.
export function plannedCases(ledger, manifestName = "auth") {
  const planned = new Map();
  // Only a deferring manifest may defer scoring; auth and settings goldens
  // always score.
  if (!defersScoring(manifestName)) return planned;
  for (const entry of ledger?.entries ?? []) {
    if (entry.status !== "planned" || entry.manifest !== manifestName) {
      continue;
    }
    for (const caseId of entry.cases ?? []) planned.set(caseId, entry);
  }
  return planned;
}

// Case ids of one manifest whose ledger route is `baselined`. They are always
// captured and scored: a `--changed` run never narrows them, so the trusted
// verifier can refuse `not-selected` for them.
export function baselinedCases(ledger, manifestName = "auth") {
  const baselined = new Set();
  if (!isSiteManifest(manifestName)) return baselined;
  for (const entry of ledger?.entries ?? []) {
    if (entry.status !== "baselined" || entry.manifest !== manifestName) {
      continue;
    }
    for (const caseId of entry.cases ?? []) baselined.add(caseId);
  }
  return baselined;
}

// Case id -> the `debt` ledger entry that owns it, for one manifest. A debt
// entry has no golden cases of its own: it lists Paper frames only, so a case
// belongs to it when the case's design frame (`case.frameId`) is one of the
// entry's frames. Only a deferring manifest may defer scoring this way; auth
// and settings goldens always score, so they have no debt cases.
export function debtCases(ledger, manifest, manifestName = "enterprise") {
  const debt = new Map();
  if (!defersScoring(manifestName)) return debt;
  const frames = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry.status !== "debt") continue;
    for (const frame of entry.frames ?? []) {
      if (typeof frame?.frameId === "string") {
        frames.set(frame.frameId, entry);
      }
    }
  }
  for (const designCase of manifest?.cases ?? []) {
    if (designCase.reference !== "design") continue;
    const entry = frames.get(designCase.frameId);
    if (entry) debt.set(designCase.id, entry);
  }
  return debt;
}

// Viewport a site-rendered (enterprise or settings) case is captured at. A phone case with `deviceChrome`
// is captured at W x (H - top): the web app renders no device chrome, and the
// reference rows [top, H) are what the candidate must show. Shared by the
// capture (which sets it) and the comparison (which checks the capture
// recorded it). Any other case keeps its viewport.
export function captureViewport(designCase) {
  const chrome = designCase?.deviceChrome;
  if (!chrome) return designCase?.viewport;
  return {
    width: designCase.viewport.width,
    height: designCase.viewport.height - chrome.top,
  };
}
