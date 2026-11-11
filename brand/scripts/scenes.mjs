// Character scene exports: raw illustration -> transparent light + dark cutouts, SVG, manifest.
// Run: node brand/scripts/scenes.mjs [screen-id ...]   (no ids = all; SCENES_SVG=1 also traces SVGs, rejected, see README)
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BRAND,
  ensure,
  optimize,
  palette,
  PYTHON,
  rel,
  ROOT,
  sharp,
  surfaces,
  WORK,
} from "./lib.mjs";

const OUT = path.join(BRAND, "scenes");
const TRACE = path.join(ROOT, "brand/scripts/scenes_trace.py");
const SVG_MAX = 90 * 1024;
const BLOB_GOLD_MIX = 0.14;

const raw = (dir, n) => `brand/raw/${dir}/${dir}-${n}.png`;
const err = (n) => raw("003-scenes-errors", n);
const emp = (n) => raw("004-scenes-empty", n);
const mom = (n) => raw("005-scenes-moments", n);

export const SCENES = [
  [
    "not-found",
    "Page not found",
    "The chef mascot peers through a magnifying glass at a trail of crumbs.",
    err(2),
  ],
  [
    "not-found-pantry",
    "Page not found, pantry",
    "The chef mascot reads a map beside a stack of flour sacks.",
    err(16),
  ],
  [
    "server-error",
    "Server error",
    "The chef mascot looks worried next to a smoking oven and a burnt loaf.",
    err(5),
  ],
  [
    "forbidden",
    "Access denied",
    "The chef mascot raises a hand in front of a closed door and a velvet rope.",
    err(7),
  ],
  [
    "offline",
    "Offline",
    "The chef mascot holds an unplugged power cord beside a stopped conveyor belt.",
    err(11),
  ],
  [
    "reconnecting",
    "Reconnecting",
    "The chef mascot happily turns a hand crank to get a conveyor belt moving again.",
    raw("006-scene-reconnecting", 1),
  ],
  [
    "maintenance",
    "Maintenance",
    "The chef mascot sits on a conveyor belt with a big wrench and an open toolbox.",
    err(14),
  ],
  [
    "empty-tasks",
    "No tasks yet",
    "The chef mascot relaxes on a conveyor belt with a cup of coffee.",
    emp(2),
  ],
  [
    "empty-sessions",
    "No sessions yet",
    "The chef mascot waves from a small cafe table with two empty chairs.",
    emp(4),
  ],
  [
    "empty-workers",
    "No workers yet",
    "The chef mascot holds a clipboard while spare hats and mitts hang nearby.",
    emp(8),
  ],
  [
    "empty-search",
    "No results",
    "The chef mascot holds a whisk over an empty mixing bowl.",
    emp(10),
  ],
  [
    "loading",
    "Loading",
    "The chef mascot kneads dough on a conveyor belt.",
    mom(2),
  ],
  [
    "success",
    "Success",
    "The chef mascot cheers with confetti beside a fresh loaf of bread.",
    mom(4),
  ],
  [
    "welcome",
    "Welcome",
    "The chef mascot proudly holds a tray of fresh rolls.",
    mom(8),
  ],
  [
    "sign-in-hero",
    "Sign in",
    "The chef mascot waves beside a brick oven and a row of baked loaves.",
    mom(11),
    1600,
  ],
];

// ---------------------------------------------------------------- colour helpers
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) =>
  "#" +
  c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
    .toUpperCase();
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

const RAISED = hexToRgb(surfaces["dark.surface-raised"].hex);
export const DARK_BLOB = rgbToHex(
  mix(RAISED, hexToRgb(palette.golden), BLOB_GOLD_MIX),
);
const CREAM_ON_DARK = hexToRgb(palette.creamOnDark);

// ---------------------------------------------------------------- pixel pipeline
const D8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [
  1,
  1,
]];

// Breadth-first flood over `ok` pixels from `seeds`; returns the visited mask.
function flood(w, h, ok, seeds, conn = 4) {
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const s of seeds) {
    if (ok[s] && !seen[s]) {
      seen[s] = 1;
      queue[tail++] = s;
    }
  }
  const steps = conn === 8 ? D8 : D8.filter(([dx, dy]) => dx === 0 || dy === 0);
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (ok[q] && !seen[q]) {
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
  }
  return seen;
}

// Separable box blur of a float plane (radius r, clamped edges).
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum += src[row + Math.min(w - 1, x + r + 1)] -
        src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] -
        tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Ground = near-white or blob cream (R high, B lowered by cream tint, never blue/orange).
const isGround = (r, g, b) => r >= 238 && b >= 190 && g >= b - 4 && r - b <= 70;
const isWhite = (r, g, b) => Math.min(r, g, b) >= 243;

// Raw RGB -> analysis: alpha, per-pixel class, outline coverage. `dark` selects the recolour.
function cutout(rgb, w, h, dark) {
  const n = w * h;
  const seeds = [];
  for (let x = 0; x < w; x++) seeds.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) seeds.push(y * w, y * w + w - 1);

  const white = new Uint8Array(n);
  const groundOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    white[i] = isWhite(r, g, b) ? 1 : 0;
    groundOk[i] = isGround(r, g, b) ? 1 : 0;
  }
  const ext = flood(w, h, white, seeds); // background outside the blob
  const ground = flood(w, h, groundOk, seeds); // background + connected blob

  // Cocoa colour = median of the darkest pixels.
  const darkVals = [];
  for (let i = 0; i < n; i += 11) {
    const s = rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2];
    if (s < 260) darkVals.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  }
  const cocoa = [0, 1, 2].map((c) =>
    darkVals.map((v) => v[c]).sort((a, b) => a - b)[darkVals.length >> 1]
  );

  // Core outline pixels (close to cocoa); fringe coverage f from projection against local neighbours.
  const core = new Uint8Array(n);
  const num = [0, 1, 2].map(() => new Float32Array(n));
  const wgt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = rgb[i * 3] - cocoa[0],
      dg = rgb[i * 3 + 1] - cocoa[1],
      db = rgb[i * 3 + 2] - cocoa[2];
    if (dr * dr + dg * dg + db * db < 55 * 55) {
      core[i] = 1;
    } else {
      wgt[i] = 1;
      for (let c = 0; c < 3; c++) num[c][i] = rgb[i * 3 + c];
    }
  }
  const R = 6;
  const bw = boxBlur(wgt, w, h, R);
  const bn = num.map((p) => boxBlur(p, w, h, R));
  const f = new Float32Array(n);
  const q = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (bw[i] < 0.02) {
      f[i] = core[i];
      continue;
    }
    const qq = [bn[0][i] / bw[i], bn[1][i] / bw[i], bn[2][i] / bw[i]];
    q[i * 3] = qq[0], q[i * 3 + 1] = qq[1], q[i * 3 + 2] = qq[2];
    if (core[i]) {
      f[i] = 1;
      continue;
    }
    const d = [cocoa[0] - qq[0], cocoa[1] - qq[1], cocoa[2] - qq[2]];
    const p = [
      rgb[i * 3] - qq[0],
      rgb[i * 3 + 1] - qq[1],
      rgb[i * 3 + 2] - qq[2],
    ];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    f[i] = dd > 0 ? clamp((p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / dd) : 0;
  }

  // Outline thickness: median horizontal / vertical core run.
  const runs = [];
  for (let y = 0; y < h; y += 5) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && core[y * w + x]) run++;
      else if (run) runs.push(run), (run = 0);
    }
  }
  for (let x = 0; x < w; x += 5) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && core[y * w + x]) run++;
      else if (run) runs.push(run), (run = 0);
    }
  }
  runs.sort((a, b) => a - b);
  if (process.env.SCENES_DEBUG) {
    console.log(
      "runs p10/30/50/70",
      [0.1, 0.3, 0.5, 0.7].map((q) => runs[Math.floor(runs.length * q)]),
    );
  }
  const thickness = runs.filter((v) => v >= 6)[Math.floor(runs.length * 0.2)] ??
    12;

  // Outer band: outline-ish pixels within ~one outline of the ground (geodesic, 8-connected).
  const band = new Uint8Array(n);
  if (dark) {
    const outlineish = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      outlineish[i] = f[i] > 0.02 && !ground[i] ? 1 : 0;
    }
    const W = Math.ceil(thickness) + 3;
    let frontier = [];
    for (let i = 0; i < n; i++) {
      if (!outlineish[i]) continue;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of D8) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && ground[ny * w + nx]) {
          band[i] = 1;
          frontier.push(i);
          break;
        }
      }
    }
    for (let step = 1; step < W; step++) {
      const next = [];
      for (const i of frontier) {
        const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of D8) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (outlineish[j] && !band[j]) {
            band[j] = 1;
            next.push(j);
          }
        }
      }
      frontier = next;
    }
    // Inner AA fringe of the band: pick up faint cocoa leftovers next to it.
    for (let step = 0; step < 3; step++) {
      const grown = [];
      for (let i = 0; i < n; i++) {
        if (band[i] || ground[i] || f[i] <= 0.005) continue;
        const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of D8) {
          const nx = x + dx, ny = y + dy;
          if (
            nx >= 0 && ny >= 0 && nx < w && ny < h && band[ny * w + nx] === 1
          ) {
            grown.push(i);
            break;
          }
        }
      }
      for (const i of grown) band[i] = 1;
    }
  }

  // Soft-edge zone: ground pixels within EDGE steps of the exterior.
  const edge = new Uint8Array(n);
  {
    let frontier = [];
    for (let i = 0; i < n; i++) if (ext[i]) frontier.push(i);
    for (let step = 0; step < 32; step++) {
      const next = [];
      for (const i of frontier) {
        const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of D8) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (ground[j] && !ext[j] && !edge[j]) {
            edge[j] = 1;
            next.push(j);
          }
        }
      }
      frontier = next;
    }
  }

  // Compose RGBA.
  const out = Buffer.alloc(n * 4);
  const blob = hexToRgb(DARK_BLOB);
  const cream = [254, 239, 213];
  const outlineOut = dark ? CREAM_ON_DARK : cocoa;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    let col = [r, g, b];
    let a = 1;
    if (ext[i]) {
      a = 0;
      col = dark ? blob : cream;
    } else if (ground[i] && (edge[i] || b <= 228)) {
      // Blob body, plus the soft blob edge ramping to transparent.
      a = edge[i] ? clamp((240 - b) / 26) : 1;
      col = dark ? blob : b > 205 && a < 1 ? cream : col;
    } else if (ground[i]) {
      a = 1; // white feature inside the blob (steam, flour): stays opaque
    } else if (f[i] > 0.03) {
      const qr = [q[i * 3], q[i * 3 + 1], q[i * 3 + 2]];
      const toExterior = isWhite(qr[0], qr[1], qr[2]);
      const toGround = !toExterior && isGround(qr[0], qr[1], qr[2]);
      const recolour = !dark || band[i];
      if (toExterior) {
        // Fringe against transparent: unmix to outline colour at coverage f.
        col = recolour ? outlineOut : cocoa;
        a = core[i] ? 1 : f[i];
      } else if (recolour) {
        const base = toGround && dark ? blob : qr;
        col = core[i] ? outlineOut : mix(base, outlineOut, f[i]);
      } else if (toGround && dark) {
        col = core[i] ? cocoa : mix(blob, cocoa, f[i]);
      }
    }
    out[i * 4] = col[0],
      out[i * 4 + 1] = col[1],
      out[i * 4 + 2] = col[2],
      out[i * 4 + 3] = Math.round(a * 255);
  }
  return { out, thickness, cocoa };
}

// ---------------------------------------------------------------- per-scene export
const kb = (file) => Math.round(statSync(file).size / 102.4) / 10;

async function build(scene) {
  const [id, title, alt, source, wide = 1200] = scene;
  const dir = path.join(OUT, id);
  ensure(dir);
  const { data, info } = await sharp(path.join(ROOT, source)).removeAlpha()
    .raw().toBuffer({
      resolveWithObject: true,
    });
  const { width: w, height: h } = info;
  const result = { id, title, alt, source, blobDark: DARK_BLOB, exports: {} };
  let lightRgba;
  for (const mode of ["light", "dark"]) {
    const { out, thickness } = cutout(data, w, h, mode === "dark");
    // trim to content (alpha > 12) + 2% padding
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (out[(y * w + x) * 4 + 3] > 12) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const pad = Math.round(0.02 * Math.max(x1 - x0 + 1, y1 - y0 + 1));
    const trimmed = await sharp(out, {
      raw: { width: w, height: h, channels: 4 },
    })
      .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const sizes = [[`${id}-${mode}`, wide], [`${id}-${mode}-600`, 600]];
    for (const [name, width] of sizes) {
      const img = sharp(trimmed).resize({ width, kernel: "lanczos3" });
      const webp = path.join(dir, `${name}.webp`);
      await img.clone().webp({ quality: 85, alphaQuality: 100, effort: 5 })
        .toFile(webp);
      const meta = await sharp(webp).metadata();
      result.exports[`${name}.webp`] = {
        width: meta.width,
        height: meta.height,
        kb: kb(webp),
      };
      if (!name.endsWith("-600")) {
        const png = path.join(dir, `${name}.png`);
        await img.clone().png({
          palette: true,
          colours: 48,
          quality: 70,
          effort: 10,
          dither: 0,
        }).toFile(png);
        result.exports[`${name}.png`] = {
          width: meta.width,
          height: meta.height,
          kb: kb(png),
        };
      }
    }
    if (mode === "light") lightRgba = path.join(dir, `${id}-light.png`);
    console.log(`${id} ${mode}: outline ${thickness}px`);
  }
  result.svg = process.env.SCENES_SVG
    ? await vectorise(id, dir, lightRgba)
    : null;
  return result;
}

// Trace the palette-quantised light PNG with vtracer, snap, svgo, accept only when small enough.
async function vectorise(id, dir, lightPng) {
  ensure(WORK);
  const flat = path.join(WORK, `${id}-flat.png`);
  const svgTmp = path.join(WORK, `${id}-trace.svg`);
  const target = path.join(dir, `${id}.svg`);
  rmSync(target, { force: true });
  await sharp(lightPng).flatten({ background: "#ffffff" }).png({
    palette: true,
    colours: 14,
    dither: 0,
  }).toFile(flat);
  execFileSync(PYTHON, ["-I", TRACE, flat, svgTmp], { stdio: "inherit" });
  const svg = optimize(readFileSync(svgTmp, "utf8"), {
    multipass: true,
    floatPrecision: 1,
    plugins: ["preset-default"],
  }).data;
  const bytes = Buffer.byteLength(svg);
  console.log(`${id} svg: ${(bytes / 1024).toFixed(1)} KB`);
  if (bytes > SVG_MAX) return null;
  writeFileSync(target, svg);
  return rel(target);
}

// ---------------------------------------------------------------- contact sheet
async function contactSheet(results) {
  const cols = 3, cw = 300, ch = 225, gap = 12, label = 34;
  const light = surfaces["light.surface"].hex,
    dark = surfaces["dark.surface"].hex;
  const cell = cw * 2 + gap;
  const rows = Math.ceil(results.length / cols);
  const W = cols * cell + (cols + 1) * 24;
  const H = rows * (ch + label + 24) + 24;
  const layers = [];
  for (const [i, r] of results.entries()) {
    const x0 = 24 + (i % cols) * (cell + 24);
    const y0 = 24 + Math.floor(i / cols) * (ch + label + 24);
    for (const [k, mode] of ["light", "dark"].entries()) {
      const x = x0 + k * (cw + gap);
      const img = await sharp(path.join(OUT, r.id, `${r.id}-${mode}-600.webp`))
        .resize({ width: cw - 16, height: ch - 16, fit: "inside" })
        .png()
        .toBuffer();
      const m = await sharp(img).metadata();
      layers.push({
        input: {
          create: {
            width: cw,
            height: ch,
            channels: 4,
            background: mode === "light" ? light : dark,
          },
        },
        left: x,
        top: y0,
      });
      layers.push({
        input: img,
        left: x + Math.round((cw - m.width) / 2),
        top: y0 + Math.round((ch - m.height) / 2),
      });
    }
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><text x="2" y="22" font-family="sans-serif" font-size="15" fill="#222">${r.id}</text></svg>`,
      ),
      left: x0,
      top: y0 + ch + 4,
    });
  }
  await sharp({
    create: { width: W, height: H, channels: 4, background: "#9aa0a8" },
  })
    .composite(layers)
    .png({ palette: true, colours: 256 })
    .toFile(path.join(OUT, "contact-sheet.png"));
}

// ---------------------------------------------------------------- main
const only = process.argv.slice(2);
const manifestFile = path.join(OUT, "scenes.json");
const prior = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, "utf8")).scenes
  : [];
const done = new Map(prior.map((s) => [s.id, s]));
for (const scene of SCENES) {
  if (only.length && !only.includes(scene[0])) continue;
  done.set(scene[0], await build(scene));
}
const results = SCENES.map((s) => done.get(s[0])).filter(Boolean);
ensure(OUT);
writeFileSync(
  manifestFile,
  JSON.stringify({ darkBlob: DARK_BLOB, scenes: results }, null, 2) + "\n",
);
await contactSheet(results);
console.log(`dark blob ${DARK_BLOB}`);
