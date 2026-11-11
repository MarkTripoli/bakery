import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export const K0_RASTER_VERSION = "paper-k0-export-reconciliation-v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const implementationDigest = digest(readFileSync(new URL(import.meta.url)));
const verified = new WeakSet();
const fail = (message) => {
  throw new Error(`K-0 raster: ${message}`);
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Validate the original file, not merely its 24-byte dimension header.
function dimensions(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail("PNG bytes required");
  }
  const png = Buffer.from(bytes);
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) fail("invalid PNG signature");
  let width, height, channels, depth, ended = false, dataEnded = false;
  const data = [];
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) fail("truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) fail("truncated PNG payload");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, end - 4);
    if (
      crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)
    ) fail("invalid PNG CRC");
    if (offset === 8 && type !== "IHDR") fail("missing PNG IHDR");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) fail("invalid PNG IHDR");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[body[9]];
      // Indexed/interlaced exports require an explicit decoder, not a header-only claim.
      if (
        !width || !height || !channels || ![8, 16].includes(depth) ||
        body[10] || body[11] || body[12]
      ) fail("unsupported PNG encoding");
    } else if (type === "IDAT") {
      if (dataEnded) fail("noncontiguous PNG IDAT");
      data.push(body);
    } else {
      if (data.length) dataEnded = true;
      if (type === "IEND") {
        if (length || end !== png.length || !data.length) {
          fail("invalid PNG IEND");
        }
        ended = true;
      } else if (/^[A-Z]/.test(type) && type !== "PLTE") {
        fail("unknown critical PNG chunk");
      }
    }
    offset = end;
  }
  if (!ended) fail("missing PNG IEND");
  const stride = width * channels * depth / 8 + 1;
  const size = stride * height;
  if (!Number.isSafeInteger(size) || size > 256 * 1024 * 1024) {
    fail("PNG too large");
  }
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: size });
  if (raw.length !== size) fail("invalid PNG scanline length");
  for (let offset = 0; offset < size; offset += stride) {
    if (raw[offset] > 4) fail("invalid PNG filter");
  }
  return { width, height };
}

/** Empirical export reconciliation only; not a claim about the backend producer. */
export function deriveK0RasterProfile(originalReferencePng, expected) {
  const reference = dimensions(originalReferencePng);
  const sha256 = digest(originalReferencePng);
  if (
    !expected || !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    sha256 !== expected.sha256
  ) fail("reference hash mismatch");
  if (
    reference.width !== expected.width || reference.height !== expected.height
  ) fail("reference dimensions mismatch");
  if (
    typeof expected.sourceIdentity !== "string" ||
    !expected.sourceIdentity.trim()
  ) fail("source identity required");
  const profile = Object.freeze({
    version: K0_RASTER_VERSION,
    sourceIdentity: expected.sourceIdentity,
    reference: Object.freeze({ sha256, ...reference }),
    offset: Object.freeze({ x: 0, y: (reference.height % 2) / 2 }),
    implementationDigest,
  });
  verified.add(profile);
  return profile;
}

/** Re-derive after JSON transport: serialized metadata alone is not verification. */
export function verifyK0RasterProfile(originalReferencePng, metadata) {
  const profile = deriveK0RasterProfile(originalReferencePng, {
    ...metadata?.reference,
    sourceIdentity: metadata?.sourceIdentity,
  });
  if (
    metadata.version !== profile.version ||
    metadata.implementationDigest !== profile.implementationDigest ||
    metadata.offset?.x !== profile.offset.x ||
    metadata.offset?.y !== profile.offset.y
  ) fail("profile metadata mismatch");
  return profile;
}

export async function captureK0Raster(page, targetSelector, profile) {
  if (!verified.has(profile)) {
    fail("unverified profile; re-derive from original reference bytes");
  }
  const target = page.locator(targetSelector);
  if (await target.count() !== 1 || !await target.isVisible()) {
    fail("target must be unique and visible");
  }
  const box = await target.boundingBox();
  if (
    !box || box.width !== profile.reference.width ||
    box.height !== profile.reference.height
  ) fail("natural dimensions mismatch");
  const environment = await page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  if (
    environment.dpr !== 1 || !Number.isInteger(box.x) ||
    !Number.isInteger(box.y) || box.x < 0 || box.y < 0 ||
    box.x + box.width > environment.width ||
    box.y + box.height > environment.height
  ) fail("unsupported viewport or clipping");
  // Playwright page screenshot clips are viewport-relative, even after scroll.
  const clip = { ...box };
  const screenshot = () => page.screenshot({ type: "png", clip, scale: "css" });
  // Read-only inspection on even exports; no style injection or extra screenshot.
  // Only observed full-width, same-fill background chains can supply edge paint.
  // Empty control boxes preserve their measured geometry and clipping hierarchy.
  const backgroundModel = await target.evaluate((root, odd) => {
    let inspected = root;
    const reject = (why, fields = {}) => {
      const node = {
        tag: inspected.tagName,
        id: inspected.id,
        className: inspected.getAttribute?.("class"),
        box: inspected.getBoundingClientRect(),
      };
      throw new Error(
        `K-0 raster: ${why}; ${JSON.stringify({ node, fields })}`,
      );
    };
    const rect = root.getBoundingClientRect();
    const layers = [];
    let fill;
    const cssKeys = [
      "background-color",
      "box-sizing",
      "display",
      "flex-direction",
      "flex-shrink",
      "align-items",
      "gap",
      "padding-top",
      "padding-bottom",
      "padding-left",
      "padding-right",
      "overflow-x",
      "overflow-y",
      "min-height",
      "width",
    ];
    for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.transform !== "none" || style.translate !== "none" ||
        style.rotate !== "none" || style.scale !== "none" ||
        style.perspective !== "none" || style.zoom !== "1"
      ) reject("unexpected transform");
      if (
        style.clipPath !== "none" || style.maskImage !== "none" ||
        style.filter !== "none" || style.opacity !== "1" ||
        style.mixBlendMode !== "normal"
      ) reject("unsupported paint or clipping");
      if (
        ancestor !== root &&
        (style.overflowX !== "visible" || style.overflowY !== "visible")
      ) {
        const a = ancestor.getBoundingClientRect();
        if (
          rect.left < a.left + ancestor.clientLeft ||
          rect.top < a.top + ancestor.clientTop ||
          rect.right > a.left + ancestor.clientLeft + ancestor.clientWidth ||
          rect.bottom > a.top + ancestor.clientTop + ancestor.clientHeight
        ) reject("ancestor clipping");
      }
    }
    const check = (r, edge) => {
      if (
        r.width && r.height &&
        (r.left < rect.left || r.right > rect.right || r.top < rect.top ||
          r.bottom > rect.bottom - (edge ? 0.5 : 0) ||
          (edge && r.top < rect.top + 1))
      ) reject("overflow or displaced-edge content");
    };
    for (const element of [root, ...root.querySelectorAll("*")]) {
      inspected = element;
      const style = getComputedStyle(element);
      // A display:none ancestor prevents all descendant paint. Zero-size boxes,
      // visibility and opacity are not proof: overflowing artwork still matters.
      let nonrendered = false;
      for (
        let ancestor = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        if (getComputedStyle(ancestor).display === "none") {
          nonrendered = true;
          break;
        }
      }
      if (nonrendered) continue;
      if (
        ((element === root || style.overflowX !== "visible") &&
          element.scrollWidth > element.clientWidth) ||
        ((element === root || style.overflowY !== "visible") &&
          element.scrollHeight > element.clientHeight)
      ) reject("overflow lost content");
      check(element.getBoundingClientRect(), false);
      if (!odd) continue;
      if (
        element.shadowRoot || element.tagName?.includes("-") ||
        element.hasAttribute?.("is")
      ) reject("uninspectable custom-element paint");
      if (
        style.position === "fixed" || style.position === "sticky" ||
        style.translate !== "none" || style.rotate !== "none" ||
        style.scale !== "none" || style.perspective !== "none"
      ) reject("unsupported descendant geometry");
      if (
        element.tagName?.toLowerCase() === "svg" && style.overflow === "visible"
      ) reject("unbounded SVG paint");
      if (
        style.boxShadow !== "none" || style.textShadow !== "none" ||
        style.filter !== "none" || style.backdropFilter !== "none" ||
        style.clipPath !== "none" || style.maskImage !== "none" ||
        style.outlineStyle !== "none" || style.transform !== "none"
      ) reject("unbounded paint");
      if (
        style.animationName !== "none" ||
        style.transitionDuration.split(",").some((v) => parseFloat(v) !== 0)
      ) reject("moving paint");
      for (const pseudo of ["::before", "::after", "::marker"]) {
        const p = getComputedStyle(element, pseudo);
        if (p.content !== "none" && p.content !== "normal") {
          reject("unproven pseudo paint");
        }
      }
      if (style.display === "list-item") reject("unproven marker paint");
      const painted =
        /^(IMG|SVG|CANVAS|VIDEO|IFRAME|OBJECT|EMBED|INPUT|BUTTON|SELECT|TEXTAREA)$/i
          .test(element.tagName) ||
        style.backgroundImage !== "none" ||
        style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        [
          style.borderTopWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
          style.borderRightWidth,
        ].some((v) => parseFloat(v) > 0);
      const box = element.getBoundingClientRect();
      const atBand = box.top < rect.top + 1 || box.bottom > rect.bottom - 0.5;
      if (atBand && (painted || element === root)) {
        if (painted && !/^(DIV|SECTION|MAIN)$/.test(element.tagName)) {
          check(box, true);
        }
        const transparent = style.backgroundColor === "rgba(0, 0, 0, 0)";
        const requirements = {
          tag: /^(DIV|SECTION|MAIN)$/.test(element.tagName),
          left: box.left === rect.left,
          width: box.width === rect.width,
          top: box.top === rect.top,
          height: Number.isInteger(box.height) && box.height >= 1 &&
            box.height <= rect.height,
          backgroundImage: style.backgroundImage === "none",
          borderRadius: style.borderRadius === "0px",
          opacity: style.opacity === "1",
          mixBlendMode: style.mixBlendMode === "normal",
          backgroundClip: style.backgroundClip === "border-box",
          position: style.position === "static",
          zIndex: style.zIndex === "auto",
          isolation: style.isolation === "auto",
          backgroundAttachment: style.backgroundAttachment === "scroll",
          backgroundBlendMode: style.backgroundBlendMode === "normal",
          borderTopWidth: parseFloat(style.borderTopWidth) === 0,
          borderBottomWidth: parseFloat(style.borderBottomWidth) === 0,
          borderLeftWidth: parseFloat(style.borderLeftWidth) === 0,
          borderRightWidth: parseFloat(style.borderRightWidth) === 0,
          overflowX: ["visible", "clip"].includes(style.overflowX),
          overflowY: ["visible", "clip"].includes(style.overflowY),
          backgroundColor: !transparent || element === root,
        };
        if (Object.values(requirements).some((valid) => !valid)) {
          reject("unproven background geometry or paint", {
            target: rect,
            failed: Object.fromEntries(
              Object.entries(requirements)
                .filter(([, valid]) => !valid)
                .map((
                  [field],
                ) => [field, style[field] ?? box[field] ?? element.tagName]),
            ),
          });
        }
        if (!transparent) {
          if (!/^rgb\(\d+, \d+, \d+\)$/.test(style.backgroundColor)) {
            reject("nonopaque background");
          }
          if (fill && fill !== style.backgroundColor) {
            reject("different background colors");
          }
          fill = style.backgroundColor;
        }
        const parent = element === root
          ? -1
          : layers.findIndex((l) => l.element === element.parentElement);
        if (element !== root && parent !== layers.length - 1) {
          reject("unfamiliar background geometry");
        }
        if (
          style.boxSizing !== "border-box" &&
          [style.paddingTop, style.paddingBottom].some((v) => parseFloat(v) > 0)
        ) reject("unfamiliar background geometry");
        layers.push({
          element,
          parent,
          height: box.height,
          css: Object.fromEntries(
            cssKeys.map((k) => [k, style.getPropertyValue(k)]),
          ),
        });
      } else if (painted) check(box, true);
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) check(r, true);
        }
      }
    }
    if (odd) {
      if (
        !fill ||
        !layers.some((l) =>
          l.height === rect.height && l.css["background-color"] === fill
        )
      ) reject("missing full background");
      // Back the target at its immediate canvas, not behind opaque ancestors.
      // This changes no descendant paint and is restored before any full-UI proof.
      const canvas = root.parentElement;
      if (!canvas) reject("missing background canvas");
      inspected = canvas;
      const canvasStyle = getComputedStyle(canvas);
      const canvasBox = canvas.getBoundingClientRect();
      if (
        canvasBox.left > rect.left || canvasBox.top > rect.top ||
        canvasBox.right < rect.right || canvasBox.bottom < rect.bottom ||
        canvasStyle.backgroundImage !== "none" ||
        canvasStyle.backgroundClip !== "border-box" ||
        canvasStyle.borderRadius !== "0px" ||
        canvasStyle.mixBlendMode !== "normal"
      ) reject("unproven background canvas");
      return {
        fill,
        canvas: {
          tag: canvas.tagName,
          backgroundColor: canvasStyle.backgroundColor,
          box: canvasBox.toJSON(),
        },
        layers: layers.map(({ parent, height, css }) => ({
          parent,
          height,
          css,
        })),
      };
    }
  }, profile.offset.y !== 0);
  if (!profile.offset.y) return screenshot();
  const baseline = await screenshot();
  const edgeEvidence = (bytes) =>
    page.evaluate(async ({ url, width, height }) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.width !== width || image.height !== height) {
        throw new Error(
          `K-0 raster: raster edge dimensions mismatch; expected ${width}x${height}, actual ${image.width}x${image.height}`,
        );
      }
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0);
      const pixels =
        context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rows = [];
      for (const y of [0, canvas.height - 1]) {
        const start = y * canvas.width * 4;
        if (pixels[start + 3] !== 255) {
          throw new Error(
            `K-0 raster: raster edge alpha at (0,${y}): ${pixels[start + 3]}`,
          );
        }
        rows.push(Array.from(pixels.subarray(start, start + 4)));
        for (let x = 0; x < canvas.width; x++) {
          for (let c = 0; c < 4; c++) {
            if (
              pixels[(y * canvas.width + x) * 4 + c] !== pixels[start + c]
            ) {
              const rgba = Array.from(pixels.subarray(
                (y * canvas.width + x) * 4,
                (y * canvas.width + x) * 4 + 4,
              ));
              throw new Error(
                `K-0 raster: raster edge nonuniform at (${x},${y}): ${rgba}; row origin ${
                  rows.at(-1)
                }`,
              );
            }
          }
        }
      }
      return rows;
    }, {
      url: `data:image/png;base64,${bytes.toString("base64")}`,
      ...profile.reference,
    });
  const safe = await edgeEvidence(baseline);
  const expectedFill = backgroundModel.fill.match(/\d+/g).map(Number).concat(
    255,
  );
  if (!safe || safe.some((row) => row.some((v, i) => v !== expectedFill[i]))) {
    fail(
      `raster edge is not uniform opaque background; expected ${expectedFill}; actual ${
        JSON.stringify(safe)
      }`,
    );
  }
  const originalStyle = await target.getAttribute("style");
  const canvas = target.locator("..");
  const canvasStyle = await canvas.getAttribute("style");
  let control;
  try {
    control = await page.context().newPage();
    await control.setViewportSize(page.viewportSize());
    await control.setContent(
      '<!doctype html><html><body><div id="model"></div></body></html>',
    );
    await control.evaluate(({ model, clip, offset }) => {
      document.body.style.margin = "0";
      document.body.style.backgroundColor = model.fill;
      const wrapper = document.querySelector("#model");
      Object.assign(wrapper.style, {
        position: "absolute",
        left: clip.x + "px",
        top: clip.y + "px",
        width: clip.width + "px",
        transform: `translateY(${offset}px)`,
      });
      const nodes = [];
      for (const layer of model.layers) {
        const e = document.createElement("div");
        for (const [k, v] of Object.entries(layer.css)) {
          e.style.setProperty(k, v);
        }
        e.style.height = layer.height + "px";
        (layer.parent === -1 ? wrapper : nodes[layer.parent]).append(e);
        nodes.push(e);
      }
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect();
        if (
          r.x !== clip.x || r.y !== clip.y + offset || r.width !== clip.width ||
          r.height !== model.layers[i].height
        ) {
          throw new Error("K-0 raster: modeled background geometry mismatch");
        }
      }
    }, { model: backgroundModel, clip, offset: profile.offset.y });
    const modeledEdge = await edgeEvidence(
      await control.screenshot({ type: "png", clip, scale: "css" }),
    );
    if (!modeledEdge) fail("nonuniform modeled edge");
    await canvas.evaluate(
      (e, fill) => e.style.setProperty("background-color", fill, "important"),
      backgroundModel.fill,
    );
    await target.evaluate((element) =>
      element.style.setProperty("transform", "translateY(0.5px)", "important")
    );
    const shifted = await target.boundingBox();
    if (
      !shifted || shifted.x !== box.x || shifted.y !== box.y + 0.5 ||
      shifted.width !== box.width || shifted.height !== box.height
    ) fail("transformed geometry mismatch");
    // Page clip stays fixed. Locator screenshot would cancel the translation.
    const result = await screenshot();
    const shiftedEdge = await edgeEvidence(result);
    if (
      !shiftedEdge ||
      JSON.stringify(shiftedEdge) !== JSON.stringify(modeledEdge)
    ) {
      fail(
        `shift exposed different edge paint; actual ${
          JSON.stringify(shiftedEdge)
        }; control ${JSON.stringify(modeledEdge)}; background ${
          JSON.stringify(backgroundModel)
        }`,
      );
    }
    return result;
  } finally {
    try {
      await target.evaluate((element, style) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }, originalStyle);
    } finally {
      try {
        await canvas.evaluate(
          (e, style) =>
            style === null
              ? e.removeAttribute("style")
              : e.setAttribute("style", style),
          canvasStyle,
        );
      } finally {
        await control?.close();
      }
    }
  }
}
