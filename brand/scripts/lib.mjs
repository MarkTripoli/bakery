// Shared helpers for the brand build: paths, tokens, colour maths, SVG clean, render.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOOLS = process.env.BRAND_TOOLS ??
  path.join(os.homedir(), ".local/state/bakery/agent-tmp/brand-tools");
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const BRAND = path.join(ROOT, "assets/brand");
export const LOGO = path.join(BRAND, "logo");
export const PNG = path.join(LOGO, "png");
export const FAVICON = path.join(BRAND, "favicon");
export const SOCIAL = path.join(BRAND, "social");
export const SHEETS = path.join(BRAND, "sheets");
export const WORK = path.join(TOOLS, "work");
export const MASTER = path.join(
  ROOT,
  "brand/raw/001-logo-refine/001-logo-refine-3.png",
);
export const PYTHON = path.join(TOOLS, "venv/bin/python");
export const THEME_CSS = path.join(
  ROOT,
  "packages/ui/src/foundations/theme.css",
);

const toolRequire = createRequire(path.join(TOOLS, "node/"));
export const { optimize } = toolRequire("svgo");
export const { Resvg } = toolRequire("@resvg/resvg-js");
export const sharp = toolRequire("sharp");
export const potrace = toolRequire("potrace");

// Single source of truth for brand colours and variant roles.
const tokens = await import(
  pathToFileURL(path.join(ROOT, "packages/ui/src/brand/tokens.ts")).href
);
const foundation = await import(
  pathToFileURL(path.join(ROOT, "packages/ui/src/foundations/tokens.ts")).href
);
export const palette = tokens.brandPalette;
export const variants = tokens.logoVariants;
export const VARIANT_IDS = Object.keys(variants);
export const TILE_IDS = VARIANT_IDS.filter((id) =>
  variants[id].roles.tile.source !== "none"
);
export const ART_IDS = VARIANT_IDS.filter((id) => !TILE_IDS.includes(id));

// Theme blocks of foundations/theme.css -> { light: {--x: #hex}, dark: {...} }.
function parseTheme() {
  const css = readFileSync(THEME_CSS, "utf8");
  const blocks = { light: {}, dark: {} };
  const re =
    /(:root,\s*\[data-theme="light"\]|\[data-theme="dark"\])\s*\{([^}]*)\}/g;
  for (const [, head, body] of css.matchAll(re)) {
    const theme = head.includes("dark") ? "dark" : "light";
    for (
      const [, name, value] of body.matchAll(
        /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g,
      )
    ) {
      blocks[theme][name] = value.toUpperCase();
    }
  }
  return blocks;
}
export const theme = parseTheme();

export function foundationHex(name, themeName) {
  const cssVar = foundation.semanticTokens[name];
  const hex = theme[themeName][cssVar];
  if (!hex) throw new Error(`no ${cssVar} in ${themeName} theme`);
  return hex;
}

// Surfaces of the contract: key -> { token, theme, hex, label }.
export const surfaces = (() => {
  const s = {};
  const add = (key, token, themeName, label) => {
    s[key] = { token, theme: themeName, hex: theme[themeName][token], label };
  };
  add("light.surface", "--color-surface", "light", "Surface · light");
  add("light.canvas", "--color-canvas", "light", "Canvas · light");
  add(
    "light.surface-subtle",
    "--color-surface-subtle",
    "light",
    "Subtle · light",
  );
  add("light.primary", "--color-primary", "light", "Primary fill · light");
  add("light.selection", "--color-selection", "light", "Accent · light");
  add("dark.surface", "--color-surface", "dark", "Surface · dark");
  add("dark.canvas", "--color-canvas", "dark", "Canvas · dark");
  add("dark.surface-raised", "--color-surface-raised", "dark", "Raised · dark");
  add("dark.primary", "--color-primary", "dark", "Primary fill · dark");
  add("dark.selection", "--color-selection", "dark", "Accent · dark");
  s["brand.golden"] = {
    token: "brand.golden",
    theme: "brand",
    hex: palette.golden,
    label: "Brand orange",
  };
  return s;
})();

// Hex of one role in one variant, or null (none) / "knockout".
export function roleHex(variantId, role) {
  const r = variants[variantId].roles[role];
  if (r.source === "palette") return palette[r.name].toUpperCase();
  if (r.source === "foundation") return foundationHex(r.name, r.theme);
  if (r.source === "knockout") return "knockout";
  return null;
}
export const roleColors = (variantId) =>
  Object.fromEntries(
    Object.keys(variants[variantId].roles).map((
      r,
    ) => [r, roleHex(variantId, r)]),
  );

// WCAG 2.x contrast.
const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const rgb = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const ensure = (...dirs) =>
  dirs.forEach((dir) => mkdirSync(dir, { recursive: true }));
export const rel = (file) => path.relative(ROOT, file);

export function clean(svg, precision = 1) {
  return optimize(svg, {
    multipass: true,
    floatPrecision: precision,
    plugins: ["preset-default", "removeDimensions"],
  }).data;
}

export function writeSvg(file, svg, precision = 1) {
  const out = clean(svg, precision);
  ensure(path.dirname(file));
  writeFileSync(file, out);
  return out;
}

export function render(svg, { width, height, background } = {}) {
  const fitTo = height
    ? { mode: "height", value: height }
    : width
    ? { mode: "width", value: width }
    : { mode: "original" };
  const resvg = new Resvg(svg, {
    fitTo,
    background,
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

export function writePng(file, svg, opts) {
  ensure(path.dirname(file));
  const png = render(svg, opts);
  writeFileSync(file, png);
  return png;
}

export const hex = (n) => n.toString(16).padStart(2, "0");
export const f1 = (n) => Number(n.toFixed(1));

// Trace a black-on-white bitmap file with potrace -> list of path `d` strings.
export function traceFile(file, options = {}) {
  return new Promise((resolve, reject) => {
    potrace.trace(
      file,
      {
        threshold: 128,
        turdSize: 2,
        optTolerance: 0.4,
        alphaMax: 1,
        ...options,
      },
      (err, svg) => {
        if (err) return reject(err);
        resolve([...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]));
      },
    );
  });
}

// Scale and offset every number in an absolute path (potrace emits M/L/C/z only).
export function transformPath(d, scale, dx = 0, dy = 0, digits = 1) {
  let i = 0;
  return d.replace(/-?\d*\.?\d+/g, (num) => {
    const v = Number(num);
    const out = i++ % 2 === 0 ? v * scale + dx : v * scale + dy;
    return String(Number(out.toFixed(digits)));
  });
}

export const svgOpen = (viewBox, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>`;

export function pathStats(svg) {
  const cmds = (svg.match(/\sd="([^"]+)"/g) ?? []).join(" ").match(
    /[MmLlHhVvCcSsQqTtAaZz]/g,
  ) ?? [];
  return { bytes: Buffer.byteLength(svg), commands: cmds.length };
}

export { readFileSync, writeFileSync };
