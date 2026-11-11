import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(GALLERY_DIR, "..", "..");
const BRAND_DIR = path.join(ROOT, "brand");
const RAW_DIR = path.join(BRAND_DIR, "raw");
const CUTOUT_DIR = path.join(BRAND_DIR, "cutouts");
const ASSETS_BRAND = path.join(ROOT, "assets", "brand");
const THEME_CSS = path.join(
  ROOT,
  "packages",
  "ui",
  "src",
  "foundations",
  "theme.css",
);
const VARIANTS_JSON = process.env.VARIANTS_JSON ||
  path.join(ASSETS_BRAND, "logo", "variants.json");
const PORT = Number(process.env.PORT) || 18446;
const HOST = "127.0.0.1";

const MOUNTS = {
  "/raw": path.join(BRAND_DIR, "raw"),
  "/requests": path.join(BRAND_DIR, "requests"),
  "/exports": path.join(BRAND_DIR, "exports"),
  "/scenes": path.join(BRAND_DIR, "scenes"),
  "/current": ASSETS_BRAND,
  "/assets-brand": ASSETS_BRAND,
};
const PRODUCTION_DIRS = [
  "logo/mark",
  "logo/lockup",
  "logo/wordmark",
  "logo/png",
  "favicon",
  "social",
  "sheets",
];
const CUTOUT_MAX = 1600;
const CUTOUT_JOBS = 2;
// Cutouts older than this are rebuilt; bump when the cutout recipe changes.
const CUTOUT_EPOCH = Date.parse("2026-10-09T15:30:00Z");
// Logo art keeps enclosed white counters (b, a, e) too, not just border-connected background.
const COUNTER_GROUP = /logo|mark|wordmark/i;
// Keep mask: 0 where min channel >= 240 and spread <= 10, ramping to 1 over 8 levels each side.
const WHITE_FX =
  "1-min(1,max(0,(min(min(r,g),b)*255-232)/8))*min(1,max(0,(18-(max(max(r,g),b)-min(min(r,g),b))*255)/8))";
const SAFE_SEGMENT = /^[\w][\w .-]*$/;
const SURFACES = [
  ["light.surface", "--color-surface", "light", "Surface · light"],
  ["light.canvas", "--color-canvas", "light", "Canvas · light"],
  ["light.surface-subtle", "--color-surface-subtle", "light", "Subtle · light"],
  ["light.primary", "--color-primary", "light", "Primary fill · light"],
  ["light.selection", "--color-selection", "light", "Accent · light"],
  ["dark.surface", "--color-surface", "dark", "Surface · dark"],
  ["dark.canvas", "--color-canvas", "dark", "Canvas · dark"],
  ["dark.surface-raised", "--color-surface-raised", "dark", "Raised · dark"],
  ["dark.primary", "--color-primary", "dark", "Primary fill · dark"],
  ["dark.selection", "--color-selection", "dark", "Accent · dark"],
];
const BRAND_GOLDEN_FALLBACK = "#F7A93B";
const GALLERY_FILES = new Set(["index.html", "gallery.css", "gallery.js"]);

const MIME = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const IMAGE_EXTS = new Set([
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
]);
const RESULT_LIST_KEYS = [
  "images",
  "results",
  "jobs",
  "outputs",
  "generations",
  "items",
];

const ext = (file) => path.extname(file).toLowerCase();
const isImage = (file) => IMAGE_EXTS.has(ext(file));
const naturalSort = (a, b) => a.localeCompare(b, "en", { numeric: true });
const toUrl = (prefix, rel) =>
  `${prefix}/${rel.split("/").map(encodeURIComponent).join("/")}`;

const cutoutUrlFor = (group, name) =>
  toUrl("/cutout", `${group}/${path.basename(name, ext(name))}.png`);

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
}

async function readHead(file, length) {
  const handle = await fs.open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(length),
      0,
      length,
      0,
    );
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function pngSize(head) {
  if (head.length < 24 || head.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function webpSize(head) {
  if (head.length < 30 || head.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = head.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + head.readUIntLE(24, 3),
      height: 1 + head.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L") {
    const bits = head.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    return {
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function icoSize(head) {
  if (head.length < 8 || head.readUInt16LE(2) !== 1) return null;
  return { width: head[6] || 256, height: head[7] || 256 };
}

function svgSize(head) {
  const text = head.toString("utf8");
  const box = text.match(
    /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i,
  );
  if (box) return { width: Number(box[1]), height: Number(box[2]) };
  const width = text.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
  const height = text.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
  return width && height
    ? { width: Number(width[1]), height: Number(height[1]) }
    : null;
}

const SIZE_READERS = {
  ".png": pngSize,
  ".webp": webpSize,
  ".ico": icoSize,
  ".svg": svgSize,
};

async function imageSize(file) {
  const reader = SIZE_READERS[ext(file)];
  if (!reader) return null;
  try {
    return reader(await readHead(file, 4096));
  } catch {
    return null;
  }
}

async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(dir, path.join(entry.parentPath, entry.name)).split(
          path.sep,
        ).join("/")
      )
      .sort(naturalSort);
  } catch {
    return [];
  }
}

async function describeFile(dir, urlPrefix, rel) {
  const file = path.join(dir, rel);
  const stats = await fs.stat(file);
  return {
    name: path.basename(rel),
    path: rel,
    url: toUrl(urlPrefix, rel),
    kind: isImage(rel) ? "image" : "file",
    bytes: stats.size,
    ...(await imageSize(file)),
  };
}

const describeFiles = (dir, urlPrefix, rels) =>
  Promise.all(rels.map((rel) => describeFile(dir, urlPrefix, rel)));

function resultEntries(result) {
  const lists = Array.isArray(result)
    ? [result]
    : RESULT_LIST_KEYS.map((key) => result?.[key]).filter(Array.isArray);
  return lists.flat().filter((entry) => entry && typeof entry === "object");
}

function entryFor(entries, name, index) {
  const mentions = (entry) =>
    Object.values(entry).some((value) =>
      typeof value === "string" && value.includes(name)
    );
  return entries.find(mentions) ?? entries[index] ?? {};
}

function withGenerationInfo(images, result) {
  const entries = resultEntries(result);
  return images.map((image, index) => {
    const entry = entryFor(entries, image.name, index);
    return {
      ...image,
      prompt: entry.prompt ?? result?.prompt ?? null,
      seed: entry.seed ?? entry.params?.seed ?? null,
      id: entry.id ?? null,
    };
  });
}

function requestStatus(hasImages, hasResult) {
  if (hasResult) return "done";
  return hasImages ? "partial" : "pending";
}

const modelName = (
  model,
) => (typeof model === "object" && model
  ? model.name ?? model.id ?? null
  : model ?? null);

async function requestGroup(id, requestFile) {
  const requestText = requestFile &&
    (await readText(path.join(BRAND_DIR, "requests", requestFile)));
  const title = requestText?.match(/^# (.+)$/m)?.[1] ?? id;
  const rawDir = path.join(BRAND_DIR, "raw", id);
  const rels = (await listFiles(rawDir)).filter((rel) =>
    !rel.includes("/") && isImage(rel)
  );
  const resultText = await readText(path.join(rawDir, "result.json"));
  const result = resultText === null ? null : parseJson(resultText, {});
  const images =
    (await describeFiles(rawDir, `/raw/${encodeURIComponent(id)}`, rels)).map((
      image,
    ) => ({
      ...image,
      cutoutUrl: cutoutUrlFor(id, image.name),
    }));
  return {
    id,
    title,
    section: "requests",
    status: requestStatus(images.length > 0, resultText !== null),
    requestUrl: requestFile ? toUrl("/requests", requestFile) : null,
    model: modelName(
      result?.model ??
        resultEntries(result).find((entry) => entry.model)?.model,
    ),
    images: withGenerationInfo(images, result),
  };
}

async function requestGroups() {
  const requestFiles = (await listFiles(path.join(BRAND_DIR, "requests")))
    .filter((rel) => ext(rel) === ".md");
  const requestIds = new Map(
    requestFiles.map((file) => [path.basename(file, ".md"), file]),
  );
  const rawDirs = await fs.readdir(path.join(BRAND_DIR, "raw"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of rawDirs) {
    if (entry.isDirectory() && !requestIds.has(entry.name)) {
      requestIds.set(entry.name, null);
    }
  }
  const ids = [...requestIds.keys()].sort(naturalSort);
  return Promise.all(ids.map((id) => requestGroup(id, requestIds.get(id))));
}

async function currentGroup() {
  const dir = MOUNTS["/current"];
  const rels = (await listFiles(dir)).filter((rel) =>
    !rel.includes("/") && ext(rel) === ".png"
  );
  const images = await describeFiles(dir, "/current", rels);
  return {
    id: "current",
    title: "Current logo (before)",
    section: "current",
    status: "done",
    images: images.map((image) => ({
      ...image,
      cutoutUrl: cutoutUrlFor("current", image.name),
    })),
  };
}

async function folderGroups(section, label) {
  const dir = MOUNTS[`/${section}`];
  const buckets = new Map();
  for (const rel of await listFiles(dir)) {
    const folder = rel.includes("/") ? rel.split("/")[0] : "";
    buckets.set(folder, [...(buckets.get(folder) ?? []), rel]);
  }
  const groups = [...buckets].map(async ([folder, rels]) => ({
    id: folder ? `${section}-${folder}` : `${section}-loose`,
    title: folder ? `${label} / ${folder}` : `${label} (loose files)`,
    section,
    status: "done",
    images: await describeFiles(dir, `/${section}`, rels),
  }));
  return Promise.all(groups);
}

async function readPicks() {
  const text = await readText(path.join(GALLERY_DIR, "picks.json"));
  return text === null ? {} : parseJson(text, {});
}

async function productionGroups() {
  const groups = await Promise.all(PRODUCTION_DIRS.map(async (rel) => {
    const dir = path.join(ASSETS_BRAND, rel);
    const files = (await listFiles(dir)).filter(isImage);
    if (files.length === 0) return null;
    return {
      id: `brand-${rel.replace("/", "-")}`,
      title: `Production / ${rel}`,
      section: "production",
      status: "done",
      images: await describeFiles(dir, `/assets-brand/${rel}`, files),
    };
  }));
  return groups.filter(Boolean);
}

async function readVariants() {
  const text = await readText(VARIANTS_JSON);
  return text === null ? null : parseJson(text, null);
}

const cssBlock = (css, opener) => {
  const start = css.indexOf(opener);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
};

function cssVar(block, name, seen = new Set()) {
  const value = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim();
  const ref = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (ref && !seen.has(ref)) return cssVar(block, ref, seen.add(name));
  return /^#[0-9a-f]{3,8}$/i.test(value ?? "") ? value.toUpperCase() : null;
}

async function readSurfaces() {
  const css = (await readText(THEME_CSS)) ?? "";
  const blocks = {
    light: cssBlock(css, ':root,\n[data-theme="light"]') ||
      cssBlock(css, '[data-theme="light"]'),
    dark: cssBlock(css, '[data-theme="dark"]'),
  };
  const surfaces = {};
  for (const [key, token, theme, label] of SURFACES) {
    const hex = cssVar(blocks[theme], token);
    if (hex) surfaces[key] = { token, theme, hex, label };
  }
  const golden = (await readVariants())?.palette?.golden ??
    BRAND_GOLDEN_FALLBACK;
  surfaces["brand.golden"] = {
    token: "brand.golden",
    theme: "brand",
    hex: golden,
    label: "Brand orange",
  };
  return surfaces;
}

async function buildData() {
  const [
    current,
    requests,
    exports,
    scenes,
    production,
    picks,
    surfaces,
    logo,
  ] = await Promise.all([
    currentGroup(),
    requestGroups(),
    folderGroups("exports", "Exports"),
    folderGroups("scenes", "Scenes"),
    productionGroups(),
    readPicks(),
    readSurfaces(),
    readVariants(),
  ]);
  return {
    groups: [current, ...requests, ...exports, ...scenes, ...production],
    picks,
    surfaces,
    logo,
  };
}

const cutoutQueue = { running: 0, waiting: [], inflight: new Map() };

async function acquireCutoutSlot() {
  if (cutoutQueue.running >= CUTOUT_JOBS) {
    await new Promise((resolve) => cutoutQueue.waiting.push(resolve));
  }
  cutoutQueue.running += 1;
}

function releaseCutoutSlot() {
  cutoutQueue.running -= 1;
  cutoutQueue.waiting.shift()?.();
}

const run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 120000 },
      (
        error,
        stdout,
        stderr,
      ) => (error
        ? reject(new Error(stderr || error.message))
        : resolve(stdout)),
    );
  });

// Border flood-fill of near-white to alpha; the 1 px erode+blur only softens the cut edge.
function cutoutArgs(source, target, group) {
  const corner = (x, y) => ["-draw", `color ${x},${y} floodfill`];
  return [
    source,
    "-resize",
    `${CUTOUT_MAX}x${CUTOUT_MAX}>`,
    "-alpha",
    "set",
    "-fuzz",
    "8%",
    "-fill",
    "none",
    ...corner("0", "0"),
    ...corner("%[fx:w-1]", "0"),
    ...corner("0", "%[fx:h-1]"),
    ...corner("%[fx:w-1]", "%[fx:h-1]"),
    "(",
    "+clone",
    "-alpha",
    "extract",
    "-morphology",
    "Erode",
    "Disk:1",
    "-blur",
    "0x0.6",
    ")",
    "-compose",
    "CopyOpacity",
    "-composite",
    ...(COUNTER_GROUP.test(group) ? counterArgs() : []),
    `PNG32:${target}`,
  ];
}

// Multiply the alpha by (1 - whiteness) so enclosed near-white pixels turn transparent; cream stays opaque.
function counterArgs() {
  return [
    "(",
    "-clone",
    "0",
    "-alpha",
    "extract",
    ")",
    "(",
    "-clone",
    "0",
    "-alpha",
    "off",
    "-fx",
    WHITE_FX,
    ")",
    "(",
    "-clone",
    "1,2",
    "-compose",
    "Multiply",
    "-composite",
    ")",
    "-delete",
    "1,2",
    "-compose",
    "CopyOpacity",
    "-composite",
  ];
}

async function buildCutout(source, target, group) {
  await acquireCutoutSlot();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await run("magick", cutoutArgs(source, tmp, group));
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
    releaseCutoutSlot();
  }
}

async function findRawSource(group, name) {
  const groupDir = group === "current"
    ? ASSETS_BRAND
    : safePath(RAW_DIR, `/${group}`);
  if (!groupDir) return null;
  const entries = await fs.readdir(groupDir).catch(() => []);
  const match = entries.find((entry) =>
    path.basename(entry, ext(entry)) === name && isImage(entry) &&
    ext(entry) !== ".svg"
  );
  return match ? path.join(groupDir, match) : null;
}

async function ensureCutout(group, name) {
  const source = await findRawSource(group, name);
  const target = source && safePath(CUTOUT_DIR, `/${group}/${name}.png`);
  if (!target) return null;
  const [rawStats, cutStats] = await Promise.all([
    fs.stat(source),
    fs.stat(target).catch(() => null),
  ]);
  if (
    cutStats && cutStats.mtimeMs >= Math.max(rawStats.mtimeMs, CUTOUT_EPOCH)
  ) return target;
  if (!cutoutQueue.inflight.has(target)) {
    const job = buildCutout(source, target, group).finally(() =>
      cutoutQueue.inflight.delete(target)
    );
    cutoutQueue.inflight.set(target, job);
  }
  await cutoutQueue.inflight.get(target);
  return target;
}

async function serveCutout(req, res, pathname, query) {
  const parts = pathname.split("/").slice(2);
  const [group, file] = parts;
  if (
    parts.length !== 2 || !SAFE_SEGMENT.test(group) ||
    !SAFE_SEGMENT.test(file) || ext(file) !== ".png"
  ) {
    return send(res, 404, "Not found");
  }
  try {
    const target = await ensureCutout(group, path.basename(file, ".png"));
    return target
      ? serveFile(req, res, target, query)
      : send(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    return send(res, 500, "Cutout failed");
  }
}

function resolveRequest(pathname) {
  const mount = Object.keys(MOUNTS).find((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  if (mount) return { dir: MOUNTS[mount], rel: pathname.slice(mount.length) };
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  return GALLERY_FILES.has(name) ? { dir: GALLERY_DIR, rel: `/${name}` } : null;
}

function safePath(dir, rel) {
  const file = path.resolve(dir, `.${rel}`);
  return file.startsWith(dir + path.sep) ? file : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

async function serveFile(req, res, file, query) {
  const stats = await fs.stat(file).catch(() => null);
  if (!stats?.isFile()) return send(res, 404, "Not found");
  const headers = {
    "Content-Type": MIME[ext(file)] ?? "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": "public, max-age=30",
  };
  if (query.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="${
      path.basename(file).replace(/"/g, "")
    }"`;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

async function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method not allowed");
  }
  const url = new URL(req.url, `http://${HOST}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (pathname.includes("\0")) return send(res, 400, "Bad request");
  if (pathname === "/data.json") {
    return send(res, 200, JSON.stringify(await buildData()), {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
    });
  }
  if (pathname === "/surfaces.json") {
    return send(res, 200, JSON.stringify(await readSurfaces()), {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
    });
  }
  if (pathname.startsWith("/cutout/")) {
    return serveCutout(req, res, pathname, url.searchParams);
  }
  const target = resolveRequest(pathname);
  const file = target && safePath(target.dir, target.rel);
  if (!file) return send(res, 404, "Not found");
  return serveFile(req, res, file, url.searchParams);
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, "Server error");
    else res.destroy();
  });
}).listen(
  PORT,
  HOST,
  () => console.log(`Bakery brand gallery on http://${HOST}:${PORT}`),
);
