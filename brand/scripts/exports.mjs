// PNG renders, favicon / app icons, manifest and social cards. Everything renders from the SVGs.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  ART_IDS,
  BRAND,
  ensure,
  FAVICON,
  foundationHex,
  LOGO,
  optimize,
  PNG,
  render,
  roleColors,
  sharp,
  SOCIAL,
  theme,
  VARIANT_IDS,
  WORK,
  writePng,
  writeSvg,
} from "./lib.mjs";
import { BBOX, markBody } from "./mark.mjs";
import { ART24, gridPaths } from "./pixel.mjs";
import { WORDMARK_ALIAS } from "./lockup.mjs";
import { markGrid } from "./matrix.mjs";

export const FULL_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
export const SHORT_SIZES = [64, 256, 1024];
export const FULL_SET = [
  "color-light",
  "color-dark",
  "tile-light",
  "tile-dark",
];
export const LOCKUP_HEIGHTS = [64, 128, 256, 512];
export const WORDMARK_HEIGHTS = [64, 128, 256];

const read = (...p) => readFileSync(path.join(LOGO, ...p), "utf8");
export const markFile = (id, grid = "") =>
  path.join(LOGO, "mark", grid ? `mark-${grid}-${id}.svg` : `mark-${id}.svg`);

// Size rule lives in matrix.mjs SIZE_RULES: 16 master below 20 px, 32 master at 30-34 px, else the 512 art.
function markSource(id, size) {
  return read("mark", `mark-${markGrid(size)}${id}.svg`);
}

export function buildPngs() {
  const made = [];
  for (const id of VARIANT_IDS) {
    const sizes = FULL_SET.includes(id) ? FULL_SIZES : SHORT_SIZES;
    for (const size of sizes) {
      const file = path.join(PNG, `mark-${id}-${size}.png`);
      writePng(file, markSource(id, size), { width: size });
      made.push(file);
    }
  }
  for (const id of ART_IDS) {
    for (const height of LOCKUP_HEIGHTS) {
      const file = path.join(PNG, `lockup-${id}-h${height}.png`);
      writePng(file, read("lockup", `lockup-${id}.svg`), { height });
      made.push(file);
    }
    if (WORDMARK_ALIAS[id]) continue;
    for (const height of WORDMARK_HEIGHTS) {
      const file = path.join(PNG, `wordmark-${id}-h${height}.png`);
      writePng(file, read("wordmark", `wordmark-${id}.svg`), { height });
      made.push(file);
    }
  }
  return made;
}

// Full-bleed square with the mark scaled to `fraction` of the height (or fit in a safe circle).
function bleedSvg(fill, { fraction, circle }) {
  const w = BBOX.x1 - BBOX.x0;
  const h = BBOX.y1 - BBOX.y0;
  const s = circle ? (circle * 512) / Math.hypot(w, h) : (fraction * 512) / h;
  const cx = (BBOX.x0 + BBOX.x1) / 2;
  const cy = (BBOX.y0 + BBOX.y1) / 2;
  const tx = (256 - cx * s).toFixed(2);
  const ty = (256 - cy * s).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${fill}"/><g transform="translate(${tx} ${ty}) scale(${
    s.toFixed(4)
  })">${markBody("color-light")}</g></svg>`;
}

const LETTER_CLASS = {
  O: "o",
  L: "l",
  F: "f",
  D: "d",
  P: "p",
  B: "b",
  R: "r",
  K: "k",
};
const LETTER_ROLE = {
  o: "outline",
  l: "line",
  f: "feature",
  d: "dough",
  p: "plate",
  b: "belt",
  r: "roller",
  k: "blush",
};

// favicon.svg: tile art on the 32 grid; light by default, dark via prefers-color-scheme.
function faviconSvg() {
  const classes = (id) => {
    const c = roleColors(id);
    const rules = [`.t{fill:${c.tile}}`];
    for (const [cls, role] of Object.entries(LETTER_ROLE)) {
      if (c[role] && c[role] !== "knockout") {
        rules.push(`.${cls}{fill:${c[role]}}`);
      }
    }
    return rules.join("");
  };
  const groups = gridPaths(ART24, (ch) => LETTER_CLASS[ch] ?? null);
  const body = [...groups].map(([cls, ds]) =>
    `<path class="${cls}" transform="translate(4 4)" d="${ds.join("")}"/>`
  ).join("");
  const style = `${classes("tile-light")}@media (prefers-color-scheme:dark){${
    classes("tile-dark")
  }}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>${style}</style><rect class="t" width="32" height="32" rx="7"/>${body}</svg>`;
}

function writeFaviconSvg(file) {
  const svg = optimize(faviconSvg(), {
    multipass: true,
    floatPrecision: 0,
    plugins: [{
      name: "preset-default",
      params: { overrides: { inlineStyles: false } },
    }, "removeDimensions"],
  }).data;
  writeFileSync(file, svg);
  return svg;
}

export function buildFavicons() {
  ensure(FAVICON);
  const out = [];
  const cream = roleColors("tile-light").tile;
  writeFaviconSvg(path.join(FAVICON, "favicon.svg"));
  out.push("favicon.svg");

  // ico from the tile-light PNGs (16 and 32 from the optical masters)
  const ico = [16, 32, 48].map((n) =>
    path.join(PNG, `mark-tile-light-${n}.png`)
  );
  execFileSync("magick", [...ico, path.join(FAVICON, "favicon.ico")]);
  out.push("favicon.ico");

  writePng(
    path.join(FAVICON, "apple-touch-icon.png"),
    bleedSvg(cream, { fraction: 0.72 }),
    {
      width: 180,
    },
  );
  writePng(
    path.join(FAVICON, "icon-192.png"),
    read("mark", "mark-tile-light.svg"),
    { width: 192 },
  );
  writePng(
    path.join(FAVICON, "icon-512.png"),
    read("mark", "mark-tile-light.svg"),
    { width: 512 },
  );
  writePng(
    path.join(FAVICON, "icon-maskable-512.png"),
    bleedSvg(cream, { circle: 0.8 }),
    {
      width: 512,
    },
  );
  writePng(
    path.join(FAVICON, "icon-dark-192.png"),
    read("mark", "mark-tile-dark.svg"),
    {
      width: 192,
    },
  );
  writePng(
    path.join(FAVICON, "icon-dark-512.png"),
    read("mark", "mark-tile-dark.svg"),
    {
      width: 512,
    },
  );
  out.push(
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "icon-dark-192.png",
    "icon-dark-512.png",
  );

  const canvas = theme.light["--color-canvas"];
  const manifest = {
    name: "Bakery",
    short_name: "Bakery",
    start_url: "/",
    display: "standalone",
    theme_color: canvas,
    background_color: canvas,
    icons: [
      {
        src: "icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  writeFileSync(
    path.join(FAVICON, "site.webmanifest"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  out.push("site.webmanifest");
  return out;
}

async function socialCard(file, bg, lockupId) {
  const width = Math.round(1200 * 0.62);
  const lockup = render(read("lockup", `lockup-${lockupId}.svg`), { width });
  const meta = await sharp(lockup).metadata();
  await sharp({
    create: { width: 1200, height: 630, channels: 3, background: bg },
  })
    .composite([{
      input: lockup,
      left: Math.round((1200 - meta.width) / 2),
      top: Math.round((630 - meta.height) / 2),
    }])
    .png()
    .toFile(file);
}

export async function buildSocial() {
  ensure(SOCIAL, WORK);
  await socialCard(
    path.join(SOCIAL, "og-1200x630.png"),
    roleColors("tile-light").tile,
    "color-light",
  );
  await socialCard(
    path.join(SOCIAL, "og-1200x630-dark.png"),
    foundationHex("color.surface", "dark"),
    "color-dark",
  );
  return ["og-1200x630.png", "og-1200x630-dark.png"];
}

export { BRAND, writeSvg };
