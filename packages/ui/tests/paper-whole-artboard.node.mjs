import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import {
  captureViewportBundle,
  viewportBundleIdentity,
  viewportBundleIssues,
} from "../scripts/native-viewport-bundle.mjs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const {
  captureWholeArtboardPair,
  metadataDigest,
  observeWholeArtboard,
  pairedIdentity,
  WHOLE_ARTBOARD_BINDING,
  WHOLE_ARTBOARD_VERSION,
  wholeArtboardBindingIssues,
  wholeArtboardMetadataIssues,
  wholeArtboardObservationIssues,
  wholeArtboardPairIssues,
} = await import(
  new URL("../scripts/paper-whole-artboard.mjs", import.meta.url).href
);
const {
  computeSourceIdentity,
  loadK0RasterProfile,
} = await import(
  new URL("../scripts/render-paper-references.mjs", import.meta.url).href
);
const { baselineMetadataIssues } = await import(
  new URL("../scripts/compare-paper.mjs", import.meta.url).href
);
const { deriveK0RasterProfile } = await import(
  new URL("../scripts/paper-k0-raster.mjs", import.meta.url).href
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselines = JSON.parse(
  await readFile(
    "docs/technical-design/ui-baselines/paper-baselines.json",
    "utf8",
  ),
);
const baseline = baselines.cases.find((entry) =>
  entry.id === "detail.default.light.desktop"
);
const runtime = JSON.parse(
  await readFile(
    "docs/technical-design/ui-baselines/runtime-cases.json",
    "utf8",
  ),
);
const catalog = JSON.parse(
  await readFile("docs/technical-design/ui-baselines/components.json", "utf8"),
);

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function observation() {
  const element = {
    box: { x: 0, y: 40, width: 1440, height: 960 },
    visible: true,
    accessible: true,
    scrollWidth: 1440,
    clientWidth: 1440,
    scrollHeight: 960,
    clientHeight: 960,
  };
  return {
    targetCount: 1,
    qualificationCount: 1,
    target: element,
    qualification: {
      ...element,
      box: { x: 0, y: 0, width: 1440, height: 40 },
      text: "Synthetic example. No execution eligibility proved.",
      label: "Fixture qualification",
      textElements: [{
        ...element,
        box: { x: 0, y: 0, width: 1440, height: 40 },
        unclipped: true,
      }],
    },
    structure: true,
    state: "ready",
    required: [
      ".bakery-app-shell",
      ".bakery-app-shell__header",
      ".bakery-app-shell__main",
      ".ui-worker-detail__intro",
      ".ui-worker-detail__harnesses",
      ".ui-worker-detail__inspector",
      ".ui-worker-detail__tabs",
      ".ui-worker-detail__intro .ui-button",
      ".ui-worker-detail__harness:nth-of-type(1)",
      ".ui-worker-detail__harness:nth-of-type(2)",
      ".ui-worker-detail__harness:nth-of-type(1) .ui-worker-detail__versions",
      ".ui-worker-detail__harness:nth-of-type(2) .ui-worker-detail__versions",
      ".ui-worker-detail__inspector > div:nth-child(1)",
      ".ui-worker-detail__inspector > div:nth-child(2)",
      ".ui-worker-detail__inspector > div:nth-child(3)",
      ".ui-worker-detail__rail",
      ".ui-worker-detail__desktop-header",
      ".ui-worker-detail__identity",
    ].map((selector) => ({ selector, elements: [element] })),
    hiddenArtwork: [],
    elements: [element],
    fonts: [["Geist", "400", "loaded"]],
    document: { width: 1440, height: 1000 },
    html: '<div data-paper-whole-artboard="worker-detail"></div>',
  };
}

// Real Chromium bundle and DOM observations; legacy manufactured full-page PNGs
// must never stand in for complete native viewport evidence.
async function bundlePage(browser) {
  const context = await browser.newContext({
    viewport: baseline.viewport,
    deviceScaleFactor: 1,
    hasTouch: false,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const font = await readFile(
    "docs/technical-design/enterprise-mocks/fonts/geist-400.ttf",
  );
  await page.setContent(`<!doctype html><style>
    @font-face {font-family:Fixture;src:url(data:font/ttf;base64,${
    font.toString("base64")
  })}
    body {margin:0;font:14px Fixture;background:white}
    .ui-worker-detail__boundary {height:40px}
    [data-paper-whole-artboard] {height:960px;background:white}
    header,main,section,aside,nav,div {box-sizing:border-box}
  </style><div data-ui-component="workerReadOnlyDetail" data-state="ready"><div class="ui-worker-detail__boundary" role="note" aria-label="Fixture qualification">Synthetic example. No execution eligibility proved.</div><div data-paper-whole-artboard="worker-detail"><div class="bakery-app-shell">
    <header class="bakery-app-shell__header">Header</header><main class="bakery-app-shell__main">
      <section class="ui-worker-detail__intro">Intro <span class="ui-button">Static artwork</span></section>
      <section class="ui-worker-detail__harnesses"><div class="ui-worker-detail__harness"><div class="ui-worker-detail__versions">Version one</div></div><div class="ui-worker-detail__harness"><div class="ui-worker-detail__versions">Version two</div></div></section>
      <section class="ui-worker-detail__inspector"><div>One</div><div>Two</div><div>Three</div></section>
      <nav class="ui-worker-detail__tabs">Tabs</nav><aside class="ui-worker-detail__rail">Rail</aside><header class="ui-worker-detail__desktop-header">Desktop</header><div class="ui-worker-detail__identity">Identity</div>
    </main></div></div></div>`);
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}
const browserOnly = { skip: process.env.BROWSER_TESTS !== "1" };

test("exact two bindings retain 40 full UI detail cases and all 126 worker cases", () => {
  const workers = runtime.cases.filter((entry) => entry.id.startsWith("wr."));
  assert.equal(workers.length, 126);
  assert.equal(
    workers.filter((entry) =>
      entry.catalogId === "template.workerReadOnlyDetail"
    ).length,
    40,
  );
  assert.equal(workers.filter((entry) => entry.wholeArtboardCapture).length, 2);
  assert.equal(
    catalog.entries.flatMap((entry) => entry.requiredCases).filter((entry) =>
      entry.wholeArtboardCapture
    ).length,
    2,
  );
  assert.deepEqual(wholeArtboardBindingIssues(baseline), []);
  for (
    const mutate of [
      (b) => delete b.wholeArtboardCapture,
      (b) => b.wholeArtboardCapture.targetSelector = "main",
      (b) => b.wholeArtboardCapture.measure = "main",
      (b) => b.wholeArtboardCapture.contractVersion = "unknown",
      (b) => b.candidate.args.state = "offline",
      (b) => b.frameId = "8SD-0",
      (b) => b.artboard.height--,
      (b) => b.comparisonRegion = { x: 0, y: 0, width: 1440, height: 960 },
    ]
  ) {
    const b = structuredClone(baseline);
    mutate(b);
    assert.ok(wholeArtboardBindingIssues(b).length);
  }
  const masked = structuredClone(baselines);
  masked.cases.find((entry) => entry.id === baseline.id).comparisonRegion = {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    measure: "main",
  };
  assert.ok(
    baselineMetadataIssues(masked).some((issue) =>
      issue.includes("unmasked full frame")
    ),
  );
});

test("profile integration verifies every original; unused odd/even predictions and V0 stay pinned", async () => {
  assert.equal(
    (await computeSourceIdentity(baselines)).digest,
    "a6978501f470309914eb5865790937c7dff9db7f1bb94f21c8cc80db8013d449",
  );
  const entries = baselines.cases.filter((entry) =>
    entry.sourceProfile === "K-0"
  );
  assert.equal(entries.length, 12);
  for (const entry of entries) {
    const profile = await loadK0RasterProfile(baselines, entry);
    assert.equal(profile.offset.y, entry.artboard.height % 2 / 2);
    assert.deepEqual(profile, entry.rasterProfile);
    for (
      const mutate of [
        (b) => delete b.rasterProfile,
        (b) => delete b.sourceProfile,
        (b) => b.fontDigests = {},
        (b) => b.imageSha256 = "0".repeat(64),
        (b) => b.artboard.height++,
        (b) => b.rasterProfile.implementationDigest = "0".repeat(64),
        (b) => b.rasterProfile.offset.y = b.rasterProfile.offset.y ? 0 : 0.5,
        (b) => b.sourceDigest = "0".repeat(64),
      ]
    ) {
      const changed = structuredClone(entry);
      mutate(changed);
      await assert.rejects(loadK0RasterProfile(baselines, changed));
    }
  }
  for (
    const [frame, width, height] of [
      ["96H-0", 1440, 1123],
      ["8XK-0", 390, 1261],
      ["98S-0", 390, 1586],
      ["9ZB-0", 390, 1132],
    ]
  ) {
    const bytes = png(width, height);
    const profile = deriveK0RasterProfile(bytes, {
      sha256: hash(bytes),
      width,
      height,
      sourceIdentity: "saved-unused-prediction",
    });
    assert.equal(profile.offset.y, height % 2 / 2, frame);
  }
});

test("producer rejects missing, duplicate, partial, hidden, resized and overflow observations before screenshots", async () => {
  assert.deepEqual(
    wholeArtboardObservationIssues(observation(), baseline.artboard),
    [],
  );
  for (
    const mutate of [
      (o) => o.targetCount = 0,
      (o) => o.targetCount = 2,
      (o) => o.qualificationCount = 0,
      (o) => o.qualificationCount = 2,
      (o) => o.target.box.height--,
      (o) => o.structure = false,
      (o) => o.qualification.visible = false,
      (o) => o.qualification.accessible = false,
      (o) => o.qualification.textElements[0].visible = false,
      (o) => o.qualification.textElements[0].accessible = false,
      (o) => o.qualification.textElements[0].unclipped = false,
      (o) => o.required.pop(),
      (o) => o.required[0].elements = [],
      (o) => o.hiddenArtwork.push("hidden body"),
      (o) => o.elements[0].scrollHeight++,
      (o) => o.fonts[0][2] = "loading",
    ]
  ) {
    const observed = observation();
    mutate(observed);
    assert.ok(
      wholeArtboardObservationIssues(observed, baseline.artboard).length,
    );
    let screenshots = 0;
    await assert.rejects(
      captureWholeArtboardPair(
        { evaluate: () => observed },
        WHOLE_ARTBOARD_BINDING,
        { reference: baseline.artboard },
        () => {
          screenshots++;
        },
        async () => {},
      ),
    );
    assert.equal(screenshots, 0);
  }
});

test(
  "consumer recomputes paired files/receipt and rejects cross-case/context/theme/build/generation or failed proof",
  browserOnly,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-pair-"));
    const browser = await chromium.launch({ headless: true });
    try {
      const { page } = await bundlePage(browser);
      const original = await readFile(baseline.imagePath);
      const reference = { ...baseline, imagePath: "original.png" };
      await writeFile(join(root, reference.imagePath), original);
      const parity = {
        scope: "whole-artboard-parity",
        path: "detail.whole-artboard-parity.png",
        sha256: hash(original),
        ...baseline.artboard,
      };
      await writeFile(join(root, parity.path), original);
      const candidate = {
        id: baseline.requiredStoryCase,
        requiredCaseId: baseline.requiredStoryCase,
        storyId: baseline.candidate.storyId,
        status: "passed",
        assertions: ["axe", "containment"],
        sourceCommit: "candidate",
        sourceDiffDigest: "dirty",
        storybookBuildDigest: "b".repeat(64),
        tokenDigest: "theme",
        colorScheme: "light",
        viewport: baseline.viewport,
        dpr: 1,
        rasterProfile: baseline.rasterProfile,
        catalogId: "template.workerReadOnlyDetail",
        pointer: "fine",
        locale: "en-US",
        timezone: "UTC",
        reducedMotion: "reduce",
        captureStartedAt: "start",
        captureFinishedAt: "end",
      };
      const observed = await observeWholeArtboard(page, WHOLE_ARTBOARD_BINDING);
      assert.deepEqual(
        wholeArtboardObservationIssues(observed, baseline.artboard),
        [],
      );
      const snapshotNonce = "test-generation";
      const bundle = await captureViewportBundle(page, {
        root,
        directory: join(root, "detail.full-ui"),
        identity: viewportBundleIdentity(candidate),
        nonce: snapshotNonce,
      });
      const fullUI = bundle.reference;
      Object.assign(candidate, {
        outputPath: fullUI.manifestPath,
        outputSha256: fullUI.manifestSha256,
        outputScope: "full-ui-bundle",
        outputAdapter: "none",
        fullUIBundle: fullUI,
      });
      const snapshotGeneration = metadataDigest({
        snapshotNonce,
        observation: observed,
      });
      const adapter = {
        version: "paper-k0-centered-canvas-v1",
        implementationDigest: baseline.rasterProfile.implementationDigest,
        x: 0,
        y: 0,
      };
      const receipt = {
        identity: pairedIdentity(candidate, reference),
        snapshotNonce,
        snapshotGeneration,
        adapter,
        fullUI,
        parity,
        captureStartedAt: "start",
        captureFinishedAt: "end",
        assertions: candidate.assertions,
        status: "passed",
        checks: [
          "runtime-assertions-before",
          "runtime-assertions-after",
          "unchanged-dom-layout-fonts",
          "whole-artboard-bounds",
        ],
        observation: observed,
      };
      const record = {
        contractVersion: WHOLE_ARTBOARD_VERSION,
        ...receipt.identity,
        snapshotGeneration,
        adapter,
        target: {
          selector: WHOLE_ARTBOARD_BINDING.targetSelector,
          naturalWidth: 1440,
          naturalHeight: 960,
          completeArtwork: true,
        },
        fullUI,
        parity,
        browserContract: {
          passed: true,
          receiptSha256: hash(JSON.stringify(receipt)),
        },
        qualification: {
          visible: true,
          accessible: true,
          textDigest: hash(observed.qualification.text),
        },
      };
      candidate.wholeArtboardCapture = record;
      candidate.wholeArtboardCaptureSha256 = metadataDigest(record);
      await writeFile(
        join(root, `${parity.path}.browser.json`),
        JSON.stringify(receipt),
      );
      assert.deepEqual(wholeArtboardMetadataIssues(record), []);
      assert.deepEqual(
        await wholeArtboardPairIssues(root, reference, candidate),
        [],
      );
      for (
        const mutate of [
          (c) => delete c.wholeArtboardCapture,
          (c) => c.id = "other",
          (c) => c.colorScheme = "dark",
          (c) => c.viewport.height++,
          (c) => c.storybookBuildDigest = "0".repeat(64),
          (c) => c.sourceCommit = "stale",
          (c) => c.captureStartedAt = "stale",
          (c) => c.status = "failed",
          (c) => c.wholeArtboardCapture.snapshotGeneration = "0".repeat(64),
          (c) => c.wholeArtboardCapture.originalPng.height++,
          (c) => c.wholeArtboardCapture.adapter.y = 0.5,
          (c) =>
            c.wholeArtboardCapture.fullUI.adapter =
              "paper-k0-centered-canvas-v1",
          (c) =>
            c.wholeArtboardCapture.fullUI.manifestPath =
              c.wholeArtboardCapture.parity.path,
          (c) => c.wholeArtboardCapture.browserContract.passed = false,
          (c) => c.wholeArtboardCapture.qualification.visible = false,
          (c) => c.wholeArtboardCapture.target.selector = "main",
        ]
      ) {
        const c = structuredClone(candidate);
        mutate(c);
        assert.ok((await wholeArtboardPairIssues(root, reference, c)).length);
      }
      // Rehash a failed or partial browser receipt: caller's passed=true still cannot authorize it.
      for (
        const mutate of [
          (r) => r.status = "failed",
          (r) => r.observation.targetCount = 2,
          (r) => r.observation.qualification.visible = false,
          (r) => r.observation.required.pop(),
          (r) => r.snapshotNonce = "stale",
          (r) => r.identity.contextDigest = "0".repeat(64),
        ]
      ) {
        const r = structuredClone(receipt);
        mutate(r);
        const bytes = JSON.stringify(r);
        await writeFile(join(root, `${parity.path}.browser.json`), bytes);
        const c = structuredClone(candidate);
        c.wholeArtboardCapture.browserContract.receiptSha256 = hash(bytes);
        c.wholeArtboardCaptureSha256 = metadataDigest(c.wholeArtboardCapture);
        assert.ok((await wholeArtboardPairIssues(root, reference, c)).length);
      }
      await writeFile(
        join(root, `${parity.path}.browser.json`),
        JSON.stringify(receipt),
      );
      // Internally valid, rehashed bundles from another capture still cannot pair.
      const manifestBytes = await readFile(join(root, fullUI.manifestPath));
      for (
        const [name, mutate, expected] of [
          ["nonce", (m) => {
            m.nonce = "another-browser-generation";
          }, /stale browser generation/],
          ["root DOM", (m) => {
            for (
              const o of [
                m.initial,
                m.restored,
                ...m.frames.flatMap((f) => [f.before, f.after]),
              ]
            ) o.rootDomDigest = hash("different root DOM");
          }, /root DOM mismatch/],
          ["qualification", (m) => {
            for (
              const o of [
                m.initial,
                m.restored,
                ...m.frames.flatMap((f) => [f.before, f.after]),
              ]
            ) o.qualification.text = "Different qualification";
          }, /qualification mismatch/],
        ]
      ) {
        const m = JSON.parse(manifestBytes);
        mutate(m);
        m.snapshotGeneration = metadataDigest({
          nonce: m.nonce,
          initial: m.initial,
        });
        const bytes = JSON.stringify(m);
        await writeFile(join(root, fullUI.manifestPath), bytes);
        const changedReference = { ...fullUI, manifestSha256: hash(bytes) };
        assert.deepEqual(
          await viewportBundleIssues(
            root,
            changedReference,
            viewportBundleIdentity(candidate),
          ),
          [],
          name,
        );
        const c = structuredClone(candidate), r = structuredClone(receipt);
        c.fullUIBundle =
          c.wholeArtboardCapture.fullUI =
          r.fullUI =
            changedReference;
        c.outputSha256 = hash(bytes);
        const receiptBytes = JSON.stringify(r);
        await writeFile(
          join(root, `${parity.path}.browser.json`),
          receiptBytes,
        );
        c.wholeArtboardCapture.browserContract.receiptSha256 = hash(
          receiptBytes,
        );
        c.wholeArtboardCaptureSha256 = metadataDigest(c.wholeArtboardCapture);
        assert.match(
          (await wholeArtboardPairIssues(root, reference, c)).join(),
          expected,
          name,
        );
      }
      await writeFile(join(root, fullUI.manifestPath), manifestBytes);
      await writeFile(
        join(root, `${parity.path}.browser.json`),
        JSON.stringify(receipt),
      );
      const legacy = structuredClone(candidate);
      legacy.wholeArtboardCapture.fullUI = {
        scope: "full-ui",
        adapter: "none",
        path: "legacy.png",
        sha256: hash(original),
        width: 1440,
        height: 1000,
      };
      legacy.wholeArtboardCaptureSha256 = metadataDigest(
        legacy.wholeArtboardCapture,
      );
      assert.ok(
        (await wholeArtboardPairIssues(root, reference, legacy)).length,
        "legacy full UI remains inadmissible",
      );
      await rm(join(root, parity.path));
      assert.match(
        (await wholeArtboardPairIssues(root, reference, candidate)).join(),
        /ENOENT/,
        "parity missing",
      );
      await writeFile(join(root, parity.path), original);
      assert.deepEqual(
        await wholeArtboardPairIssues(root, reference, candidate),
        [],
      );
      await writeFile(join(root, fullUI.manifestPath), Buffer.from("stale"));
      assert.ok(
        (await wholeArtboardPairIssues(root, reference, candidate)).length,
      );
      await rm(join(root, fullUI.manifestPath));
      assert.ok(
        (await wholeArtboardPairIssues(root, reference, candidate)).length,
      );
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "producer real paired capture binds the native bundle nonce and root DOM without altering viewport or scroll",
  browserOnly,
  async () => {
    const browser = await chromium.launch({ headless: true });
    const root = await mkdtemp(join(tmpdir(), "bakery-real-pair-"));
    try {
      const { page } = await bundlePage(browser);
      await page.evaluate(() => scrollTo(0, 13));
      const originalDom = await page.content();
      const original = await readFile(baseline.imagePath);
      const profile = deriveK0RasterProfile(original, {
        sha256: baseline.imageSha256,
        ...baseline.artboard,
        sourceIdentity: baseline.sourceDigest,
      });
      const identity = viewportBundleIdentity({
        viewport: baseline.viewport,
        dpr: 1,
        pointer: "fine",
        locale: "en-US",
        timezone: "UTC",
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      let assertions = 0;
      const result = await captureWholeArtboardPair(
        page,
        WHOLE_ARTBOARD_BINDING,
        profile,
        (nonce) =>
          captureViewportBundle(page, {
            root,
            directory: join(root, "paired.full-ui"),
            identity,
            nonce,
          }),
        async () => {
          assertions++;
          assert.deepEqual(
            wholeArtboardObservationIssues(
              await observeWholeArtboard(page, WHOLE_ARTBOARD_BINDING),
              baseline.artboard,
            ),
            [],
          );
        },
      );
      assert.equal(assertions, 2);
      assert.deepEqual(
        await viewportBundleIssues(root, result.fullUI.reference, identity),
        [],
      );
      assert.equal(result.fullUI.manifest.nonce, result.snapshotNonce);
      assert.equal(
        result.fullUI.manifest.initial.rootDomDigest,
        hash(result.observation.html),
      );
      assert.equal(
        result.snapshotGeneration,
        metadataDigest({
          snapshotNonce: result.snapshotNonce,
          observation: result.observation,
        }),
      );
      assert.equal(result.parity.readUInt32BE(16), 1440);
      assert.equal(result.parity.readUInt32BE(20), 960);
      assert.equal(result.fullUI.manifest.initial.document.height, 1000);
      assert.equal(await page.content(), originalDom);
      assert.equal(await page.evaluate(() => scrollY), 13);
      assert.deepEqual(page.viewportSize(), baseline.viewport);
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "producer retains full UI before parity, runs both browser checks, detects drift and restores scroll on failure",
  browserOnly,
  async () => {
    const browser = await chromium.launch({ headless: true });
    const root = await mkdtemp(join(tmpdir(), "bakery-pair-producer-"));
    try {
      const { page: nativePage } = await bundlePage(browser);
      const original = await readFile(baseline.imagePath);
      const profile = deriveK0RasterProfile(original, {
        sha256: baseline.imageSha256,
        ...baseline.artboard,
        sourceIdentity: baseline.sourceDigest,
      });
      for (
        const mode of [
          "passed",
          "drift",
          "browser-failed",
          "raster-failed",
          "mutation",
        ]
      ) {
        const events = [];
        let scroll = { x: 0, y: 0 },
          observations = 0,
          assertions = 0,
          disconnected = false;
        const page = {
          locator: () => ({
            count: () => 1,
            isVisible: () => true,
            boundingBox: () => ({ x: 0, y: 0, ...baseline.artboard }),
            evaluate: async () => {},
          }),
          screenshot: () => {
            events.push("parity");
            if (mode === "raster-failed") throw new Error("raster failed");
            return original;
          },
          evaluate: (fn, arg) => {
            if (arg?.desktopSelectors) {
              const o = observation();
              if (observations++ && mode === "drift") o.html += "changed";
              return o;
            }
            if (arg?.key && "odd" in arg) {
              disconnected = true;
              return mode === "mutation";
            }
            if (arg?.key) return;
            if (typeof arg === "string") {
              scroll = { x: 0, y: 40 };
              return;
            }
            if (arg && "x" in arg) {
              scroll = arg;
              return;
            }
            if (fn.toString().includes("devicePixelRatio")) {
              return { ...scroll, ...baseline.viewport, dpr: 1 };
            }
            return scroll;
          },
        };
        const run = () =>
          captureWholeArtboardPair(
            page,
            WHOLE_ARTBOARD_BINDING,
            profile,
            (nonce) => {
              events.push("full-ui");
              return captureViewportBundle(nativePage, {
                root,
                directory: join(root, `${mode}.full-ui`),
                nonce,
                identity: viewportBundleIdentity({
                  viewport: baseline.viewport,
                  dpr: 1,
                  pointer: "fine",
                  locale: "en-US",
                  timezone: "UTC",
                  reducedMotion: "reduce",
                  colorScheme: "light",
                }),
              });
            },
            () => {
              assertions++;
              if (mode === "browser-failed" && assertions === 2) {
                throw new Error("browser proof failed");
              }
            },
          );
        if (mode === "passed") {
          const result = await run();
          assert.equal(
            result.snapshotGeneration,
            metadataDigest({
              snapshotNonce: result.snapshotNonce,
              observation: result.observation,
            }),
          );
          assert.equal(result.fullUI.reference.scope, "full-ui-bundle");
          assert.equal(result.fullUI.manifest.nonce, result.snapshotNonce);
          assert.equal(assertions, 2);
          assert.deepEqual(result.parity, original);
        } else await assert.rejects(run());
        assert.deepEqual(events, ["full-ui", "parity"]);
        assert.deepEqual(scroll, { x: 0, y: 0 });
        assert.equal(disconnected, true);
      }
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
