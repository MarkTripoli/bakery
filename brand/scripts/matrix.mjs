// Contrast matrix and variants.json: WCAG 2.x ratios of every variant on every surface.
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  ART_IDS,
  contrast,
  LOGO,
  palette,
  rel,
  roleColors,
  ROOT,
  surfaces,
  TILE_IDS,
  VARIANT_IDS,
  variants,
} from "./lib.mjs";
import {
  FULL_SET,
  FULL_SIZES,
  LOCKUP_HEIGHTS,
  SHORT_SIZES,
  WORDMARK_HEIGHTS,
} from "./exports.mjs";
import { WORDMARK_ALIAS } from "./lockup.mjs";

export const MARK_MIN = 3;
export const TEXT_MIN = 4.5;
export const LARGE_TEXT_MIN = 3;
export const MIN_SIZE = { mark: 16, lockupHeight: 24, wordmarkHeight: 16 };
// First match wins; file is a key of a variant's files map.
export const SIZE_RULES = [
  { maxPx: 19, file: "mark16" },
  { minPx: 30, maxPx: 34, file: "mark32" },
  { file: "mark" },
];
export const markGrid = (size) => {
  const rule = SIZE_RULES.find((r) =>
    size >= (r.minPx ?? 0) && size <= (r.maxPx ?? Infinity)
  );
  return { mark16: "16-", mark32: "32-" }[rule.file] ?? "";
};

// First passing variant wins; order per surface.
export const PREFERENCE = {
  "light.surface": ["color-light"],
  "light.canvas": ["color-light"],
  "light.surface-subtle": ["color-light"],
  "dark.surface": ["color-dark"],
  "dark.canvas": ["color-dark"],
  "dark.surface-raised": ["color-dark"],
  "brand.golden": ["on-brand"],
  "light.primary": ["color-dark"],
  "dark.primary": ["color-light"],
  "light.selection": ["mono-light", "mono-dark"],
  "dark.selection": ["mono-light", "mono-dark"],
};

const r2 = (n) => Number(n.toFixed(2));

function evaluate(surfaceKey, id) {
  const surface = surfaces[surfaceKey].hex;
  const c = roleColors(id);
  if (TILE_IDS.includes(id)) {
    const tile = r2(contrast(c.tile, surface));
    const inner = r2(contrast(c.outline, c.tile));
    return {
      contrast: { mark: tile, wordmark: null, tile, inner },
      pass: { mark: tile >= MARK_MIN && inner >= MARK_MIN, wordmark: null },
    };
  }
  const mark = r2(contrast(c.outline, surface));
  const word = r2(contrast(c.type, surface));
  return {
    contrast: { mark, wordmark: word },
    pass: {
      mark: mark >= MARK_MIN,
      wordmark: word >= TEXT_MIN,
      wordmarkLarge: word >= LARGE_TEXT_MIN,
    },
  };
}

export function buildMatrix() {
  const rows = [];
  for (const key of Object.keys(surfaces)) {
    const order = PREFERENCE[key];
    const winner = order.find((id) => {
      const e = evaluate(key, id);
      return e.pass.mark && e.pass.wordmark;
    });
    for (const id of VARIANT_IDS) {
      rows.push({
        surface: key,
        variant: id,
        recommended: id === winner,
        ...evaluate(key, id),
      });
    }
  }
  return rows;
}

export const recommendedFor = (matrix, surfaceKey) =>
  matrix.find((r) => r.surface === surfaceKey && r.recommended)?.variant ??
    null;

function filesFor(id) {
  const f = {
    mark: `assets/brand/logo/mark/mark-${id}.svg`,
    mark32: `assets/brand/logo/mark/mark-32-${id}.svg`,
    mark16: `assets/brand/logo/mark/mark-16-${id}.svg`,
  };
  if (ART_IDS.includes(id)) {
    f.lockup = `assets/brand/logo/lockup/lockup-${id}.svg`;
    f.wordmark = `assets/brand/logo/wordmark/wordmark-${
      WORDMARK_ALIAS[id] ?? id
    }.svg`;
  }
  return f;
}

// viewBox width/height of every SVG file of a variant, keyed like `files`.
function dimensionsFor(files) {
  const out = {};
  for (const [key, file] of Object.entries(files)) {
    const svg = readFileSync(path.join(ROOT, file), "utf8");
    const box = svg.match(/viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/)
      .map(Number);
    if (!box || box.length !== 4 || box.some(Number.isNaN)) {
      throw new Error(`${file}: unreadable viewBox`);
    }
    out[key] = { width: box[2], height: box[3] };
  }
  return out;
}

function pngFor(id) {
  const sizes = FULL_SET.includes(id) ? FULL_SIZES : SHORT_SIZES;
  const png = {
    mark: Object.fromEntries(
      sizes.map((
        s,
      ) => [String(s), `assets/brand/logo/png/mark-${id}-${s}.png`]),
    ),
  };
  if (ART_IDS.includes(id)) {
    png.lockup = Object.fromEntries(
      LOCKUP_HEIGHTS.map((
        h,
      ) => [`h${h}`, `assets/brand/logo/png/lockup-${id}-h${h}.png`]),
    );
    const wm = WORDMARK_ALIAS[id] ?? id;
    png.wordmark = Object.fromEntries(
      WORDMARK_HEIGHTS.map((
        h,
      ) => [`h${h}`, `assets/brand/logo/png/wordmark-${wm}-h${h}.png`]),
    );
  }
  return png;
}

export function buildVariantsJson(matrix) {
  const json = {
    palette: { ...palette },
    surfaces,
    variants: {},
    matrix,
    minSize: MIN_SIZE,
    sizeRules: SIZE_RULES,
    clearSpace: {
      unit: "x",
      definition: "x = 0.25 × mark height",
      minimum: "1x on every side",
    },
  };
  for (const id of VARIANT_IDS) {
    const { label, use } = variants[id];
    json.variants[id] = {
      label,
      use,
      colors: roleColors(id),
      files: filesFor(id),
      dimensions: dimensionsFor(filesFor(id)),
      png: pngFor(id),
    };
  }
  return json;
}

export function writeVariantsJson(matrix) {
  const file = path.join(LOGO, "variants.json");
  writeFileSync(
    file,
    `${JSON.stringify(buildVariantsJson(matrix), null, 2)}\n`,
  );
  return rel(file);
}
