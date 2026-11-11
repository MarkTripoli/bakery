import {
  assertK0Environment,
  paperBrowserLaunchOptions,
} from "./paper-browser-profile.mjs";
import { viewportBundleRecordIssues } from "./native-viewport-bundle.mjs";
import { verifyK0RasterProfile } from "./paper-k0-raster.mjs";
import {
  wholeArtboardBindingIssues,
  wholeArtboardPairIssues,
} from "./paper-whole-artboard.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  computeSourceIdentity,
  resolveSourceProfile,
} from "./render-paper-references.mjs";
import { comparePngs, pngDimensions } from "./image-score.mjs";
import {
  artifactsDirectoryFor,
  baselinedCases,
  captureViewport,
  debtCases,
  defersScoring,
  isSiteManifest,
  manifestProfile,
  plannedCases,
  readRouteLedger,
} from "./paper-manifests.mjs";
import { enterpriseLaunchOptions } from "./render-enterprise-references.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
// BAKERY_UI_ARTIFACTS_DIR mirrors capture-stories.mjs: the whole artifact
// tree moves together so a relocated capture is compared and reported in the
// same place; CI leaves it unset.
const artifactsDirectory = resolve(
  root,
  process.env.BAKERY_UI_ARTIFACTS_DIR || "artifacts/ui-baseline",
);
// The auth manifest keeps its historical paths; any other manifest writes its
// candidate and report beside them under a manifest-named subdirectory.
const pathsFor = (manifestName = "auth") => {
  const directory = artifactsDirectoryFor(artifactsDirectory, manifestName);
  return {
    candidatePath: join(directory, "runtime/manifest.json"),
    reportDirectory: join(directory, "paper"),
  };
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// K-0 publishes Storybook fixtures, not web routes. Bind both declarations and
// captured URL args to the production runtime registry and catalog.
export function storyCandidateIssues(
  baseline,
  candidate,
  read = (path) => readFileSync(join(root, path)),
) {
  const issues = [];
  const spec = baseline.candidate ?? {};
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return ["invalid Storybook candidate declaration"];
  }
  const validArgs = (args) =>
    args && typeof args === "object" &&
    !Array.isArray(args) && typeof args.state === "string" &&
    args.state.trim() && Object.entries(args).every(([key, value]) =>
      /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) && typeof value === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(value)
    );
  if (typeof spec.storyId !== "string" || !spec.storyId.trim()) {
    issues.push("missing candidate.storyId");
  }
  if (!validArgs(spec.args)) issues.push("invalid candidate.args/state");
  if ("route" in spec || "session" in spec) {
    issues.push("Storybook candidate must not declare route/session");
  }
  const runtime = JSON.parse(
    read("docs/technical-design/ui-baselines/runtime-cases.json").toString(
      "utf8",
    ),
  );
  const catalog = JSON.parse(
    read("docs/technical-design/ui-baselines/components.json").toString("utf8"),
  );
  const matches = runtime.cases.filter((entry) =>
    entry.paperBaselineId === baseline.id
  );
  const binding = matches[0];
  const entry = catalog.entries.find((entry) =>
    entry.id === baseline.catalogId
  );
  const required = entry?.requiredCases.find((entry) =>
    entry.id === baseline.requiredStoryCase
  );
  if (
    matches.length !== 1 || !binding ||
    binding.id !== baseline.requiredStoryCase ||
    binding.requiredCaseId !== baseline.requiredStoryCase ||
    binding.catalogId !== baseline.catalogId ||
    binding.storyId !== spec.storyId ||
    !isDeepStrictEqual(binding.args, spec.args) ||
    binding.sourceProvenance?.pageId !== baseline.pageId ||
    binding.sourceProvenance?.frameId !== baseline.frameId ||
    (required?.baselineIds.length > 0 &&
      !required.baselineIds.includes(baseline.id)) ||
    !required?.states.includes(spec.args?.state) ||
    !entry?.states.includes(spec.args?.state)
  ) {
    issues.push(
      "candidate story/args differs from registered runtime/catalog binding",
    );
  }
  if (candidate) {
    if (
      candidate.kind !== "story" || candidate.storyId !== spec.storyId ||
      candidate.id !== baseline.requiredStoryCase ||
      candidate.requiredCaseId !== baseline.requiredStoryCase ||
      candidate.catalogId !== baseline.catalogId ||
      candidate.paperBaselineId !== baseline.id ||
      "route" in candidate || "session" in candidate ||
      (candidate.args !== undefined &&
        !isDeepStrictEqual(candidate.args, spec.args))
    ) {
      issues.push("captured story differs from candidate binding");
    }
    // Capture records args in storyURL. Do not fabricate new capture metadata.
    try {
      const url = new URL(candidate.storyURL);
      const args = Object.fromEntries(
        (url.searchParams.get("args") ?? "")
          .split(";").map((arg) => arg.split(":")),
      );
      if (
        url.pathname !== "/iframe.html" ||
        url.searchParams.getAll("id").length !== 1 ||
        url.searchParams.get("id") !== spec.storyId ||
        url.searchParams.get("viewMode") !== "story" ||
        url.searchParams.getAll("args").length !== 1 ||
        !validArgs(args) || !isDeepStrictEqual(args, spec.args) ||
        url.searchParams.get("args") !==
          Object.entries(args).map(([k, v]) => `${k}:${v}`).join(";")
      ) {
        issues.push("captured story URL/args differs from candidate binding");
      }
    } catch {
      issues.push("missing or invalid captured story URL");
    }
  }
  return issues;
}

// Specimen cases compare a rendered Storybook contract against a pinned
// reference; every declared input must match the candidate byte-for-byte
// identity fields, including the component/story/token revisions that only
// specimens carry.
export function compatibilityIssues(candidate, baseline) {
  const issues = [];
  const fields = [
    ["viewport", "viewport"],
    ["dpr", "dpr"],
    ["theme", "colorScheme"],
    ["pointer", "pointer"],
    ["locale", "locale"],
    ["direction", "direction"],
    ["fontDigests", "fontDigests"],
    ["tokenRevision", "tokenRevision"],
    ["fixtureRevision", "fixtureRevision"],
    ["browser", "browser"],
    // Text rasterization differs per operating system by more than the parity
    // threshold allows, so a reference image is only comparable on the platform
    // that produced it. Without this the gate reports a low similarity score for
    // a layout that actually matches.
    ["os", "os"],
  ];
  for (const [baselineField, candidateField] of fields) {
    if (baseline[baselineField] === undefined) {
      issues.push(`baseline does not declare ${baselineField}`);
    } else if (
      JSON.stringify(baseline[baselineField]) !==
        JSON.stringify(candidate[candidateField])
    ) {
      issues.push(`${baselineField} differs from candidate`);
    }
  }
  if (baseline.catalogId !== candidate.catalogId) {
    issues.push("catalog ID differs from candidate");
  }
  if (baseline.requiredStoryCase !== candidate.requiredCaseId) {
    issues.push("required story case differs from candidate");
  }
  return issues;
}

// Design cases compare against committed design source. V-0 captures web
// routes; K-0 captures registered Storybook fixtures whose binding is checked
// separately by storyCandidateIssues. Neither compares specimen revisions.
export function designCompatibilityIssues(candidate, baseline) {
  const issues = [];
  if (candidate.sourceProfile !== baseline.sourceProfile) {
    issues.push("sourceProfile differs from candidate");
  }
  if (baseline.sourceProfile !== undefined) {
    try {
      assertK0Environment(candidate);
    } catch (error) {
      issues.push(error.message);
    }
    if (
      !baseline.rasterProfile ||
      JSON.stringify(candidate.rasterProfile) !==
        JSON.stringify(baseline.rasterProfile)
    ) issues.push("rasterProfile differs from candidate");
    const expected = paperBrowserLaunchOptions(baseline);
    for (const record of [baseline, candidate]) {
      if (
        JSON.stringify(record.browserLaunchOptions) !== JSON.stringify(expected)
      ) {
        issues.push("browserLaunchOptions differs from pinned source profile");
      }
    }
    if (
      !baseline.sourceDigest || candidate.sourceDigest !== baseline.sourceDigest
    ) {
      issues.push("sourceDigest differs from candidate");
    }
    if (!candidate.browserVersion) {
      issues.push("candidate does not declare browserVersion");
    }
  }
  const fields = [
    ["viewport", "viewport"],
    ["dpr", "dpr"],
    ["theme", "colorScheme"],
    ["pointer", "pointer"],
    ["locale", "locale"],
    ["direction", "direction"],
    ["fontDigests", "fontDigests"],
    ["browser", "browser"],
    ["os", "os"],
  ];
  for (const [baselineField, candidateField] of fields) {
    // A device-chrome case is captured at W x (H - top), so the viewport the
    // candidate must record is the derived one.
    const expected = baselineField === "viewport"
      ? captureViewport(baseline)
      : baseline[baselineField];
    if (expected === undefined) {
      issues.push(`baseline does not declare ${baselineField}`);
    } else if (
      JSON.stringify(expected) !==
        JSON.stringify(candidate[candidateField])
    ) {
      issues.push(`${baselineField} differs from candidate`);
    }
  }
  return issues;
}

export function parseArguments(argv) {
  const args = {
    candidatePath: undefined,
    cycle: 1,
    maxCycles: 3,
    startedAt: undefined,
    only: [],
    manifestName: "auth",
  };
  let maxCyclesProvided = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--candidate") {
      args.candidatePath = resolve(root, argv[++index]);
    } else if (argument === "--cycle") args.cycle = Number(argv[++index]);
    else if (argument === "--max-cycles") {
      if (maxCyclesProvided) {
        throw new Error("--max-cycles may only be provided once");
      }
      const value = argv[index + 1];
      if (value === undefined || value === "--" || value.startsWith("--")) {
        throw new Error("--max-cycles requires a value");
      }
      maxCyclesProvided = true;
      args.maxCycles = Number(value);
      index++;
    } else if (argument === "--started-at") args.startedAt = argv[++index];
    else if (argument === "--only") args.only.push(argv[++index]);
    else if (argument === "--manifest") {
      args.manifestName = argv[++index];
      manifestProfile(args.manifestName);
    } else throw new Error(`Unknown comparison argument ${argument}`);
  }
  validateCycle(args.cycle, {
    manifestName: args.manifestName,
    maxCycles: args.maxCycles,
  });
  return args;
}

export function validateCycle(
  cycle,
  { maxCycles = 3, manifestName = "auth" } = {},
) {
  if (![3, 4, 5, 6].includes(maxCycles)) {
    throw new Error(`Maximum convergence cycles ${maxCycles} is unsupported`);
  }
  if (!Number.isInteger(cycle)) {
    throw new Error(`Convergence cycle ${cycle} must be a finite integer`);
  }
  if (maxCycles === 3 && ![1, 2, 3].includes(cycle)) {
    throw new Error(
      `Convergence cycle ${cycle} is outside the supported 1..3 budget`,
    );
  }
  if (maxCycles === 4 && !(manifestName === "entitlements" && cycle === 4)) {
    throw new Error(
      "Maximum 4 is supported only for entitlements convergence cycle 4",
    );
  }
  if (maxCycles === 5 && !(manifestName === "entitlements" && cycle === 5)) {
    throw new Error(
      "Maximum 5 is supported only for entitlements convergence cycle 5",
    );
  }
  if (maxCycles === 6 && !(manifestName === "entitlements" && cycle === 6)) {
    throw new Error(
      "Maximum 6 is supported only for entitlements convergence cycle 6",
    );
  }
}

// Device chrome (an excluded top band on phone references) exists only in the
// site-rendered manifests (enterprise, settings). An auth or K-0 case that
// carries it is refused, so the exclusion can never be used to loosen those
// goldens.
export function deviceChromeIssues(baseline, manifestName = "auth") {
  if (isSiteManifest(manifestName)) return [];
  return (baseline.cases ?? []).filter((entry) =>
    entry.deviceChrome !== undefined
  ).map((entry) =>
    `${entry.id}: deviceChrome is only valid in the enterprise manifest`
  );
}

// The renderer module of each site-rendered manifest, behind one interface:
// `checkDesignReferences` re-renders and scores the committed references,
// `closeServer` stops its static server, `schemaIssues` validates the manifest.
const SITE_RENDERERS = {
  artifacts: async () => {
    const module = await import("./render-artifacts-references.mjs");
    return {
      checkDesignReferences: module.checkArtifactsReferences,
      closeServer: module.closeArtifactsServer,
      schemaIssues: module.artifactsSchemaIssues,
    };
  },
  enterprise: async () => {
    const module = await import("./render-enterprise-references.mjs");
    return {
      checkDesignReferences: module.checkEnterpriseReferences,
      closeServer: module.closeEnterpriseServer,
      schemaIssues: module.enterpriseSchemaIssues,
    };
  },
  settings: async () => {
    const module = await import("./render-settings-references.mjs");
    return {
      checkDesignReferences: module.checkSettingsReferences,
      closeServer: module.closeSettingsServer,
      schemaIssues: module.settingsSchemaIssues,
    };
  },
  entitlements: async () => {
    const module = await import("./render-entitlements-references.mjs");
    return {
      checkDesignReferences: module.checkEntitlementsReferences,
      closeServer: module.closeEntitlementsServer,
      schemaIssues: module.entitlementsSchemaIssues,
    };
  },
  "worker-dark": async () => {
    const module = await import("./render-worker-dark-references.mjs");
    return {
      checkDesignReferences: module.checkWorkerDarkReferences,
      closeServer: module.closeWorkerDarkServer,
      schemaIssues: module.workerDarkSchemaIssues,
    };
  },
};

function siteRenderer(manifestName) {
  const load = SITE_RENDERERS[manifestName];
  if (!load) {
    throw new Error(`manifest "${manifestName}" has no site renderer`);
  }
  return load();
}

// A site-rendered design case whose candidate is a Storybook story scored by
// its whole-artboard element (design-cases.ts StoryCandidateSchema). Only
// site-rendered manifests admit it; auth and K-0 stories keep their pinned
// source-profile path.
export function isSiteStoryCase(baseline) {
  return baseline?.sourceProfile === undefined &&
    typeof baseline?.candidate?.storyId === "string" &&
    baseline.candidate.wholeArtboard !== undefined;
}

// Binds a captured site story record to its case: same story and args in the
// captured URL, same whole-artboard selectors and reduced motion, a stored
// preference equal to the theme, and an artboard image whose bytes and size
// are the ones recorded.
export async function siteStoryCandidateIssues(baseline, candidate) {
  const issues = [];
  const spec = baseline.candidate ?? {};
  const artboard = candidate.storyArtboard ?? {};
  if (
    candidate.kind !== "story" || candidate.storyId !== spec.storyId ||
    candidate.paperBaselineId !== baseline.id
  ) issues.push("captured story differs from candidate binding");
  try {
    const url = new URL(candidate.storyURL);
    const expectedArgs = Object.entries(spec.args ?? {}).map(([key, value]) =>
      `${key}:${value}`
    ).join(";");
    if (
      url.pathname !== "/iframe.html" ||
      url.searchParams.getAll("id").length !== 1 ||
      url.searchParams.get("id") !== spec.storyId ||
      url.searchParams.get("viewMode") !== "story" ||
      (url.searchParams.get("args") ?? "") !== expectedArgs
    ) issues.push("captured story URL/args differs from candidate binding");
  } catch {
    issues.push("missing or invalid captured story URL");
  }
  if (
    candidate.reducedMotion !== spec.reducedMotion ||
    candidate.storedPreference !== baseline.theme
  ) issues.push("captured story context differs from candidate binding");
  if (
    artboard.targetSelector !== spec.wholeArtboard?.targetSelector ||
    artboard.qualificationSelector !==
      spec.wholeArtboard?.qualificationSelector
  ) issues.push("captured whole-artboard selectors differ from the case");
  const parity = artboard.parity;
  if (!parity?.path) {
    issues.push("captured story has no whole-artboard image");
    return issues;
  }
  try {
    const bytes = await readFile(join(root, parity.path));
    const size = pngDimensions(bytes);
    if (sha256(bytes) !== parity.sha256) {
      issues.push("whole-artboard image digest changed");
    }
    if (
      size.width !== parity.width || size.height !== parity.height ||
      size.width !== baseline.artboard?.width ||
      size.height !== baseline.artboard?.height
    ) issues.push("whole-artboard image is not the artboard size");
  } catch {
    issues.push("whole-artboard image is missing");
  }
  return issues;
}

export function baselineMetadataIssues(
  manifest,
  read,
  { siteStories = false } = {},
) {
  const issues = [];
  if (manifest.schemaVersion !== 2) {
    issues.push("unsupported Paper baseline schema version");
  }
  const source = manifest.source ?? {};
  if (
    !source.fileId || !source.pageId || !source.manifestPath ||
    !source.revision || !/^[a-f0-9]{64}$/.test(source.digest ?? "") ||
    !Array.isArray(source.inputs) || !source.inputs.length
  ) {
    issues.push(
      "Paper source metadata must include an immutable SHA-256 digest",
    );
  }
  const reference = manifest.reference ?? {};
  if (!Array.isArray(reference.hidden)) {
    issues.push("Paper baseline reference.hidden must be an array");
  }
  if (
    reference.overrides !== undefined &&
    (typeof reference.overrides !== "object" || reference.overrides === null ||
      Array.isArray(reference.overrides))
  ) {
    issues.push("Paper baseline reference.overrides must be an object");
  }
  if (
    reference.capabilities !== undefined && reference.capabilities !== "core"
  ) {
    issues.push('Paper baseline reference.capabilities must be "core"');
  }
  if (
    reference.derived !== undefined &&
    (!Array.isArray(reference.derived) ||
      reference.derived.some((screen) => typeof screen !== "string"))
  ) {
    issues.push(
      "Paper baseline reference.derived must be an array of screen ids",
    );
  }
  if (reference.derived !== undefined && reference.capabilities === undefined) {
    issues.push(
      "Paper baseline reference.derived requires reference.capabilities",
    );
  }
  if (!Array.isArray(manifest.cases) || !manifest.cases.length) {
    issues.push("Paper baseline has no cases");
  }
  const ids = new Set();
  for (const baseline of manifest.cases ?? []) {
    if (!baseline.id || ids.has(baseline.id)) {
      issues.push(`duplicate or blank Paper baseline ID ${baseline.id ?? ""}`);
    }
    ids.add(baseline.id);
    if (baseline.reference !== "design" && baseline.reference !== "specimen") {
      issues.push(
        `${baseline.id ?? "Paper case"} has an unsupported reference kind`,
      );
    }
    if (
      !baseline.imagePath || !/^[a-f0-9]{64}$/.test(baseline.imageSha256 ?? "")
    ) {
      issues.push(
        `${baseline.id ?? "Paper case"} lacks immutable image metadata`,
      );
    }
    for (const field of ["frameId", "pageId"]) {
      if (typeof baseline[field] !== "string" || !baseline[field].trim()) {
        issues.push(`${baseline.id ?? "Paper case"} lacks ${field}`);
      }
    }
    issues.push(
      ...wholeArtboardBindingIssues(baseline).map((issue) =>
        `${baseline.id}: ${issue}`
      ),
    );
    const siteStory = siteStories && isSiteStoryCase(baseline);
    if (
      baseline.candidate?.storyId && !siteStory &&
      (baseline.comparisonRegion || baseline.comparisonMask ||
        !baseline.sourceProfile)
    ) {
      issues.push(
        `${baseline.id}: source-shaped story requires an explicit profile and an unmasked full frame`,
      );
    }
    if (baseline.pageId === "K-0" && baseline.sourceProfile !== "K-0") {
      issues.push(`${baseline.id}: missing K-0 source profile`);
    }
    const region = baseline.comparisonRegion;
    if (
      region !== undefined &&
      (!Number.isInteger(region.x) || !Number.isInteger(region.y) ||
        !Number.isInteger(region.width) || !Number.isInteger(region.height) ||
        region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0)
    ) {
      issues.push(
        `${baseline.id ?? "Paper case"} has an invalid comparison region`,
      );
    }
    if (
      region?.candidateOrigin !== undefined &&
      region.candidateOrigin !== "main"
    ) {
      issues.push(
        `${
          baseline.id ?? "Paper case"
        } comparison region candidateOrigin must be "main"`,
      );
    }
    if (
      region?.measure !== undefined &&
      (typeof region.measure !== "string" || !region.measure.trim())
    ) {
      issues.push(
        `${
          baseline.id ?? "Paper case"
        } comparison region measure must be a selector`,
      );
    }
    if (baseline.comparisonMask !== undefined) {
      issues.push(
        `${baseline.id ?? "Paper case"} declares an unsupported comparisonMask`,
      );
    }
    if (baseline.reference === "specimen") {
      for (const field of ["catalogId", "requiredStoryCase"]) {
        if (typeof baseline[field] !== "string" || !baseline[field].trim()) {
          issues.push(`${baseline.id ?? "Paper case"} lacks ${field}`);
        }
      }
    } else if (baseline.reference === "design") {
      const design = baseline.design ?? {};
      for (const field of ["screen", "state", "theme", "device"]) {
        if (typeof design[field] !== "string" || !design[field].trim()) {
          issues.push(`${baseline.id ?? "Paper case"} lacks design.${field}`);
        }
      }
      const artboard = baseline.artboard ?? {};
      if (
        !Number.isInteger(artboard.width) ||
        !Number.isInteger(artboard.height) ||
        artboard.width <= 0 || artboard.height <= 0
      ) {
        issues.push(
          `${baseline.id ?? "Paper case"} lacks a valid artboard size`,
        );
      }
      const candidateSpec = baseline.candidate ?? {};
      if (baseline.sourceProfile === "K-0") {
        issues.push(
          ...storyCandidateIssues(baseline, undefined, read).map((issue) =>
            `${baseline.id}: ${issue}`
          ),
        );
      } else if (siteStory) {
        if (baseline.comparisonRegion || baseline.deviceChrome) {
          issues.push(
            `${baseline.id}: a story candidate is scored by its whole-artboard element only`,
          );
        }
      } else {
        if (baseline.sourceProfile !== undefined) {
          issues.push(`${baseline.id}: unsupported sourceProfile`);
        }
        if (
          typeof candidateSpec.route !== "string" || !candidateSpec.route.trim()
        ) {
          issues.push(`${baseline.id ?? "Paper case"} lacks candidate.route`);
        }
        if (
          candidateSpec.session !== "anonymous" &&
          candidateSpec.session !== "authenticated"
        ) {
          issues.push(
            `${baseline.id ?? "Paper case"} lacks a valid candidate.session`,
          );
        }
      }
    }
  }
  for (const excluded of manifest.excluded ?? []) {
    for (const field of ["screen", "state", "reason"]) {
      if (typeof excluded[field] !== "string" || !excluded[field].trim()) {
        issues.push(`excluded entry lacks ${field}`);
      }
    }
  }
  return issues;
}

export function sourceRefreshed(manifest, baseManifest) {
  return manifest?.source?.revision !== baseManifest?.source?.revision &&
    manifest?.source?.digest !== baseManifest?.source?.digest;
}

export function baselineMutationIssues(manifest, baseManifest) {
  if (sourceRefreshed(manifest, baseManifest)) return [];
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left.localeCompare(right)
        )
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return value;
  };
  const sameCase = (current, previous) =>
    JSON.stringify(normalize(current)) === JSON.stringify(normalize(previous));
  const baseCases = new Map(
    (baseManifest.cases ?? []).map((baseline) => [baseline.id, baseline]),
  );
  const currentCases = new Map(
    (manifest.cases ?? []).map((baseline) => [baseline.id, baseline]),
  );
  const issues = (manifest.cases ?? []).flatMap((baseline) => {
    const previous = baseCases.get(baseline.id);
    if (!previous) {
      return [
        `${baseline.id} added without refreshed immutable Paper source identity`,
      ];
    }
    return sameCase(baseline, previous) ? [] : [
      `${baseline.id} metadata changed without refreshed immutable Paper source identity`,
    ];
  });
  for (const id of baseCases.keys()) {
    if (!currentCases.has(id)) {
      issues.push(
        `${id} removed without refreshed immutable Paper source identity`,
      );
    }
  }
  return issues;
}

// Only a manifest committed before this branch is an independent predecessor.
// The first branch manifest carrying both refreshed source identity fields is
// used on top of it so that one legitimate source refresh cannot license
// unlimited later edits under the same refreshed identity. An unrefreshed first
// branch commit must remain compared with the merge-base manifest.
export function predecessorManifest(baseManifest, firstBranchManifest) {
  if (!baseManifest) return null;
  if (
    firstBranchManifest &&
    sourceRefreshed(firstBranchManifest, baseManifest)
  ) {
    return firstBranchManifest;
  }
  return baseManifest;
}
// A baseline that has no predecessor is being introduced, not mutated. There is
// nothing for automation to compare it against, so the report records that
// fact instead of claiming verification or blocking a change that can never
// gain a predecessor.
export function baselineProvenance(manifest, predecessor) {
  if (hasProfiles(manifest) || hasProfiles(predecessor)) {
    return {
      status: "blocked",
      issues: ["Profile provenance requires trusted repository history"],
    };
  }
  if (!predecessor) {
    return {
      status: "introduced",
      notes: [
        "Paper baseline has no predecessor on the merge base, so this run compares a first introduction; the pinned source identity and reference images carry only the approval of the humans who review this branch",
      ],
    };
  }
  const issues = baselineMutationIssues(manifest, predecessor);
  return issues.length ? { status: "blocked", issues } : { status: "passed" };
}

function hasProfiles(manifest) {
  return manifest?.sourceProfiles !== undefined ||
    manifest?.cases?.some((entry) => entry.sourceProfile !== undefined);
}

// Retain exact JSON value spans, including whitespace/key order. JSON.parse
// alone would silently discard duplicate keys and cannot freeze original bytes.
function provenanceDocument(bytes) {
  const text = bytes.toString("utf8");
  const manifest = JSON.parse(text);
  const spans = new Map();
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? "x")) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (text[cursor] !== '"') {
      if (text[cursor] === "\\") cursor++;
      cursor++;
    }
    return JSON.parse(text.slice(start, ++cursor));
  };
  const value = (path) => {
    whitespace();
    const start = cursor;
    if (text[cursor] === "{") {
      cursor++;
      whitespace();
      const keys = new Set();
      while (text[cursor] !== "}") {
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        cursor++; // colon; JSON.parse already verified grammar
        value([...path, key]);
        whitespace();
        if (text[cursor] !== ",") break;
        cursor++;
        whitespace();
      }
      cursor++;
    } else if (text[cursor] === "[") {
      cursor++;
      whitespace();
      let index = 0;
      while (text[cursor] !== "]") {
        value([...path, index++]);
        whitespace();
        if (text[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (text[cursor] === '"') string();
    else {
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
    }
    spans.set(JSON.stringify(path), text.slice(start, cursor));
  };
  value([]);
  return { manifest, span: (...path) => spans.get(JSON.stringify(path)) };
}

function sourcePath(path) {
  if (
    typeof path !== "string" || !path || path.startsWith("/") ||
    path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Invalid repository source path");
  return path;
}

function requireProvenance(condition, message) {
  if (!condition) throw new Error(message);
}

// A V-0 refresh is genuine only when the snapshot's declared identity is bound
// to its own V-0 input bytes: the digest is recomputed from `source.inputs` as
// the V-0 renderer does (no browser launch options), must differ from the
// lineage's V-0 digest, and the revision must follow the bound pattern
// `paper:<sha8(manifestPath)>; mock:<digest8>; rendered:<date>`. Returns the
// reason a snapshot is not a refresh, or "" when it is one.
function v0RefreshIssue(snapshot, lineage) {
  try {
    const { manifest, read } = snapshot;
    const { source } = manifest;
    if (
      !source || typeof source.digest !== "string" ||
      typeof source.revision !== "string" ||
      typeof source.manifestPath !== "string" ||
      !Array.isArray(source.inputs) ||
      new Set(source.inputs).size !== source.inputs.length ||
      !source.inputs.includes(source.manifestPath)
    ) return "the V0 source identity is malformed";
    const material = source.inputs.map((path) =>
      `${path}\0${sha256(read(sourcePath(path)))}\n`
    );
    const digest = sha256(material.join(""));
    if (source.digest !== digest) {
      return "the declared V0 digest does not match the V0 input bytes";
    }
    if (!lineage.manifest) return "no V0 identity exists to refresh";
    if (source.digest === lineage.manifest.source?.digest) {
      return "the V0 digest is unchanged from the merge base";
    }
    const prefix = `paper:${
      sha256(read(sourcePath(source.manifestPath))).slice(0, 8)
    }; mock:${digest.slice(0, 8)}; rendered:`;
    if (
      !source.revision.startsWith(prefix) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.revision.slice(prefix.length))
    ) return "the V0 revision is not bound to the V0 input bytes";
    return "";
  } catch (error) {
    return `the V0 identity cannot be verified (${
      error instanceof Error ? error.message.split("\n")[0] : String(error)
    })`;
  }
}

function profileBindings(snapshot, name, original) {
  const { manifest, read } = snapshot;
  const profile = resolveSourceProfile(manifest, { sourceProfile: name });
  const { source } = profile;
  const revisionPrefix = `paper:${
    sha256(read(source.manifestPath)).slice(0, 8)
  }; mock:${source.digest.slice(0, 8)}; rendered:`;
  requireProvenance(
    source.revision.startsWith(revisionPrefix) &&
      /^\d{4}-\d{2}-\d{2}$/.test(source.revision.slice(revisionPrefix.length)),
    `${name}: revision binding mismatch`,
  );
  requireProvenance(
    Array.isArray(source.inputs) &&
      new Set(source.inputs).size === source.inputs.length &&
      source.inputs.includes(source.manifestPath),
    `${name}: missing or duplicate pinned source inputs`,
  );
  const inputs = new Set(source.inputs.map(sourcePath));
  const material = source.inputs.map((path) =>
    `${path}\0${sha256(read(path))}\n`
  );
  material.push(
    `browserLaunchOptions\0${
      JSON.stringify(paperBrowserLaunchOptions({ sourceProfile: name }))
    }\n`,
  );
  requireProvenance(
    sha256(material.join("")) === source.digest,
    `${name}: source digest mismatch`,
  );
  requireProvenance(
    Array.isArray(original.inputs) && original.inputs.length &&
      Array.isArray(original.screens),
    `${name}: malformed export manifest`,
  );
  const pins = new Map();
  for (const input of original.inputs) {
    const path = sourcePath(
      `${dirname(source.manifestPath)}/${sourcePath(input.path)}`,
    );
    requireProvenance(
      !pins.has(path) && inputs.has(path) &&
        /^[a-f0-9]{64}$/.test(input.sha256 ?? ""),
      `${name}: missing or duplicate export pin`,
    );
    requireProvenance(
      sha256(read(path)) === input.sha256,
      `${name}: original input digest mismatch: ${path}`,
    );
    pins.set(path, input.sha256);
  }
  const frames = new Map();
  for (const frame of original.screens) {
    requireProvenance(
      typeof frame.nodeId === "string" && frame.nodeId &&
        !frames.has(frame.nodeId),
      `${name}: duplicate or missing original frame ID`,
    );
    frames.set(frame.nodeId, frame);
  }
  const fonts = Object.fromEntries(
    [...pins].filter(([path]) => /\.(ttf|woff2?)$/.test(path)),
  );
  requireProvenance(
    Object.keys(fonts).length > 0,
    `${name}: missing font pins`,
  );
  for (
    const entry of manifest.cases.filter((item) => item.sourceProfile === name)
  ) {
    const frame = frames.get(entry.frameId);
    requireProvenance(
      frame && frame.exactFrameEligible === true,
      `${entry.id}: unknown original frame`,
    );
    const imagePath = sourcePath(
      `${dirname(source.manifestPath)}/${sourcePath(frame.imagePath)}`,
    );
    const cssPath = sourcePath(
      `${dirname(source.manifestPath)}/${sourcePath(frame.sourcePath)}`,
    );
    const size = { width: frame.width, height: frame.height };
    requireProvenance(
      pins.has(cssPath) && pins.has(imagePath) &&
        entry.imagePath === imagePath &&
        entry.imageSha256 === pins.get(imagePath) &&
        entry.pageId === source.pageId &&
        entry.sourceDigest === source.digest && entry.dpr === 1 &&
        isDeepStrictEqual(entry.design, {
          screen: frame.id,
          state: frame.state,
          theme: frame.theme,
          device: frame.device,
        }) &&
        entry.theme === frame.theme &&
        isDeepStrictEqual(entry.artboard, size) &&
        isDeepStrictEqual(entry.image, size) &&
        isDeepStrictEqual(entry.viewport, size) &&
        isDeepStrictEqual(pngDimensions(read(imagePath)), size) &&
        isDeepStrictEqual(entry.fontDigests, fonts),
      `${entry.id}: original PNG/React-CSS/frame/render binding mismatch`,
    );
  }
}

// The repository is the authority for absence/history, never a caller-supplied
// null predecessor or an ignored task ledger. Options support isolated Git tests.
export function repositoryBaselineProvenance({
  repositoryRoot = root,
  baselinePath = manifestProfile("auth").baselinePath,
  comparisonRef = process.env.PAPER_BASE_REF ??
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : "origin/main"),
} = {}) {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    requireProvenance(
      git(["rev-parse", "--is-shallow-repository"]) === "false",
      "Incomplete shallow provenance history",
    );
    const bases = git(["merge-base", "--all", "HEAD", comparisonRef]).split(
      "\n",
    );
    requireProvenance(
      bases.length === 1 && /^[a-f0-9]{40}$/.test(bases[0]),
      "Ambiguous or unavailable provenance merge base",
    );
    const baseCommit = bases[0];
    const path = relative(root, baselinePath).replaceAll("\\", "/");
    const snapshotAt = (commit) => {
      const cache = new Map();
      const read = (input) => {
        sourcePath(input);
        if (!cache.has(input)) {
          cache.set(
            input,
            commit === null
              ? readFileSync(join(repositoryRoot, input))
              : execFileSync("git", ["show", `${commit}:${input}`], {
                cwd: repositoryRoot,
                maxBuffer: 256 * 1024 * 1024,
                stdio: ["ignore", "pipe", "pipe"],
              }),
          );
        }
        return cache.get(input);
      };
      if (
        commit !== null && !git(["ls-tree", "--name-only", commit, "--", path])
      ) return { commit, manifest: null };
      return { ...provenanceDocument(read(path)), read, commit };
    };
    const base = snapshotAt(baseCommit);
    const commits = git([
      "rev-list",
      "--reverse",
      "--topo-order",
      `${baseCommit}..HEAD`,
    ]).split("\n").filter(Boolean);
    const history = commits.map(snapshotAt);
    const current = snapshotAt(null);
    const snapshots = [base, ...history, current];
    if (!snapshots.some((snapshot) => hasProfiles(snapshot.manifest))) {
      const identity = (manifest) =>
        JSON.stringify([manifest?.source?.revision, manifest?.source?.digest]);
      const first = history.find((snapshot) =>
        snapshot.manifest &&
        identity(snapshot.manifest) === identity(current.manifest)
      );
      return {
        ...baselineProvenance(
          current.manifest,
          predecessorManifest(base.manifest, first?.manifest),
        ),
        baseCommit,
      };
    }
    // Per-lineage first appearance. A branch that merges main has snapshots
    // that predate the merge: they descend from their own main lineage, not
    // from the (newer) merge base, so main-authored profile bytes arrive
    // legitimately "after" them. Judge each snapshot against the lineage
    // reference L: the merge base itself when the snapshot descends from it,
    // else merge-base(snapshot, baseCommit). If L carries the profile or the
    // legacy objects, the snapshot must equal L byte for byte, so in-branch
    // edits on the pre-merge lineage still block even if later reverted. If L
    // lacks them the snapshot is an in-branch introduction and is tracked in
    // `appearances` / `legacyIntros`; only descendants compare to it. Bytes
    // never change along one lineage except by a merge that brings main's.
    const appearances = [];
    const legacyIntros = [];
    let legacyRefresh = null;
    const seen = new Set();
    const pageOwners = new Map();
    const follows = (first, next) => {
      if (next === null || first === next) return true;
      try {
        git(["merge-base", "--is-ancestor", first, next]);
        return true;
      } catch (error) {
        if (error.status === 1) return false;
        throw error;
      }
    };
    const lineageSnapshots = new Map();
    const lineageOf = (commit) => {
      if (commit === null || follows(baseCommit, commit)) return base;
      const point = git(["merge-base", commit, baseCommit]);
      if (!lineageSnapshots.has(point)) {
        lineageSnapshots.set(
          point,
          history.find((item) => item.commit === point) ?? snapshotAt(point),
        );
      }
      return lineageSnapshots.get(point);
    };
    const legacyBytesOf = ({ manifest, span }) =>
      JSON.stringify([
        Object.keys(manifest).filter((key) =>
          key !== "cases" && key !== "sourceProfiles"
        ).sort().map((key) => [key, span(key)]),
        manifest.cases.flatMap((item, index) =>
          item.sourceProfile === undefined ? [span("cases", index)] : []
        ),
      ]);
    const profileBytesOf = ({ manifest, span }, name) =>
      JSON.stringify([
        span("sourceProfiles", name),
        manifest.cases.flatMap((entry, index) =>
          entry.sourceProfile === name ? [span("cases", index)] : []
        ),
      ]);
    const profileIdentityOf = ({ manifest, read }, name) => {
      const source = manifest.sourceProfiles[name].source;
      return JSON.stringify([
        source.fileId,
        source.pageId,
        sha256(read(sourcePath(source.manifestPath))),
      ]);
    };
    const legacyPage = (manifest) =>
      JSON.stringify([manifest.source.fileId, manifest.source.pageId]);
    for (const snapshot of snapshots) {
      const { manifest, read, commit } = snapshot;
      const lineage = lineageOf(commit);
      const lineageDefinitions = lineage.manifest?.sourceProfiles;
      const lineageHasProfiles = lineageDefinitions &&
        typeof lineageDefinitions === "object" &&
        !Array.isArray(lineageDefinitions);
      if (!manifest) {
        requireProvenance(
          !lineage.manifest &&
            !legacyIntros.some((item) => follows(item.commit, commit)),
          "Provenance manifest disappeared from branch history",
        );
        continue;
      }
      requireProvenance(
        Array.isArray(manifest.cases),
        "Malformed provenance cases",
      );
      const metadata = baselineMetadataIssues(manifest, read);
      requireProvenance(
        !metadata.length,
        `Invalid provenance metadata: ${metadata.join("; ")}`,
      );
      const definitions = manifest.sourceProfiles === undefined
        ? {}
        : manifest.sourceProfiles;
      requireProvenance(
        definitions && typeof definitions === "object" &&
          !Array.isArray(definitions),
        "Malformed source profiles",
      );
      const names = new Set([
        ...Object.keys(definitions),
        ...manifest.cases.filter((item) => item.sourceProfile !== undefined)
          .map((item) => item.sourceProfile),
      ]);
      const legacyBytes = legacyBytesOf(snapshot);
      const legacyReference = lineage.manifest
        ? legacyBytesOf(lineage)
        : legacyIntros.find((item) => follows(item.commit, commit))?.bytes;
      if (legacyReference === undefined) {
        legacyIntros.push({ commit, bytes: legacyBytes });
      }
      // V-0 objects stay frozen except for one input-bound refresh per branch.
      // Snapshots following the refresh commit must carry the refreshed bytes.
      const refreshed = legacyRefresh && follows(legacyRefresh.commit, commit);
      const expectedLegacy = refreshed
        ? legacyRefresh.bytes
        : legacyReference ?? legacyBytes;
      if (legacyBytes !== expectedLegacy) {
        const issue = legacyRefresh
          ? "a V0 refresh already exists on this branch"
          : v0RefreshIssue(snapshot, lineage);
        requireProvenance(
          !issue,
          `Existing V0 objects or top-level settings changed: ${issue}`,
        );
        legacyRefresh = { commit, bytes: legacyBytes };
      }
      // Snapshots descending from the merge base share one ownership map;
      // pre-merge snapshots only answer to their own page claims.
      const owners = lineage === base ? pageOwners : new Map();
      if (!owners.has(legacyPage(manifest))) {
        owners.set(legacyPage(manifest), "legacy");
      }
      for (
        const entry of manifest.cases.filter((item) =>
          item.sourceProfile === undefined
        )
      ) {
        requireProvenance(
          sha256(read(sourcePath(entry.imagePath))) === entry.imageSha256,
          `${entry.id}: existing reference bytes changed`,
        );
      }
      if (lineageHasProfiles) {
        for (const name of Object.keys(lineageDefinitions)) {
          requireProvenance(
            names.has(name),
            `${name}: profile removed or renamed`,
          );
        }
      }
      for (const first of appearances) {
        requireProvenance(
          names.has(first.name) || !follows(first.commit, commit),
          `${first.name}: profile removed or renamed`,
        );
      }
      // Reserve page ownership before validating supported renderers: aliases
      // cannot mint a license, even with a new export SHA or disjoint case IDs.
      const resolved = new Map();
      for (const name of names) {
        const definition = definitions[name];
        requireProvenance(
          typeof name === "string" && definition?.source,
          `${name}: dangling or malformed profile appearance`,
        );
        const source = definition.source;
        requireProvenance(
          typeof source.fileId === "string" && source.fileId &&
            typeof source.pageId === "string" && source.pageId,
          `${name}: missing original Paper identity`,
        );
        const exportBytes = read(sourcePath(source.manifestPath));
        const original = provenanceDocument(exportBytes).manifest;
        requireProvenance(
          original.fileId === source.fileId &&
            original.pageId === source.pageId,
          `${name}: export file/page identity mismatch`,
        );
        const page = JSON.stringify([source.fileId, source.pageId]);
        requireProvenance(
          !owners.has(page) || owners.get(page) === name,
          `${name}: Paper page already owned by ${owners.get(page)}`,
        );
        owners.set(page, name);
        resolved.set(name, {
          original,
          identity: JSON.stringify([
            source.fileId,
            source.pageId,
            sha256(exportBytes),
          ]),
        });
      }
      for (const [name, { original, identity }] of resolved) {
        const bytes = profileBytesOf(snapshot, name);
        seen.add(name);
        const first = lineageHasProfiles &&
            Object.hasOwn(lineageDefinitions, name)
          ? {
            identity: profileIdentityOf(lineage, name),
            bytes: profileBytesOf(lineage, name),
          }
          : appearances.find((item) =>
            item.name === name && follows(item.commit, commit)
          );
        if (first) {
          requireProvenance(
            identity === first.identity,
            `${name}: in-branch original export identity changed`,
          );
          requireProvenance(
            bytes === first.bytes,
            `${name}: first-introduction inventory or metadata changed`,
          );
        }
        // A second, unrelated in-branch introduction has no lineage to anchor
        // it; only main's own copy (the merge base) may coexist with one.
        requireProvenance(
          first ||
            !appearances.some((item) =>
              item.name === name && item.commit !== baseCommit
            ),
          `${name}: ambiguous first profile appearance`,
        );
        profileBindings(snapshot, name, original);
        if (!first) appearances.push({ name, identity, bytes, commit });
      }
    }
    const profiles = Object.fromEntries(
      [...seen].map((
        name,
      ) => [
        name,
        Object.hasOwn(base.manifest?.sourceProfiles ?? {}, name)
          ? "passed"
          : "introduced",
      ]),
    );
    const introduced = Object.entries(profiles).filter(([, status]) =>
      status === "introduced"
    ).map(([name]) => name);
    return {
      status: introduced.length ? "introduced" : "passed",
      baseCommit,
      profiles: {
        legacy: base.manifest ? "passed" : "introduced",
        ...profiles,
      },
      ...(introduced.length
        ? {
          notes: [
            `Paper profiles ${
              introduced.join(", ")
            } are first introductions on this branch; history and original bytes are checked, not human design approval. Branch review and all downstream gates remain required.`,
          ],
        }
        : {}),
    };
  } catch (error) {
    return {
      status: "blocked",
      issues: [
        `Paper profile provenance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

// Verifies the manifest's pinned digest still matches the actual bytes of the
// design source it claims to describe. Independent of any render: this alone
// proves the recorded `source.digest` was not fabricated or left stale after
// the auth-mocks were edited.
export async function sourceDigestIssues(manifest) {
  const selections = [
    {},
    ...[
      ...new Set(
        (manifest.cases ?? []).filter((entry) =>
          entry.reference === "design" && entry.sourceProfile !== undefined
        ).map((entry) => entry.sourceProfile),
      ),
    ].map((sourceProfile) => ({ sourceProfile })),
  ];
  const issues = [];
  for (const selection of selections) {
    try {
      const { source } = resolveSourceProfile(manifest, selection);
      if (!Array.isArray(source?.inputs) || !source.inputs.length) continue;
      const identity = await computeSourceIdentity(manifest, selection);
      if (selection.sourceProfile !== undefined) {
        for (const entry of manifest.cases ?? []) {
          if (
            entry.sourceProfile === selection.sourceProfile &&
            entry.sourceDigest !== source.digest
          ) {
            issues.push(
              `${entry.id}: sourceDigest differs from source profile`,
            );
          }
        }
      }
      if (identity.digest !== source.digest) {
        issues.push(
          `${
            selection.sourceProfile ? `${selection.sourceProfile}: ` : ""
          }Paper source digest does not match the pinned inputs listed in source.inputs`,
        );
      }
    } catch (error) {
      issues.push(
        `Paper source inputs are unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return issues;
}

// Everything that produces or pins a design reference: the manifest's own
// source inputs, the manifest, the committed PNGs, and the two scripts that
// render and score them. A pull request that touches none of these compares
// against exactly the references its base already proved by re-rendering
// them (every main push re-renders; a reference can only enter main through
// a pull request that changed one of these paths and therefore re-rendered).
export function designReferenceInputs(baseline, manifestName = "auth") {
  const profile = manifestProfile(manifestName);
  return new Set([
    ...(baseline.source?.inputs ?? []),
    ...(manifestName === "auth" ? [] : [
      "packages/ui/scripts/paper-jsx-to-html.mjs",
    ]),
    ...(baseline.cases ?? []).filter((entry) =>
      entry.reference === "design" && entry.sourceProfile !== undefined
    ).flatMap((entry) => resolveSourceProfile(baseline, entry).source.inputs),
    profile.baselineRepoPath,
    ...(baseline.cases ?? []).flatMap((entry) =>
      entry.reference === "design" && entry.imagePath ? [entry.imagePath] : []
    ),
    "packages/ui/scripts/render-paper-references.mjs",
    "packages/ui/scripts/image-score.mjs",
  ]);
}

// The base commit whose re-render may stand in for this run's, or null when
// the run must re-render itself: no base was given (a main push), or the
// committed or working-tree changes touch a reference input.
export function referenceRenderProvedAt(
  baseline,
  baseSha = process.env.BAKERY_CAPTURE_BASE_SHA,
  git = execFileSync,
  manifestName = "auth",
) {
  if (!baseSha) return null;
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error("BAKERY_CAPTURE_BASE_SHA_INVALID");
  }
  // Rendering reads ignored inputs too. Bound untracked discovery to literal
  // reference-input pathspecs, without applying Git's ignore exclusions.
  // NUL delimiters keep unusual file names intact; discovery errors fail closed.
  const inputs = designReferenceInputs(baseline, manifestName);
  const changed = [
    ["diff", "--name-only", "-z", `${baseSha}...HEAD`],
    ["diff", "--name-only", "-z", "HEAD"],
    [
      "ls-files",
      "--others",
      "-z",
      "--",
      ...[...inputs].map((path) => `:(top,literal)${path}`),
    ],
  ].flatMap((args) =>
    git("git", args, { cwd: root, encoding: "utf8" }).split("\0")
      .filter(Boolean).map((path) => path.replaceAll("\\", "/"))
  );
  return changed.some((path) => inputs.has(path)) ? null : baseSha;
}

// Producer diagnostics only. No renderer settings, reference bytes, thresholds,
// verdicts or trusted-verifier inputs are derived from these observations.
export function paperRasterDiagnostics(results, run = spawnSync) {
  const probe = (command, args) => {
    try {
      const result = run(command, args, {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0) {
        return { status: "unavailable", exitCode: result.status ?? null };
      }
      return {
        status: "observed",
        output: (result.stdout || result.stderr || "").slice(0, 4096),
      };
    } catch {
      return { status: "unavailable", exitCode: null };
    }
  };
  return {
    purpose: "read-only diagnostics; not acceptance or trusted score inputs",
    images: "omitted: trusted ui_paper archive permits JSON artifacts only",
    os: {
      platform: process.platform,
      arch: process.arch,
      kernel: probe("uname", ["-sr"]),
      distribution: probe("lsb_release", ["-ds"]),
    },
    versions: {
      fontconfig: probe("fc-match", ["-V"]),
      freetypePkgConfig: probe("pkg-config", ["--modversion", "freetype2"]),
      installedPackages: probe("dpkg-query", [
        "--show",
        "--showformat=${binary:Package}=${Version}\\n",
        "fontconfig",
        "libfontconfig1",
        "libfreetype6",
      ]),
    },
    fonts: ["sans-serif", "monospace", "system-ui"].map((pattern) => ({
      pattern,
      fields: ["family", "file", "hintstyle", "rgba"],
      resolved: probe("fc-match", [
        "--format=%{family}\\t%{file}\\t%{hintstyle}\\t%{rgba}\\n",
        pattern,
      ]),
    })),
    referenceComparisons: [
      "list.default.light.desktop",
      "list.default.dark.desktop",
      "detail.default.light.desktop",
    ].map((id) => {
      const result = results.find((entry) => entry.id === id);
      return {
        id,
        compared: Number.isFinite(result?.score),
        ...Object.fromEntries([
          "score",
          "inkScore",
          "surfaceScore",
          "inkCoverage",
          "surfaceCoverage",
        ].map((key) => [
          key,
          Number.isFinite(result?.[key]) ? result[key] : null,
        ])),
      };
    }),
  };
}

// Design references are only honest if a fresh, deterministic render of the
// pinned design source still matches the committed reference PNGs. That check
// re-renders every design case using the existing reference renderer.
async function designReferenceIssues(
  baseline,
  browser,
  referenceResults,
  manifestName = "auth",
) {
  const hasDesignCases = (baseline.cases ?? []).some((entry) =>
    entry.reference === "design"
  );
  if (!hasDesignCases) return [];
  let checkDesignReferences;
  let closeServer;
  try {
    // Site-rendered manifests (enterprise, settings) have their own renderers;
    // auth and K-0 keep the pinned render-paper-references.mjs.
    ({ checkDesignReferences, closeServer } = isSiteManifest(manifestName)
      ? await siteRenderer(manifestName)
      : await import("./render-paper-references.mjs"));
  } catch (error) {
    return [
      `design reference renderer is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  try {
    const outcome = await checkDesignReferences({ baseline, browser });
    referenceResults.push(...(outcome?.results ?? []));
    return outcome?.issues ?? [];
  } finally {
    // The renderer's static mock server would otherwise keep the event loop
    // alive after a passing run and the process would never exit.
    await closeServer();
  }
}

const withinBounds = (image, x, y, width, height) =>
  x >= 0 && y >= 0 && width > 0 && height > 0 &&
  x + width <= image.width && y + height <= image.height;

// Decodes both PNGs and scores them with the shared content-registration
// algorithm (image-score.mjs). A dimension mismatch is reported without a
// score: it is a structural fact the caller decides how to treat (a design
// case fails outright; a specimen case blocks, since a specimen candidate can
// never legitimately have different dimensions from its pinned reference).
//
// A `comparisonRegion` with `candidateOrigin: "main"` compares the
// reference's rectangle against the same-sized rectangle whose origin is the
// app's `<main>` content box, as capture-stories.mjs recorded it for the
// candidate (`contentBox`). The two frames may then differ in overall size,
// because the region is the whole comparison. This is how a design artboard
// whose surrounding shell is illustrative (the settings screens' rail and
// top bar) is held to the app's real content box without pretending the two
// shells are the same.
// Crops that exclude a phone frame's device chrome band. The reference (W by
// H) is compared over rows [top, H). The candidate is captured at the derived
// W by (H - top) viewport, because a web app renders no device chrome, and is
// compared whole. Exactly `top` rows leave the reference, so the two crops have
// the same size. A candidate of any other size is a size mismatch, never
// cropped or padded to fit.
export function deviceChromeCrops(deviceChrome, baseline, candidate) {
  const { top } = deviceChrome;
  if (!Number.isInteger(top) || top <= 0 || top >= baseline.height) {
    return {
      issue:
        `deviceChrome.top ${top} must be a whole number of rows below the reference height ${baseline.height}`,
    };
  }
  const height = baseline.height - top;
  if (candidate.width !== baseline.width || candidate.height !== height) {
    return {
      sizeMismatch: true,
      issue:
        `deviceChrome candidate must be exactly ${baseline.width}x${height} (reference ${baseline.width}x${baseline.height} minus ${top} chrome rows), got ${candidate.width}x${candidate.height}`,
    };
  }
  return {
    baselineCrop: { x: 0, y: top, width: baseline.width, height },
    candidateCrop: { x: 0, y: 0, width: candidate.width, height },
  };
}

export async function comparePixels(
  page,
  candidateBytes,
  baselineBytes,
  comparisonRegion,
  contentBox = null,
  deviceChrome = null,
) {
  const candidate = pngDimensions(candidateBytes);
  const baseline = pngDimensions(baselineBytes);
  const region = comparisonRegion ?? null;
  let offset = null;
  if (region?.candidateOrigin === "main") {
    if (!contentBox) {
      return { issue: "candidate capture recorded no <main> content box" };
    }
    // The region IS the design's content box, so the app's <main> must be
    // the same size: a taller or wider main (extra rows, a missing section
    // rail) is the same structural failure as a whole-frame dimension
    // mismatch and must not be graded on its top-left corner alone.
    if (
      contentBox.width !== region.width || contentBox.height !== region.height
    ) {
      return {
        width: candidate.width,
        height: candidate.height,
        baselineWidth: baseline.width,
        baselineHeight: baseline.height,
        contentBox,
        region: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
      };
    }
    offset = { x: contentBox.x - region.x, y: contentBox.y - region.y };
  }
  if (
    !offset && !deviceChrome &&
    (candidate.width !== baseline.width ||
      candidate.height !== baseline.height)
  ) {
    return {
      width: candidate.width,
      height: candidate.height,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
    };
  }
  if (deviceChrome) {
    const crops = deviceChromeCrops(deviceChrome, baseline, candidate);
    if (crops.sizeMismatch) {
      // Same shape as a whole-frame dimension mismatch, so a design case
      // fails outright; `chromeIssue` carries the exact expectation.
      return {
        width: candidate.width,
        height: candidate.height,
        baselineWidth: baseline.width,
        baselineHeight: baseline.height,
        chromeIssue: crops.issue,
      };
    }
    if (crops.issue) return { issue: crops.issue };
    const scored = await comparePngs(page, {
      candidate: candidateBytes,
      baseline: baselineBytes,
      ...crops,
      diff: true,
    });
    if (scored.issue !== undefined) {
      return {
        width: candidate.width,
        height: candidate.height,
        issue: scored.issue,
      };
    }
    return {
      width: candidate.width,
      height: candidate.height,
      score: scored.score,
      inkScore: scored.inkScore,
      surfaceScore: scored.surfaceScore,
      inkCoverage: scored.inkCoverage,
      surfaceCoverage: scored.surfaceCoverage,
      mismatched: scored.mismatched,
      diffDataURL: scored.diffDataURL,
    };
  }
  if (
    region &&
    !withinBounds(baseline, region.x, region.y, region.width, region.height)
  ) {
    return { issue: "comparison region is outside the reference image bounds" };
  }
  if (
    region &&
    !withinBounds(
      candidate,
      region.x + (offset?.x ?? 0),
      region.y + (offset?.y ?? 0),
      region.width,
      region.height,
    )
  ) {
    // Same shape as the whole-frame dimension mismatch above: the app did
    // not render enough page to contain the design's content box, which the
    // caller treats as a parity failure for a design case.
    return {
      width: candidate.width,
      height: candidate.height,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
    };
  }
  const scored = await comparePngs(page, {
    candidate: candidateBytes,
    baseline: baselineBytes,
    ...(offset
      ? {
        candidateCrop: {
          x: region.x + offset.x,
          y: region.y + offset.y,
          width: region.width,
          height: region.height,
        },
        baselineCrop: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
      }
      : { region }),
    diff: true,
  });
  if (scored.issue !== undefined) {
    return {
      width: candidate.width,
      height: candidate.height,
      issue: scored.issue,
    };
  }
  return {
    width: candidate.width,
    height: candidate.height,
    score: scored.score,
    inkScore: scored.inkScore,
    surfaceScore: scored.surfaceScore,
    inkCoverage: scored.inkCoverage,
    surfaceCoverage: scored.surfaceCoverage,
    mismatched: scored.mismatched,
    diffDataURL: scored.diffDataURL,
  };
}

// Turns a comparePixels() outcome into a case status. Only a design case's
// dimension mismatch is a scored failure rather than a block: the candidate is
// a real app render, so a wrong-sized page is exactly the parity defect the
// gate exists to catch, not a broken input to set aside.
export function caseResultForPixels(baselineCase, pixels, threshold) {
  if (pixels.score !== undefined) {
    return {
      status: comparisonStatus(pixels.score, threshold),
      score: pixels.score,
      inkScore: pixels.inkScore,
      surfaceScore: pixels.surfaceScore,
      inkCoverage: pixels.inkCoverage,
      surfaceCoverage: pixels.surfaceCoverage,
    };
  }
  if (pixels.issue !== undefined) {
    return { status: "blocked", issues: [pixels.issue] };
  }
  if (baselineCase.reference === "design") {
    const box = pixels.contentBox;
    return {
      status: "failed",
      score: 0,
      issue: pixels.chromeIssue ??
        (box
          ? `design content box ${pixels.region.width}x${pixels.region.height}, candidate <main> ${box.width}x${box.height} at ${box.x},${box.y}`
          : `artboard ${pixels.baselineWidth}x${pixels.baselineHeight}, candidate ${pixels.width}x${pixels.height}`),
    };
  }
  return {
    status: "blocked",
    issues: ["candidate and baseline dimensions differ"],
  };
}

export async function baselineInputIssues(
  baseline,
  candidate,
  { siteStories = false } = {},
) {
  if (!candidate) return ["missing required runtime capture"];
  if (candidate.status !== "passed") {
    return [
      `runtime capture status is ${candidate.status ?? "unknown"}: ${
        candidate.reason ?? candidate.description?.observed ??
          "no reason recorded"
      }`,
    ];
  }
  const issues = baseline.reference === "design"
    ? designCompatibilityIssues(candidate, baseline)
    : compatibilityIssues(candidate, baseline);
  if (baseline.sourceProfile === "K-0") {
    issues.push(...storyCandidateIssues(baseline, candidate));
  }
  if (isSiteStoryCase(baseline)) {
    issues.push(
      ...(siteStories
        ? await siteStoryCandidateIssues(baseline, candidate)
        : ["story candidates are admitted only in site-rendered manifests"]),
    );
  }
  issues.push(...wholeArtboardBindingIssues(baseline));
  if (baseline.candidate?.storyId && baseline.comparisonRegion) {
    issues.push("source-shaped story comparisonRegion is unsupported");
  }
  if (baseline.pageId === "K-0" && baseline.sourceProfile !== "K-0") {
    issues.push("missing K-0 source profile");
  }
  issues.push(...await viewportBundleRecordIssues(root, candidate));
  issues.push(...await wholeArtboardPairIssues(root, baseline, candidate));
  const region = baseline.comparisonRegion;
  if (baseline.reference === "specimen" && region?.measure) {
    const extent = candidate.componentExtent;
    if (!extent) {
      issues.push("candidate capture recorded no measured component extent");
    } else if (
      ["x", "y", "width", "height"].some((key) => extent[key] !== region[key])
    ) {
      issues.push("component extent differs from baseline comparison region");
    }
  }
  const baselineImagePath = join(root, baseline.imagePath ?? "");
  try {
    const bytes = await readFile(baselineImagePath);
    if (sha256(bytes) !== baseline.imageSha256) {
      issues.push("baseline image digest changed");
    }
    if (baseline.sourceProfile) {
      try {
        const verified = verifyK0RasterProfile(bytes, baseline.rasterProfile);
        verifyK0RasterProfile(bytes, candidate.rasterProfile);
        if (
          verified.sourceIdentity !== baseline.sourceDigest ||
          verified.reference.width !== baseline.artboard?.width ||
          verified.reference.height !== baseline.artboard?.height
        ) issues.push("raster source/geometry mismatch");
      } catch (error) {
        issues.push(error.message);
      }
    }
  } catch {
    issues.push("baseline image is missing");
  }
  const candidatePath = join(root, candidate.outputPath ?? "");
  try {
    const bytes = await readFile(candidatePath);
    if (sha256(bytes) !== candidate.outputSha256) {
      issues.push("candidate image digest changed");
    }
    if (
      baseline.sourceProfile && !baseline.wholeArtboardCapture &&
      JSON.stringify(pngDimensions(bytes)) !== JSON.stringify(baseline.artboard)
    ) {
      issues.push(
        "candidate raster dimensions differ from complete original PNG",
      );
    }
  } catch {
    issues.push("candidate image is missing");
  }
  return issues;
}

export function comparisonStatus(score, threshold = 0.95) {
  return score >= threshold ? "passed" : "failed";
}

// A design artboard the branch deliberately excludes from Paper parity is
// still reported, with its reason, instead of silently vanishing from
// coverage. It is accepted like an introduced baseline: there is nothing to
// compare it against by construction.
export function excludedResult(entry) {
  return {
    baselineId: `excluded:${entry.screen}.${entry.state}`,
    status: "excluded",
    reason: entry.reason,
    description: resultDescription(
      "Design artboards deliberately outside Paper parity coverage are recorded with a reason, not silently dropped.",
      entry.reason,
    ),
  };
}

// A case whose ledger route is `planned` has goldens but no shipped route:
// its reference is self-checked with the rest of the manifest, and the case
// itself is reported, not scored, and not a failure.
export function plannedResult(baselineCase, entry, candidateCase = null) {
  const observed = candidateCase
    ? `Route ${entry.routeId} is planned in the route reference ledger; its capture is not scored until the ledger entry becomes baselined.`
    : `Route ${entry.routeId} is planned in the route reference ledger and has no capture; scoring starts when the ledger entry becomes baselined.`;
  return {
    baselineId: baselineCase.id,
    kind: baselineCase.reference === "design" ? "design" : "specimen",
    ...(baselineCase.design ? { design: baselineCase.design } : {}),
    status: "planned",
    reason: entry.rationale ?? observed,
    route: entry.path,
    description: resultDescription(
      "A planned route's goldens are self-checked and reported; scoring starts once the route ships and its ledger entry is baselined.",
      observed,
    ),
  };
}

// A case whose Paper frame belongs to a ledger `debt` entry has a design but
// no honest golden to meet: it is reported, not scored, and not a failure.
// Deferring manifests only (enterprise); the ledger entry's rationale is the
// stated reason.
export function debtResult(baselineCase, entry, candidateCase = null) {
  const observed = candidateCase
    ? `Route ${entry.routeId} is debt in the route reference ledger; its capture is not scored.`
    : `Route ${entry.routeId} is debt in the route reference ledger and has no capture; it is not scored.`;
  return {
    baselineId: baselineCase.id,
    kind: baselineCase.reference === "design" ? "design" : "specimen",
    ...(baselineCase.design ? { design: baselineCase.design } : {}),
    status: "debt",
    reason: entry.rationale ?? observed,
    route: entry.path,
    description: resultDescription(
      "A debt route's Paper frames are accepted without a golden; the debt set may only shrink, and scoring starts once the route is baselined.",
      observed,
    ),
  };
}

// A case a `--changed` capture deliberately did not select (see
// selection.designCaseIds in the candidate manifest). Its references and
// inputs are unchanged since the base, whose own run compared it.
export function notSelectedResult(baselineCase) {
  return {
    baselineId: baselineCase.id,
    kind: "design",
    ...(baselineCase.design ? { design: baselineCase.design } : {}),
    status: "not-selected",
    reason: "unchanged since the base; not captured in this changed run",
    description: resultDescription(
      "A case that is not new, whose reference inputs are unchanged and whose route module is untouched is not re-captured in a changed run.",
      "Not selected for this changed run.",
    ),
  };
}

// True when a `--changed` capture legitimately skipped a design case. A case
// the ledger marks `baselined` is never skipped: it must be captured and
// scored, and the trusted verifier refuses `not-selected` for it.
export function isNotSelected(
  baselineCase,
  selectedDesign,
  baselined,
  captured,
) {
  return Boolean(selectedDesign) && baselineCase.reference === "design" &&
    !baselined.has(baselineCase.id) &&
    !selectedDesign.has(baselineCase.id) && !captured;
}

function resultDescription(expected, observed, inputs = {}) {
  return { expected, observed, inputs };
}

function reportText(report) {
  return [
    `Paper comparison cycle ${report.cycle}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    `Coverage: expected=${report.coverage.expected} selected=${report.coverage.selected} observed=${report.coverage.observed} passed=${report.coverage.passed} failed=${report.coverage.failed} blocked=${report.coverage.blocked}${
      report.coverage.planned ? ` planned=${report.coverage.planned}` : ""
    }${report.coverage.debt ? ` debt=${report.coverage.debt}` : ""}${
      report.coverage.notSelected
        ? ` not-selected=${report.coverage.notSelected}`
        : ""
    }`,
    `Missing baseline IDs: ${report.coverage.missing.join(", ") || "none"}`,
    `Design references: ${
      report.designReferences
        ? `re-render proved at base ${report.designReferences.provedAt}; no reference input changed since`
        : "re-rendered in this run"
    }`,
    ...report.results.map((result) => {
      const suffix = result.score !== undefined
        ? `score=${result.score.toFixed(6)} ink=${
          (result.inkScore ?? result.score).toFixed(4)
        } surface=${(result.surfaceScore ?? result.score).toFixed(4)}`
        : (result.issues ?? result.notes ??
          (result.reason ? [result.reason] : [])).join("; ");
      return [
        `${result.status.toUpperCase()} ${result.baselineId}: ${suffix}`,
        `  Expected: ${result.description.expected}`,
        `  Observed: ${result.description.observed}`,
        `  Inputs: ${JSON.stringify(result.description.inputs)}`,
        ...(result.inputDigests?.comparisonScope === "whole-artboard-parity"
          ? [
            `  Whole-artboard parity: ${
              result.inputDigests.parity?.path ?? "missing"
            }`,
            `  Full UI (untransformed context): ${
              result.inputDigests.fullUI?.path ?? "missing"
            }`,
            `  Browser contract receipt: ${
              result.inputDigests.browserReceipt ?? "missing"
            }`,
          ]
          : []),
      ].join("\n");
    }),
    `Threshold: ${report.threshold}`,
    `Overall: ${report.status}`,
  ].join("\n") + "\n";
}

async function writeReport(report, reportDirectory) {
  await mkdir(join(reportDirectory, "diff-images"), { recursive: true });
  await writeFile(
    join(reportDirectory, "comparison.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(join(reportDirectory, "comparison.txt"), reportText(report));
}

// An introduced baseline has no predecessor to verify against, and an
// excluded design artboard has nothing to compare by construction. A planned
// case (route not shipped) and a case a changed run did not select are the
// same: reported distinctly, neither passing nor failing the gate. Those two
// statuses are limited to ledger-aware manifests: `not-selected` to the
// site-rendered ones (enterprise, settings), `planned` and `debt` only to the
// deferring one (enterprise). For auth they are impossible, and for settings
// a planned or debt result is impossible too, so one that ever arises there is
// not accepted and fails the run.
export const accepted = (result, manifestName = "auth") =>
  result.status === "passed" || result.status === "introduced" ||
  result.status === "excluded" ||
  (isSiteManifest(manifestName) && result.status === "not-selected") ||
  (defersScoring(manifestName) &&
    (result.status === "planned" || result.status === "debt"));

// Fix all acceptance fields before optional, failure-isolated observations.
// Diagnostics may consume time, but never the acceptance convergence budget.
export function finalizePaperComparison(
  report,
  baseline,
  candidates,
  collectDiagnostics,
  { manifestName = "auth", planned = new Map(), debt = new Map() } = {},
) {
  const elapsed = Date.now() - Date.parse(report.startedAt);
  if (elapsed > 4 * 60 * 60 * 1000) {
    report.results.push({
      baselineId: "convergence-budget",
      status: "blocked",
      issues: ["four focused engineering hours elapsed"],
      description: resultDescription(
        "The comparison completes within the four-hour convergence budget.",
        "Four focused engineering hours elapsed.",
      ),
    });
  }
  if (
    report.cycle === 3 &&
    report.results.some((result) => !accepted(result, manifestName))
  ) {
    report.results.push({
      baselineId: "convergence-budget",
      status: "blocked",
      issues: [
        "three compare-adjust cycles exhausted; preserve this report for human disposition",
      ],
      description: resultDescription(
        "The candidate reaches parity within three compare-adjust cycles.",
        "Three compare-adjust cycles were exhausted.",
      ),
    });
  }
  const baselineIds = new Set(
    (baseline.cases ?? []).map((entry) => entry.id),
  );
  const comparisonResults = report.results.filter((result) =>
    baselineIds.has(result.baselineId)
  );
  const plannedCount =
    comparisonResults.filter((result) => result.status === "planned").length;
  const debtCount =
    comparisonResults.filter((result) => result.status === "debt").length;
  const notSelectedIds = new Set(
    comparisonResults.filter((result) => result.status === "not-selected")
      .map((result) => result.baselineId),
  );
  report.coverage = {
    expected: baselineIds.size,
    selected: baselineIds.size,
    observed: comparisonResults.length,
    passed: comparisonResults.filter((result) => result.status === "passed")
      .length,
    failed: comparisonResults.filter((result) => result.status === "failed")
      .length,
    blocked: comparisonResults.filter((result) => result.status === "blocked")
      .length,
    missing: (baseline.cases ?? []).filter((entry) =>
      !candidates.has(entry.id) && !planned.has(entry.id) &&
      !debt.has(entry.id) && !notSelectedIds.has(entry.id)
    ).map((entry) => entry.id),
    ...(plannedCount ? { planned: plannedCount } : {}),
    ...(debtCount ? { debt: debtCount } : {}),
    ...(notSelectedIds.size ? { notSelected: notSelectedIds.size } : {}),
  };
  report.status = report.partial ? "partial" : report.results.length > 0 &&
      report.results.every((result) => accepted(result, manifestName))
    ? "passed"
    : "blocked";
  if (collectDiagnostics) {
    try {
      report.rasterDiagnostics = collectDiagnostics();
    } catch {
      report.rasterDiagnostics = {
        purpose:
          "read-only diagnostics; not acceptance or trusted score inputs",
        status: "unavailable",
      };
    }
  }
}

export async function comparePaper(
  {
    candidatePath: candidatePathOption,
    cycle = 1,
    maxCycles = 3,
    startedAt,
    only = [],
    manifestName = "auth",
  } = {},
) {
  const profile = manifestProfile(manifestName);
  const baselinePath = profile.baselinePath;
  const { reportDirectory } = pathsFor(manifestName);
  const candidatePath = candidatePathOption ??
    pathsFor(manifestName).candidatePath;
  const started = startedAt ?? new Date().toISOString();
  const report = {
    schemaVersion: 2,
    cycle,
    threshold: 0.95,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    status: "blocked",
    coverage: {
      expected: 0,
      selected: 0,
      observed: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      missing: [],
    },
    results: [],
  };
  await mkdir(join(reportDirectory, "diff-images"), { recursive: true });
  let browser;
  let candidates = new Map();
  const referenceResults = [];
  try {
    validateCycle(cycle, { maxCycles, manifestName });
    const [candidate, fullBaseline] = await Promise.all([
      readJson(candidatePath),
      readJson(baselinePath),
    ]);
    // Development loop only: compare the cases whose id starts with a prefix,
    // skip the reference re-render, and never report as evidence.
    const baseline = only.length
      ? {
        ...fullBaseline,
        cases: (fullBaseline.cases ?? []).filter((entry) =>
          only.some((prefix) => entry.id.startsWith(prefix))
        ),
        excluded: [],
      }
      : fullBaseline;
    if (only.length) report.partial = { only };
    // Selection cannot bypass history or hide mutations in unselected profiles.
    const provenance = repositoryBaselineProvenance({ baselinePath });
    report.provenance = provenance;
    browser = await chromium.launch({
      headless: true,
      ...(isSiteManifest(manifestName) ? enterpriseLaunchOptions() : {}),
    });
    const page = await browser.newPage();
    const provedAt = only.length ? null : referenceRenderProvedAt(
      baseline,
      process.env.BAKERY_CAPTURE_BASE_SHA,
      execFileSync,
      manifestName,
    );
    if (provedAt) report.designReferences = { provedAt };
    const metadataIssues = [
      ...(candidate.schemaVersion === 2
        ? []
        : ["unsupported runtime capture schema version"]),
      ...baselineMetadataIssues(baseline, undefined, {
        siteStories: isSiteManifest(manifestName),
      }),
      ...deviceChromeIssues(baseline, manifestName),
      ...(isSiteManifest(manifestName)
        ? await (await siteRenderer(manifestName)).schemaIssues(baseline)
        : []),
      ...(only.length && !baseline.cases.some((entry) => entry.sourceProfile)
        ? []
        : await sourceDigestIssues(baseline)),
      ...(only.length || provedAt ? [] : await designReferenceIssues(
        baseline,
        browser,
        referenceResults,
        manifestName,
      )),
      ...(provenance.issues ?? []),
    ];
    // Full-UI-only detail cases have no baseline iteration or paired parity.
    // Validate their explicit output references before admitting the manifest.
    for (const entry of candidate.cases ?? []) {
      if (entry.paperBaselineId) continue;
      metadataIssues.push(...(await viewportBundleRecordIssues(root, entry))
        .map((issue) => `${entry.id}: ${issue}`));
    }
    if (metadataIssues.length) {
      report.results.push({
        baselineId: "manifest",
        status: "blocked",
        issues: metadataIssues,
        description: resultDescription(
          "Paper and runtime manifests provide compatible, immutable inputs before image comparison.",
          metadataIssues.join("; "),
        ),
      });
    } else if (provenance.notes) {
      report.results.push({
        baselineId: "manifest",
        status: provenance.status,
        notes: provenance.notes,
        description: resultDescription(
          "Paper provenance has an independent predecessor or is explicitly reported as a first introduction.",
          provenance.notes.join("; "),
        ),
      });
    }
    for (const entry of baseline.excluded ?? []) {
      report.results.push(excludedResult(entry));
    }
    candidates = new Map(
      (candidate.cases ?? []).map((entry) => [entry.paperBaselineId, entry]),
    );
    const ledger = await readRouteLedger();
    const planned = plannedCases(ledger, manifestName);
    const debt = debtCases(ledger, baseline, manifestName);
    const baselined = baselinedCases(ledger, manifestName);
    const selectedDesign = candidate.selection?.designCaseIds
      ? new Set(candidate.selection.designCaseIds)
      : null;
    for (const baselineCase of baseline.cases ?? []) {
      const plannedEntry = planned.get(baselineCase.id);
      if (plannedEntry) {
        report.results.push(
          plannedResult(
            baselineCase,
            plannedEntry,
            candidates.get(baselineCase.id),
          ),
        );
        continue;
      }
      const debtEntry = debt.get(baselineCase.id);
      if (debtEntry) {
        report.results.push(
          debtResult(baselineCase, debtEntry, candidates.get(baselineCase.id)),
        );
        continue;
      }
      if (
        isNotSelected(
          baselineCase,
          selectedDesign,
          baselined,
          candidates.has(baselineCase.id),
        )
      ) {
        report.results.push(notSelectedResult(baselineCase));
        continue;
      }
      const kind = baselineCase.reference === "design" ? "design" : "specimen";
      const label = kind === "design"
        ? `${baselineCase.design?.screen ?? baselineCase.id}/${
          baselineCase.design?.state ?? "default"
        }`
        : baselineCase.catalogId;
      const candidateCase = candidates.get(baselineCase.id);
      const issues = await baselineInputIssues(baselineCase, candidateCase, {
        siteStories: isSiteManifest(manifestName),
      });
      if (
        baselineCase.wholeArtboardCapture &&
        (candidate.cases ?? []).filter((entry) =>
            entry.paperBaselineId === baselineCase.id
          ).length !== 1
      ) issues.push("duplicate or missing paired candidate");
      if (metadataIssues.length && baselineCase.sourceProfile) {
        issues.push(...metadataIssues);
      }
      const inputDigests = {
        baselineImage: baselineCase.imagePath ?? null,
        candidateImage: candidateCase?.outputPath ??
          candidateCase?.evidencePath ?? null,
        baselineImageDigest: baselineCase.imageSha256,
        candidateImageDigest: candidateCase?.outputSha256 ?? null,
        candidateComponent: candidateCase?.componentSourceDigest ?? null,
        candidateToken: candidateCase?.tokenDigest ?? null,
        candidateFonts: candidateCase?.fontDigests ?? null,
        candidateComponentExtent: candidateCase?.componentExtent ?? null,
        ...(isSiteStoryCase(baselineCase)
          ? {
            comparisonScope: "story-whole-artboard",
            fullUI: candidateCase?.fullUIBundle ?? null,
            parity: candidateCase?.storyArtboard?.parity ?? null,
          }
          : {}),
        ...(baselineCase.wholeArtboardCapture
          ? {
            comparisonScope: "whole-artboard-parity",
            fullUI: candidateCase?.wholeArtboardCapture?.fullUI ?? null,
            parity: candidateCase?.wholeArtboardCapture?.parity ?? null,
            browserReceipt: candidateCase?.wholeArtboardCapture?.parity?.path
              ? `${candidateCase.wholeArtboardCapture.parity.path}.browser.json`
              : null,
          }
          : {}),
      };
      if (issues.length) {
        report.results.push({
          baselineId: baselineCase.id,
          candidateId: candidateCase?.id ?? null,
          kind,
          ...(kind === "design" ? { design: baselineCase.design } : {}),
          status: "blocked",
          issues,
          inputDigests,
          description: resultDescription(
            `Rendered ${label} ${kind} matches the approved reference within the fixed threshold.`,
            issues.join("; "),
            inputDigests,
          ),
        });
        continue;
      }
      const candidateBytes = await readFile(
        join(
          root,
          baselineCase.wholeArtboardCapture
            ? candidateCase.wholeArtboardCapture.parity.path
            : isSiteStoryCase(baselineCase)
            ? candidateCase.storyArtboard.parity.path
            : candidateCase.outputPath,
        ),
      );
      const baselineBytes = await readFile(
        join(root, baselineCase.imagePath),
      );
      const pixels = await comparePixels(
        page,
        candidateBytes,
        baselineBytes,
        baselineCase.comparisonRegion,
        candidateCase.contentBox ?? null,
        // Device chrome is site-manifest-only; an auth case carrying it is a
        // metadata issue (deviceChromeIssues) and never reaches scoring.
        isSiteManifest(manifestName) ? baselineCase.deviceChrome ?? null : null,
      );
      const outcome = caseResultForPixels(
        baselineCase,
        pixels,
        report.threshold,
      );
      if (outcome.status === "blocked") {
        report.results.push({
          baselineId: baselineCase.id,
          candidateId: candidateCase.id,
          kind,
          ...(kind === "design" ? { design: baselineCase.design } : {}),
          status: "blocked",
          issues: outcome.issues,
          pixels,
          inputDigests,
          description: resultDescription(
            `Rendered ${label} ${kind} matches the approved reference within the fixed threshold.`,
            outcome.issues.join("; "),
            inputDigests,
          ),
        });
        continue;
      }
      const result = {
        baselineId: baselineCase.id,
        candidateId: candidateCase.id,
        kind,
        ...(kind === "design" ? { design: baselineCase.design } : {}),
        status: outcome.status,
        score: outcome.score,
        inkScore: outcome.inkScore,
        surfaceScore: outcome.surfaceScore,
        inkCoverage: outcome.inkCoverage,
        surfaceCoverage: outcome.surfaceCoverage,
        viewport: { width: pixels.width, height: pixels.height },
        inputDigests,
        description: resultDescription(
          `Rendered ${label} ${kind} matches the approved reference within the fixed threshold.`,
          outcome.status === "passed"
            ? `Score ${
              outcome.score.toFixed(4)
            } meets the inclusive ${report.threshold} threshold.`
            : outcome.issue ??
              `Score ${
                outcome.score.toFixed(4)
              } is below the inclusive ${report.threshold} threshold.`,
          inputDigests,
        ),
      };
      if (outcome.issue) result.issues = [outcome.issue];
      if (pixels.diffDataURL) {
        const image = Buffer.from(
          pixels.diffDataURL.replace(/^data:image\/png;base64,/, ""),
          "base64",
        );
        const diffPath = join(
          reportDirectory,
          "diff-images",
          `${baselineCase.id}.png`,
        );
        await writeFile(diffPath, image);
        result.diffImagePath = relative(root, diffPath);
      }
      report.results.push(result);
    }
    finalizePaperComparison(
      report,
      baseline,
      candidates,
      process.env.BAKERY_PAPER_RASTER_DIAGNOSTICS === "1"
        ? () => paperRasterDiagnostics(referenceResults)
        : undefined,
      { manifestName, planned, debt },
    );
  } catch (error) {
    report.results.push({
      baselineId: "comparison",
      status: "blocked",
      issues: [error instanceof Error ? error.message : String(error)],
      description: resultDescription(
        "Paper comparison completes and reports every selected baseline.",
        error instanceof Error ? error.message : String(error),
      ),
    });
  } finally {
    if (browser) await browser.close();
  }
  report.finishedAt = new Date().toISOString();
  await writeReport(report, reportDirectory);
  if (report.status === "partial") {
    console.log(
      `PARTIAL Paper comparison (${
        report.partial.only.join(", ")
      }) — development loop only, not evidence; see ${
        relative(root, join(reportDirectory, "comparison.txt"))
      }`,
    );
  } else if (report.status !== "passed") {
    throw new Error(
      `Paper parity gate ${report.status}; see ${
        relative(root, join(reportDirectory, "comparison.txt"))
      }`,
    );
  }
  return report;
}

if (import.meta.main) {
  await comparePaper({ ...parseArguments(process.argv.slice(2)) });
}
