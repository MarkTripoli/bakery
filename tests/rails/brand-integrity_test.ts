import { assert, assertEquals } from "@std/assert";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The brand system's integrity: provenance is complete, every shipped file is
 * credited, the web app serves the brand's own favicons, and the logo SVGs are
 * plain art. This is the part of `brand/scripts/check.mjs` that needs no image
 * library, so it runs on every pull request; the pixel audits (corner alpha,
 * plate coverage, the contrast matrix) stay in that script.
 */

const ROOT = new URL("../../", import.meta.url);
const at = (path: string) => fileURLToPath(new URL(path, ROOT));
const text = (path: string) => readFile(at(path), "utf8");
const bytes = async (path: string) => new Uint8Array(await readFile(at(path)));
const exists = async (path: string) => {
  try {
    await stat(at(path));
    return true;
  } catch {
    return false;
  }
};

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(at(dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await walk(child));
    else found.push(child);
  }
  return found.sort();
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice());
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

type Credit = {
  file: string;
  shippedAs: string[];
  tool: string;
  model: string;
  generationId: string;
  prompt: string;
  request: string;
  sha256: string;
};
type LegacyImage = {
  file: string;
  promptFile: string;
  tool: string;
  generationId: string | null;
  generationIdNote: string;
  sha256: string;
  bytes: number;
};
type Credits = {
  legacy: { images: LegacyImage[] };
  images: Credit[];
};

const credits = JSON.parse(await text("assets/brand/credits.json")) as Credits;

Deno.test("every generated brand image records how it was made", async () => {
  assert(credits.images.length > 0, "credits.json lists no images");
  for (const image of credits.images) {
    for (const field of ["tool", "model", "generationId", "prompt"] as const) {
      assert(
        typeof image[field] === "string" && image[field].trim() !== "",
        `${image.file}: ${field} is empty`,
      );
    }
    assert(
      /^[0-9a-f]{64}$/.test(image.sha256),
      `${image.file}: sha256 is not a hex digest`,
    );
    assert(image.shippedAs.length > 0, `${image.file}: shipped as nothing`);
    assert(await exists(image.request), `${image.file}: request file missing`);
  }
});

Deno.test("the images made before records were kept are identified by their bytes", async () => {
  const legacy = credits.legacy.images;
  assertEquals(legacy.map((image) => image.file).sort(), [
    "assets/brand/bakery-favicon-master.png",
    "assets/brand/bakery-logo-v1.png",
    "assets/brand/bakery-logo-v2.png",
  ]);
  for (const image of legacy) {
    const data = await bytes(image.file);
    assertEquals(await sha256(data), image.sha256, `${image.file}: checksum`);
    assertEquals(data.byteLength, image.bytes, `${image.file}: size`);
    // No generation id was recorded for these, and the record says so instead of
    // inventing one.
    assertEquals(image.generationId, null);
    assert(image.generationIdNote.trim() !== "", `${image.file}: no note`);
    assert(
      await exists(image.promptFile),
      `${image.file}: prompt file missing`,
    );
  }
});

Deno.test("every shipped brand file is credited and every credit matches a file", async () => {
  const shipped = [
    ...(await Promise.all(
      ["logo", "favicon", "social", "scenes"].map((dir) =>
        walk(`assets/brand/${dir}`)
      ),
    )).flat(),
    ...await walk("brand/refs"),
  ].filter((file) =>
    !/\.(json|md|webmanifest)$/.test(file) &&
    !file.endsWith("contact-sheet.png")
  );
  const prefixes = credits.images.flatMap((image) => image.shippedAs);
  const uncovered = shipped.filter((file) =>
    !prefixes.some((prefix) => file.startsWith(prefix))
  );
  assertEquals(uncovered, [], "files that no credit covers");
  const dangling = prefixes.filter((prefix) =>
    !shipped.some((file) => file.startsWith(prefix))
  );
  assertEquals(dangling, [], "credits that match no file");
});

Deno.test("the web app serves the brand favicons byte for byte", async () => {
  const served = (await walk("apps/web/public")).filter((file) =>
    !file.endsWith(".js")
  );
  assert(served.length > 0, "apps/web/public has no brand files");
  for (const file of served) {
    const source = `assets/brand/favicon/${file.split("/").at(-1)}`;
    assert(
      await exists(source),
      `${file} has no source in assets/brand/favicon`,
    );
    assertEquals(
      await sha256(await bytes(file)),
      await sha256(await bytes(source)),
      `${file} differs from ${source}`,
    );
  }
  // Every icon the page links, and every icon the manifest names, is served.
  const index = await text("apps/web/index.html");
  const linked = [
    ...index.matchAll(
      /<link rel="(?:icon|apple-touch-icon|manifest)" href="\/([^"]+)"/g,
    ),
  ]
    .map((match) => match[1]);
  assert(linked.length >= 4, "index.html links fewer than four brand files");
  for (const name of linked) {
    assert(
      await exists(`apps/web/public/${name}`),
      `index.html links /${name}`,
    );
  }
  const manifest = JSON.parse(
    await text("apps/web/public/site.webmanifest"),
  ) as {
    icons: { src: string }[];
  };
  for (const icon of manifest.icons) {
    assert(
      await exists(`apps/web/public/${icon.src.replace(/^\//, "")}`),
      `manifest icon ${icon.src}`,
    );
  }
});

Deno.test("variants.json names only files that exist and sizes every SVG", async () => {
  const variants = JSON.parse(
    await text("assets/brand/logo/variants.json"),
  ) as {
    variants: Record<
      string,
      {
        files: Record<string, string>;
        dimensions?: Record<string, { width: number; height: number }>;
      }
    >;
    sizeRules: { file: string }[];
  };
  assert(variants.sizeRules.length > 0, "variants.json: sizeRules missing");
  const paths: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string" && node.startsWith("assets/")) {
      paths.push(node);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(variants.variants);
  for (const path of paths) assert(await exists(path), `missing: ${path}`);
  for (const [id, variant] of Object.entries(variants.variants)) {
    for (const [key, file] of Object.entries(variant.files)) {
      if (!file.endsWith(".svg")) continue;
      const size = variant.dimensions?.[key];
      assert(
        size !== undefined && size.width > 0 && size.height > 0,
        `${id}.${key}: no width and height`,
      );
    }
  }
});

Deno.test("the logo SVGs are plain, scalable art", async () => {
  const svgs = [
    ...(await Promise.all(
      ["mark", "lockup", "wordmark"].map((dir) =>
        walk(`assets/brand/logo/${dir}`)
      ),
    )).flat(),
    "assets/brand/favicon/favicon.svg",
  ].filter((file) => file.endsWith(".svg"));
  assert(svgs.length > 0, "no logo SVGs found");
  for (const file of svgs) {
    const svg = await text(file);
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
    assert(!svg.includes("<image"), `${file}: embeds a raster image`);
    assert(/viewBox="/.test(root), `${file}: no viewBox`);
    assert(
      !/\s(width|height)=/.test(root),
      `${file}: fixed root width or height`,
    );
    assert(!/<!--|<metadata|<title/.test(svg), `${file}: comment or metadata`);
  }
});
