import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import variants from "../../../assets/brand/logo/variants.json" with {
  type: "json",
};
import scenes from "../../../assets/brand/scenes/scenes.json" with {
  type: "json",
};
import {
  logoFiles,
  logoSurfaceIds,
  logoSurfaces,
  logoVariantIds,
  selectLogo,
} from "../src/brand/logo-select.ts";
import {
  sceneFiles,
  sceneIds,
  selectScene,
} from "../src/brand/scene-select.ts";
import { logoVariants } from "../src/brand/tokens.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = (name) =>
  readFileSync(new URL(`../src/brand/${name}`, import.meta.url), "utf8");
const bound = (name) =>
  new Set(
    [
      ...source(name).matchAll(
        /^import \w+ from "\.\.\/\.\.\/\.\.\/\.\.\/([^"]+)";$/gm,
      ),
    ]
      .map((match) => match[1]),
  );

test("logo ids and surfaces equal variants.json and the token role table", () => {
  assert.deepEqual(logoVariantIds, Object.keys(variants.variants));
  assert.deepEqual(
    logoVariantIds.toSorted(),
    Object.keys(logoVariants).toSorted(),
  );
  assert.deepEqual(logoSurfaceIds, Object.keys(variants.surfaces));
  for (const id of logoSurfaceIds) {
    const { token, theme, hex, label } = variants.surfaces[id];
    assert.deepEqual(logoSurfaces[id], { token, theme, hex, label });
    assert.ok(
      variants.matrix.some((row) => row.surface === id && row.recommended),
      `${id} has a recommended variant`,
    );
  }
});

test("recommended variant per surface equals the contrast matrix", () => {
  for (const row of variants.matrix.filter((entry) => entry.recommended)) {
    assert.equal(
      selectLogo({ art: "mark", surface: row.surface }).variant,
      row.variant,
      row.surface,
    );
  }
  assert.equal(selectLogo({ art: "mark" }).variant, "color-light");
  assert.equal(
    selectLogo({ art: "mark", surface: "dark.canvas", variant: "mono-dark" })
      .variant,
    "mono-dark",
  );
});

test("logo alt, minSize and scaled dimensions", () => {
  const lockup = selectLogo({ art: "lockup", size: 48 });
  const natural = variants.variants["color-light"].dimensions.lockup;
  assert.equal(lockup.alt, "Bakery");
  assert.equal(lockup.height, 48);
  assert.equal(
    lockup.width,
    Math.round(48 * natural.width / natural.height * 10) / 10,
  );
  assert.equal(lockup.minSize, variants.minSize.lockupHeight);
  assert.equal(
    selectLogo({ art: "wordmark" }).minSize,
    variants.minSize.wordmarkHeight,
  );
  assert.equal(selectLogo({ art: "mark", size: 40 }).width, 40);
});

test("mark size rule follows variants.json sizeRules, first match wins", () => {
  const file = (size) => selectLogo({ art: "mark", size }).file;
  const expected = (size) => {
    const rule = variants.sizeRules.find((entry) =>
      (entry.minPx === undefined || size >= entry.minPx) &&
      (entry.maxPx === undefined || size <= entry.maxPx)
    );
    return variants.variants["color-light"].files[rule.file];
  };
  for (const size of [12, 16, 19, 20, 24, 29, 30, 32, 34, 35, 64, 512]) {
    assert.equal(file(size), expected(size), `${size}px`);
  }
  assert.match(file(16), /mark-16-/);
  assert.match(file(32), /mark-32-/);
  assert.match(file(24), /mark-color-light\.svg$/);
});

test("tiles are marks only, at runtime", () => {
  for (const variant of ["tile-light", "tile-dark"]) {
    assert.match(selectLogo({ art: "mark", variant }).file, /tile/);
    assert.throws(() => selectLogo({ art: "lockup", variant }), /no lockup/);
    assert.throws(
      () => selectLogo({ art: "wordmark", variant }),
      /no wordmark/,
    );
  }
  assert.throws(
    () => selectLogo({ art: "mark", variant: "nope" }),
    /unknown variant/,
  );
});

test("every shipped logo and scene path exists and is bound statically", () => {
  const jsonLogoFiles = [
    ...new Set(
      Object.values(variants.variants).flatMap((variant) =>
        Object.values(variant.files)
      ),
    ),
  ];
  assert.deepEqual(logoFiles().toSorted(), jsonLogoFiles.toSorted());
  for (const file of logoFiles()) assert.ok(existsSync(root + file), file);
  assert.deepEqual(
    [...bound("logo-assets.ts")].toSorted(),
    logoFiles().toSorted(),
  );

  for (const file of sceneFiles()) assert.ok(existsSync(root + file), file);
  assert.deepEqual(
    [...bound("scene-assets.ts")].toSorted(),
    sceneFiles().toSorted(),
  );
});

test("scene ids, dimensions and alt equal scenes.json", () => {
  assert.deepEqual(sceneIds, scenes.scenes.map((entry) => entry.id));
  for (const entry of scenes.scenes) {
    for (const theme of ["light", "dark"]) {
      for (const width of [600, 1200]) {
        const picked = selectScene(entry.id, { theme, width });
        const name = `${entry.id}-${theme}${width === 600 ? "-600" : ""}.webp`;
        assert.equal(picked.file, `assets/brand/scenes/${entry.id}/${name}`);
        assert.equal(picked.width, entry.exports[name].width);
        assert.equal(picked.height, entry.exports[name].height);
        assert.equal(picked.alt, entry.alt);
      }
    }
    assert.equal(
      selectScene(entry.id, { theme: "dark" }).file,
      selectScene(entry.id, { theme: "dark", width: 1200 }).file,
    );
  }
  assert.throws(() => selectScene("nope", { theme: "light" }), /unknown id/);
});

test("slim tables match the full contracts (rebuild brand/scripts if not)", () => {
  const logoTable = JSON.parse(
    readFileSync(
      new URL("../src/brand/logo-table.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(logoTable.sizeRules, variants.sizeRules);
  assert.deepEqual(logoTable.minSize, variants.minSize);
  for (const [id, variant] of Object.entries(variants.variants)) {
    assert.deepEqual(logoTable.variants[id].files, variant.files);
    assert.deepEqual(logoTable.variants[id].dimensions, variant.dimensions);
  }
});
