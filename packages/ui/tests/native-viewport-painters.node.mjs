import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureViewportBundle,
  decodeViewportPng,
  viewportBundleIdentity,
  viewportBundleIssues,
} from "../scripts/native-viewport-bundle.mjs";

const shapes = [
  ["horizontal", '<line id="target" x1="10" y1="20" x2="90" y2="20"/>', 640],
  ["vertical", '<line id="target" x1="20" y1="10" x2="20" y2="50"/>', 320],
  [
    "round-point",
    '<line id="target" x1="20" y1="20" x2="20" y2="20" stroke-linecap="round"/>',
  ],
  ["ordinary", '<div id="target">Painter</div>'],
];
const markup = (name, shape, extra = "") =>
  `<!doctype html><style>body{margin:0;background:white}.ui-worker-detail__boundary{height:40px;background:#ffe099}#artwork{height:680px}svg{display:block;width:100px;height:60px}#target{stroke:red;stroke-width:8;fill:red;color:red}div#target{width:80px;height:0;position:relative;top:20px;left:10px}${extra}</style><main><div class="ui-worker-detail__boundary" role="note" aria-label="Fixture qualification">Synthetic example only.</div><div id="artwork">${
    name === "ordinary" ? shape : `<svg viewBox="0 0 100 60">${shape}</svg>`
  }</div></main>`;

function changedPixels(a, b) {
  const before = decodeViewportPng(a), after = decodeViewportPng(b);
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  let count = 0;
  for (let i = 0; i < before.pixels.length; i += 4) {
    if (
      !before.pixels.subarray(i, i + 4).equals(after.pixels.subarray(i, i + 4))
    ) count++;
  }
  return count;
}

describe("zero-area painter observation", {
  skip: process.env.BROWSER_TESTS !== "1",
}, () => {
  let browser, root;
  before(async () => {
    root = process.env.SVG_PAINTER_EVIDENCE_ROOT
      ? resolve(process.env.SVG_PAINTER_EVIDENCE_ROOT)
      : await mkdtemp(join(tmpdir(), "bakery-painters-"));
    await mkdir(root, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    if (root && !process.env.SVG_PAINTER_EVIDENCE_ROOT) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function fixture(name, html) {
    const viewport = { width: 320, height: 240 };
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.setContent(html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      scrollTo(0, 0);
    });
    const raw = [];
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (...args) => {
      const result = await evaluate(...args);
      if (result?.geometry) raw.push(result);
      return result;
    };
    const identity = viewportBundleIdentity({
      id: name,
      catalogId: "template.workerReadOnlyDetail",
      storyId: "review-svg",
      viewport,
      dpr: 1,
      pointer: "fine",
      colorScheme: "light",
      locale: "en-US",
      timezone: "UTC",
      reducedMotion: "reduce",
      sourceCommit: "painter-regression",
    });
    return {
      page,
      context,
      raw,
      identity,
      capture: () =>
        captureViewportBundle(page, {
          root,
          directory: join(root, `${name}.full-ui`),
          identity,
        }),
      save: (data) =>
        writeFile(
          join(root, `${name}.json`),
          JSON.stringify({ browser: browser.version(), ...data }, null, 2) +
            "\n",
        ),
      target: () =>
        page.locator("#target").evaluate((e) => ({
          index: [...document.querySelectorAll("body, body *")].indexOf(e),
          rect: e.getBoundingClientRect().toJSON(),
          visible: e.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }),
        })),
    };
  }

  for (const [name, shape, expectedPixels] of shapes) {
    test(`${name}: CSSOM paint changes reject with unchanged DOM`, async (t) => {
      const f = await fixture(`paint-${name}`, markup(name, shape));
      try {
        const original = await f.page.content(), target = await f.target();
        const screenshot = f.page.screenshot.bind(f.page);
        let shots = 0, pixels;
        f.page.screenshot = async () => {
          const bytes = await screenshot();
          if (shots++ === 0) {
            await f.page.evaluate(
              (rule) =>
                document.styleSheets[0].insertRule(
                  rule,
                  document.styleSheets[0].cssRules.length,
                ),
              name === "ordinary"
                ? "#target{color:blue}"
                : "#target{stroke:blue;fill:blue}",
            );
            // Measure before failure restoration. These diagnostic PNGs never
            // replace any native bundle frame or participate in admission.
            const after = await screenshot();
            pixels = changedPixels(bytes, after);
            await writeFile(join(root, `paint-${name}-before.png`), bytes);
            await writeFile(join(root, `paint-${name}-after.png`), after);
          }
          return bytes;
        };
        let result, error;
        try {
          result = await f.capture();
        } catch (e) {
          error = e.message;
        }
        const issues = result
          ? await viewportBundleIssues(root, result.reference, f.identity)
          : null;
        const domUnchanged = await f.page.content() === original;
        await f.save({
          target,
          pixels,
          error: error ?? null,
          issues,
          domUnchanged,
          mutationCount: result?.manifest.mutationCount,
          frames: result?.manifest.frames.map((f) => f.rect),
          raw: f.raw,
        });
        t.diagnostic(
          `${name}: changedPixels=${pixels}, checkVisibility=${target.visible}, error=${
            error ?? "none"
          }`,
        );
        assert.ok(target.rect.width === 0 || target.rect.height === 0);
        if (expectedPixels !== undefined) assert.equal(pixels, expectedPixels);
        else assert.ok(pixels > 0, "fixture must actually paint");
        assert.equal(domUnchanged, true);
        assert.match(error ?? "", /context\/DOM\/layout changed/);
        assert.equal(f.raw[0].html, f.raw[2].html);
        assert.equal(f.raw[0].rootHtml, f.raw[2].rootHtml);
        const initial = f.raw[0].geometry.find((e) => e.index === target.index);
        const changed = f.raw[2].geometry.find((e) => e.index === target.index);
        assert.ok(initial && changed, "painted target must be observed");
        assert.notDeepEqual(initial.style, changed.style);
        assert.deepEqual(
          initial.svg ?? initial.box,
          changed.svg ?? changed.box,
        );
        assert.equal(await f.page.evaluate(() => scrollY), 0);
      } finally {
        await f.context.close();
      }
    });

    test(`${name}: unchanged zero-area painter passes native bundle`, async () => {
      const f = await fixture(`unchanged-${name}`, markup(name, shape));
      try {
        const original = await f.page.content(), target = await f.target();
        const { reference, manifest } = await f.capture();
        assert.deepEqual(
          await viewportBundleIssues(root, reference, f.identity),
          [],
        );
        await f.save({ target, reference, raw: f.raw });
        const geometry = f.raw[0].geometry;
        const observed = geometry.find((e) => e.index === target.index);
        assert.ok(observed, "zero-area painter must not be omitted");
        if (name === "ordinary") {
          assert.equal(observed.box.height, 0);
        } else {
          assert.ok(
            Object.values(observed.svg.localBox).every(Number.isFinite),
          );
          assert.ok(Object.values(observed.svg.ctm).every(Number.isFinite));
          assert.ok(
            observed.svg.localBox.width === 0 ||
              observed.svg.localBox.height === 0,
          );
          const owner = geometry.find((e) =>
            e.index === observed.svg.ownerViewport
          );
          assert.equal(owner.tag, "svg");
          assert.ok(owner.box);
        }
        assert.ok(observed.style.length > 0);
        for (const o of f.raw) assert.deepEqual(o.geometry, geometry);
        assert.deepEqual(manifest.initial, manifest.restored);
        assert.equal(manifest.mutationCount, 0);
        assert.deepEqual(manifest.frames.map((f) => f.rect.y), [
          0,
          120,
          240,
          360,
          480,
        ]);
        assert.equal(await f.page.content(), original);
      } finally {
        await f.context.close();
      }
    });
  }

  for (const hidden of ["display:none", "visibility:hidden", "opacity:0"]) {
    for (const name of ["svg", "ordinary"]) {
      test(`${name}: ${hidden} ancestry excludes unpainted descendants`, async (t) => {
        const shape = name === "svg"
          ? `<g style="${hidden}">${shapes[0][1]}</g>`
          : `<div style="${hidden}">${shapes[3][1]}</div>`;
        const f = await fixture(
          `hidden-${name}-${hidden.replace(":", "-")}`,
          markup(name, shape),
        );
        try {
          const target = await f.target(), original = await f.page.content();
          const screenshot = f.page.screenshot.bind(f.page);
          let shots = 0, pixels;
          f.page.screenshot = async () => {
            const bytes = await screenshot();
            if (shots++ === 0) {
              await f.page.evaluate(() =>
                document.styleSheets[0].insertRule(
                  "#target{stroke:blue;color:blue}",
                  document.styleSheets[0].cssRules.length,
                )
              );
              pixels = changedPixels(bytes, await screenshot());
            }
            return bytes;
          };
          const { reference } = await f.capture();
          await f.save({ target, pixels, raw: f.raw });
          t.diagnostic(
            `${name} ${hidden}: changedPixels=${pixels}, checkVisibility=${target.visible}`,
          );
          assert.equal(pixels, 0);
          assert.deepEqual(
            await viewportBundleIssues(root, reference, f.identity),
            [],
          );
          assert.ok(
            f.raw.every((o) =>
              !o.geometry.some((e) => e.index === target.index)
            ),
          );
          assert.equal(await f.page.content(), original);
        } finally {
          await f.context.close();
        }
      });
    }
  }

  for (
    const [name, rule] of [
      ["translation", "#target{transform:translateY(0.001px)}"],
      ["resize", "svg{width:101px}"],
    ]
  ) {
    test(`zero-area SVG ${name} rejects`, async () => {
      const f = await fixture(name, markup("horizontal", shapes[0][1]));
      try {
        const original = await f.page.content();
        const screenshot = f.page.screenshot.bind(f.page);
        let shots = 0;
        f.page.screenshot = async () => {
          const bytes = await screenshot();
          if (shots++ === 0) {
            await f.page.evaluate((rule) =>
              document.styleSheets[0].insertRule(
                rule,
                document.styleSheets[0].cssRules.length,
              ), rule);
          }
          return bytes;
        };
        await assert.rejects(f.capture(), /context\/DOM\/layout changed/);
        assert.equal(await f.page.content(), original);
      } finally {
        await f.context.close();
      }
    });
  }

  test("zero-area qualification is not vacuously visible", async () => {
    const f = await fixture(
      "zero-qualification",
      markup(
        "horizontal",
        shapes[0][1],
        ".ui-worker-detail__boundary{width:0;height:0}",
      ),
    );
    try {
      await assert.rejects(
        f.capture(),
        /qualification missing\/obscured\/incomplete/,
      );
      assert.equal(f.raw[0].qualification.visible, false);
      assert.equal(f.raw[0].qualification.box.width, 0);
      assert.equal(f.raw[0].qualification.box.height, 0);
    } finally {
      await f.context.close();
    }
  });
});
