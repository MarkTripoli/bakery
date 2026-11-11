// Mark art: 512 primitives per variant, mono by tracing the cocoa pixels, optical 16/32 masters.
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  ART_IDS,
  ensure,
  f1,
  LOGO,
  render,
  roleColors,
  sharp,
  TILE_IDS,
  traceFile,
  transformPath,
  VARIANT_IDS,
  WORK,
  writeSvg,
} from "./lib.mjs";
import { ART12, ART16, ART24, ART32, gridSvg } from "./pixel.mjs";

// Outline weight on the 512 artboard (approved mark).
const STROKE = 14;
const h = STROKE / 2;

// Union outline of three circles, closed along the (hidden) bottom, as one arc path.
function toquePath(circles) {
  const [l, c, r] = circles;
  const meet = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    const half = Math.sqrt(a.r * a.r - k * k);
    const mx = a.x + (k * (b.x - a.x)) / d;
    const my = a.y + (k * (b.y - a.y)) / d;
    const ox = (half * (b.y - a.y)) / d;
    const oy = (half * (b.x - a.x)) / d;
    const pts = [{ x: mx + ox, y: my - oy }, { x: mx - ox, y: my + oy }];
    return { upper: pts.sort((p, q) => p.y - q.y)[0], lower: pts[1] };
  };
  const lc = meet(l, c);
  const cr = meet(c, r);
  const arc = (circle, from, to) => {
    const sweep = (Math.atan2(to.y - circle.y, to.x - circle.x) -
      Math.atan2(from.y - circle.y, from.x - circle.x) + 4 * Math.PI) %
      (2 * Math.PI);
    return `A${f1(circle.r)} ${f1(circle.r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${
      f1(to.x)
    } ${f1(to.y)}`;
  };
  return [
    `M${f1(lc.lower.x)} ${f1(lc.lower.y)}`,
    arc(l, lc.lower, lc.upper),
    arc(c, lc.upper, cr.upper),
    arc(r, cr.upper, cr.lower),
    arc(c, cr.lower, lc.lower),
    "Z",
  ].join("");
}

const circles = [
  { x: 179.5, y: 103.3, r: 48.6 - h },
  { x: 256, y: 100.4, r: 69.4 - h },
  { x: 332.5, y: 103.3, r: 48.6 - h },
];
const bandHalf = 87.2 - h;
const bx0 = f1(256 - bandHalf);
const bx1 = f1(256 + bandHalf);
const G = {
  toque: toquePath(circles),
  ticks: "M194 118C194 132 202 140 216 143M318 118C318 132 310 140 296 143",
  bandTop: `M${bx0} 146Q256 133 ${bx1} 146`,
  bandBottom: `M${bx0} 184Q256 172 ${bx1} 184`,
  band: `M${bx0} 146Q256 133 ${bx1} 146L${bx1} 184Q256 172 ${bx0} 184Z`,
  head:
    "M112 395C104 350 99.6 330 99.6 309C99.6 245 125 184 172 182L340 182C387 184 412.4 245 412.4 309C412.4 330 408 350 400 395Z",
  face:
    "M256 221C340 221 389 258 389 305C389 350 350 377 256 377C162 377 123 350 123 305C123 258 172 221 256 221Z",
  smile: "M233 320C238 348 274 348 279 320",
  belt: { x: 65.3, y: 379.3, w: 378.4, h: 101.5 },
};
// Painted extent of the mark inside the 512 artboard (outer outline edge).
export const BBOX = { x0: 65.3, x1: 443.7, y0: 31, y1: 480.8 };

const rect = (r, fill, rx) =>
  `<rect x="${f1(r.x)}" y="${f1(r.y)}" width="${f1(r.w)}" height="${
    f1(r.h)
  }" rx="${f1(rx)}" fill="${fill}"/>`;

// Mark art for one variant, in 512 units, as SVG fragments (no <svg> wrapper).
export function markBody(variantId) {
  const c = roleColors(variantId);
  if (c.outline === null) throw new Error("variant has no mark art");
  const fill = (v) => v ?? "none";
  const ink = (color, d, extra = "") =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="${
      extra || "round"
    }"/>`;
  const shaped = (d, fillColor) =>
    `<path d="${d}" fill="${
      fill(fillColor)
    }" stroke="${c.outline}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
  const split = c.line !== c.outline;
  const b = G.belt;
  const inset = h * 2;
  const trim = 8;
  const inner = { x: b.x + h, y: b.y + h, w: b.w - inset, h: b.h - inset };
  const band = {
    x: b.x + h + trim,
    y: b.y + h + trim,
    w: b.w - 2 * (h + trim),
    h: b.h - 2 * (h + trim),
  };
  const cy = f1(band.y + band.h / 2);
  const rollers = [-112, 0, 112].map((dx) =>
    `<circle cx="${256 + dx}" cy="${cy}" r="25" fill="${c.roller}"/>`
  ).join("");
  const hubs = [-112, 0, 112].map((dx) =>
    `<circle cx="${256 + dx}" cy="${cy}" r="6" fill="${c.belt}"/>`
  ).join("");
  return [
    shaped(G.head, c.dough),
    `<path d="${G.face}" fill="${fill(c.plate)}"/>`,
    c.blush
      ? `<ellipse cx="169.2" cy="345" rx="22" ry="11.8" fill="${c.blush}"/><ellipse cx="342.8" cy="345" rx="22" ry="11.8" fill="${c.blush}"/>`
      : "",
    `<rect x="173.9" y="253.9" width="41.8" height="78.8" rx="20.9" fill="${c.feature}"/>`,
    `<rect x="296.3" y="253.9" width="41.8" height="78.8" rx="20.9" fill="${c.feature}"/>`,
    ink(c.feature, G.smile),
    shaped(G.toque, c.plate),
    ink(c.line, G.ticks),
    shaped(G.band, c.plate),
    split
      ? ink(c.line, G.bandTop, "butt") + ink(c.line, G.bandBottom, "butt")
      : "",
    rect(b, c.outline, b.h / 2),
    rect(inner, c.roller, inner.h / 2),
    rect(band, c.belt, band.h / 2),
    rollers,
    hubs,
  ].join("");
}

const svg512 = (body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${extra}>${body}</svg>`;

// Tile: rounded square, mark bbox height = 72% of the tile, centred.
function tileSvg(variantId) {
  const c = roleColors(variantId);
  const s = (0.72 * 512) / (BBOX.y1 - BBOX.y0);
  const cx = (BBOX.x0 + BBOX.x1) / 2;
  const cy = (BBOX.y0 + BBOX.y1) / 2;
  const tx = f1(256 - cx * s);
  const ty = f1(256 - cy * s);
  const tile = `<rect width="512" height="512" rx="115.2" fill="${c.tile}"/>`;
  return svg512(
    `${tile}<g transform="translate(${tx} ${ty}) scale(${
      f1(s * 1000) / 1000
    })">${markBody(variantId)}</g>`,
  );
}

// Mono: trace the cocoa pixels of the colour-light mark at 4x, one compound path.
async function monoSvg(variantId) {
  const ink = roleColors(variantId).outline;
  ensure(WORK);
  const size = 2048;
  const png = render(svg512(markBody("color-light")), {
    width: size,
    background: "#ffffff",
  });
  const { data, info } = await sharp(png).raw().toBuffer({
    resolveWithObject: true,
  });
  const mask = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < mask.length; i++) {
    const lum = 0.299 * data[i * info.channels] +
      0.587 * data[i * info.channels + 1] +
      0.114 * data[i * info.channels + 2];
    mask[i] = lum < 100 ? 0 : 255;
  }
  const file = path.join(WORK, "mark-mono-mask.png");
  await sharp(mask, {
    raw: { width: info.width, height: info.height, channels: 1 },
  }).png()
    .toFile(file);
  const paths = await traceFile(file, { turdSize: 8, optTolerance: 0.6 });
  const d = paths.map((p) => transformPath(p, 512 / size)).join("");
  return svg512(`<path d="${d}" fill="${ink}" fill-rule="evenodd"/>`);
}

export const isMono = (id) => id.startsWith("mono-");

export async function buildMarks() {
  const dir = path.join(LOGO, "mark");
  ensure(dir);
  const out = {};
  for (const id of VARIANT_IDS) {
    const tile = TILE_IDS.includes(id);
    let svg512Doc;
    if (tile) svg512Doc = tileSvg(id);
    else if (isMono(id)) svg512Doc = await monoSvg(id);
    else svg512Doc = svg512(markBody(id));
    out[`mark-${id}`] = writeSvg(
      path.join(dir, `mark-${id}.svg`),
      svg512Doc,
      1,
    );
    const art32 = tile
      ? gridSvg(ART24, id, { tileSize: 32 })
      : gridSvg(ART32, id);
    const art16 = tile
      ? gridSvg(ART12, id, { tileSize: 16 })
      : gridSvg(ART16, id);
    out[`mark-32-${id}`] = writeSvg(
      path.join(dir, `mark-32-${id}.svg`),
      art32,
      0,
    );
    out[`mark-16-${id}`] = writeSvg(
      path.join(dir, `mark-16-${id}.svg`),
      art16,
      0,
    );
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildMarks();
  writeFileSync(
    path.join(WORK, "marks.json"),
    JSON.stringify(Object.keys(out)),
  );
  console.log(Object.keys(out).length, "mark SVGs");
}
export { ART_IDS };
