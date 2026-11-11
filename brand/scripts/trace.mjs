// Trace the J3 master into vector layers: one wordmark path and the character by role.
// All coordinates come out in "lockup units": master pixels x 0.1, origin at the lockup bbox.
import path from "node:path";
import {
  ensure,
  MASTER,
  palette,
  sharp,
  traceFile,
  transformPath,
  WORK,
} from "./lib.mjs";

const SCALE = 0.1;
// Master regions (px): the mascot sits left of x = 2150, the wordmark right of it.
const SPLIT_X = 2150;
const CROP = { left: 100, top: 250, width: 5300, height: 2600 };

const LUM = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Two-pass chamfer distance (3-4) to the nearest `seed` pixel, in pixels.
function distance(seed, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const at = (
    x,
    y,
  ) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i],
        at(x - 1, y) + 1,
        at(x, y - 1) + 1,
        at(x - 1, y - 1) + 1.4142,
        at(x + 1, y - 1) + 1.4142,
      );
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      d[i] = Math.min(
        d[i],
        at(x + 1, y) + 1,
        at(x, y + 1) + 1,
        at(x + 1, y + 1) + 1.4142,
        at(x - 1, y + 1) + 1.4142,
      );
    }
  }
  return d;
}

// Connected components of `mask` (4-neighbour); returns label array and sizes.
function components(mask, w, h) {
  const label = new Int32Array(w * h);
  const sizes = [0];
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % w;
      const y = (i - x) / w;
      for (
        const j of [
          x > 0 ? i - 1 : -1,
          x < w - 1 ? i + 1 : -1,
          y > 0 ? i - w : -1,
          y < h - 1 ? i + w : -1,
        ]
      ) {
        if (j >= 0 && mask[j] && !label[j]) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

async function writeMask(name, mask, w, h) {
  const out = Buffer.alloc(w * h, 255);
  for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = 0;
  const file = path.join(WORK, `${name}.png`);
  await sharp(out, { raw: { width: w, height: h, channels: 1 } }).png().toFile(
    file,
  );
  return file;
}

async function load() {
  const { data, info } = await sharp(MASTER).extract(CROP).removeAlpha().raw()
    .toBuffer({
      resolveWithObject: true,
    });
  return { data, w: info.width, h: info.height };
}

// Wordmark: threshold the dark pixels right of the mascot, trace one compound path.
async function traceWordmark({ data, w, h }) {
  const mask = new Uint8Array(w * h);
  const x0 = SPLIT_X - CROP.left;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (LUM(data[i], data[i + 1], data[i + 2]) < 140) mask[y * w + x] = 1;
    }
  }
  const file = await writeMask("wordmark-mask", mask, w, h);
  const paths = await traceFile(file, {
    turdSize: 400,
    optTolerance: 2.2,
    alphaMax: 1.1,
  });
  return { paths, mask, w, h };
}

// Character: classify pixels, split roles, trace one compound path per role.
async function traceCharacter({ data, w, h }) {
  const n = w * h;
  const xEnd = SPLIT_X - CROP.left;
  const rgbOf = (i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const white = [255, 255, 255];
  const bgLike = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    if (x < xEnd && near(rgbOf(i), white) < 30) bgLike[i] = 1;
  }
  // background = every large near-white component (exterior and enclosed pockets)
  const bgc = components(bgLike, w, h);
  const bg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (bgLike[i] && bgc.sizes[bgc.label[i]] > 3000) bg[i] = 1;
  }
  const S = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!bg[i] && i % w < xEnd) S[i] = 1;
  // keep only the main mascot body
  const sc = components(S, w, h);
  let best = 1;
  sc.sizes.forEach((s, id) => id && s > sc.sizes[best] && (best = id));
  for (let i = 0; i < n; i++) S[i] = sc.label[i] === best ? 1 : 0;

  const cocoa = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (S[i]) {
      const [r, g, b] = rgbOf(i);
      if (LUM(r, g, b) < 90) cocoa[i] = 1;
    }
  }
  const dBg = distance(bg, w, h);
  // outline width: modal cocoa run length crossing the silhouette on the head's flank
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    if (!cocoa[i]) continue;
    const k = Math.round(dBg[i]);
    if (k > 0 && k < 120) hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  // thickness T: where the cocoa pixel count per unit distance drops off the outer ring
  const counts = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  const peak = Math.max(...counts.slice(0, 30).map((c) => c[1]));
  let T = 1;
  for (const [k, c] of counts) if (k < 90 && c > peak * 0.55) T = k;
  const ringW = T * 1.18;

  const ring = new Uint8Array(n);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!cocoa[i]) continue;
    if (dBg[i] <= ringW) ring[i] = 1;
    else ink[i] = 1;
  }

  // colour classes for non-cocoa pixels
  const classes = ["golden", "cream", "terracotta", "blush"];
  const refs = classes.map((c) => hexRgb(palette[c]));
  const label = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    if (!S[i] || cocoa[i]) continue;
    const c = rgbOf(i);
    let bi = 0;
    let bd = 1e9;
    refs.forEach((ref, k) => {
      const d = near(c, ref);
      if (d < bd) {
        bd = d;
        bi = k;
      }
    });
    label[i] = bi;
  }
  // majority filter (radius 3) on the labels removes anti-alias fringes
  const smooth = new Uint8Array(label);
  const R = 3;
  for (let y = R; y < h - R; y += 1) {
    for (let x = R; x < w - R; x += 1) {
      const i = y * w + x;
      if (label[i] === 255) continue;
      const votes = [0, 0, 0, 0];
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const l = label[i + dy * w + dx];
          if (l < 4) votes[l]++;
        }
      }
      let top = label[i];
      for (let k = 0; k < 4; k++) if (votes[k] > votes[top]) top = k;
      smooth[i] = top;
    }
  }

  const SPECK = Math.round(S.reduce((a, v) => a + v, 0) * 0.0005);
  const opts = { turdSize: SPECK, optTolerance: 2.5, alphaMax: 1.1 };
  const masks = {};
  // dough base: whole interior (stacked beneath everything, never reaching the edge)
  masks.dough = S.map((v, i) => (v && dBg[i] >= 4 ? 1 : 0));
  // class masks grown by 4 px so stacked layers overlap instead of leaving seams
  for (const cls of ["cream", "terracotta", "blush"]) {
    const core = new Uint8Array(n).map((
      _,
      i,
    ) => (S[i] && smooth[i] === classes.indexOf(cls) ? 1 : 0));
    const grow = distance(core, w, h);
    masks[cls] = new Uint8Array(n).map((
      _,
      i,
    ) => (S[i] && dBg[i] >= 4 && grow[i] <= 4 ? 1 : 0));
  }
  masks.cocoa = cocoa;
  masks.ring = ring;
  masks.ink = ink;

  const layers = {};
  for (const [name, mask] of Object.entries(masks)) {
    const file = await writeMask(`char-${name}`, mask, w, h);
    layers[name] = await traceFile(
      file,
      name === "dough" ? { ...opts, turdSize: SPECK * 4 } : opts,
    );
  }
  return { layers, T, ringW, SPECK, S };
}

export async function traceMaster() {
  ensure(WORK);
  const img = await load();
  const word = await traceWordmark(img);
  const char = await traceCharacter(img);
  // bboxes in crop px from the masks
  const bbox = (mask, xMin, xMax) => {
    let x0 = 1e9;
    let x1 = -1;
    let y0 = 1e9;
    let y1 = -1;
    for (let y = 0; y < img.h; y++) {
      for (let x = xMin; x < xMax; x++) {
        if (mask[y * img.w + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return { x0, x1, y0, y1 };
  };
  return { img, word, char, bbox };
}

export { CROP, SCALE, SPLIT_X, transformPath };

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = await traceMaster();
  console.log("T", t.char.T, "ringW", t.char.ringW, "speck", t.char.SPECK);
  console.log("word paths", t.word.paths.length, t.word.paths.join("").length);
  for (const [k, v] of Object.entries(t.char.layers)) {
    console.log(k, v.length, v.join("").length);
  }
}
