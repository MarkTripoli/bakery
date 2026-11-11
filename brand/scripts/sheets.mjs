// Review sheets drawn on real token surface colours: legibility, variants, clear space.
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  contrast,
  ensure,
  foundationHex,
  LOGO,
  render,
  Resvg,
  ROOT,
  sharp,
  SHEETS,
  surfaces,
  TILE_IDS,
  VARIANT_IDS,
} from "./lib.mjs";
import { BBOX, markBody } from "./mark.mjs";
import { markGrid, recommendedFor } from "./matrix.mjs";

const FONT = "Liberation Sans";
const read = (...p) => readFileSync(path.join(LOGO, ...p), "utf8");
const inkOn = (hex) => {
  const light = foundationHex("color.foreground", "dark");
  const dark = foundationHex("color.foreground", "light");
  return contrast(light, hex) >= contrast(dark, hex) ? light : dark;
};

function text(label, { size = 13, color, weight = 400, width = 300 }) {
  const lines = String(label).split("\n");
  const h = Math.ceil(lines.length * size * 1.35) + 4;
  const tspans = lines.map((l, i) =>
    `<text x="0" y="${
      size * 1.1 + i * size * 1.35
    }" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}">${
      l.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    }</text>`
  ).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${tspans}</svg>`;
  const r = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: FONT },
  });
  return r.render().asPng();
}

const viewBoxOf = (svg) =>
  svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);

function markPng(id, size) {
  return render(read("mark", `mark-${markGrid(size)}${id}.svg`), {
    width: size,
  });
}
const lockupPng = (id, height) =>
  render(read("lockup", `lockup-${id}.svg`), { height });
const wordmarkPng = (id, height) => {
  const alias = id === "on-brand" ? "color-light" : id;
  return render(read("wordmark", `wordmark-${alias}.svg`), { height });
};
const nearest = (png, factor) =>
  sharp(png).metadata().then((m) =>
    sharp(png).resize(m.width * factor, m.height * factor, {
      kernel: "nearest",
    }).png().toBuffer()
  );

async function sheet(file, width, height, background, layers) {
  ensure(path.dirname(file));
  await sharp({ create: { width, height, channels: 3, background } })
    .composite(
      layers.map((l) => ({
        ...l,
        left: Math.round(l.left),
        top: Math.round(l.top),
      })),
    )
    .png()
    .toFile(file);
}

function fallbackVariant(matrix, key) {
  const rows = matrix.filter((r) =>
    r.surface === key && !TILE_IDS.includes(r.variant)
  );
  return rows.sort((a, b) => b.contrast.mark - a.contrast.mark)[0].variant;
}

export async function legibilitySheet(matrix) {
  const keys = Object.keys(surfaces);
  const ROW = 212;
  const HEAD = 56;
  const W = 1320;
  const head = surfaces["light.canvas"];
  const headInk = inkOn(head.hex);
  const layers = [];
  const rects = [];
  // column x offsets
  const col = { label: 16, before: 330, one: 440, six: 570, lockup: 1062 };
  const heads = [
    [col.before, "before (old favicons)\n16 · 32 px"],
    [col.one, "1×  16 · 24 · 32 px"],
    [col.six, "6× nearest-neighbour"],
    [col.lockup, "lockup 24 · 32 px tall"],
  ];
  layers.push({
    input: text("Legibility · recommended variant per surface, actual pixels", {
      size: 15,
      color: headInk,
      weight: 700,
      width: 600,
    }),
    left: col.label,
    top: 8,
  });
  for (const [x, label] of heads) {
    layers.push({
      input: text(label, { size: 11, color: headInk, width: 240 }),
      left: x,
      top: 26,
    });
  }
  const old16 = readFileSync(path.join(ROOT, "assets/brand/favicon-16.png"));
  const old32 = readFileSync(path.join(ROOT, "assets/brand/favicon-32.png"));
  for (const [i, key] of keys.entries()) {
    const s = surfaces[key];
    const y = HEAD + i * ROW;
    const ink = inkOn(s.hex);
    const id = recommendedFor(matrix, key) ?? fallbackVariant(matrix, key);
    const row = matrix.find((r) => r.surface === key && r.variant === id);
    rects.push({ y, hex: s.hex });
    layers.push({
      input: text(
        `${s.label}\n${s.token} ${s.hex}\n${id}\nmark ${row.contrast.mark}:1 · word ${row.contrast.wordmark}:1`,
        { size: 12, color: ink, width: 300 },
      ),
      left: col.label,
      top: y + 14,
    });
    layers.push({ input: old16, left: col.before, top: y + 14 });
    layers.push({ input: old32, left: col.before + 28, top: y + 14 });
    let x = col.one;
    for (const size of [16, 24, 32]) {
      layers.push({ input: markPng(id, size), left: x, top: y + 14 });
      x += size + 14;
    }
    x = col.six;
    for (const size of [16, 24, 32]) {
      layers.push({
        input: await nearest(markPng(id, size), 6),
        left: x,
        top: y + 10,
      });
      x += size * 6 + 14;
    }
    const lk = [24, 32];
    let lx = col.lockup;
    for (const h of lk) {
      const png = lockupPng(id, h);
      layers.push({ input: png, left: lx, top: y + 14 });
      lx += (await sharp(png).metadata()).width + 14;
    }
  }
  // per-row surface fills go underneath everything
  const bands = [];
  for (const r of rects) {
    bands.push({
      input: await sharp({
        create: { width: W, height: ROW, channels: 3, background: r.hex },
      }).png().toBuffer(),
      left: 0,
      top: r.y,
    });
  }
  const file = path.join(SHEETS, "legibility.png");
  await sheet(file, W, HEAD + keys.length * ROW, head.hex, [
    ...bands,
    ...layers,
  ]);
  return file;
}

export async function variantsSheet(matrix) {
  const ids = VARIANT_IDS;
  const CELL_W = 470;
  const CELL_H = 212;
  const LABEL_W = 190;
  const W = LABEL_W + CELL_W * 4;
  const H = 40 + ids.length * CELL_H;
  const page = surfaces["light.canvas"];
  const layers = [
    {
      input: text(
        "Variants on their recommended surfaces · mark, lockup, wordmark · WCAG ratios",
        {
          size: 15,
          color: inkOn(page.hex),
          weight: 700,
          width: 900,
        },
      ),
      left: 16,
      top: 10,
    },
  ];
  for (const [r, id] of ids.entries()) {
    const y = 40 + r * CELL_H;
    const keys = TILE_IDS.includes(id)
      ? (id === "tile-light"
        ? ["dark.canvas", "dark.surface"]
        : ["light.canvas", "light.surface"])
      : matrix.filter((m) => m.variant === id && m.recommended).map((m) =>
        m.surface
      );
    layers.push({
      input: text(id, {
        size: 14,
        color: inkOn(page.hex),
        weight: 700,
        width: LABEL_W,
      }),
      left: 16,
      top: y + 12,
    });
    for (const [c, key] of keys.slice(0, 4).entries()) {
      const s = surfaces[key];
      const x = LABEL_W + c * CELL_W;
      const row = matrix.find((m) => m.surface === key && m.variant === id);
      const ink = inkOn(s.hex);
      layers.push({
        input: await sharp({
          create: {
            width: CELL_W,
            height: CELL_H,
            channels: 3,
            background: s.hex,
          },
        }).png().toBuffer(),
        left: x,
        top: y,
      });
      layers.push({ input: markPng(id, 128), left: x + 16, top: y + 16 });
      if (!TILE_IDS.includes(id)) {
        layers.push({ input: lockupPng(id, 80), left: x + 164, top: y + 16 });
        layers.push({
          input: wordmarkPng(id, 44),
          left: x + 164,
          top: y + 112,
        });
      }
      const caption = TILE_IDS.includes(id)
        ? `${s.label} · tile ${row.contrast.tile}:1 · mark ${row.contrast.inner}:1`
        : `${s.label} · mark ${row.contrast.mark}:1 · word ${row.contrast.wordmark}:1`;
      layers.push({
        input: text(caption, { size: 11, color: ink, width: CELL_W - 24 }),
        left: x + 16,
        top: y + CELL_H - 34,
      });
    }
  }
  const file = path.join(SHEETS, "variants.png");
  await sheet(file, W, H, page.hex, layers);
  return file;
}

// Clear space: x = 0.25 × mark height, 1x minimum on every side.
export async function clearSpaceSheet() {
  const page = surfaces["light.canvas"];
  const ink = inkOn(page.hex);
  const guide = foundationHex("color.selection", "light");
  const W = 1200;
  const H = 610;
  const markH = BBOX.y1 - BBOX.y0;
  const markW = BBOX.x1 - BBOX.x0;
  const MARK_PX = 300;
  const k = MARK_PX / markH; // 512-art units -> px
  const xMark = 0.25 * MARK_PX;
  const mx = 40 + xMark;
  const my = 70 + xMark;
  const lockup = read("lockup", "lockup-color-light.svg");
  const [lw, lh] = viewBoxOf(lockup);
  const lockH = 200;
  const lockW = (lw / lh) * lockH;
  const xLock = 0.25 * lockH;
  const lx = 520 + xLock;
  const ly = my + (MARK_PX - lockH) / 2;
  const inner = lockup.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const label = (x, y) =>
    `<text x="${x}" y="${
      y + 5
    }" font-family="${FONT}" font-size="14" font-weight="700" text-anchor="middle" fill="${guide}">x</text>`;
  const frame = (x, y, w, h, u) =>
    `<rect x="${x - u}" y="${y - u}" width="${w + 2 * u}" height="${
      h + 2 * u
    }" fill="${guide}" fill-opacity="0.1" stroke="${guide}" stroke-width="1.5"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${page.hex}"/>`;
  const dashed = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${guide}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  const labels = (x, y, w, h, u) =>
    label(x + w / 2, y - u / 2) + label(x + w / 2, y + h + u / 2) +
    label(x - u / 2, y + h / 2) +
    label(x + w + u / 2, y + h / 2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="${page.hex}"/>
<text x="24" y="34" font-family="${FONT}" font-size="16" font-weight="700" fill="${ink}">Clear space · x = 0.25 × mark height · minimum 1x on every side</text>
${frame(mx, my, markW * k, MARK_PX, xMark)}
<g transform="translate(${mx - BBOX.x0 * k} ${my - BBOX.y0 * k}) scale(${k})">${
      markBody("color-light")
    }</g>
${dashed(mx, my, markW * k, MARK_PX)}
${labels(mx, my, markW * k, MARK_PX, xMark)}
${frame(lx, ly, lockW, lockH, xLock)}
<svg x="${lx}" y="${ly}" width="${lockW}" height="${lockH}" viewBox="0 0 ${lw} ${lh}">${inner}</svg>
${dashed(lx, ly, lockW, lockH)}
${labels(lx, ly, lockW, lockH, xLock)}
<text x="24" y="${
      H - 20
    }" font-family="${FONT}" font-size="13" fill="${ink}">Mark: x = ${xMark} px at ${MARK_PX} px tall. Lockup: x = ${xLock} px at ${lockH} px tall (character height drives x).</text>
</svg>`;
  const file = path.join(SHEETS, "clear-space.png");
  ensure(SHEETS);
  const r = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: FONT },
  });
  await sharp(r.render().asPng()).toFile(file);
  return file;
}
