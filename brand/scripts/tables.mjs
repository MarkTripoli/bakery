// Slim selection tables for packages/ui/src/brand: just what logo() and scene()
// read, so a consumer of one does not bundle the full contracts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND, ROOT } from "./lib.mjs";

const OUT = path.join(ROOT, "packages/ui/src/brand");
const write = (name, table) =>
  writeFileSync(path.join(OUT, name), `${JSON.stringify(table, null, 2)}\n`);

export function writeBrandTables() {
  const logo = JSON.parse(
    readFileSync(path.join(BRAND, "logo/variants.json"), "utf8"),
  );
  write("logo-table.json", {
    surfaces: Object.fromEntries(
      Object.entries(logo.surfaces).map(([id, surface]) => [id, {
        token: surface.token,
        theme: surface.theme,
        hex: surface.hex,
        label: surface.label,
      }]),
    ),
    recommended: Object.fromEntries(
      logo.matrix.filter((row) => row.recommended).map((
        row,
      ) => [row.surface, row.variant]),
    ),
    variants: Object.fromEntries(
      Object.entries(logo.variants).map(([id, variant]) => [id, {
        files: variant.files,
        dimensions: variant.dimensions,
      }]),
    ),
    minSize: logo.minSize,
    sizeRules: logo.sizeRules,
  });

  const scenes = JSON.parse(
    readFileSync(path.join(BRAND, "scenes/scenes.json"), "utf8"),
  );
  write("scene-table.json", {
    scenes: Object.fromEntries(scenes.scenes.map((scene) => [scene.id, {
      alt: scene.alt,
      exports: Object.fromEntries(
        Object.entries(scene.exports).filter(([name]) => name.endsWith(".webp"))
          .map(([name, size]) => [name, {
            width: size.width,
            height: size.height,
          }]),
      ),
    }])),
  });
}
