import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  accepted,
  baselineInputIssues,
  baselineMetadataIssues,
  baselineMutationIssues,
  baselineProvenance,
  caseResultForPixels,
  comparePixels,
  comparisonStatus,
  compatibilityIssues,
  debtResult,
  designCompatibilityIssues,
  designReferenceInputs,
  deviceChromeCrops,
  deviceChromeIssues,
  finalizePaperComparison,
  isNotSelected,
  notSelectedResult,
  paperRasterDiagnostics,
  parseArguments,
  plannedResult,
  predecessorManifest,
  referenceRenderProvedAt,
  sourceDigestIssues,
  sourceRefreshed,
  validateCycle,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/compare-paper.mjs";
import { excludedResult } from "../scripts/compare-paper.mjs";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  scorePixels,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/image-score.mjs";
import type {
  ScorePixelsIssue,
  ScorePixelsResult,
} from "../scripts/image-score.mjs";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  captureConcurrency,
  changedPaths,
  includePaperCases,
  selectCases,
  sourceIdentity,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/capture-stories.mjs";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  deviceChromeDrift,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/render-enterprise-references.mjs";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  captureCaseFor,
  routeOwnedPaths,
  selectDesignCases,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/capture-enterprise.mjs";
// Playwright executes the .mjs runtime; its .d.mts sidecar supplies types.
import {
  artifactsDirectoryFor,
  baselinedCases,
  captureViewport,
  debtCases,
  defersScoring,
  isSiteManifest,
  manifestProfile,
  plannedCases,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/paper-manifests.mjs";

const compatibleCandidate = {
  viewport: { width: 1280, height: 960 },
  dpr: 1,
  colorScheme: "light",
  pointer: "fine",
  locale: "en-US",
  direction: "ltr",
  fontDigests: { "font.ttf": "font-digest" },
  tokenRevision: "token-revision",
  fixtureRevision: "fixture-revision",
  browser: "chromium",
  os: "linux-x64",
  catalogId: "ui.themeProvider",
  requiredCaseId: "contract",
};

const compatibleBaseline = {
  viewport: { width: 1280, height: 960 },
  dpr: 1,
  theme: "light",
  pointer: "fine",
  locale: "en-US",
  direction: "ltr",
  fontDigests: { "font.ttf": "font-digest" },
  tokenRevision: "token-revision",
  fixtureRevision: "fixture-revision",
  browser: "chromium",
  os: "linux-x64",
  frameId: "frame-1",
  pageId: "page-1",
  catalogId: "ui.themeProvider",
  requiredStoryCase: "contract",
};

const WHITE: [number, number, number] = [255, 255, 255];
const white = () => WHITE;

function canvas(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[pixel] = r;
      data[pixel + 1] = g;
      data[pixel + 2] = b;
      data[pixel + 3] = 255;
    }
  }
  return data;
}

function squareAt(left: number, top: number, size = 10) {
  return (x: number, y: number): [number, number, number] =>
    x >= left && x < left + size && y >= top && y < top + size
      ? [0, 0, 0]
      : WHITE;
}

function selectFixture(paths: string[]) {
  const runtimeCases = [
    { id: "button", catalogId: "ui.button", storyId: "button-story" },
    { id: "thing", catalogId: "ui.thing", storyId: "thing-story" },
  ];
  const catalog = {
    entries: [
      { id: "ui.button", name: "Button", level: "atom" },
      { id: "ui.thing", name: "Thing", level: "molecule" },
    ],
  };
  const stories = [
    { id: "button-story", importPath: "src/atoms/Button.stories.tsx" },
    { id: "thing-story", importPath: "src/molecules/Thing.stories.tsx" },
  ];
  return {
    runtimeCases,
    selected: selectCases({ cases: runtimeCases }, catalog, stories, {
      changed: true,
      caseIds: [],
    }, paths),
  };
}

// Type guards so the tests can access `.score`/`.inkScore`/`.issue` on the
// scorePixels union without an `as` cast at every call site.
function expectScored(
  result: ScorePixelsResult | ScorePixelsIssue,
): ScorePixelsResult {
  if ("issue" in result) {
    throw new Error(`expected a score, got issue: ${result.issue}`);
  }
  return result;
}

function expectIssue(result: ScorePixelsResult | ScorePixelsIssue): string {
  if (!("issue" in result)) {
    throw new Error("expected an issue, got a score");
  }
  return result.issue;
}

test.describe("scorePixels (content-registration algorithm)", () => {
  const W = 100;
  const H = 100;

  test("scores identical images 1", () => {
    const image = canvas(W, H, squareAt(0, 0));
    const result = expectScored(scorePixels({
      candidate: image,
      baseline: image,
      width: W,
      height: H,
      region: null,
    }));
    expect(result.score).toBe(1);
    expect(result.inkScore).toBe(1);
    expect(result.surfaceScore).toBe(1);
  });

  test("scores a wholly missing square as a hard failure, not a diluted full-frame pass", () => {
    const result = expectScored(scorePixels({
      candidate: canvas(W, H, white),
      baseline: canvas(W, H, squareAt(0, 0)),
      width: W,
      height: H,
      region: null,
    }));
    expect(result.score).toBe(0);
  });

  test("tolerates a 1px registration shift", () => {
    const result = expectScored(scorePixels({
      candidate: canvas(W, H, squareAt(1, 1)),
      baseline: canvas(W, H, squareAt(0, 0)),
      width: W,
      height: H,
      region: null,
    }));
    expect(result.score).toBe(1);
  });

  test("fails a 3px shift below the inclusive threshold via the ink score", () => {
    const result = expectScored(scorePixels({
      candidate: canvas(W, H, squareAt(3, 3)),
      baseline: canvas(W, H, squareAt(0, 0)),
      width: W,
      height: H,
      region: null,
    }));
    expect(result.inkScore).toBeLessThan(0.95);
    expect(result.score).toBeLessThan(0.95);
  });

  test("scores two different layouts near zero", () => {
    const result = expectScored(scorePixels({
      candidate: canvas(W, H, squareAt(90, 90)),
      baseline: canvas(W, H, squareAt(0, 0)),
      width: W,
      height: H,
      region: null,
    }));
    expect(result.score).toBe(0);
  });

  test("reports an issue instead of a score for a blank-vs-blank comparison", () => {
    const issue = expectIssue(scorePixels({
      candidate: canvas(W, H, white),
      baseline: canvas(W, H, white),
      width: W,
      height: H,
      region: null,
    }));
    expect(issue).toBeTruthy();
  });

  test("scores a flat off-white panel against pure white as a hard surface failure", () => {
    const size = 300;
    const flatOffWhite = (x: number, y: number): [number, number, number] =>
      x < 200 && y < 200 ? [245, 246, 248] : WHITE;
    const result = expectScored(scorePixels({
      candidate: canvas(size, size, white),
      baseline: canvas(size, size, flatOffWhite),
      width: size,
      height: size,
      region: null,
    }));
    expect(result.inkScore).toBe(1);
    expect(result.surfaceScore).toBe(0);
    expect(result.score).toBe(0);
  });
});

test.describe("Paper parity gate", () => {
  test("uses an inclusive 0.95 threshold", () => {
    expect(comparisonStatus(0.949999)).toBe("failed");
    expect(comparisonStatus(0.95)).toBe("passed");
    expect(comparisonStatus(1)).toBe("passed");
  });

  test("blocks a missing candidate capture", async () => {
    await expect(baselineInputIssues(compatibleBaseline, undefined)).resolves
      .toContain("missing required runtime capture");
  });

  test("blocks a specimen capture with no measured component extent", async () => {
    const imagePath =
      "docs/technical-design/ui-baselines/paper/ui-theme-provider.png";
    const imageBytes = await readFile(
      new URL(`../../../${imagePath}`, import.meta.url),
    );
    const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
    const issues = await baselineInputIssues(
      {
        ...compatibleBaseline,
        reference: "specimen",
        imagePath,
        imageSha256: imageDigest,
        comparisonRegion: {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          measure: "[data-ui-component]",
        },
      },
      {
        ...compatibleCandidate,
        status: "passed",
        outputPath: imagePath,
        outputSha256: imageDigest,
      },
    );
    expect(issues).toContain(
      "candidate capture recorded no measured component extent",
    );
  });

  test("blocks a specimen extent that grows by 8px", async () => {
    const imagePath =
      "docs/technical-design/ui-baselines/paper/ui-theme-provider.png";
    const imageBytes = await readFile(
      new URL(`../../../${imagePath}`, import.meta.url),
    );
    const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
    const issues = await baselineInputIssues(
      {
        ...compatibleBaseline,
        reference: "specimen",
        imagePath,
        imageSha256: imageDigest,
        comparisonRegion: {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          measure: "[data-ui-component]",
        },
      },
      {
        ...compatibleCandidate,
        status: "passed",
        outputPath: imagePath,
        outputSha256: imageDigest,
        componentExtent: { x: 0, y: 0, width: 100, height: 108 },
      },
    );
    expect(issues).toContain(
      "component extent differs from baseline comparison region",
    );
  });

  test("blocks a deliberately altered reference", async () => {
    const imagePath =
      "docs/technical-design/ui-baselines/paper/ui-theme-provider.png";
    const imageBytes = await readFile(
      new URL(`../../../${imagePath}`, import.meta.url),
    );
    const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
    const alteredDigest = createHash("sha256").update(imageBytes).update(
      "altered-reference",
    ).digest("hex");
    const issues = await baselineInputIssues(
      { ...compatibleBaseline, imagePath, imageSha256: alteredDigest },
      {
        ...compatibleCandidate,
        status: "passed",
        outputPath: imagePath,
        outputSha256: imageDigest,
      },
    );
    expect(issues).toContain("baseline image digest changed");
  });

  test("blocks a candidate produced on a different OS", () => {
    expect(compatibilityIssues(
      { ...compatibleCandidate, os: "darwin-arm64" },
      compatibleBaseline,
    )).toContain("os differs from candidate");
  });

  test("blocks a missing baseline image", async () => {
    const imagePath =
      "docs/technical-design/ui-baselines/paper/ui-theme-provider.png";
    const imageBytes = await readFile(
      new URL(`../../../${imagePath}`, import.meta.url),
    );
    const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
    const issues = await baselineInputIssues(
      {
        ...compatibleBaseline,
        imagePath: "docs/technical-design/ui-baselines/paper/missing.png",
        imageSha256: "0".repeat(64),
      },
      {
        ...compatibleCandidate,
        status: "passed",
        outputPath: imagePath,
        outputSha256: imageDigest,
      },
    );
    expect(issues).toContain("baseline image is missing");
  });

  test("does not accept a failed capture record as affirmative evidence", async () => {
    await expect(baselineInputIssues(compatibleBaseline, {
      ...compatibleCandidate,
      status: "failed",
      reason: "axe",
    })).resolves.toContain("runtime capture status is failed: axe");
  });

  test("accepts only exactly compatible declared inputs", () => {
    expect(compatibilityIssues(compatibleCandidate, compatibleBaseline))
      .toEqual([]);
    expect(compatibilityIssues(
      { ...compatibleCandidate, viewport: { width: 320, height: 844 } },
      compatibleBaseline,
    )).toContain("viewport differs from candidate");
    expect(compatibilityIssues(
      { ...compatibleCandidate, requiredCaseId: "default" },
      compatibleBaseline,
    )).toContain("required story case differs from candidate");
    expect(compatibilityIssues(
      { ...compatibleCandidate, catalogId: "ui.other" },
      compatibleBaseline,
    )).toContain("catalog ID differs from candidate");
    expect(compatibilityIssues(
      compatibleCandidate,
      { ...compatibleBaseline, requiredStoryCase: undefined },
    )).toContain("required story case differs from candidate");
    expect(compatibilityIssues(
      compatibleCandidate,
      { ...compatibleBaseline, os: undefined },
    )).toContain("baseline does not declare os");
  });

  test("design compatibility ignores fixtureRevision, tokenRevision, catalogId and story case", () => {
    const designBaseline = {
      viewport: { width: 1440, height: 960 },
      dpr: 1,
      theme: "light",
      pointer: "fine",
      locale: "en-US",
      direction: "ltr",
      fontDigests: { "font.ttf": "font-digest" },
      browser: "chromium",
      os: "linux-x64",
    };
    // A route candidate carries none of a specimen's identity fields.
    const routeCandidate = {
      viewport: { width: 1440, height: 960 },
      dpr: 1,
      colorScheme: "light",
      pointer: "fine",
      locale: "en-US",
      direction: "ltr",
      fontDigests: { "font.ttf": "font-digest" },
      browser: "chromium",
      os: "linux-x64",
    };
    expect(designCompatibilityIssues(routeCandidate, designBaseline))
      .toEqual([]);
    expect(designCompatibilityIssues(
      { ...routeCandidate, os: "darwin-arm64" },
      designBaseline,
    )).toContain("os differs from candidate");
  });

  test("scores a design case's dimension mismatch as a scored failure, not a block", () => {
    const pixels = {
      width: 1440,
      height: 976,
      baselineWidth: 1440,
      baselineHeight: 960,
    };
    expect(caseResultForPixels({ reference: "design" }, pixels, 0.95))
      .toEqual({
        status: "failed",
        score: 0,
        issue: "artboard 1440x960, candidate 1440x976",
      });
  });

  // Paints a PNG in the browser: a white frame with one black square, the
  // same shape the scorePixels fixtures use, so the settings-shell region
  // alignment can be exercised end to end through the real PNG decode path.
  async function paintedPng(
    page: import("@playwright/test").Page,
    width: number,
    height: number,
    square: { left: number; top: number; size: number },
  ) {
    const dataUrl = await page.evaluate(({ width, height, square }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#000000";
      context.fillRect(square.left, square.top, square.size, square.size);
      return canvas.toDataURL("image/png");
    }, { width, height, square });
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  }

  test("aligns a comparison region to the candidate's recorded <main> box", async ({ page }) => {
    // Reference: 100x80 artboard whose content box starts at (20, 10); the
    // square sits at (30, 20). Candidate: a larger 140x120 page whose <main>
    // starts at (50, 40) and carries the same square at (60, 50).
    const reference = await paintedPng(page, 100, 80, {
      left: 30,
      top: 20,
      size: 10,
    });
    const candidate = await paintedPng(page, 140, 120, {
      left: 60,
      top: 50,
      size: 10,
    });
    const region = {
      x: 20,
      y: 10,
      width: 80,
      height: 70,
      candidateOrigin: "main" as const,
    };
    const aligned = await comparePixels(page, candidate, reference, region, {
      x: 50,
      y: 40,
      width: 80,
      height: 70,
    });
    expect(aligned.score).toBe(1);

    // A <main> box that puts the square somewhere else is a real mismatch.
    const misaligned = await comparePixels(page, candidate, reference, region, {
      x: 50,
      y: 30,
      width: 80,
      height: 70,
    });
    expect(misaligned.score).toBeLessThan(0.95);

    // The region is the design's content box, so a <main> of another size
    // (extra rows below the design's last element, or a wider column) is a
    // structural failure even when its top-left corner matches.
    for (
      const box of [
        { x: 50, y: 40, width: 80, height: 79 },
        { x: 50, y: 40, width: 100, height: 70 },
      ]
    ) {
      const outcome = caseResultForPixels(
        { reference: "design" },
        await comparePixels(page, candidate, reference, region, box),
        0.95,
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.issue).toContain("design content box 80x70");
    }

    // Without a recorded box the comparison cannot be made at all.
    const unrecorded = await comparePixels(
      page,
      candidate,
      reference,
      region,
      null,
    );
    expect(unrecorded.issue).toBe(
      "candidate capture recorded no <main> content box",
    );

    // A candidate page too short to contain the design's content box is the
    // same structural failure as a whole-frame dimension mismatch.
    const short = await paintedPng(page, 140, 100, {
      left: 60,
      top: 50,
      size: 10,
    });
    const outcome = caseResultForPixels(
      { reference: "design" },
      await comparePixels(page, short, reference, region, {
        x: 50,
        y: 40,
        width: 80,
        height: 70,
      }),
      0.95,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.score).toBe(0);
  });

  test("blocks a specimen case's dimension mismatch instead of scoring it", () => {
    const pixels = {
      width: 1440,
      height: 976,
      baselineWidth: 1440,
      baselineHeight: 960,
    };
    const outcome = caseResultForPixels(
      { reference: "specimen" },
      pixels,
      0.95,
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.issues).toEqual([
      "candidate and baseline dimensions differ",
    ]);
  });

  test("echoes an excluded design artboard as an accepted, reasoned result", () => {
    const entry = {
      screen: "login",
      state: "unverified",
      reason: "not in scope",
    };
    const result = excludedResult(entry);
    expect(result.status).toBe("excluded");
    expect(result.baselineId).toBe("excluded:login.unverified");
    expect(result.reason).toBe("not in scope");
    expect(accepted(result)).toBe(true);
  });

  test("verifies the pinned source digest against the actual input bytes", async () => {
    const relativePath = "docs/technical-design/auth-mocks/paper-manifest.json";
    const bytes = await readFile(
      new URL(`../../../${relativePath}`, import.meta.url),
    );
    const fileDigest = createHash("sha256").update(bytes).digest("hex");
    const digest = createHash("sha256").update(
      `${relativePath}\0${fileDigest}\n`,
    ).digest("hex");
    await expect(
      sourceDigestIssues({ source: { inputs: [relativePath], digest } }),
    ).resolves.toEqual([]);
    await expect(
      sourceDigestIssues({
        source: { inputs: [relativePath], digest: "0".repeat(64) },
      }),
    ).resolves.toContain(
      "Paper source digest does not match the pinned inputs listed in source.inputs",
    );
  });

  test("rejects incomplete or changed immutable baseline metadata", () => {
    expect(baselineMetadataIssues({
      schemaVersion: 2,
      source: {},
      reference: { hidden: [] },
      cases: [],
    }))
      .toEqual([
        "Paper source metadata must include an immutable SHA-256 digest",
        "Paper baseline has no cases",
      ]);
    expect(baselineMetadataIssues({
      schemaVersion: 2,
      source: {
        fileId: "paper",
        pageId: "page-1",
        manifestPath: "manifest.json",
        inputs: ["a"],
        revision: "r1",
        digest: "f".repeat(64),
      },
      reference: { hidden: [] },
      cases: [{
        id: "case",
        reference: "specimen",
        imagePath: "case.png",
        imageSha256: "not-a-digest",
      }],
    })).toContain("case lacks immutable image metadata");

    const completeCase = {
      id: "case",
      reference: "specimen",
      frameId: "frame-1",
      pageId: "page-1",
      catalogId: "ui.themeProvider",
      requiredStoryCase: "contract",
      imagePath: "case.png",
      imageSha256: "a".repeat(64),
    };
    for (
      const field of ["frameId", "pageId", "catalogId", "requiredStoryCase"]
    ) {
      const incompleteCase = Object.fromEntries(
        Object.entries(completeCase).filter(([key]) => key !== field),
      );
      expect(baselineMetadataIssues({
        schemaVersion: 2,
        source: {
          fileId: "paper",
          pageId: "page-1",
          manifestPath: "manifest.json",
          inputs: ["a"],
          revision: "r1",
          digest: "f".repeat(64),
        },
        reference: { hidden: [] },
        cases: [incompleteCase],
      })).toContain(`case lacks ${field}`);
    }

    expect(baselineMetadataIssues({
      schemaVersion: 2,
      source: {
        fileId: "paper",
        pageId: "page-1",
        manifestPath: "manifest.json",
        inputs: ["a"],
        revision: "r1",
        digest: "f".repeat(64),
      },
      reference: { hidden: [] },
      cases: [{
        ...completeCase,
        comparisonRegion: { x: 0, y: 0, width: 10, height: 10, measure: 42 },
      }],
    })).toContain("case comparison region measure must be a selector");

    expect(baselineMetadataIssues({
      schemaVersion: 2,
      source: {
        fileId: "paper",
        pageId: "page-1",
        manifestPath: "manifest.json",
        inputs: ["a"],
        revision: "r1",
        digest: "f".repeat(64),
      },
      reference: { hidden: [] },
      cases: [{ ...completeCase, comparisonMask: "baseline-content" }],
    })).toContain("case declares an unsupported comparisonMask");

    const baseManifest = {
      schemaVersion: 2,
      source: {
        fileId: "paper",
        pageId: "page-1",
        manifestPath: "manifest.json",
        inputs: ["a"],
        revision: "r1",
        digest: "f".repeat(64),
      },
      reference: { hidden: [] },
      cases: [{
        id: "case",
        reference: "specimen",
        imagePath: "case.png",
        imageSha256: "a".repeat(64),
        comparisonRegion: { x: 0, y: 0, width: 10, height: 10 },
      }],
    };
    const replacedImage = {
      ...baseManifest,
      cases: [{ ...baseManifest.cases[0], imageSha256: "b".repeat(64) }],
    };
    expect(baselineMutationIssues(replacedImage, baseManifest)).toEqual([
      "case metadata changed without refreshed immutable Paper source identity",
    ]);
    expect(baselineMutationIssues({
      ...baseManifest,
      cases: [{
        ...baseManifest.cases[0],
        comparisonRegion: { x: 0, y: 0, width: 1, height: 1 },
      }],
    }, baseManifest)).toEqual([
      "case metadata changed without refreshed immutable Paper source identity",
    ]);
    expect(baselineMutationIssues({ ...baseManifest, cases: [] }, baseManifest))
      .toEqual([
        "case removed without refreshed immutable Paper source identity",
      ]);
    expect(baselineMutationIssues({
      ...baseManifest,
      cases: [...baseManifest.cases, { id: "new-case" }],
    }, baseManifest)).toEqual([
      "new-case added without refreshed immutable Paper source identity",
    ]);
    expect(baselineMutationIssues({
      ...baseManifest,
      cases: [{ ...baseManifest.cases[0], fixtureRevision: "new" }],
    }, baseManifest)).toEqual([
      "case metadata changed without refreshed immutable Paper source identity",
    ]);
    expect(baselineMutationIssues({
      ...replacedImage,
      source: {
        ...replacedImage.source,
        revision: "r2",
        digest: "e".repeat(64),
      },
    }, baseManifest)).toEqual([]);
  });

  test("separates an introduced Paper baseline from a mutated one", () => {
    const baseManifest = {
      schemaVersion: 2,
      source: {
        fileId: "paper",
        pageId: "page-1",
        manifestPath: "manifest.json",
        inputs: ["a"],
        revision: "r1",
        digest: "f".repeat(64),
      },
      reference: { hidden: [] },
      cases: [{
        id: "case",
        reference: "specimen",
        imagePath: "case.png",
        imageSha256: "a".repeat(64),
      }],
    };
    const refreshed = {
      ...baseManifest,
      source: {
        ...baseManifest.source,
        revision: "r2",
        digest: "e".repeat(64),
      },
    };
    const tunedAfterRefresh = {
      ...refreshed,
      cases: [{ ...baseManifest.cases[0], imageSha256: "b".repeat(64) }],
    };
    const revisionOnly = {
      ...tunedAfterRefresh,
      source: { ...baseManifest.source, revision: "r2" },
    };
    const digestOnly = {
      ...tunedAfterRefresh,
      source: { ...baseManifest.source, digest: "e".repeat(64) },
    };
    const sameIdentityEdited = {
      ...baseManifest,
      cases: [{ ...baseManifest.cases[0], imageSha256: "b".repeat(64) }],
    };

    expect(sourceRefreshed(baseManifest, baseManifest)).toBe(false);
    expect(sourceRefreshed(revisionOnly, baseManifest)).toBe(false);
    expect(sourceRefreshed(digestOnly, baseManifest)).toBe(false);
    expect(sourceRefreshed(refreshed, baseManifest)).toBe(true);

    // Every one-field or unchanged identity stays compared with the merge base.
    for (const unrefreshed of [sameIdentityEdited, revisionOnly, digestOnly]) {
      expect(predecessorManifest(baseManifest, unrefreshed)).toBe(baseManifest);
      expect(baselineProvenance(
        unrefreshed,
        predecessorManifest(
          baseManifest,
          unrefreshed,
        ),
      )).toEqual({
        status: "blocked",
        issues: [
          "case metadata changed without refreshed immutable Paper source identity",
        ],
      });
    }

    // A genuine two-field refresh becomes the predecessor for later edits.
    expect(predecessorManifest(baseManifest, refreshed)).toBe(refreshed);
    expect(baselineProvenance(refreshed, baseManifest).status).toBe("passed");
    expect(baselineProvenance(tunedAfterRefresh, refreshed)).toEqual({
      status: "blocked",
      issues: [
        "case metadata changed without refreshed immutable Paper source identity",
      ],
    });

    // Introduction is reported, not silently passed and not blocked forever.
    expect(predecessorManifest(null, baseManifest)).toBeNull();
    expect(predecessorManifest(baseManifest, null)).toBe(baseManifest);
    const introduced = baselineProvenance(baseManifest, null);
    expect(introduced.status).toBe("introduced");
    expect(introduced.issues).toBeUndefined();
    expect(introduced.notes?.join(" ")).toContain("no predecessor");
    expect(baselineProvenance(baseManifest, baseManifest).status).toBe(
      "passed",
    );
  });

  test("profile introduction cannot use caller-supplied absence or a global refresh", async () => {
    const profileManifest = JSON.parse(
      await readFile(
        new URL(
          "../../../docs/technical-design/ui-baselines/paper-baselines.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const refreshed = {
      ...profileManifest,
      source: {
        ...profileManifest.source,
        revision: "fake refresh",
        digest: "f".repeat(64),
      },
    };
    for (const predecessor of [null, profileManifest]) {
      expect(baselineProvenance(refreshed, predecessor)).toEqual({
        status: "blocked",
        issues: ["Profile provenance requires trusted repository history"],
      });
    }
    // Introduction does not alter coverage or compatibility.
    const designCase = profileManifest.cases.find((
      entry: { sourceProfile?: string },
    ) => entry.sourceProfile === "K-0");
    expect((await baselineInputIssues(designCase)).length).toBeGreaterThan(0);
    expect(designCompatibilityIssues({}, designCase).length).toBeGreaterThan(0);
  });

  test("keeps Paper-linked cases in changed capture selection", () => {
    const runtimeCases = [
      { id: "changed" },
      { id: "paper", paperBaselineId: "paper-baseline" },
      { id: "unrelated" },
    ];
    expect(includePaperCases(runtimeCases, [runtimeCases[0]])).toEqual([
      runtimeCases[0],
      runtimeCases[1],
    ]);
  });

  test("qualifies dirty source commits with a deterministic diff digest", () => {
    expect(sourceIdentity("head", "")).toEqual({
      sourceCommit: "head",
      sourceDirty: false,
      sourceDiffDigest: null,
    });
    const dirty = sourceIdentity("head", "tracked change");
    expect(dirty.sourceDirty).toBe(true);
    expect(dirty.sourceDiffDigest).toMatch(/^[a-f0-9]{64}$/);
    const untracked = sourceIdentity("head", "", "new-file.ts\0file-digest");
    expect(untracked.sourceDirty).toBe(true);
    expect(untracked.sourceDiffDigest).not.toBe(dirty.sourceDiffDigest);
  });

  test("fails closed when changed-path discovery fails", () => {
    expect(() => changedPaths({ baseRef: "definitely-missing" }))
      .toThrow(/Unable to discover changed paths/);
  });

  test("pins changed-path discovery to a captured base sha", () => {
    const baseSha = "a".repeat(40);
    const calls: unknown[][] = [];
    const git = (...args: unknown[]) => {
      calls.push([args[0], args[1]]);
      return "packages/ui/src/atoms/Button.tsx\n";
    };
    const result = changedPaths({ baseSha, git });
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", `${baseSha}...HEAD`]],
    ]);
    expect(result).toEqual(["packages/ui/src/atoms/Button.tsx"]);
  });

  test("rejects a malformed captured base sha", () => {
    expect(() => changedPaths({ baseSha: "not-a-sha" }))
      .toThrow("BAKERY_CAPTURE_BASE_SHA_INVALID");
  });

  test("bounds concurrent design captures on shared runners", () => {
    expect(captureConcurrency({})).toBe(1);
    expect(captureConcurrency({ BAKERY_CAPTURE_JOBS: "1" })).toBe(1);
    expect(captureConcurrency({ BAKERY_CAPTURE_JOBS: "2" })).toBe(2);
    expect(captureConcurrency({ BAKERY_CAPTURE_JOBS: "64" })).toBe(4);
    expect(captureConcurrency({ BAKERY_CAPTURE_JOBS: "0" })).toBe(1);
  });

  test("re-renders references unless the base already proved every input", () => {
    const baseSha = "b".repeat(40);
    const baseline = {
      source: { inputs: ["docs/technical-design/auth-mocks/auth.css"] },
      cases: [{
        reference: "design",
        imagePath: "docs/technical-design/ui-baselines/paper/design/a.png",
      }],
    };
    const gitReporting = (changed: string[]) => () => changed.join("\0");
    // A main push has no base: always re-render.
    expect(referenceRenderProvedAt(baseline, undefined, gitReporting([])))
      .toBeNull();
    expect(() => referenceRenderProvedAt(baseline, "nope", gitReporting([])))
      .toThrow("BAKERY_CAPTURE_BASE_SHA_INVALID");
    // Unrelated app work reuses the base's re-render.
    expect(referenceRenderProvedAt(
      baseline,
      baseSha,
      gitReporting(["apps/web/src/pages/SignInPage.tsx", "scripts/x.ts"]),
    )).toBe(baseSha);
    // Any reference input - source, manifest, PNG, renderer, scorer - forces it.
    for (
      const changed of [
        "docs/technical-design/auth-mocks/auth.css",
        "docs/technical-design/ui-baselines/paper-baselines.json",
        "docs/technical-design/ui-baselines/paper/design/a.png",
        "packages/ui/scripts/render-paper-references.mjs",
        "packages/ui/scripts/image-score.mjs",
      ]
    ) {
      expect(
        referenceRenderProvedAt(baseline, baseSha, gitReporting([changed])),
      )
        .toBeNull();
    }
  });

  test("never reuses base proof for dirty or untracked reference inputs", () => {
    const baseSha = "b".repeat(40);
    const input = "docs/technical-design/mock/input with\nnewline.css";
    const baseline = { source: { inputs: [input] }, cases: [] };
    const queries = [
      ["diff", "--name-only", "-z", `${baseSha}...HEAD`],
      ["diff", "--name-only", "-z", "HEAD"],
      [
        "ls-files",
        "--others",
        "-z",
        "--",
        ...[...designReferenceInputs(baseline)].map((path) =>
          `:(top,literal)${path}`
        ),
      ],
    ];
    for (const changedQuery of queries) {
      const calls: unknown[] = [];
      const git = (...args: unknown[]) => {
        calls.push(args[1]);
        return JSON.stringify(args[1]) === JSON.stringify(changedQuery)
          ? `${input}\0`
          : "";
      };
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      expect(calls).toEqual(queries);
    }
  });

  test("real Git detects ignored declared inputs using bounded literal pathspecs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reference-proof-"));
    const runGit = (args: string[]) =>
      execFileSync("git", [
        "-c",
        "user.name=Reference proof test",
        "-c",
        "user.email=reference-proof@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ], {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
    const git = (...args: unknown[]) => {
      const parameters = args[1];
      if (
        !Array.isArray(parameters) ||
        !parameters.every((entry): entry is string => typeof entry === "string")
      ) throw new Error("invalid Git arguments");
      return runGit(parameters);
    };
    try {
      runGit(["init", "--quiet", "--initial-branch=main", "--template="]);
      await writeFile(join(directory, ".gitignore"), "ignored/\n");
      await writeFile(join(directory, "tracked.css"), "original\n");
      runGit(["add", ".gitignore", "tracked.css"]);
      runGit(["commit", "--quiet", "-m", "Initial fixture"]);
      const baseSha = runGit(["rev-parse", "HEAD"]).trim();
      const input = "ignored/reference[1].css";
      const baseline = {
        source: { inputs: [input, "tracked.css", "new.css"] },
        cases: [],
      };
      await mkdir(join(directory, "ignored"));
      // A glob would match this unrelated ignored file; a literal must not.
      await writeFile(join(directory, "ignored/reference1.css"), "unrelated\n");
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBe(baseSha);
      await writeFile(join(directory, input), "rendered but ignored\n");
      expect(runGit(["ls-files", "--others", "--exclude-standard", "-z"]))
        .toBe("");
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      await rm(join(directory, input));
      await writeFile(join(directory, "new.css"), "untracked input\n");
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      await rm(join(directory, "new.css"));
      await writeFile(join(directory, "tracked.css"), "changed\n");
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      runGit(["add", "tracked.css"]);
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      runGit(["commit", "--quiet", "-m", "Changed fixture"]);
      expect(referenceRenderProvedAt(baseline, baseSha, git)).toBeNull();
      const current = runGit(["rev-parse", "HEAD"]).trim();
      expect(referenceRenderProvedAt(baseline, current, git)).toBe(current);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when dirty reference discovery fails", () => {
    const baseSha = "b".repeat(40);
    const baseline = { source: { inputs: [] }, cases: [] };
    for (const failingQuery of ["HEAD", "--others"]) {
      const git = (...args: unknown[]) => {
        if (
          Array.isArray(args[1]) && args[1].includes(failingQuery)
        ) throw new Error("reference input discovery failed");
        return "";
      };
      expect(() => referenceRenderProvedAt(baseline, baseSha, git))
        .toThrow("reference input discovery failed");
    }
  });

  test("bounds read-only raster probes and retains only the three diagnostic comparisons", () => {
    const calls: unknown[][] = [];
    const run = (...args: unknown[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "observed version or font" };
    };
    const result = Object.freeze({
      id: "list.default.light.desktop",
      score: 0.9407,
      inkScore: 0.9407,
      surfaceScore: 1,
      inkCoverage: 0.2,
      surfaceCoverage: 0.8,
      imageBytes: "must not copy images",
    });
    const diagnostic = paperRasterDiagnostics([
      result,
      { id: "unrelated", score: 1 },
    ], run);
    expect(calls.map(([command, args]) => [command, args])).toEqual([
      ["uname", ["-sr"]],
      ["lsb_release", ["-ds"]],
      ["fc-match", ["-V"]],
      ["pkg-config", ["--modversion", "freetype2"]],
      ["dpkg-query", [
        "--show",
        "--showformat=${binary:Package}=${Version}\\n",
        "fontconfig",
        "libfontconfig1",
        "libfreetype6",
      ]],
      ...["sans-serif", "monospace", "system-ui"].map((pattern) => [
        "fc-match",
        ["--format=%{family}\\t%{file}\\t%{hintstyle}\\t%{rgba}\\n", pattern],
      ]),
    ]);
    for (const [, , options] of calls) {
      expect(options).toEqual({
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    const notCompared = (id: string) => ({
      id,
      compared: false,
      score: null,
      inkScore: null,
      surfaceScore: null,
      inkCoverage: null,
      surfaceCoverage: null,
    });
    expect(diagnostic.referenceComparisons).toEqual([
      {
        id: result.id,
        compared: true,
        score: 0.9407,
        inkScore: 0.9407,
        surfaceScore: 1,
        inkCoverage: 0.2,
        surfaceCoverage: 0.8,
      },
      notCompared("list.default.dark.desktop"),
      notCompared("detail.default.light.desktop"),
    ]);
    expect(diagnostic).not.toHaveProperty("status");
    expect(diagnostic).not.toHaveProperty("threshold");
    expect(JSON.stringify(diagnostic)).not.toContain("must not copy images");
    expect(result.score).toBe(0.9407);
    expect(comparisonStatus(result.score)).toBe("failed");
  });

  test("unavailable or oversized raster diagnostics do not leak command errors", () => {
    const secret = "unbounded command failure details";
    for (
      const run of [
        () => ({ status: 1, stderr: secret }),
        () => ({ status: null, error: new Error(secret) }),
        () => {
          throw new Error(secret);
        },
      ]
    ) {
      const diagnostic = paperRasterDiagnostics([], run);
      expect(JSON.stringify(diagnostic)).toContain("unavailable");
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
    }
    const diagnostic = paperRasterDiagnostics([], () => ({
      status: 0,
      stdout: "x".repeat(8192),
    }));
    expect(JSON.stringify(diagnostic)).not.toContain("x".repeat(4097));
  });

  test("slow or failed diagnostics cannot change acceptance at the four-hour boundary", () => {
    const realNow = Date.now;
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const budget = 4 * 60 * 60 * 1000;
    try {
      for (const offset of [-1, 0, 1]) {
        for (const cycle of [1, 3]) {
          for (const caseStatus of ["passed", "failed"]) {
            const run = (mode: "disabled" | "slow" | "throw") => {
              let clock = start + budget + offset;
              Date.now = () => clock;
              const report: Record<string, unknown> = {
                startedAt: new Date(start).toISOString(),
                cycle,
                threshold: 0.95,
                status: "blocked",
                results: [{ baselineId: "reference", status: caseStatus }],
              };
              const probeStatuses: unknown[] = [];
              finalizePaperComparison(
                report,
                { cases: [{ id: "reference" }] },
                new Map([["reference", {}]]),
                mode === "disabled" ? undefined : () => {
                  if (mode === "throw") {
                    clock += 16000;
                    throw new Error("private collection error");
                  }
                  return paperRasterDiagnostics([], () => {
                    probeStatuses.push(report.status);
                    clock += 2000;
                    return {
                      status: null,
                      error: new Error("probe timed out"),
                    };
                  });
                },
              );
              const { rasterDiagnostics, ...acceptance } = report;
              return { acceptance, rasterDiagnostics, clock, probeStatuses };
            };
            const disabled = run("disabled");
            expect(disabled.acceptance.status).toBe(
              offset <= 0 && caseStatus === "passed" ? "passed" : "blocked",
            );
            for (const mode of ["slow", "throw"] as const) {
              const enabled = run(mode);
              expect(enabled.clock).toBeGreaterThan(start + budget);
              expect(enabled.acceptance).toEqual(disabled.acceptance);
              expect(JSON.stringify(enabled.rasterDiagnostics))
                .not.toContain("private collection error");
              if (mode === "slow") {
                expect(enabled.probeStatuses)
                  .toEqual(Array(8).fill(disabled.acceptance.status));
              } else {
                expect(enabled.rasterDiagnostics).toMatchObject({
                  status: "unavailable",
                });
              }
            }
          }
        }
      }
    } finally {
      Date.now = realNow;
    }
  });

  test("captures the full matrix for mixed shared changes", () => {
    const { runtimeCases, selected } = selectFixture([
      "packages/ui/src/atoms/Button.tsx",
      "packages/ui/src/controls.css",
    ]);
    expect(selected).toEqual(runtimeCases);
  });

  test("selects only the owning entry for a lone story change", () => {
    const { runtimeCases, selected } = selectFixture([
      "packages/ui/src/atoms/Button.stories.tsx",
    ]);
    expect(selected).toEqual([runtimeCases[0]]);
  });

  test("captures the full matrix for a shared component source change", () => {
    const { runtimeCases, selected } = selectFixture([
      "packages/ui/src/atoms/Button.tsx",
    ]);
    expect(selected).toEqual(runtimeCases);
  });

  for (
    const path of [
      "docs/technical-design/ui-baselines/components.json",
      "docs/technical-design/ui-baselines/paper-baselines.json",
      ".github/workflows/ci.yml",
    ]
  ) {
    test(`captures the full matrix for ${path}`, () => {
      const { runtimeCases, selected } = selectFixture([path]);
      expect(selected).toEqual(runtimeCases);
    });
  }

  test("captures the full matrix for a web fixture change", () => {
    const { runtimeCases, selected } = selectFixture([
      "apps/web/src/fixtures/settings.tsx",
    ]);
    expect(selected).toEqual(runtimeCases);
  });

  test("stops at the three-cycle convergence budget", () => {
    expect(() => validateCycle(1)).not.toThrow();
    expect(() => validateCycle(3)).not.toThrow();
    expect(() => validateCycle(4)).toThrow(/outside the supported/);
  });

  test("admits cycle four only through the entitlements maximum-four opt-in", () => {
    for (const cycle of [1, 2, 3]) {
      expect(() => validateCycle(cycle, { maxCycles: 3 })).not.toThrow();
      expect(() =>
        validateCycle(cycle, {
          manifestName: "entitlements",
          maxCycles: 4,
        })
      ).toThrow(/only for entitlements convergence cycle 4/);
    }

    expect(() =>
      validateCycle(4, { manifestName: "entitlements", maxCycles: 4 })
    ).not.toThrow();
    expect(() => validateCycle(4, { manifestName: "entitlements" }))
      .toThrow(/outside the supported/);

    for (const manifestName of ["auth", "enterprise", "settings"]) {
      expect(() => validateCycle(4, { manifestName, maxCycles: 4 }))
        .toThrow(/only for entitlements convergence cycle 4/);
    }
    expect(() =>
      validateCycle(5, { manifestName: "entitlements", maxCycles: 4 })
    ).toThrow(/only for entitlements convergence cycle 4/);

    for (const cycle of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => validateCycle(cycle)).toThrow(/finite integer/);
    }
    for (
      const maxCycles of [
        2,
        7,
        3.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]
    ) {
      expect(() => validateCycle(1, { maxCycles })).toThrow(/unsupported/);
    }
  });

  test("parses and forwards only a valid explicit cycle-four budget", () => {
    expect(parseArguments([])).toEqual({
      candidatePath: undefined,
      cycle: 1,
      maxCycles: 3,
      startedAt: undefined,
      only: [],
      manifestName: "auth",
    });
    expect(
      parseArguments([
        "--manifest",
        "entitlements",
        "--cycle",
        "4",
        "--max-cycles",
        "4",
      ]),
    ).toMatchObject({
      cycle: 4,
      maxCycles: 4,
      manifestName: "entitlements",
    });

    expect(() => parseArguments(["--max-cycles"]))
      .toThrow(/requires a value/);
    expect(() => parseArguments(["--max-cycles", "3", "--max-cycles", "3"]))
      .toThrow(/only be provided once/);
    for (const value of ["2", "3.5", "not-a-number"]) {
      expect(() => parseArguments(["--max-cycles", value]))
        .toThrow(/unsupported/);
    }
    expect(() => parseArguments(["--cycle", "1.5"]))
      .toThrow(/finite integer/);
    expect(() =>
      parseArguments([
        "--manifest",
        "auth",
        "--cycle",
        "4",
        "--max-cycles",
        "4",
      ])
    ).toThrow(/only for entitlements convergence cycle 4/);
  });

  test("admits cycle five only through the entitlements maximum-five opt-in", () => {
    expect(() => validateCycle(5, { manifestName: "entitlements" }))
      .toThrow(/outside the supported/);
    expect(() =>
      validateCycle(5, { manifestName: "entitlements", maxCycles: 5 })
    ).not.toThrow();

    for (const cycle of [1, 2, 3, 4]) {
      expect(() =>
        validateCycle(cycle, {
          manifestName: "entitlements",
          maxCycles: 5,
        })
      ).toThrow(/only for entitlements convergence cycle 5/);
    }
    for (const manifestName of ["auth", "enterprise", "settings"]) {
      expect(() => validateCycle(5, { manifestName, maxCycles: 5 }))
        .toThrow(/only for entitlements convergence cycle 5/);
    }
    expect(() =>
      validateCycle(6, { manifestName: "entitlements", maxCycles: 5 })
    ).toThrow(/only for entitlements convergence cycle 5/);
  });

  test("parses only a valid explicit cycle-five budget", () => {
    expect(
      parseArguments([
        "--manifest",
        "entitlements",
        "--cycle",
        "5",
        "--max-cycles",
        "5",
      ]),
    ).toMatchObject({
      cycle: 5,
      maxCycles: 5,
      manifestName: "entitlements",
    });

    expect(() => parseArguments(["--manifest", "entitlements", "--cycle", "5"]))
      .toThrow(/outside the supported/);
    expect(() => parseArguments(["--max-cycles", "5"]))
      .toThrow(/only for entitlements convergence cycle 5/);
    expect(() => parseArguments(["--max-cycles"]))
      .toThrow(/requires a value/);
    expect(() => parseArguments(["--max-cycles", "5", "--max-cycles", "5"]))
      .toThrow(/only be provided once/);
    expect(() => parseArguments(["--max-cycles", "7"]))
      .toThrow(/unsupported/);
    expect(() =>
      parseArguments([
        "--manifest",
        "auth",
        "--cycle",
        "5",
        "--max-cycles",
        "5",
      ])
    ).toThrow(/only for entitlements convergence cycle 5/);
  });

  test("admits cycle six only through the entitlements maximum-six opt-in", () => {
    expect(() => validateCycle(6, { manifestName: "entitlements" }))
      .toThrow(/outside the supported/);
    expect(() =>
      validateCycle(6, { manifestName: "entitlements", maxCycles: 6 })
    ).not.toThrow();

    for (const cycle of [1, 2, 3, 4, 5]) {
      expect(() =>
        validateCycle(cycle, {
          manifestName: "entitlements",
          maxCycles: 6,
        })
      ).toThrow(/only for entitlements convergence cycle 6/);
    }
    for (const manifestName of ["auth", "enterprise", "settings"]) {
      expect(() => validateCycle(6, { manifestName, maxCycles: 6 }))
        .toThrow(/only for entitlements convergence cycle 6/);
    }
  });

  test("parses only a valid explicit cycle-six budget", () => {
    expect(
      parseArguments([
        "--manifest",
        "entitlements",
        "--cycle",
        "6",
        "--max-cycles",
        "6",
      ]),
    ).toMatchObject({
      cycle: 6,
      maxCycles: 6,
      manifestName: "entitlements",
    });

    expect(() => parseArguments(["--manifest", "entitlements", "--cycle", "6"]))
      .toThrow(/outside the supported/);
    expect(() => parseArguments(["--max-cycles", "6"]))
      .toThrow(/only for entitlements convergence cycle 6/);
    expect(() => parseArguments(["--max-cycles"]))
      .toThrow(/requires a value/);
    expect(() => parseArguments(["--max-cycles", "6", "--max-cycles", "6"]))
      .toThrow(/only be provided once/);
    expect(() => parseArguments(["--max-cycles", "7"]))
      .toThrow(/unsupported/);
    expect(() =>
      parseArguments([
        "--manifest",
        "auth",
        "--cycle",
        "6",
        "--max-cycles",
        "6",
      ])
    ).toThrow(/only for entitlements convergence cycle 6/);
  });
});

const plannedLedger = {
  entries: [
    {
      routeId: "tasks",
      path: "/tasks",
      status: "planned",
      rationale: "Route ships on a later branch.",
      manifest: "enterprise",
      cases: ["queue.default.light.desktop"],
    },
    {
      routeId: "task-detail",
      path: "/tasks/$taskId",
      status: "baselined",
      manifest: "enterprise",
      cases: ["session.default.light.desktop"],
    },
    {
      routeId: "login",
      path: "/sign-in",
      status: "planned",
      manifest: "auth",
      cases: ["login.default.light.desktop"],
    },
  ],
};

const enterpriseCases = [
  { id: "queue.default.light.desktop", imagePath: "queue.png" },
  { id: "session.default.light.desktop", imagePath: "session.png" },
  { id: "brand-new.default.light.desktop", imagePath: "new.png" },
];

const enterpriseBase = {
  cases: enterpriseCases.slice(0, 2),
};

function selectDesign(paths: string[], baseManifest: unknown = enterpriseBase) {
  return selectDesignCases({
    designCases: enterpriseCases,
    manifestName: "enterprise",
    paths,
    baseManifest: baseManifest as { cases?: Array<Record<string, unknown>> },
    manifest: {
      source: {
        inputs: ["docs/technical-design/enterprise-mocks/site/index.html"],
        manifestPath:
          "docs/technical-design/enterprise-mocks/paper-source/source-manifest.json",
      },
    },
    ledger: plannedLedger,
    manifestRepoPath:
      "docs/technical-design/ui-baselines/enterprise-baselines.json",
  }).map((entry) => entry.id);
}

test.describe("manifest selection and planned routes", () => {
  test("resolves manifest profiles and per-manifest artifact paths", () => {
    expect(manifestProfile().baselineRepoPath).toBe(
      "docs/technical-design/ui-baselines/paper-baselines.json",
    );
    expect(manifestProfile("enterprise").baselineRepoPath).toBe(
      "docs/technical-design/ui-baselines/enterprise-baselines.json",
    );
    expect(() => manifestProfile("nope")).toThrow(/unknown manifest/);
    expect(artifactsDirectoryFor("/a", "auth")).toBe("/a");
    expect(artifactsDirectoryFor("/a", "enterprise")).toBe("/a/enterprise");
  });

  test("maps planned ledger entries to their cases per manifest", () => {
    expect([...plannedCases(plannedLedger, "enterprise").keys()]).toEqual([
      "queue.default.light.desktop",
    ]);
    // The auth manifest can never defer scoring, whatever the ledger says.
    expect([...plannedCases(plannedLedger, "auth").keys()]).toEqual([]);
  });

  test("reports a planned case as accepted but not passed, with its reason", () => {
    const [entry] = plannedLedger.entries;
    const result = plannedResult(enterpriseCases[0], entry);
    expect(result.status).toBe("planned");
    expect(result.reason).toBe("Route ships on a later branch.");
    expect(result.route).toBe("/tasks");
    expect(result.description.observed).toMatch(/no capture/);
    expect(accepted(result, "enterprise")).toBe(true);
    // Auth can never defer scoring: a forced planned result fails there.
    expect(accepted(result)).toBe(false);
    expect(accepted(result, "auth")).toBe(false);
    expect(accepted({ status: "failed" })).toBe(false);
    expect(accepted({ status: "blocked" })).toBe(false);
    // A capture that exists is still not scored while the route is planned.
    expect(
      plannedResult(enterpriseCases[0], entry, { id: "x" }).description
        .observed,
    ).toMatch(/not scored/);
  });

  test("a planned case does not fail on a missing capture, a baselined one does", async () => {
    const planned = plannedCases(plannedLedger, "enterprise");
    expect(planned.has("queue.default.light.desktop")).toBe(true);
    expect(planned.has("session.default.light.desktop")).toBe(false);
    // The planned path never reaches input checks; the same missing capture
    // for any other case still blocks.
    await expect(
      baselineInputIssues(enterpriseCases[1] as never, undefined),
    ).resolves.toContain("missing required runtime capture");
  });

  test("maps debt ledger frames to enterprise design cases, never auth", () => {
    const manifest = {
      cases: [
        {
          id: "session.default.light.desktop",
          reference: "design",
          frameId: "HU-0",
        },
        {
          id: "session.default.light.phone",
          reference: "design",
          frameId: "P6-0",
        },
        {
          id: "queue.default.light.desktop",
          reference: "design",
          frameId: "5J-0",
        },
      ],
    };
    const ledger = {
      entries: [
        {
          routeId: "task-detail",
          path: "/tasks/$taskId",
          status: "debt",
          frames: [{ frameId: "HU-0" }, { frameId: "P6-0" }],
        },
        // Planned and baselined entries own cases, not debt frames.
        ...plannedLedger.entries,
      ],
    };
    expect([...debtCases(ledger, manifest).keys()]).toEqual([
      "session.default.light.desktop",
      "session.default.light.phone",
    ]);
    expect([...debtCases(ledger, manifest, "enterprise").keys()]).toHaveLength(
      2,
    );
    expect(debtCases(ledger, manifest, "auth").size).toBe(0);
    expect(debtCases(null, manifest).size).toBe(0);
    expect(debtCases(ledger, null).size).toBe(0);
  });

  test("reports a debt case as accepted for enterprise only, not scored", () => {
    const entry = {
      routeId: "task-detail",
      path: "/tasks/$taskId",
      rationale: "No honest golden yet.",
    };
    const result = debtResult(enterpriseCases[1], entry);
    expect(result.status).toBe("debt");
    expect(result.reason).toBe("No honest golden yet.");
    expect(result.description.observed).toMatch(/no capture/);
    expect(accepted(result, "enterprise")).toBe(true);
    expect(accepted(result, "auth")).toBe(false);
    expect(accepted(result)).toBe(false);
    expect(
      debtResult(enterpriseCases[1], entry, { id: "x" }).description.observed,
    )
      .toMatch(/not scored/);
  });

  test("counts debt in coverage and does not report its missing capture", () => {
    const report: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      cycle: 1,
      threshold: 0.95,
      status: "blocked",
      results: [
        { baselineId: "queue.default.light.desktop", status: "passed" },
        { baselineId: "session.default.light.desktop", status: "debt" },
        { baselineId: "session.default.light.phone", status: "debt" },
      ],
    };
    const debt = new Map([
      ["session.default.light.desktop", {}],
      ["session.default.light.phone", {}],
    ]);
    finalizePaperComparison(
      report,
      {
        cases: [
          { id: "queue.default.light.desktop" },
          { id: "session.default.light.desktop" },
          { id: "session.default.light.phone" },
        ],
      },
      new Map([["queue.default.light.desktop", {}]]),
      undefined,
      { manifestName: "enterprise", debt },
    );
    expect(report.status).toBe("passed");
    expect(report.coverage).toMatchObject({ debt: 2, missing: [], failed: 0 });
    // Auth never accepts a debt result.
    const auth: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      cycle: 1,
      threshold: 0.95,
      status: "blocked",
      results: [{ baselineId: "a", status: "debt" }],
    };
    finalizePaperComparison(auth, { cases: [{ id: "a" }] }, new Map());
    expect(auth.status).toBe("blocked");
  });

  test("reports an unselected changed-run case as accepted and distinct", () => {
    const result = notSelectedResult(enterpriseCases[1]);
    expect(result.status).toBe("not-selected");
    expect(accepted(result, "enterprise")).toBe(true);
    expect(accepted(result, "auth")).toBe(false);
  });

  test("a baselined enterprise case is never reported not-selected", () => {
    const baselined = baselinedCases(plannedLedger, "enterprise");
    expect([...baselined]).toEqual(["session.default.light.desktop"]);
    // Auth cases are never ledger-baselined for narrowing purposes.
    expect(baselinedCases(plannedLedger, "auth").size).toBe(0);
    const selected = new Set(["brand-new.default.light.desktop"]);
    const session = {
      id: "session.default.light.desktop",
      reference: "design",
    };
    const other = { id: "other.default.light.desktop", reference: "design" };
    // The narrowed run omits the baselined case: it must be scored, not skipped.
    expect(isNotSelected(session, selected, baselined, false)).toBe(false);
    // A non-ledger case outside the selection may still be not-selected.
    expect(isNotSelected(other, selected, baselined, false)).toBe(true);
    // Captured or full (no selection) runs never report not-selected.
    expect(isNotSelected(other, selected, baselined, true)).toBe(false);
    expect(isNotSelected(other, null, baselined, false)).toBe(false);
  });

  test("changed selection always selects baselined enterprise cases", () => {
    // Nothing changed, base has every case: the baselined case is still taken.
    expect(selectDesign(["README.md"], { cases: enterpriseCases })).toEqual([
      "session.default.light.desktop",
    ]);
    expect(selectDesign(["apps/web/src/pages/SignInPage.tsx"], {
      cases: enterpriseCases,
    })).toEqual(["session.default.light.desktop"]);
  });

  test("changed selection picks a brand-new case", () => {
    expect(selectDesign(["README.md"])).toEqual([
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
    // Without a merge-base manifest every case counts as new.
    expect(selectDesign(["README.md"], null)).toEqual([
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
  });

  test("changed selection never selects a planned case", () => {
    expect(selectDesign(["apps/web/src/screens/tasks/Queue.tsx"])).not
      .toContain("queue.default.light.desktop");
  });

  test("changed selection picks cases whose reference inputs changed", () => {
    const base = {
      cases: enterpriseCases.slice(0, 2).map((entry) => ({ ...entry })),
    };
    // One PNG: only that case.
    expect(selectDesign(["session.png"], base)).toEqual([
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
    // A pinned source file or the generator: every non-planned case.
    expect(
      selectDesign(["docs/technical-design/enterprise-mocks/site/index.html"], {
        cases: enterpriseCases,
      }),
    ).toEqual([
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
    // An edited manifest entry selects just the edited case.
    const edited = {
      cases: [
        enterpriseCases[0],
        { ...enterpriseCases[1], imagePath: "old.png" },
        enterpriseCases[2],
      ],
    };
    expect(
      selectDesign(
        ["docs/technical-design/ui-baselines/enterprise-baselines.json"],
        edited,
      ),
    ).toEqual(["session.default.light.desktop"]);
  });

  test("changed selection picks the case of a ledger route whose module changed", () => {
    const base = { cases: enterpriseCases };
    expect(selectDesign(["apps/web/src/pages/TaskDetailPage.tsx"], base))
      .toEqual(["session.default.light.desktop"]);
    expect(selectDesign(["apps/web/src/pages/SignInPage.tsx"], base))
      .toEqual(["session.default.light.desktop"]);
    expect(
      routeOwnedPaths(
        { routeId: "task-detail", path: "/tasks/$taskId" },
        ["apps/web/src/screens/tasks/List.tsx", "packages/ui/src/tasks.ts"],
      ),
    ).toEqual(["apps/web/src/screens/tasks/List.tsx"]);
  });

  test("changed selection takes every non-planned case on a shared change", () => {
    expect(selectDesign(["packages/ui/src/atoms/Button.tsx"], {
      cases: enterpriseCases,
    })).toEqual([
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
  });

  test("changed selection treats shared shell, router, i18n, contracts and ledger edits as global", () => {
    const base = { cases: enterpriseCases };
    const all = [
      "session.default.light.desktop",
      "brand-new.default.light.desktop",
    ];
    for (
      const path of [
        "apps/web/src/shell/AppLayout.tsx",
        "apps/web/src/router.tsx",
        "apps/web/src/app/providers.tsx",
        "apps/web/src/main.tsx",
        "apps/web/src/index.css",
        "packages/i18n/src/en.ts",
        "packages/contracts/src/index.ts",
        "docs/technical-design/ui-baselines/tokens.json",
        "docs/technical-design/ui-baselines/paper-tokens.json",
        "docs/technical-design/ui-baselines/route-references.json",
      ]
    ) {
      expect(selectDesign([path], base), path).toEqual(all);
    }
    // Unrelated edits still select only the always-selected baselined case.
    expect(selectDesign(["README.md"], base)).toEqual([
      "session.default.light.desktop",
    ]);
  });

  test("enterprise reference inputs include the generator and its manifest", () => {
    const inputs = designReferenceInputs(
      {
        source: {
          inputs: ["docs/technical-design/enterprise-mocks/site/index.html"],
        },
        cases: [],
      },
      "enterprise",
    );
    expect(inputs.has(
      "docs/technical-design/ui-baselines/enterprise-baselines.json",
    )).toBe(true);
    expect(inputs.has("packages/ui/scripts/paper-jsx-to-html.mjs")).toBe(true);
    expect(
      designReferenceInputs({ cases: [] }).has(
        "docs/technical-design/ui-baselines/paper-baselines.json",
      ),
    ).toBe(true);
    expect(
      designReferenceInputs({ cases: [] }).has(
        "packages/ui/scripts/paper-jsx-to-html.mjs",
      ),
    ).toBe(false);
  });
});

const settingsLedger = {
  entries: [
    {
      routeId: "profile",
      path: "/settings/profile",
      status: "baselined",
      manifest: "settings",
      cases: ["profile.default.light.desktop"],
    },
    // A settings manifest can never defer scoring, whatever the ledger says.
    {
      routeId: "appearance",
      path: "/settings/appearance",
      status: "planned",
      rationale: "Not allowed for settings.",
      manifest: "settings",
      cases: ["appearance.default.light.desktop"],
    },
    {
      routeId: "access",
      path: "/settings/access",
      status: "debt",
      rationale: "Frame only.",
      frames: [{ frameId: "KHJ-0" }],
    },
  ],
};

const settingsCases = [
  { id: "profile.default.light.desktop", imagePath: "profile.png" },
  { id: "appearance.default.light.desktop", imagePath: "appearance.png" },
  {
    id: "your-access.developer.light.desktop",
    reference: "design",
    frameId: "KHJ-0",
    imagePath: "access.png",
  },
  { id: "brand-new.default.light.desktop", imagePath: "new.png" },
];

function selectSettings(paths: string[], baseManifest: unknown) {
  return selectDesignCases({
    designCases: settingsCases,
    manifestName: "settings",
    paths,
    baseManifest: baseManifest as { cases?: Array<Record<string, unknown>> },
    manifest: {
      source: {
        inputs: ["docs/technical-design/settings-mocks/site/index.html"],
        manifestPath:
          "docs/technical-design/settings-mocks/source-manifest.json",
      },
    },
    ledger: settingsLedger,
    manifestRepoPath:
      "docs/technical-design/ui-baselines/settings-baselines.json",
  }).map((entry) => entry.id);
}

test.describe("settings manifest generalization", () => {
  test("resolves the settings profile and artifact directory", () => {
    const profile = manifestProfile("settings");
    expect(profile.baselineRepoPath).toBe(
      "docs/technical-design/ui-baselines/settings-baselines.json",
    );
    expect(profile.siteRendered).toBe(true);
    expect(profile.defersScoring).toBe(false);
    expect(artifactsDirectoryFor("/a", "settings")).toBe("/a/settings");
    expect(manifestProfile("enterprise").defersScoring).toBe(true);
    expect(manifestProfile("auth").siteRendered).toBe(false);
    expect(isSiteManifest("settings")).toBe(true);
    expect(isSiteManifest("enterprise")).toBe(true);
    expect(isSiteManifest()).toBe(false);
    expect(defersScoring("settings")).toBe(false);
    expect(defersScoring("enterprise")).toBe(true);
  });

  test("settings has baselined cases but never planned or debt cases", () => {
    expect([...baselinedCases(settingsLedger, "settings")]).toEqual([
      "profile.default.light.desktop",
    ]);
    expect(plannedCases(settingsLedger, "settings").size).toBe(0);
    expect(
      debtCases(settingsLedger, { cases: settingsCases }, "settings").size,
    ).toBe(0);
    // The same ledger entries do not leak into another manifest.
    expect(baselinedCases(settingsLedger, "enterprise").size).toBe(0);
    expect(baselinedCases(settingsLedger, "auth").size).toBe(0);
  });

  test("accepts not-selected for settings but fails planned and debt", () => {
    expect(accepted({ status: "not-selected" }, "settings")).toBe(true);
    expect(accepted({ status: "passed" }, "settings")).toBe(true);
    expect(accepted({ status: "planned" }, "settings")).toBe(false);
    expect(accepted({ status: "debt" }, "settings")).toBe(false);
    expect(accepted({ status: "failed" }, "settings")).toBe(false);
    expect(accepted({ status: "not-selected" }, "auth")).toBe(false);
    expect(accepted({ status: "planned" }, "enterprise")).toBe(true);
  });

  test("allows deviceChrome in settings and still refuses it for auth", () => {
    const baseline = {
      cases: [{ id: "profile.default.light.phone", deviceChrome: { top: 62 } }],
    };
    expect(deviceChromeIssues(baseline, "settings")).toEqual([]);
    expect(deviceChromeIssues(baseline, "enterprise")).toEqual([]);
    expect(deviceChromeIssues(baseline, "auth")).toHaveLength(1);
    expect(deviceChromeIssues(baseline)).toHaveLength(1);
  });

  test("reference inputs of settings include its manifest and generator", () => {
    const inputs = designReferenceInputs({
      source: {
        inputs: ["docs/technical-design/settings-mocks/site/index.html"],
      },
      cases: [{
        id: "profile.default.light.desktop",
        reference: "design",
        imagePath: "profile.png",
      }],
    }, "settings");
    expect(inputs.has(
      "docs/technical-design/ui-baselines/settings-baselines.json",
    )).toBe(true);
    expect(inputs.has("packages/ui/scripts/paper-jsx-to-html.mjs")).toBe(true);
    expect(inputs.has("profile.png")).toBe(true);
  });

  test("changed settings selection takes baselined and brand-new cases", () => {
    const base = { cases: settingsCases.slice(0, 3) };
    expect(selectSettings(["README.md"], base)).toEqual([
      "profile.default.light.desktop",
      "brand-new.default.light.desktop",
    ]);
    // Nothing new: only the ledger-baselined case is always taken.
    expect(selectSettings(["README.md"], { cases: settingsCases })).toEqual([
      "profile.default.light.desktop",
    ]);
    // Without a merge-base manifest every case counts as new. Settings has no
    // planned or debt narrowing, so even the frame the ledger lists as debt is
    // a candidate.
    expect(selectSettings(["README.md"], null)).toEqual(
      settingsCases.map((entry) => entry.id),
    );
  });

  test("a settings source input change selects every settings case", () => {
    expect(
      selectSettings(["docs/technical-design/settings-mocks/site/index.html"], {
        cases: settingsCases,
      }),
    ).toEqual(settingsCases.map((entry) => entry.id));
    expect(
      selectSettings(
        ["docs/technical-design/settings-mocks/source-manifest.json"],
        { cases: settingsCases },
      ),
    ).toEqual(settingsCases.map((entry) => entry.id));
    // A settings site input is not an input of the enterprise manifest.
    expect(
      selectDesign(["docs/technical-design/settings-mocks/site/index.html"], {
        cases: enterpriseCases,
      }),
    ).toEqual(["session.default.light.desktop"]);
  });
});

test.describe("artifacts manifest registration", () => {
  const cases = [
    { id: "artifact.default.light.desktop", imagePath: "artifact.png" },
    { id: "task-run.default.light.desktop", imagePath: "task-run.png" },
  ];
  const ledger = {
    entries: [{
      routeId: "artifact-page",
      path: "/artifacts/$artifactId",
      status: "planned",
      manifest: "artifacts",
      cases: ["artifact.default.light.desktop"],
    }],
  };

  test("isolates artifacts output and permits planned references", () => {
    const profile = manifestProfile("artifacts");
    expect(profile.baselineRepoPath).toBe(
      "docs/technical-design/ui-baselines/artifacts-baselines.json",
    );
    expect(profile.siteRendered).toBe(true);
    expect(profile.defersScoring).toBe(true);
    expect(artifactsDirectoryFor("/a", "artifacts")).toBe("/a/artifacts");
    expect([...plannedCases(ledger, "artifacts").keys()]).toEqual([
      "artifact.default.light.desktop",
    ]);
    expect(plannedCases(ledger, "enterprise").size).toBe(0);
    expect(plannedCases(ledger, "settings").size).toBe(0);
    expect(accepted({ status: "planned" }, "artifacts")).toBe(true);
    expect(accepted({ status: "failed" }, "artifacts")).toBe(false);
  });

  test("renderer changes select scored cases while planned cases stay deferred", () => {
    const select = (status: string) =>
      selectDesignCases({
        designCases: cases,
        manifestName: "artifacts",
        paths: ["packages/ui/scripts/render-artifacts-references.mjs"],
        baseManifest: { cases },
        manifest: {},
        ledger: {
          entries: ledger.entries.map((entry) => ({ ...entry, status })),
        },
        manifestRepoPath:
          "docs/technical-design/ui-baselines/artifacts-baselines.json",
      }).map((entry) => entry.id);
    expect(select("planned")).toEqual(["task-run.default.light.desktop"]);
    expect(select("baselined")).toEqual(cases.map((entry) => entry.id));
  });

  test("reference inputs include artifacts manifest and source generator", () => {
    const inputs = designReferenceInputs({
      source: {
        inputs: ["docs/technical-design/artifacts-mocks/site/index.html"],
      },
      cases: [{ ...cases[0], reference: "design" }],
    }, "artifacts");
    expect(inputs.has(
      "docs/technical-design/ui-baselines/artifacts-baselines.json",
    )).toBe(true);
    expect(inputs.has("packages/ui/scripts/paper-jsx-to-html.mjs")).toBe(true);
    expect(inputs.has("artifact.png")).toBe(true);
  });
});

test.describe("device chrome on phone references", () => {
  async function bandedPng(
    page: import("@playwright/test").Page,
    size: { width: number; height: number },
    band: number,
    square: { left: number; top: number; size: number },
  ) {
    const dataUrl = await page.evaluate(({ size, band, square }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.fillStyle = "#000000";
      // Device chrome: a solid band across the top rows.
      context.fillRect(0, 0, size.width, band);
      context.fillRect(square.left, square.top, square.size, square.size);
      return canvas.toDataURL("image/png");
    }, { size, band, square });
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  }

  const frame = { width: 100, height: 200 };

  test("compares the reference below the band against the whole chrome-free candidate", () => {
    // The candidate is captured at W x (H - top) = 390 x 782.
    expect(deviceChromeCrops({ top: 62 }, { width: 390, height: 844 }, {
      width: 390,
      height: 782,
    })).toEqual({
      baselineCrop: { x: 0, y: 62, width: 390, height: 782 },
      candidateCrop: { x: 0, y: 0, width: 390, height: 782 },
    });
  });

  test("requires the candidate to be exactly W x (H - top)", () => {
    const size = { width: 390, height: 844 };
    // Same size as the reference is no longer a valid capture: it would carry
    // top rows the web app never renders.
    const full = deviceChromeCrops({ top: 62 }, size, size);
    expect(full).toHaveProperty("sizeMismatch", true);
    expect(full.issue).toBe(
      "deviceChrome candidate must be exactly 390x782 (reference 390x844 minus 62 chrome rows), got 390x844",
    );
    expect(deviceChromeCrops({ top: 62 }, size, { width: 390, height: 800 }))
      .toHaveProperty("sizeMismatch", true);
    expect(deviceChromeCrops({ top: 62 }, size, { width: 400, height: 782 }))
      .toHaveProperty("sizeMismatch", true);
  });

  test("rejects out-of-range bands", () => {
    const size = { width: 390, height: 844 };
    for (const top of [0, -3, 62.5, 844, 900]) {
      const crops = deviceChromeCrops({ top }, size, size);
      expect(crops, String(top)).toHaveProperty("issue");
      expect(crops, String(top)).not.toHaveProperty("sizeMismatch", true);
    }
  });

  test("derives the capture viewport and case from the chrome band", () => {
    const phone = {
      id: "queue.default.light.phone",
      viewport: { width: 390, height: 844 },
      dpr: 2,
      deviceChrome: { top: 62 },
    };
    expect(captureViewport(phone)).toEqual({ width: 390, height: 782 });
    const derived = captureCaseFor(phone);
    expect(derived.viewport).toEqual({ width: 390, height: 782 });
    expect(derived.dpr).toBe(2);
    // The manifest case is not mutated.
    expect(phone.viewport).toEqual({ width: 390, height: 844 });
    // A case without chrome is captured as authored.
    const desktop = { viewport: { width: 1440, height: 900 } };
    expect(captureCaseFor(desktop)).toBe(desktop);
    expect(captureViewport(desktop)).toEqual(desktop.viewport);
  });

  test("the candidate must record the derived viewport", () => {
    const baseline = {
      viewport: { width: 390, height: 844 },
      deviceChrome: { top: 62 },
    };
    const candidate = {
      ...compatibleCandidate,
      viewport: { width: 390, height: 782 },
    };
    const issues = (b: Record<string, unknown>, c: Record<string, unknown>) =>
      designCompatibilityIssues(
        c as never,
        { ...compatibleBaseline, ...b } as never,
      )
        .filter((issue) => issue.startsWith("viewport"));
    expect(issues(baseline, candidate)).toEqual([]);
    expect(issues(baseline, { ...candidate, viewport: baseline.viewport }))
      .toEqual(["viewport differs from candidate"]);
  });

  test("scores the reference below the band against the chrome-free candidate", async ({ page }) => {
    // Reference: a 40-row chrome band, the UI square at row 100. Candidate: no
    // chrome and 40 rows shorter, so the same square sits at row 60.
    const reference = await bandedPng(page, frame, 40, {
      left: 10,
      top: 100,
      size: 20,
    });
    const candidate = await bandedPng(
      page,
      { width: frame.width, height: frame.height - 40 },
      0,
      { left: 10, top: 60, size: 20 },
    );
    const withChrome = await comparePixels(
      page,
      candidate,
      reference,
      undefined,
      null,
      { top: 40 },
    );
    expect(withChrome.score).toBe(1);
    // A band of the wrong height changes the required candidate size.
    const wrongBand = await comparePixels(
      page,
      candidate,
      reference,
      undefined,
      null,
      { top: 20 },
    );
    expect(wrongBand.score).toBeUndefined();
    expect(wrongBand).toMatchObject({ height: 160, baselineHeight: 200 });
  });

  test("a candidate of any other height is a size failure, not a crop", async ({ page }) => {
    const reference = await bandedPng(page, frame, 40, {
      left: 10,
      top: 100,
      size: 20,
    });
    for (const height of [200, 240]) {
      const wrong = await bandedPng(page, { width: 100, height }, 0, {
        left: 10,
        top: 60,
        size: 20,
      });
      const pixels = await comparePixels(
        page,
        wrong,
        reference,
        undefined,
        null,
        { top: 40 },
      );
      expect(pixels.score).toBeUndefined();
      expect(pixels).toMatchObject({ height, baselineHeight: 200 });
      const outcome = caseResultForPixels(
        { reference: "design" },
        pixels,
        0.95,
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.issue).toMatch(/must be exactly 100x160/);
    }
  });

  test("flags a recorded top that differs from the measured status bar", () => {
    const phone = { deviceChrome: { top: 62 } };
    expect(deviceChromeDrift(phone, 62, "9:41")).toBeNull();
    expect(deviceChromeDrift(phone, 64, "9:41")).toMatch(
      /differs from the measured/,
    );
    expect(deviceChromeDrift(phone, null, null)).toMatch(/not found/);
    expect(deviceChromeDrift(phone, 62, "Queue")).toMatch(/time text/);
    expect(deviceChromeDrift({}, 10, null)).toBeNull();
  });

  test("auth and K-0 manifests refuse deviceChrome", () => {
    const baseline = {
      cases: [
        { id: "login.default.light.phone" },
        { id: "queue.default.light.phone", deviceChrome: { top: 62 } },
      ],
    };
    expect(deviceChromeIssues(baseline)).toEqual([
      "queue.default.light.phone: deviceChrome is only valid in the enterprise manifest",
    ]);
    expect(deviceChromeIssues(baseline, "auth")).toHaveLength(1);
    expect(deviceChromeIssues(baseline, "enterprise")).toEqual([]);
  });
});
