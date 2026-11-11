// Audit of the built assets:  node brand/scripts/check.mjs   (exit 1 on any failure)
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  BRAND,
  LOGO,
  pathStats,
  render,
  roleColors,
  ROOT,
  sharp,
  VARIANT_IDS,
} from "./lib.mjs";

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};

const walk = (dir, ext) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, ext) : full.endsWith(ext) ? [full] : [];
  });

const norm = (hex) => {
  const h = hex.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
};
const usedColors = (svg) =>
  new Set(
    [...svg.matchAll(/(?:fill|stroke)[=:]\s*"?(#[0-9a-fA-F]{3,6})/g)].map((m) =>
      norm(m[1])
    ),
  );
const allowedFor = (ids) =>
  new Set(
    ids.flatMap((id) => Object.values(roleColors(id))).filter((v) =>
      v && v !== "knockout"
    ).map((
      v,
    ) => v.toLowerCase()),
  );

console.log("== SVG: bytes, path commands, audit");
const svgs = [
  ...walk(path.join(LOGO, "mark"), ".svg"),
  ...walk(path.join(LOGO, "lockup"), ".svg"),
  ...walk(path.join(LOGO, "wordmark"), ".svg"),
  path.join(BRAND, "favicon/favicon.svg"),
];
for (const file of svgs) {
  const svg = readFileSync(file, "utf8");
  const name = path.basename(file, ".svg");
  const stats = pathStats(svg);
  if (svg.includes("<image")) fail(`${name}: <image>`);
  if (!/viewBox="/.test(svg)) fail(`${name}: no viewBox`);
  if (/<svg[^>]*\s(width|height)=/.test(svg)) {
    fail(`${name}: root width/height`);
  }
  if (/<!--|<metadata|<title/.test(svg)) fail(`${name}: metadata/comment`);
  try {
    render(svg, { width: 64 });
  } catch (err) {
    fail(`${name}: resvg ${err.message}`);
  }
  const id = VARIANT_IDS.find((v) => name.endsWith(`-${v}`));
  const ids = name === "favicon" ? ["tile-light", "tile-dark"] : id ? [id] : [];
  // on-brand wordmark file is color-light's
  const allowed = allowedFor(ids);
  for (const color of usedColors(svg)) {
    if (!allowed.has(color)) fail(`${name}: colour ${color} not in role table`);
  }
  console.log(
    `${rel(file).padEnd(58)} ${String(stats.bytes).padStart(6)} B ${
      String(stats.commands).padStart(4)
    } cmds`,
  );
}
function rel(file) {
  return path.relative(ROOT, file);
}

console.log("== ico");
const ico = execFileSync("magick", [
  "identify",
  path.join(BRAND, "favicon/favicon.ico"),
], {
  encoding: "utf8",
});
console.log(ico.trim());
for (const size of ["16x16", "32x32", "48x48"]) {
  if (!ico.includes(` ${size} `)) fail(`favicon.ico missing ${size}`);
}

console.log("== json + paths");
const manifest = JSON.parse(
  readFileSync(path.join(BRAND, "favicon/site.webmanifest"), "utf8"),
);
for (const icon of manifest.icons) {
  if (!existsSync(path.join(BRAND, "favicon", icon.src))) {
    fail(`manifest icon ${icon.src}`);
  }
}
const variants = JSON.parse(
  readFileSync(path.join(LOGO, "variants.json"), "utf8"),
);
let pathsChecked = 0;
const visit = (node) => {
  if (typeof node === "string" && node.startsWith("assets/")) {
    pathsChecked++;
    if (!existsSync(path.join(ROOT, node))) {
      fail(`variants.json path missing: ${node}`);
    }
  } else if (node && typeof node === "object") {
    Object.values(node).forEach(visit);
  }
};
visit(variants.variants);
if (!Array.isArray(variants.sizeRules) || !variants.sizeRules.length) {
  fail("variants.json: sizeRules missing");
} else {
  for (const rule of variants.sizeRules) {
    for (const [id, v] of Object.entries(variants.variants)) {
      if (id.startsWith("tile")) continue;
      const file = v.files?.[rule.file];
      if (!file || !existsSync(path.join(ROOT, file))) {
        fail(`sizeRules ${rule.file}: file missing for ${id}`);
      }
    }
  }
}
console.log(`manifest ok, variants.json ok, ${pathsChecked} paths exist`);

console.log("== coverage: shipped files vs credits.json");
const credits = JSON.parse(
  readFileSync(path.join(BRAND, "credits.json"), "utf8"),
);
const prefixes = credits.images.flatMap((image) => image.shippedAs);
const walkAll = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walkAll(full) : [full];
  });
const shipped = [
  ...["logo", "favicon", "social", "scenes"].flatMap((dir) =>
    walkAll(path.join(BRAND, dir))
  ),
  ...walkAll(path.join(ROOT, "brand/refs")),
].map((file) => path.relative(ROOT, file)).filter((file) =>
  !/\.(json|md|webmanifest)$/.test(file) && !file.endsWith("contact-sheet.png")
);
for (const file of shipped) {
  if (!prefixes.some((prefix) => file.startsWith(prefix))) {
    fail(`not covered by credits.json shippedAs: ${file}`);
  }
}
for (const prefix of prefixes) {
  if (!shipped.some((file) => file.startsWith(prefix))) {
    fail(`credits.json shippedAs matches no file: ${prefix}`);
  }
}
console.log(`${shipped.length} shipped files, ${prefixes.length} prefixes`);

const cornerAlpha = async (input) => {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { width: w, height: h } = info;
  return [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) =>
    data[(y * w + x) * 4 + 3]
  );
};

console.log("== SVG corner alpha (non-tile)");
let svgCorners = 0;
for (const file of svgs) {
  const name = path.basename(file, ".svg");
  if (name.includes("tile") || name === "favicon") continue;
  const corners = await cornerAlpha(
    render(readFileSync(file, "utf8"), { width: 256 }),
  );
  svgCorners++;
  if (corners.some((v) => v !== 0)) {
    fail(`${name}: svg corner alpha ${corners}`);
  }
}
console.log(`${svgCorners} SVGs rendered, corners transparent`);

// A plate that leaves the corners clear (rounded or inset) passes the corner
// test, so also fail any single filled element that covers >= 90% of the box.
console.log("== SVG plate (non-tile): filled element coverage");
const PLATE_COVERAGE = 0.9;
const PROBE = 128;
let plateProbes = 0;
const failuresBeforePlate = failures;
for (const file of svgs) {
  const name = path.basename(file, ".svg");
  if (name.includes("tile") || name === "favicon") continue;
  const svg = readFileSync(file, "utf8");
  const open = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
  const viewBox = open.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) continue;
  const elements = svg.match(
    /<(?:path|rect|circle|ellipse|polygon)\b[^>]*\/?>/g,
  ) ?? [];
  for (const element of elements) {
    if (/\bfill="none"/.test(element)) continue;
    plateProbes++;
    const { data } = await sharp(
      render(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${element}</svg>`,
        {
          width: PROBE,
        },
      ),
    ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let covered = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) covered++;
    const share = covered / (data.length / 4);
    if (share >= PLATE_COVERAGE) {
      fail(
        `${name}: filled element covers ${
          (share * 100).toFixed(0)
        }% of viewBox`,
      );
    }
  }
}
if (failures === failuresBeforePlate) {
  console.log(`${plateProbes} filled elements probed, none cover >= 90%`);
}

console.log("== scenes/logo raster corner alpha (non-tile)");
let rasters = 0;
for (const dir of ["logo", "scenes"]) {
  for (const file of walkAll(path.join(BRAND, dir))) {
    const name = path.basename(file);
    if (!/\.(png|webp)$/.test(name) || name.includes("tile")) continue;
    if (name === "contact-sheet.png") continue;
    rasters++;
    const corners = await cornerAlpha(file);
    if (corners.some((v) => v !== 0)) {
      fail(`${rel(file)}: corner alpha ${corners}`);
    }
  }
}
console.log(`${rasters} rasters checked`);

console.log("== variants.json dimensions");
const variantsJson = JSON.parse(
  readFileSync(path.join(LOGO, "variants.json"), "utf8"),
);
let dims = 0;
for (const [id, v] of Object.entries(variantsJson.variants)) {
  for (const [key, file] of Object.entries(v.files)) {
    if (!file.endsWith(".svg")) continue;
    const d = v.dimensions?.[key];
    if (!(d?.width > 0 && d?.height > 0)) fail(`${id}.${key}: no width/height`);
    else dims++;
  }
}
console.log(`${dims} SVG dimensions listed`);

console.log("== PNG alpha");
const FULL_BLEED = [
  "apple-touch-icon.png",
  "icon-maskable-512.png",
  "og-1200x630",
];
const pngs = [
  ...walk(path.join(LOGO, "png"), ".png"),
  ...walk(path.join(BRAND, "favicon"), ".png"),
];
for (const file of pngs) {
  const name = path.basename(file);
  if (FULL_BLEED.some((f) => name.startsWith(f.replace(".png", "")))) continue;
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const a = (x, y) => data[(y * info.width + x) * 4 + 3];
  const { width: w, height: h } = info;
  const corners = [a(0, 0), a(w - 1, 0), a(0, h - 1), a(w - 1, h - 1)];
  if (corners.some((v) => v !== 0)) fail(`${name}: corner alpha ${corners}`);
  if (name.includes("tile") || name.startsWith("icon-")) {
    if (a(w >> 1, h >> 1) !== 255) fail(`${name}: centre not opaque`);
  }
}
console.log(`${pngs.length} PNGs checked`);
const total = walk(BRAND, ".png").length + walk(BRAND, ".svg").length;
console.log(`${total} png/svg files under assets/brand`);
console.log(statSync(path.join(LOGO, "variants.json")).size, "B variants.json");
console.log(failures ? `${failures} FAILURES` : "ALL CHECKS PASS");
process.exit(failures ? 1 : 0);
