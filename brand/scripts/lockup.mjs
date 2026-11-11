// Lockup (character + wordmark) and wordmark SVGs from the traced master.
import path from "node:path";
import {
  ART_IDS,
  LOGO,
  pathStats,
  roleColors,
  transformPath,
  variants,
  writeSvg,
} from "./lib.mjs";
import { traceMaster } from "./trace.mjs";

// Lockup units = master px x 0.2, origin at the lockup bbox (plus a hair of padding for AA).
const SCALE = 0.2;
const PAD = 2;

let cache;
async function parts() {
  if (cache) return cache;
  const t = await traceMaster();
  const { img, word, char } = t;
  const cb = t.bbox(char.S, 0, img.w);
  const wb = t.bbox(word.mask, 0, img.w);
  const all = {
    x0: Math.min(cb.x0, wb.x0),
    y0: Math.min(cb.y0, wb.y0),
    x1: Math.max(cb.x1, wb.x1),
    y1: Math.max(cb.y1, wb.y1),
  };
  const place = (d, box) =>
    transformPath(d, SCALE, -box.x0 * SCALE + PAD, -box.y0 * SCALE + PAD);
  const size = (box) => ({
    w: Number(((box.x1 - box.x0 + 1) * SCALE + 2 * PAD).toFixed(1)),
    h: Number(((box.y1 - box.y0 + 1) * SCALE + 2 * PAD).toFixed(1)),
  });
  cache = {
    lockup: {
      ...size(all),
      layer: (list) => list.map((d) => place(d, all)).join(""),
    },
    wordmark: {
      ...size(wb),
      layer: (list) => list.map((d) => place(d, wb)).join(""),
    },
    word: word.paths,
    layers: char.layers,
    wordX: wb.x0 - all.x0,
  };
  return cache;
}

const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const fillPath = (
  d,
  color,
) => (color && d ? `<path d="${d}" fill="${color}" fill-rule="evenodd"/>` : "");

export async function lockupSvg(variantId) {
  const p = await parts();
  const c = roleColors(variantId);
  const L = (name) => p.lockup.layer(p.layers[name]);
  const sameInk = c.outline === c.line;
  const body = [
    fillPath(L("dough"), c.dough),
    fillPath(L("cream"), c.plate),
    fillPath(L("blush"), c.blush),
    fillPath(L("terracotta"), c.roller === "knockout" ? null : c.roller),
    sameInk
      ? fillPath(L("cocoa"), c.outline)
      : fillPath(L("ring"), c.outline) + fillPath(L("ink"), c.line),
    fillPath(p.lockup.layer(p.word), c.type),
  ].join("");
  return svgDoc(p.lockup.w, p.lockup.h, body);
}

export async function wordmarkSvg(variantId) {
  const p = await parts();
  const c = roleColors(variantId);
  return svgDoc(
    p.wordmark.w,
    p.wordmark.h,
    fillPath(p.wordmark.layer(p.word), c.type),
  );
}

// on-brand wordmark equals color-light's: not written twice.
export const WORDMARK_ALIAS = { "on-brand": "color-light" };

export async function buildLockups() {
  const out = {};
  for (const id of ART_IDS) {
    out[`lockup-${id}`] = writeSvg(
      path.join(LOGO, "lockup", `lockup-${id}.svg`),
      await lockupSvg(id),
      1,
    );
    if (WORDMARK_ALIAS[id]) continue;
    out[`wordmark-${id}`] = writeSvg(
      path.join(LOGO, "wordmark", `wordmark-${id}.svg`),
      await wordmarkSvg(id),
      1,
    );
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildLockups();
  for (const [k, v] of Object.entries(out)) console.log(k, pathStats(v));
}
export { variants };
