// The entitlements source-byte check treats Paper's PNG export as optional only
// when the source manifest records `exportedPng: null` (Paper cannot export on
// this host); once `exportedPng` is set, every frame's export is mandatory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkEntitlementsSourceBytes,
  hasPaperExport,
} from "../scripts/render-entitlements-references.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 1x1 PNG header is enough for pngDimensions: signature + IHDR width/height.
const onePixelPng = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("0000000100000001", "hex"),
  Buffer.alloc(9),
]);

async function scratchTree(withExport) {
  const repo = await mkdtemp(join(tmpdir(), "entitlements-bytes-"));
  const source = join(repo, "docs/technical-design/entitlements-mocks/source");
  await mkdir(source, { recursive: true });
  const files = {
    "paper-tokens.json": Buffer.from("{}"),
    "A-0.jsx": Buffer.from("<div />"),
    "A-0.computed-styles.json": Buffer.from("{}"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(source, name), bytes);
  }
  await mkdir(join(repo, "fonts"), { recursive: true });
  await writeFile(join(repo, "fonts/geist.ttf"), "font");
  const screen = {
    id: "a--default--light--desktop",
    nodeId: "A-0",
    pageId: "p",
    width: 1,
    height: 1,
    source: "A-0.jsx",
    sha256: sha256(files["A-0.jsx"]),
    computedStylesPath: "A-0.computed-styles.json",
    computedStylesSha256: sha256(files["A-0.computed-styles.json"]),
  };
  if (withExport) {
    await writeFile(join(source, "A-0.png"), onePixelPng);
    screen.exportPath = "A-0.png";
    screen.exportSha256 = sha256(onePixelPng);
  }
  return {
    repo,
    manifest: {
      pageId: "p",
      exportedPng: withExport ? { file: "x" } : null,
      tokens: {
        path: "paper-tokens.json",
        sha256: sha256(files["paper-tokens.json"]),
      },
      assets: [],
      fonts: {
        files: [{
          path: "fonts/geist.ttf",
          sha256: sha256(Buffer.from("font")),
        }],
      },
      expectedScreens: 1,
      screens: [screen],
    },
  };
}

test("exportedPng null: frames need no Paper PNG", async () => {
  const { repo, manifest } = await scratchTree(false);
  try {
    assert.equal(hasPaperExport(manifest), false);
    assert.deepEqual(await checkEntitlementsSourceBytes(manifest, repo), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("exportedPng missing: frames require a Paper PNG", async () => {
  const { repo, manifest } = await scratchTree(false);
  try {
    delete manifest.exportedPng;
    assert.equal(hasPaperExport(manifest), true);
    const issues = await checkEntitlementsSourceBytes(manifest, repo);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /no exportPath/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("exportedPng set: a frame without its export is an issue", async () => {
  const { repo, manifest } = await scratchTree(false);
  try {
    manifest.exportedPng = { file: "x" };
    assert.equal(hasPaperExport(manifest), true);
    const issues = await checkEntitlementsSourceBytes(manifest, repo);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /no exportPath/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("exportedPng set: a present export is verified, a bad hash fails", async () => {
  const { repo, manifest } = await scratchTree(true);
  try {
    assert.deepEqual(await checkEntitlementsSourceBytes(manifest, repo), []);
    manifest.screens[0].exportSha256 = "0".repeat(64);
    const issues = await checkEntitlementsSourceBytes(manifest, repo);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /sha256 differs/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
