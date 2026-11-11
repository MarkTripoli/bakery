// One command rebuilds every logo, icon, sheet and manifest:  node brand/scripts/build.mjs
import { buildMarks } from "./mark.mjs";
import { buildLockups } from "./lockup.mjs";
import { buildFavicons, buildPngs, buildSocial } from "./exports.mjs";
import { buildMatrix, writeVariantsJson } from "./matrix.mjs";
import { clearSpaceSheet, legibilitySheet, variantsSheet } from "./sheets.mjs";
import { writeReadme } from "./readme.mjs";
import { writeBrandTables } from "./tables.mjs";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { ensure, FAVICON, ROOT } from "./lib.mjs";

// Files apps/web serves from /; byte copies of assets/brand/favicon/*.
const WEB_FAVICONS = [
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "site.webmanifest",
];
const WEB_PUBLIC = path.join(ROOT, "apps/web/public");

function copyWebFavicons() {
  ensure(WEB_PUBLIC);
  for (const name of WEB_FAVICONS) {
    copyFileSync(path.join(FAVICON, name), path.join(WEB_PUBLIC, name));
  }
}

const step = async (name, fn) => {
  const started = Date.now();
  const out = await fn();
  console.log(
    `${name.padEnd(12)} ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return out;
};

await step("marks", buildMarks);
await step("lockups", buildLockups);
await step("png", buildPngs);
await step("favicons", buildFavicons);
await step("social", buildSocial);
const matrix = buildMatrix();
await step("variants", () => writeVariantsJson(matrix));
await step("sheets", async () => {
  await legibilitySheet(matrix);
  await variantsSheet(matrix);
  await clearSpaceSheet();
});
await step("readme", () => writeReadme(matrix));
await step("web copies", copyWebFavicons);
await step("tables", writeBrandTables);
