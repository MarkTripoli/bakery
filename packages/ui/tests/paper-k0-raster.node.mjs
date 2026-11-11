import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
const {
  captureK0Raster,
  deriveK0RasterProfile,
  verifyK0RasterProfile,
} = await import(
  new URL("../scripts/paper-k0-raster.mjs", import.meta.url).href
);

function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, bytes, checksum]);
}
function fixture(height = 3) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(9 * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const expected = {
    sha256: createHash("sha256").update(png).digest("hex"),
    width: 2,
    height,
    sourceIdentity: "original-paper-export",
  };
  return { png, expected, profile: deriveK0RasterProfile(png, expected) };
}

test("original parity alone determines offset; metadata is immutable and serializable", () => {
  for (const height of [2, 3, 4, 5]) {
    const { png, expected, profile } = fixture(height);
    assert.equal(profile.offset.y, height % 2 / 2);
    assert.equal(profile.offset.x, 0);
    assert.deepEqual(
      deriveK0RasterProfile(png, {
        ...expected,
        candidateHeight: height + 1,
        frameId: "ignored",
        score: 100,
      }),
      profile,
    );
    assert.deepEqual(
      verifyK0RasterProfile(png, JSON.parse(JSON.stringify(profile))),
      profile,
    );
    assert.throws(() => {
      profile.reference.height = 90;
    }, TypeError);
    assert.match(profile.implementationDigest, /^[a-f0-9]{64}$/);
  }
});

test("hash, dimensions, source, signature, truncation and damaged payload fail closed", () => {
  const { png, expected } = fixture();
  assert.throws(
    () => deriveK0RasterProfile(png, { ...expected, sha256: "0".repeat(64) }),
    /hash mismatch/,
  );
  assert.throws(
    () => deriveK0RasterProfile(png, { ...expected, height: 4 }),
    /dimensions mismatch/,
  );
  assert.throws(
    () => deriveK0RasterProfile(png, { ...expected, sourceIdentity: " " }),
    /source identity/,
  );
  const bad = Buffer.from(png);
  bad[0] = 0;
  assert.throws(() => deriveK0RasterProfile(bad, expected), /signature/);
  assert.throws(
    () => deriveK0RasterProfile(png.subarray(0, 24), expected),
    /truncated/,
  );
  const corrupt = Buffer.from(png);
  corrupt[45] ^= 1;
  assert.throws(() => deriveK0RasterProfile(corrupt, expected), /CRC/);
});

test("transport metadata cannot substitute a profile or alter version, digest, offsets", async () => {
  const { png, profile } = fixture();
  for (
    const patch of [
      { version: "other" },
      { implementationDigest: "0".repeat(64) },
      { offset: { x: 1, y: 0.5 } },
      { offset: { x: 0, y: 0 } },
    ]
  ) {
    assert.throws(
      () => verifyK0RasterProfile(png, { ...profile, ...patch }),
      /metadata mismatch/,
    );
  }
  await assert.rejects(
    captureK0Raster({}, "#artboard", { ...profile }),
    /unverified/,
  );
});

// Protocol doubles exercise orchestration, not actual browser paint/layout.
function browserDouble(
  {
    height = 3,
    edgeSafe = true,
    shiftedEdgeSafe = true,
    captureError = false,
    geometryError = false,
    width = 2,
    count = 1,
    visible = true,
    x = 4,
    style = "color: red",
  } = {},
) {
  const clips = [];
  const mutations = [];
  let shifted = false;
  let calls = 0;
  const target = {
    count: () => count,
    isVisible: () => visible,
    boundingBox: () => ({
      x,
      y: 6 + (shifted ? (geometryError ? 1 : 0.5) : 0),
      width,
      height,
    }),
    getAttribute: () => style,
    locator: () => ({ getAttribute: () => null, evaluate: () => {} }),
    evaluate: (fn, arg) => {
      if (typeof arg === "boolean") {
        return { fill: "rgb(255, 255, 255)", layers: [] }; // DOM guards have separate executable tests below.
      }
      const element = {
        style: {
          setProperty: (...values) => {
            mutations.push(values);
            shifted = true;
          },
        },
        removeAttribute: () => {
          style = null;
          shifted = false;
        },
        setAttribute: (_, value) => {
          style = value;
          shifted = false;
        },
      };
      return fn(element, arg);
    },
  };
  const page = {
    locator: (selector) =>
      selector === "body"
        ? {
          getAttribute: () => null,
          evaluate: () => {},
        }
        : target,
    viewportSize: () => ({ width: 100, height: 100 }),
    context: () => ({
      newPage: () => ({
        setViewportSize: async () => {},
        setContent: async () => {},
        evaluate: async () => {},
        screenshot: () => Buffer.from("control-double"),
        close: async () => {},
      }),
    }),
    evaluate: (_, arg) =>
      arg
        ? (edgeSafe && (calls < 2 || shiftedEdgeSafe)
          ? [[255, 255, 255, 255], [255, 255, 255, 255]]
          : null)
        : { x: 10, y: 20, width: 100, height: 100, dpr: 1 },
    screenshot: (options) => {
      clips.push(options.clip);
      calls++;
      if (captureError && calls === 2) throw new Error("capture failed");
      return Buffer.from("test-double-only");
    },
  };
  return { page, clips, mutations, restored: () => !shifted && style };
}

test("odd capture freezes page clip rather than translating locator clip; restores exact style", async () => {
  const b = browserDouble();
  await captureK0Raster(b.page, "#artboard", fixture().profile);
  assert.equal(b.clips.length, 2);
  assert.deepEqual(
    b.clips,
    Array(2).fill({ x: 4, y: 6, width: 2, height: 3 }),
  );
  assert.deepEqual(b.mutations, [[
    "transform",
    "translateY(0.5px)",
    "important",
  ]]);
  assert.equal(b.restored(), "color: red");
});

test("even capture performs no injection or edge screenshot", async () => {
  const b = browserDouble({ height: 4 });
  await captureK0Raster(b.page, "#artboard", fixture(4).profile);
  assert.equal(b.clips.length, 1);
  assert.equal(b.mutations.length, 0);
});

test("capture and post-transform geometry errors restore styles, including absent style", async () => {
  for (
    const options of [{ captureError: true }, { geometryError: true }, {
      shiftedEdgeSafe: false,
    }, { captureError: true, style: null }]
  ) {
    const b = browserDouble(options);
    await assert.rejects(
      captureK0Raster(b.page, "#artboard", fixture().profile),
      /capture failed|geometry mismatch|different edge paint/,
    );
    assert.equal(b.restored(), options.style === null ? null : "color: red");
  }
});

test("natural size, uniqueness, visibility, viewport clipping and raster edge reject before mutation", async () => {
  for (
    const [options, error] of [
      [{ width: 3 }, /natural dimensions/],
      [{ count: 2 }, /unique/],
      [{ visible: false }, /visible/],
      [{ x: -1 }, /clipping/],
      [{ edgeSafe: false }, /raster edge/],
    ]
  ) {
    const b = browserDouble(options);
    await assert.rejects(
      captureK0Raster(b.page, "#artboard", fixture().profile),
      error,
    );
    assert.equal(b.mutations.length, 0);
  }
});

test("DOM inspector executes overflow, transform, paint and text-bound rejection", async () => {
  const defaults = {
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    zoom: "1",
    clipPath: "none",
    maskImage: "none",
    filter: "none",
    opacity: "1",
    boxShadow: "none",
    textShadow: "none",
    backdropFilter: "none",
    outlineStyle: "none",
    animationName: "none",
    transitionDuration: "0s",
    backgroundImage: "none",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderRadius: "0px",
    position: "static",
    zIndex: "auto",
    isolation: "auto",
    backgroundAttachment: "scroll",
    backgroundBlendMode: "normal",
    mixBlendMode: "normal",
    backgroundClip: "border-box",
    overflowX: "visible",
    overflowY: "visible",
    getPropertyValue: () => "",
  };
  const rect = { left: 4, top: 6, right: 6, bottom: 9, width: 2, height: 3 };
  const savedStyle = globalThis.getComputedStyle;
  const savedDocument = globalThis.document;
  try {
    for (
      const [patch, error] of [
        [{ transform: "matrix(1,0,0,1,0,0)" }, /transform/],
        [{ boxShadow: "0 1px black" }, /paint/],
        [{ pseudo: true }, /pseudo/],
        [{ overflow: true }, /overflow/],
        [{ text: true }, /edge content/],
        [{ image: "IMG" }, /edge content/],
        [{ image: "svg" }, /edge content/],
      ]
    ) {
      const root = {
        tagName: "DIV",
        parentElement: null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => rect,
        scrollWidth: patch.overflow ? 3 : 2,
        clientWidth: 2,
        scrollHeight: 3,
        clientHeight: 3,
        childNodes: patch.text
          ? [{ nodeType: 3, textContent: "last line" }]
          : [],
      };
      if (patch.image) {
        root.querySelectorAll =
          () => [{ ...root, tagName: patch.image, parentElement: root }];
      }
      globalThis.getComputedStyle = (_, pseudo) =>
        pseudo
          ? { content: patch.pseudo ? '"paint"' : "none" }
          : { ...defaults, ...patch };
      globalThis.document = {
        createRange: () => ({
          selectNodeContents() {},
          getClientRects: () => [rect],
        }),
      };
      const b = browserDouble();
      const locator = b.page.locator();
      locator.evaluate = (fn, arg) => fn(root, arg);
      await assert.rejects(
        captureK0Raster(b.page, "#artboard", fixture().profile),
        error,
      );
      assert.equal(b.clips.length, 0);
    }
  } finally {
    if (savedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = savedStyle;
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});

test("canvas edge evidence rejects nonuniform or transparent rows and wrong raster size", async () => {
  const savedImage = globalThis.Image;
  const savedDocument = globalThis.document;
  try {
    for (
      const fault of [
        null,
        "first-row",
        "last-row",
        "transparent",
        "dimensions",
        "wrong-fill",
      ]
    ) {
      const pixels = new Uint8ClampedArray(2 * 3 * 4).fill(255);
      // Interior foreground allowed; only the exposed/displaced edge must be empty.
      pixels[8] = 0;
      if (fault === "first-row") pixels[4] = 0;
      if (fault === "last-row") pixels[20] = 0;
      if (fault === "transparent") pixels[3] = 0;
      if (fault === "wrong-fill") {
        for (const i of [0, 4, 16, 20]) pixels[i] = 254;
      }
      globalThis.Image = class {
        width = fault === "dimensions" ? 3 : 2;
        height = 3;
        async decode() {}
      };
      globalThis.document = {
        createElement: () => ({
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data: pixels }),
          }),
        }),
      };
      const b = browserDouble();
      const evaluate = b.page.evaluate;
      b.page.evaluate = (fn, arg) => arg ? fn(arg) : evaluate(fn, arg);
      if (fault) {
        await assert.rejects(
          captureK0Raster(b.page, "#artboard", fixture().profile),
          fault === "dimensions"
            ? /raster edge dimensions mismatch; expected 2x3, actual 3x3/
            : fault === "transparent"
            ? /raster edge alpha at \(0,0\): 0/
            : fault === "wrong-fill"
            ? /expected 255,255,255,255; actual/
            : /raster edge nonuniform at \(1,[02]\)/,
        );
        assert.equal(b.mutations.length, 0);
      } else {
        await captureK0Raster(b.page, "#artboard", fixture().profile);
        assert.equal(b.clips.length, 2);
      }
    }
  } finally {
    if (savedImage === undefined) delete globalThis.Image;
    else globalThis.Image = savedImage;
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});

test("real DOM distinguishes visible line-box overflow and plain canvas from clipped paint", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 100, height: 101 },
    });
    const page = await context.newPage();
    await page.setContent(
      '<style>body{margin:0}#root,.canvas{width:100px;height:101px;background:white}.label{position:absolute;top:30px;line-height:1px;font-size:20px}</style><div id="root"><div class="canvas"><div class="label">Text</div></div></div>',
    );
    const bytes = await page.screenshot();
    const profile = deriveK0RasterProfile(bytes, {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 100,
      height: 101,
      sourceIdentity: "a".repeat(64),
    });
    await captureK0Raster(page, "#root", profile);
    await page.locator(".label").evaluate((el) => {
      el.style.overflow = "hidden";
    });
    await assert.rejects(
      captureK0Raster(page, "#root", profile),
      /overflow lost content/,
    );
    await page.locator(".label").evaluate((el) => {
      el.style.overflow = "visible";
      el.style.top = "100px";
    });
    await assert.rejects(
      captureK0Raster(page, "#root", profile),
      /overflow|edge content/,
    );
  } finally {
    await browser.close();
  }
});

test("declared flat and double background controls match light/dark exactly; guards and restoration", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    args: ["--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: 100, height: 101 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    for (const color of ["rgb(255, 255, 255)", "rgb(18, 22, 30)"]) {
      for (const nested of [false, true]) {
        const markup =
          `<style>body{margin:0}#root{width:100px;height:101px;overflow:clip;background:${color};box-sizing:border-box;display:flex;flex-direction:column}.band{background:${color};height:62px;flex-shrink:0;padding:21px 24px 19px;box-sizing:border-box}</style><div id="root">${
            nested ? '<div class="band"></div>' : ""
          }</div>`;
        await page.setContent(markup);
        const png = await page.screenshot();
        const profile = deriveK0RasterProfile(png, {
          sha256: createHash("sha256").update(png).digest("hex"),
          width: 100,
          height: 101,
          sourceIdentity: "unit-background-control-not-approved-mock",
        });
        await captureK0Raster(page, "#root", profile);
        assert.equal(await page.locator("#root").getAttribute("style"), null);
        assert.equal(await page.locator("body").getAttribute("style"), null);
        assert.equal(context.pages().length, 1);
        if (!nested) continue;
        const oneRgb = color.includes("255")
          ? "rgb(254,255,255)"
          : "rgb(19,22,30)";
        for (
          const fault of [
            `.band{border-top:1px solid ${oneRgb}}`,
            `.band{box-shadow:0 1px ${oneRgb}}`,
            `.band::before{content:'';position:absolute;top:0;left:0;width:100px;height:1px;background:${oneRgb}}`,
            `.band{width:99px}`,
            `.band{background:${oneRgb}}`,
            `.band{border-radius:1px}`,
            `.band{opacity:.99}`,
            `.band{height:62.5px}`,
          ]
        ) {
          await page.setContent(markup + `<style>${fault}</style>`);
          await assert.rejects(
            captureK0Raster(page, "#root", profile),
            /paint|background|geometry/,
          );
          assert.equal(await page.locator("#root").getAttribute("style"), null);
          assert.equal(context.pages().length, 1);
        }
        await page.setContent(markup);
        const screenshot = page.screenshot.bind(page);
        let calls = 0;
        page.screenshot = (...args) => {
          if (++calls === 2) throw new Error("injected actual capture failure");
          return screenshot(...args);
        };
        await assert.rejects(
          captureK0Raster(page, "#root", profile),
          /injected actual capture failure/,
        );
        page.screenshot = screenshot;
        assert.equal(await page.locator("#root").getAttribute("style"), null);
        assert.equal(await page.locator("body").getAttribute("style"), null);
        assert.equal(context.pages().length, 1);
        await page.locator("#root").evaluate((e) =>
          e.setAttribute("style", "color: red")
        );
        await page.locator("body").evaluate((e) =>
          e.setAttribute("style", "color: blue")
        );
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const modelPage = await newPage();
          modelPage.screenshot = () => {
            throw new Error("injected model capture failure");
          };
          return modelPage;
        };
        await assert.rejects(
          captureK0Raster(page, "#root", profile),
          /injected model capture failure/,
        );
        context.newPage = newPage;
        assert.equal(
          await page.locator("#root").getAttribute("style"),
          "color: red",
        );
        assert.equal(
          await page.locator("body").getAttribute("style"),
          "color: blue",
        );
        assert.equal(context.pages().length, 1);
      }
    }
  } finally {
    await browser.close();
  }
});

test("real browser ignores only display:none ancestry, not visible zero-size overflow", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 100, height: 101 },
    });
    const page = await context.newPage();
    await page.setContent(
      '<style>body{margin:0}#root{width:100px;height:101px;background:white}.rail{display:none}img{width:28px;height:28px}</style><div id="root"><div class="rail"><div><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22%3E%3Crect width=%2228%22 height=%2228%22 fill=%22black%22/%3E%3C/svg%3E"></div></div></div>',
    );
    const bytes = await page.screenshot();
    const profile = deriveK0RasterProfile(bytes, {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 100,
      height: 101,
      sourceIdentity: "a".repeat(64),
    });
    assert.equal(
      await page.locator("img").evaluate((el) =>
        el.getBoundingClientRect().width
      ),
      0,
    );
    await captureK0Raster(page, "#root", profile);
    for (
      const artwork of [
        '<img style="position:absolute;top:0;left:0">',
        '<style>.zero::after{content:"paint"}</style>',
        "overflowing text",
      ]
    ) {
      await page.locator(".rail").evaluate((el) => el.remove());
      await page.locator("#root").evaluate((el, artwork) => {
        el.insertAdjacentHTML(
          "beforeend",
          `<div class="rail zero" style="display:block;position:absolute;top:0;left:0;width:0;height:0;overflow:visible">${artwork}</div>`,
        );
      }, artwork);
      await assert.rejects(
        captureK0Raster(page, "#root", profile),
        /paint|overflow|edge|background/,
      );
    }
  } finally {
    await browser.close();
  }
});

test("opaque intermediate canvas and scrolled whole target preserve pixels, full UI and styles", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 100, height: 101 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    for (const color of ["rgb(255, 255, 255)", "rgb(18, 22, 30)"]) {
      for (const scrolled of [false, true]) {
        const markup = (backing) =>
          `<style>body{margin:0;background:rgb(245,246,248)}#ancestor{background:${backing};overflow:auto}#qualification{height:41px}#root{width:100px;height:101px}#paint{height:101px;background:${color};overflow:clip}.band{height:21px;background:${color}}.art{margin:10px;width:20px;height:20px;background:rgb(120,60,30)}</style><div id="ancestor"><div id="canvas" style="color: blue">${
            scrolled ? '<div id="qualification">Qualification</div>' : ""
          }<div id="root" style="color: red"><div id="paint"><div class="band"></div><div class="art"></div></div></div></div></div>`;
        // Derive from independent synthetic bytes; never sample a candidate color as expected.
        await page.setContent(markup(color));
        const reference = await page.screenshot();
        const profile = deriveK0RasterProfile(reference, {
          sha256: createHash("sha256").update(reference).digest("hex"),
          width: 100,
          height: 101,
          sourceIdentity: "unit-canvas-context-not-approved-mock",
        });
        if (scrolled) await page.evaluate(() => scrollTo(0, 41));
        const expected = await captureK0Raster(page, "#root", profile);
        await page.setContent(markup("rgb(245, 246, 248)"));
        await page.evaluate(() => scrollTo(0, 0));
        const fullBefore = await page.screenshot({ fullPage: true });
        if (scrolled) await page.evaluate(() => scrollTo(0, 41));
        const before = await page.locator("#root").boundingBox();
        const actual = await captureK0Raster(page, "#root", profile);
        assert.deepEqual(actual, expected);
        assert.equal(actual.readUInt32BE(16), 100);
        assert.equal(actual.readUInt32BE(20), 101);
        assert.deepEqual(await page.locator("#root").boundingBox(), before);
        assert.equal(await page.evaluate(() => scrollY), scrolled ? 41 : 0);
        assert.equal(
          await page.locator("#canvas").getAttribute("style"),
          "color: blue",
        );
        assert.equal(
          await page.locator("#root").getAttribute("style"),
          "color: red",
        );
        assert.equal(await page.locator("body").getAttribute("style"), null);
        assert.equal(context.pages().length, 1);
        await page.evaluate(() => scrollTo(0, 0));
        assert.deepEqual(await page.screenshot({ fullPage: true }), fullBefore);
        if (scrolled) await page.evaluate(() => scrollTo(0, 41));
        const screenshot = page.screenshot.bind(page);
        let calls = 0;
        page.screenshot = (...args) => {
          if (++calls === 2) throw new Error("canvas capture failure");
          return screenshot(...args);
        };
        await assert.rejects(
          captureK0Raster(page, "#root", profile),
          /canvas capture failure/,
        );
        page.screenshot = screenshot;
        assert.equal(
          await page.locator("#canvas").getAttribute("style"),
          "color: blue",
        );
        assert.equal(
          await page.locator("#root").getAttribute("style"),
          "color: red",
        );
        assert.equal(context.pages().length, 1);
        await page.locator("#canvas").evaluate((e) =>
          e.style.backgroundImage = "linear-gradient(red, blue)"
        );
        await assert.rejects(
          captureK0Raster(page, "#root", profile),
          /unproven background canvas/,
        );
      }
    }
  } finally {
    await browser.close();
  }
});
