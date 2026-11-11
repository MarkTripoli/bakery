import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureViewportBundle,
  decodeViewportPng,
  viewportBundleIdentity,
  viewportBundleIssues,
  viewportBundleRecordIssues,
} from "../scripts/native-viewport-bundle.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const html = `<!doctype html><style>
  body { margin:0; background:white; }
  .ui-worker-detail__boundary { height:40px; background:#ffe099; }
  #artwork { height:1260px; background:linear-gradient(#334455,#aabbcc); }
  #marker { height:30px; background:#558833; }
</style><main><div class="ui-worker-detail__boundary" role="note" aria-label="Fixture qualification">Synthetic example. No execution eligibility proved.</div><div id="artwork"><div id="marker">Native document</div></div></main>`;

// Every accepted fixture is captured by Chromium. Mutations below forge only
// rejected evidence; no manufactured PNG is used as a positive bundle.
describe("native viewport bundle browser contract", {
  skip: process.env.BROWSER_TESTS !== "1",
}, () => {
  let browser, root;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "bakery-viewport-"));
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(name, {
    pointer = "fine",
    dpr = 1,
    style = "",
    markup = html,
    viewport = pointer === "coarse"
      ? { width: 390, height: 300 }
      : { width: 640, height: 360 },
  } = {}) {
    const identity = viewportBundleIdentity({
      id: name,
      catalogId: "template.workerReadOnlyDetail",
      storyId: "bakery-templates-workerreadonlydetail--contract",
      viewport,
      dpr,
      pointer,
      colorScheme: "light",
      locale: "en-US",
      timezone: "UTC",
      reducedMotion: "reduce",
      sourceCommit: "test-source",
    });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: dpr,
      hasTouch: pointer === "coarse",
      locale: identity.locale,
      timezoneId: identity.timezone,
      colorScheme: identity.colorScheme,
      reducedMotion: identity.reducedMotion,
    });
    const page = await context.newPage();
    await page.setContent(markup + (style ? `<style>${style}</style>` : ""));
    await page.evaluate(async () => {
      await document.fonts.ready;
      scrollTo(0, 13);
    });
    const directory = join(root, `${name}.full-ui`);
    return {
      page,
      context,
      identity,
      capture: (extra = {}) =>
        captureViewportBundle(page, { root, directory, identity, ...extra }),
    };
  }

  for (const [pointer, dpr] of [["coarse", 1], ["fine", 2]]) {
    test(`${pointer} DPR ${dpr}: native frames, first qualification, exact pixels, complete coverage and restoration`, async () => {
      const f = await fixture(`positive-${pointer}`, { pointer, dpr });
      try {
        const original = await f.page.content();
        const screenshot = f.page.screenshot.bind(f.page);
        let screenshots = 0;
        f.page.screenshot = (options) => {
          assert.equal(
            options,
            undefined,
            "no fullPage, clip, resize or screenshot adaptation",
          );
          screenshots++;
          return screenshot();
        };
        const { reference, manifest: m } = await f.capture({
          nonce: "shared-pair-nonce",
        });
        assert.deepEqual(
          await viewportBundleIssues(root, reference, f.identity),
          [],
        );
        assert.equal(reference.scope, "full-ui-bundle");
        assert.equal(reference.adapter, "none");
        assert.equal(m.nonce, "shared-pair-nonce");
        assert.equal(
          m.snapshotGeneration,
          digest({ nonce: m.nonce, initial: m.initial }),
        );
        assert.equal(
          m.initial.rootDomDigest,
          hash(await f.page.locator("main").evaluate((e) => e.outerHTML)),
        );
        assert.deepEqual(m.initial, m.restored);
        assert.equal(m.initial.scroll.y, 13);
        assert.equal(await f.page.content(), original);
        assert.deepEqual(
          await f.page.evaluate(() => ({ x: scrollX, y: scrollY })),
          { x: 0, y: 13 },
        );
        assert.equal(m.mutationCount, 0);
        assert.equal(m.initial.context.dpr, dpr);
        assert.equal(
          m.initial.context.maxTouchPoints,
          pointer === "coarse" ? 1 : 0,
        );
        assert.equal(m.initial.context.media[`(pointer:${pointer})`], true);
        assert.ok(m.frames.length > 2);
        assert.equal(screenshots, m.frames.length);
        assert.equal(
          new Set(m.frames.map((frame) => frame.path)).size,
          m.frames.length,
        );
        const q = m.frames[0].before.qualification;
        assert.ok(q.visible && !q.hidden && !q.occluded);
        assert.ok(q.box.y + q.box.height <= f.identity.viewport.height);
        let covered = 0, previous;
        for (const frame of m.frames) {
          const bytes = await readFile(join(root, frame.path));
          const png = decodeViewportPng(bytes);
          assert.equal(hash(bytes), frame.sha256);
          assert.equal(png.width, f.identity.viewport.width * dpr);
          assert.equal(png.height, f.identity.viewport.height * dpr);
          assert.deepEqual(frame.before.context, m.initial.context);
          assert.equal(frame.before.domDigest, m.initial.domDigest);
          assert.equal(frame.before.layoutDigest, m.initial.layoutDigest);
          assert.deepEqual(frame.before, frame.after);
          assert.ok(frame.rect.y <= covered);
          if (previous) {
            const length = (covered - frame.rect.y) * dpr * png.width * 4;
            assert.ok(length > 0);
            assert.deepEqual(
              previous.pixels.subarray(previous.pixels.length - length),
              png.pixels.subarray(0, length),
            );
          }
          covered = frame.rect.y + frame.rect.height;
          previous = png;
        }
        assert.equal(covered, 1300);
        assert.equal(covered, m.initial.document.height);
        assert.ok(m.frames.at(-1).rect.y >= f.identity.viewport.height);
      } finally {
        await f.context.close();
      }
    });
  }

  // The original diagnostic file is not required: this fractional curve
  // reproduces Chromium's scroll-dependent viewport bounds at scrollY=221.
  const svgMarkup = `<!doctype html><style>
    body { margin:0; background:white; }
    .ui-worker-detail__boundary { height:221px; background:#ffe099; }
    #artwork { height:1483px; display:flow-root; }
    #outer { display:block; margin-top:19.333333px; width:19.333333px; height:19.333333px; }
  </style><main><div class="ui-worker-detail__boundary" role="note" aria-label="Fixture qualification">Synthetic example. No execution eligibility proved.</div><div id="artwork"><svg id="outer" viewBox="0 0 24 24"><path id="curve" d="M 3.2 8.7 C 6.1 -2.3 18.6 25.8 21.3 5.6 L 16.4 19.1 Z"/></svg></div></main>`;
  const svgFixture = (name) =>
    fixture(name, {
      pointer: "coarse",
      viewport: { width: 390, height: 442 },
      markup: svgMarkup,
    });
  function observeRaw(page) {
    const observations = [];
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (...args) => {
      const result = await evaluate(...args);
      if (result?.geometry) observations.push(result);
      return result;
    };
    return observations;
  }

  test("fractional SVG scroll drift preserves exact local observation and native pixels", async () => {
    const f = await svgFixture("svg-scroll");
    try {
      const original = await f.page.content();
      const bounds = [];
      const screenshots = [];
      for (const y of [0, 221, 0, 221]) {
        await f.page.evaluate((y) => scrollTo(0, y), y);
        bounds.push(
          await f.page.locator("#curve").evaluate((e) => {
            const r = e.getBoundingClientRect();
            return { y: r.y + scrollY, height: r.height };
          }),
        );
        if (y === 0) screenshots.push(await f.page.screenshot());
      }
      assert.notDeepEqual(
        bounds[0],
        bounds[1],
        "must reproduce real float drift",
      );
      assert.deepEqual(bounds.slice(0, 2), bounds.slice(2));
      assert.deepEqual(screenshots[0], screenshots[1]);
      await f.page.evaluate(() => scrollTo(0, 13));
      const observations = observeRaw(f.page);
      const { reference, manifest: m } = await f.capture();
      assert.deepEqual(
        await viewportBundleIssues(root, reference, f.identity),
        [],
      );
      assert.equal(m.initial.document.height, 1704);
      assert.equal(m.frames[1].rect.y, 221);
      assert.equal(m.frames[0].before.qualification.box.height, 221);
      assert.equal(m.frames[0].before.qualification.occluded, false);
      assert.equal(m.frames.at(-1).rect.y + m.frames.at(-1).rect.height, 1704);
      assert.deepEqual(m.initial, m.restored);
      assert.equal(m.mutationCount, 0);
      const geometry = observations[0].geometry;
      const curve = geometry.find((e) => e.tag === "path");
      const owner = geometry.find((e) => e.index === curve.svg.ownerViewport);
      assert.equal(curve.box, undefined);
      assert.equal(owner.tag, "svg");
      assert.ok(owner.box && !owner.svg, "outer SVG keeps document geometry");
      assert.ok(Object.values(curve.svg.localBox).every(Number.isFinite));
      assert.ok(Object.values(curve.svg.ctm).every(Number.isFinite));
      for (const o of observations) assert.deepEqual(o.geometry, geometry);
      assert.equal(await f.page.content(), original);
      assert.equal(await f.page.evaluate(() => scrollY), 13);
    } finally {
      await f.context.close();
    }
  });

  test("nested SVG viewport ownership, viewBox and glyph geometry stay bound", async () => {
    const f = await fixture("svg-nested", {
      viewport: { width: 390, height: 442 },
      markup: svgMarkup.replace(
        "</svg>",
        '<svg id="inner" x="1" y="1" width="20" height="20" viewBox="0 0 40 40"><g transform="translate(0.125 0.25)"><text x="2" y="12" font-size="8">SVG</text></g></svg></svg>',
      ),
    });
    try {
      const observations = observeRaw(f.page);
      const { reference } = await f.capture();
      assert.deepEqual(
        await viewportBundleIssues(root, reference, f.identity),
        [],
      );
      const geometry = observations[0].geometry;
      const viewports = geometry.filter((e) => e.tag === "svg");
      const glyph = geometry.find((e) => e.tag === "text");
      assert.equal(viewports.length, 2);
      assert.equal(viewports[1].svg.ownerViewport, viewports[0].index);
      assert.equal(glyph.svg.ownerViewport, viewports[1].index);
      assert.ok(glyph.svg.localBox.width > 0);
      for (const o of observations) assert.deepEqual(o.geometry, geometry);
      const original = await f.page.content();
      const screenshot = f.page.screenshot.bind(f.page);
      f.page.screenshot = async () => {
        const bytes = await screenshot();
        await f.page.evaluate(() => {
          const sheet = document.styleSheets[0];
          sheet.insertRule("text { font-size:8.001px }", sheet.cssRules.length);
        });
        return bytes;
      };
      await assert.rejects(f.capture(), /context\/DOM\/layout changed/);
      assert.equal(await f.page.content(), original);
    } finally {
      await f.context.close();
    }
  });

  test("SVG CSSOM changes below 1/64 remain strict without DOM mutations", async (t) => {
    for (
      const [name, rule, changed] of [
        ["translate", "#curve { transform:translateY(0.001px) }", "ctm"],
        ["scale", "#curve { transform:scale(1.00001) }", "ctm"],
        [
          "path",
          '#curve { d:path("M 3.2 8.7 C 6.1 -2.3 18.6 25.8 21.3 5.6 L 16.4 19.101 Z") }',
          "localBox",
        ],
        ["outer-viewport", "#outer { transform:translateY(0.001px) }", "outer"],
        [
          "ordinary-layout",
          "#artwork { transform:translateY(0.001px) }",
          "outer",
        ],
      ]
    ) {
      await t.test(name, async () => {
        const f = await svgFixture(`svg-${name}`);
        try {
          const original = await f.page.content();
          const observations = observeRaw(f.page);
          const screenshot = f.page.screenshot.bind(f.page);
          f.page.screenshot = async () => {
            const bytes = await screenshot();
            await f.page.evaluate((rule) => {
              const sheet = document.styleSheets[0];
              sheet.insertRule(rule, sheet.cssRules.length);
            }, rule);
            return bytes;
          };
          await assert.rejects(f.capture(), /context\/DOM\/layout changed/);
          assert.equal(
            await f.page.content(),
            original,
            "CSSOM leaves DOM hash unchanged",
          );
          const before = observations[0], after = observations[2];
          assert.equal(before.html, after.html);
          assert.equal(before.rootHtml, after.rootHtml);
          if (changed === "outer") {
            assert.notDeepEqual(
              before.geometry.find((e) => e.tag === "svg").box,
              after.geometry.find((e) => e.tag === "svg").box,
            );
          } else {
            assert.notDeepEqual(
              before.geometry.find((e) => e.tag === "path").svg[changed],
              after.geometry.find((e) => e.tag === "path").svg[changed],
            );
          }
          assert.equal(await f.page.evaluate(() => scrollY), 13);
        } finally {
          await f.context.close();
        }
      });
    }
  });

  test("SVG unavailable or nonfinite geometry fails closed", async (t) => {
    for (
      const mode of ["missing-matrix", "nonfinite-matrix", "nonfinite-box"]
    ) {
      await t.test(mode, async () => {
        const f = await svgFixture(`svg-${mode}`);
        try {
          await f.page.locator("#curve").evaluate((e, mode) => {
            if (mode === "missing-matrix") e.getCTM = () => null;
            if (mode === "nonfinite-matrix") e.getCTM = () => ({ a: NaN });
            if (mode === "nonfinite-box") e.getBBox = () => ({ x: Infinity });
          }, mode);
          await assert.rejects(
            f.capture(),
            /unavailable\/nonfinite SVG geometry/,
          );
        } finally {
          await f.context.close();
        }
      });
    }
  });

  test("rehashing cannot authorize gaps, truncation, context drift, hidden qualification or stale generation", async (t) => {
    const f = await fixture("tamper");
    try {
      const { reference, manifest } = await f.capture();
      const manifestPath = join(root, reference.manifestPath);
      const original = await readFile(manifestPath);
      const cases = [
        ["gap", (m) => {
          const frame = m.frames[1];
          frame.rect.y = m.frames[0].rect.height + 1;
          frame.before.scroll.y =
            frame.after.scroll.y =
            frame.requestedScroll
              .y =
              frame.rect.y;
        }, /missing band/],
        ["truncated below fold", (m) => m.frames.pop(), /lower edge missing/],
        ["missing frame entry", (m) => m.frames.splice(1, 1), /out-of-order/],
        [
          "frame hash",
          (m) => m.frames[1].sha256 = "0".repeat(64),
          /stale frame digest/,
        ],
        ["overlap metadata", (m) => m.frames[1].overlap++, /overlap metadata/],
        [
          "frame context",
          (m) => m.frames[1].before.context.dpr++,
          /context\/DOM\/layout changed/,
        ],
        [
          "frame DOM",
          (m) => m.frames[1].before.domDigest = "0".repeat(64),
          /context\/DOM\/layout changed/,
        ],
        [
          "frame layout",
          (m) => m.frames[1].before.layoutDigest = "0".repeat(64),
          /context\/DOM\/layout changed/,
        ],
        ["hidden qualification", (m) => {
          m.frames[0].before.qualification.hidden =
            m.frames[0].after
              .qualification.hidden =
              true;
        }, /qualification/],
        ["occluded qualification", (m) => {
          m.frames[0].before.qualification.occluded =
            m.frames[0].after
              .qualification.occluded =
              true;
        }, /qualification/],
        [
          "stale generation",
          (m) => m.nonce = "other-capture",
          /stale generation/,
        ],
        ["restoration", (m) => m.restored.scroll.y++, /restoration failed/],
        ["mutations", (m) => m.mutationCount++, /restoration failed/],
      ];
      for (const [name, mutate, expected] of cases) {
        await t.test(name, async () => {
          const m = structuredClone(manifest);
          mutate(m);
          const bytes = JSON.stringify(m);
          await writeFile(manifestPath, bytes);
          assert.match(
            (await viewportBundleIssues(root, {
              ...reference,
              manifestSha256: hash(bytes),
            }, f.identity)).join("; "),
            expected,
          );
        });
      }
      await writeFile(manifestPath, original);
      assert.deepEqual(
        await viewportBundleIssues(root, reference, f.identity),
        [],
      );
      await t.test("unhashed manifest tamper", async () => {
        await writeFile(
          manifestPath,
          Buffer.concat([original, Buffer.from(" ")]),
        );
        assert.match(
          (await viewportBundleIssues(root, reference, f.identity)).join(),
          /stale manifest digest/,
        );
        await writeFile(manifestPath, original);
      });
      await t.test("missing member file", async () => {
        const path = join(root, manifest.frames.at(-1).path),
          bytes = await readFile(path);
        await rm(path);
        assert.match(
          (await viewportBundleIssues(root, reference, f.identity)).join(),
          /ENOENT/,
        );
        await writeFile(path, bytes);
      });
      await t.test("rehashing wrong native pixels cannot fake exact overlap", async () => {
        const m = structuredClone(manifest), frame = m.frames[1];
        const path = join(root, frame.path),
          originalFrame = await readFile(path);
        const wrongPixels = await readFile(join(root, m.frames.at(-1).path));
        await writeFile(path, wrongPixels);
        frame.sha256 = hash(wrongPixels);
        const bytes = JSON.stringify(m);
        await writeFile(manifestPath, bytes);
        assert.match(
          (await viewportBundleIssues(root, {
            ...reference,
            manifestSha256: hash(bytes),
          }, f.identity)).join(),
          /overlap pixels differ/,
        );
        await writeFile(path, originalFrame);
        await writeFile(manifestPath, original);
      });
      await t.test("legacy full UI PNG is not a bundle", async () => {
        const frame = manifest.frames[0];
        assert.match(
          (await viewportBundleIssues(root, {
            scope: "full-ui",
            adapter: "none",
            path: frame.path,
            sha256: frame.sha256,
            width: frame.width,
            height: frame.height,
          }, f.identity)).join(),
          /invalid bundle reference/,
        );
      });
    } finally {
      await f.context.close();
    }
  });

  test("standalone full-UI-only records require explicit scope, reference, path and hash; non-detail stays unchanged", async (t) => {
    const f = await fixture("standalone");
    try {
      const { reference } = await f.capture();
      const candidate = {
        ...f.identity,
        outputScope: "full-ui-bundle",
        outputAdapter: "none",
        fullUIBundle: reference,
        outputPath: reference.manifestPath,
        outputSha256: reference.manifestSha256,
      };
      assert.equal(candidate.wholeArtboardCapture, undefined);
      assert.deepEqual(await viewportBundleRecordIssues(root, candidate), []);
      for (
        const [name, mutate, expected] of [
          ["missing scope", (c) => delete c.outputScope, /output binding/],
          ["legacy scope", (c) => c.outputScope = "full-ui", /output binding/],
          ["missing reference", (c) => delete c.fullUIBundle, /output binding/],
          [
            "adapted output",
            (c) => c.outputAdapter = "paper-k0-centered-canvas-v1",
            /output binding/,
          ],
          ["wrong path", (c) => c.outputPath = "legacy.png", /output binding/],
          [
            "wrong hash",
            (c) => c.outputSha256 = "0".repeat(64),
            /output binding/,
          ],
          [
            "rehash binding only",
            (c) =>
              c.outputSha256 = c.fullUIBundle.manifestSha256 = "0".repeat(64),
            /stale manifest digest/,
          ],
          [
            "stale identity",
            (c) => c.sourceCommit = "stale",
            /stale bundle identity/,
          ],
          ["legacy reference", (c) =>
            c.fullUIBundle = {
              scope: "full-ui",
              path: c.outputPath,
              sha256: c.outputSha256,
            }, /output binding/],
        ]
      ) {
        await t.test(name, async () => {
          const changed = structuredClone(candidate);
          mutate(changed);
          assert.match(
            (await viewportBundleRecordIssues(root, changed)).join(),
            expected,
          );
        });
      }
      assert.deepEqual(
        await viewportBundleRecordIssues(root, {
          catalogId: "atom.button",
          sourceProfile: "V0",
          outputPath: "existing.png",
        }),
        [],
      );
    } finally {
      await f.context.close();
    }
  });

  test("declared identity must match observed context, even when every frame agrees on the wrong context", async (t) => {
    const f = await fixture("declared-context");
    try {
      const { reference, manifest } = await f.capture();
      for (
        const [field, value] of [
          ["viewport", { width: 641, height: 360 }],
          ["dpr", 2],
          ["pointer", "coarse"],
          ["locale", "fr-FR"],
          ["timezone", "America/New_York"],
          ["reducedMotion", "no-preference"],
          ["colorScheme", "dark"],
        ]
      ) {
        await t.test(field, async () => {
          const identity = { ...f.identity, [field]: value };
          const m = { ...manifest, identity };
          const bytes = JSON.stringify(m);
          await writeFile(join(root, reference.manifestPath), bytes);
          assert.match(
            (await viewportBundleIssues(root, {
              ...reference,
              manifestSha256: hash(bytes),
            }, identity)).join(),
            /declared context mismatch/,
          );
        });
      }
    } finally {
      await f.context.close();
    }
  });

  test("inactive sticky remains canonical and pixel-identical; active sticky and fixed overlays fail", async (t) => {
    for (
      const [name, style, accepted] of [
        [
          "inactive-sticky",
          "#marker {position:sticky;top:auto;bottom:auto}",
          true,
        ],
        ["active-sticky", "#marker {position:sticky;top:0}", false],
        ["fixed", "#marker {position:fixed;top:80px;width:100%}", false],
        [
          "occluded",
          "#marker {position:absolute;z-index:1;top:0;width:100%}",
          false,
        ],
        ["hidden", ".ui-worker-detail__boundary {visibility:hidden}", false],
      ]
    ) {
      await t.test(name, async () => {
        const f = await fixture(name, { style });
        try {
          const original = await f.page.content();
          if (accepted) {
            const { reference, manifest } = await f.capture();
            assert.ok(
              manifest.initial.hazards.some((h) => h.kind === "sticky"),
            );
            for (const frame of manifest.frames) {
              assert.deepEqual(
                frame.before.hazards,
                manifest.initial.hazards,
                "sticky document boxes never move",
              );
              assert.equal(
                frame.before.layoutDigest,
                manifest.initial.layoutDigest,
              );
            }
            assert.deepEqual(
              await viewportBundleIssues(root, reference, f.identity),
              [],
            );
          } else {await assert.rejects(
              f.capture(),
              /context\/DOM\/layout changed|occlusion|qualification/,
            );}
          assert.equal(await f.page.content(), original);
          assert.equal(await f.page.evaluate(() => scrollY), 13);
        } finally {
          await f.context.close();
        }
      });
    }
  });

  test("screenshot failure and scroll-triggered DOM mutation restore original DOM and scroll", async (t) => {
    for (const mode of ["screenshot", "mutation"]) {
      await t.test(mode, async () => {
        const f = await fixture(`failure-${mode}`);
        try {
          if (mode === "mutation") {
            await f.page.evaluate(() => {
              addEventListener(
                "scroll",
                () =>
                  document.querySelector("#marker").setAttribute(
                    "data-mutated",
                    "yes",
                  ),
                { once: true },
              );
            });
          } else {
            f.page.screenshot = () =>
              Promise.reject(new Error("injected screenshot failure"));
          }
          const original = await f.page.content();
          await assert.rejects(
            f.capture(),
            /screenshot failure|context\/DOM\/layout changed|DOM mutation/,
          );
          assert.equal(await f.page.content(), original);
          assert.equal(
            await f.page.evaluate(() => scrollY),
            13,
          );
        } finally {
          await f.context.close();
        }
      });
    }
  });
});
