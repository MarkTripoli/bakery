// Writes assets/brand/README.md from the tokens and the contrast matrix, so it never drifts.
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  ART_IDS,
  BRAND,
  luminance,
  palette,
  rel,
  roleColors,
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
import { MARK_MIN, MIN_SIZE, TEXT_MIN } from "./matrix.mjs";

const mark = (b) => (b ? "pass" : "FAIL");
const tick = (r) => (r.pass.mark && r.pass.wordmark ? "pass" : "FAIL");
const L = (hex) => luminance(hex).toFixed(3);

function variantTable() {
  const rows = VARIANT_IDS.map((id) => {
    const c = roleColors(id);
    const fmt = (v) => (v === null ? "—" : v === "knockout" ? "hole" : v);
    return `| \`${id}\` | ${variants[id].use} | ${fmt(c.outline)} | ${
      fmt(c.dough)
    } | ${fmt(c.plate)} | ${fmt(c.type)} | ${fmt(c.tile)} |`;
  });
  return [
    "| id | use | outline | dough | plate | type | tile |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function usageTable(matrix) {
  const rows = Object.keys(surfaces).map((key) => {
    const s = surfaces[key];
    const r = matrix.find((m) => m.surface === key && m.recommended);
    if (!r) {
      return `| \`${key}\` | \`${s.token}\` ${s.hex} | none | — | — | FAIL |`;
    }
    return `| \`${key}\` | \`${s.token}\` ${s.hex} | \`${r.variant}\` | ${r.contrast.mark} | ${r.contrast.wordmark} | ${
      tick(r)
    } |`;
  });
  return [
    "| surface | token · hex | recommended | mark (≥ 3:1) | wordmark (≥ 4.5:1) | pass |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function failTable(matrix) {
  const bad = matrix.filter((r) =>
    !TILE_IDS.includes(r.variant) && !(r.pass.mark && r.pass.wordmark)
  );
  return bad.map((r) =>
    `- \`${r.variant}\` on \`${r.surface}\`: mark ${r.contrast.mark}:1, wordmark ${r.contrast.wordmark}:1${
      r.pass.mark && r.pass.wordmarkLarge
        ? " (wordmark passes large-text 3:1 only)"
        : ""
    }`
  ).join("\n");
}

function tileTable(matrix) {
  const rows = ["light.canvas", "dark.canvas"].flatMap((key) =>
    TILE_IDS.map((id) => {
      const r = matrix.find((m) => m.surface === key && m.variant === id);
      return `| \`${id}\` | \`${key}\` | ${r.contrast.tile} | ${r.contrast.inner} | ${
        mark(r.pass.mark)
      } |`;
    })
  );
  return [
    "| tile | on surface | tile vs surface | outline vs tile | pass (≥ 3:1) |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function inventory() {
  const sizes = (id) => (FULL_SET.includes(id) ? FULL_SIZES : SHORT_SIZES);
  const lines = [
    "```",
    "assets/brand/",
    "  logo/",
    "    variants.json                 machine contract: palette, surfaces, files, matrix",
    `    mark/mark-<variant>.svg       512 art, ${VARIANT_IDS.length} variants`,
    "    mark/mark-32-<variant>.svg    optical 32 master (tiles: 24 art on a 32 tile)",
    "    mark/mark-16-<variant>.svg    optical 16 master (tiles: 12 art on a 16 tile)",
    `    lockup/lockup-<variant>.svg   ${ART_IDS.join(", ")}`,
    `    wordmark/wordmark-<variant>.svg  ${
      ART_IDS.filter((i) => i !== "on-brand").join(", ")
    } (on-brand = color-light)`,
    "    png/mark-<variant>-<size>.png",
    `        ${FULL_SET.join(", ")}: ${sizes("tile-light").join(" ")}`,
    `        others: ${SHORT_SIZES.join(" ")}`,
    `    png/lockup-<variant>-h<${LOCKUP_HEIGHTS.join("|")}>.png`,
    `    png/wordmark-<variant>-h<${WORDMARK_HEIGHTS.join("|")}>.png`,
    "  favicon/  favicon.svg (prefers-color-scheme) favicon.ico (16 32 48) apple-touch-icon.png (180)",
    "            icon-192.png icon-512.png icon-maskable-512.png icon-dark-192.png icon-dark-512.png",
    "            site.webmanifest",
    "  social/   og-1200x630.png og-1200x630-dark.png",
    "  sheets/   legibility.png variants.png clear-space.png",
    "```",
  ];
  return lines.join("\n");
}

export function writeReadme(matrix) {
  const dough = `golden L ${L(palette.golden)} → doughOnDark L ${
    L(palette.doughOnDark)
  }`;
  const plate = `cream L ${L(palette.cream)} → plateOnDark L ${
    L(palette.plateOnDark)
  }`;
  const md = `# Bakery brand assets

Logo colour-variant system. Every logo asset is transparent; only \`tile-*\` carry a background, by design. Three platform exports are full-bleed and opaque on purpose: \`favicon/apple-touch-icon.png\`, \`favicon/icon-maskable-512.png\` and the \`social/og-1200x630*.png\` cards.
Colours come from tokens, never typed by hand: surfaces and ink from
\`packages/ui/src/foundations/theme.css\`, brand colours and role tables from
\`packages/ui/src/brand/tokens.ts\`. Rebuild reads both.

## Variants

${variantTable()}

Roles: \`outline\` outer silhouette, \`line\` inner detail on light fills, \`feature\` eyes and smile,
\`dough\` head and body, \`plate\` face and toque, \`belt\`, \`roller\`, \`blush\`, \`type\` wordmark.
Mono = one ink, knock-outs real: rollers are holes in the belt, cheeks dropped, plate and dough
transparent. \`ink\` = foundation \`color.foreground\` light theme; light ink = dark theme.

### Dark treatment

Only the outer outline and the wordmark turn \`creamOnDark\` ${palette.creamOnDark}. Lines inside
light fills stay cocoa so toque creases, eyes and smile still read. The belt band stays cocoa,
ringed by the light outline. Fills are pulled down so the mascot does not glow on dark:
${dough}; ${plate}. Cream outline vs \`dark.surface\` stays far above 3:1.

## Usage matrix

Recommended variant per surface (first passing in preference order). Mark ratio = outline colour
vs surface, non-text, needs ≥ ${MARK_MIN}:1. Wordmark ratio = type colour vs surface, needs
≥ ${TEXT_MIN}:1. Full matrix, every variant on every surface, in \`logo/variants.json\`.

${usageTable(matrix)}

Variants that fail on a surface (do not use there):

${failTable(matrix)}

Tiles carry their own ground. Check tile fill vs the surface it sits on, and outline vs tile fill.

${tileTable(matrix)}

## Minimum sizes (CSS px)

| art | min | rule |
| --- | --- | --- |
| mark | ${MIN_SIZE.mark} | under 20 px use \`mark-16-*\`; 30-34 px use \`mark-32-*\`; every other size uses the 512 art (\`sizeRules\` in variants.json, first match wins) |
| lockup | ${MIN_SIZE.lockupHeight} tall | below that, drop to mark only |
| wordmark | ${MIN_SIZE.wordmarkHeight} tall | below that, drop to mark only |

Never scale the 16/32 masters off their size band; they are pixel-grid art.

## Clear space

\`x = 0.25 × mark height\`. Keep ≥ 1x clear on every side of mark, lockup and wordmark. Lockup uses
the character height as mark height. Diagram: \`sheets/clear-space.png\`.

## Files

${inventory()}

Sheets: \`sheets/legibility.png\` (every surface, actual 16/24/32 px and 6× nearest, old favicons
as "before"), \`sheets/variants.png\` (each variant on its recommended surfaces, with ratios).

## Rebuild

\`\`\`sh
node brand/scripts/build.mjs
\`\`\`

Needs \`BRAND_TOOLS\` (default \`~/.local/state/bakery/agent-tmp/brand-tools\`). See
\`brand/scripts/README.md\`. Wordmark and character trace from
\`brand/raw/001-logo-refine/001-logo-refine-3.png\`; mark is rebuilt from primitives.

## Provenance

Source images, prompts and licences: \`assets/brand/credits.json\`.
`;
  const file = path.join(BRAND, "README.md");
  writeFileSync(file, md);
  return rel(file);
}
