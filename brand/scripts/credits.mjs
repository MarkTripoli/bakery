// Writes assets/brand/credits.json: provenance for every shipped Higgsfield image.
// Reads brand/raw/*/result.json (worker output) and brand/gallery/picks.json (lead picks).
// Asset URLs are left out on purpose: they embed the Higgsfield account id.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const rawDir = path.join(root, "brand/raw");

// Path prefixes of shipped files derived from each logo generation. The mark is
// redrawn from primitives using J6 (belt) and J7 (face) as references; favicons
// and tiles derive from the mark, social cards from the lockup.
const refPrefix = {
  "001-logo-refine-3.png": "brand/refs/mascot-j3.png",
  "001-logo-refine-7.png": "brand/refs/mark-j7.png",
};
const markPrefixes = [
  "assets/brand/logo/mark/",
  "assets/brand/logo/png/mark-",
  "assets/brand/favicon/",
];
const logoShippedAs = {
  "001-logo-refine-3.png": [
    "assets/brand/logo/lockup/",
    "assets/brand/logo/wordmark/",
    "assets/brand/logo/png/lockup-",
    "assets/brand/logo/png/wordmark-",
    "assets/brand/social/",
    refPrefix["001-logo-refine-3.png"],
  ],
  "001-logo-refine-6.png": markPrefixes,
  "001-logo-refine-7.png": [
    ...markPrefixes,
    refPrefix["001-logo-refine-7.png"],
  ],
};

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function jobFor(result, index) {
  return (result.jobs ?? []).find((job) => job.image_indices?.includes(index));
}

function shippedAs(file, scenes) {
  if (logoShippedAs[path.basename(file)]) {
    return logoShippedAs[path.basename(file)];
  }
  return scenes.filter((scene) => scene.source === file)
    .map((scene) => `assets/brand/scenes/${scene.id}/`);
}

// reference_files hold absolute paths of whichever checkout ran the request;
// keep the repo-relative suffix so a rerun anywhere writes the same bytes.
// The greedy prefix anchors on the rightmost known root, so a checkout under a
// directory named `brand` still resolves to the in-repo path.
function repoPath(ref) {
  const match = ref.match(
    /^(?:.*\/)?((?:assets\/brand|brand\/(?:refs|raw))\/.+)$/,
  );
  return match ? match[1] : path.basename(ref);
}

function credit(result, output, pick, requestId, scenes) {
  const job = jobFor(result, output.index);
  const params = output.raw_generation?.params ?? {};
  const file = `brand/raw/${requestId}/${output.filename}`;
  return {
    file,
    shippedAs: shippedAs(file, scenes),
    pick: pick.label,
    tool: "Higgsfield",
    model: `${result.model?.name} (${result.model?.id})`,
    generationId: output.job_id,
    seed: output.seed ?? null,
    request: `brand/requests/${requestId}.md`,
    prompt: job?.prompt ?? params.prompt ?? null,
    references: (result.reference_files ?? []).map(repoPath),
    aspectRatio: params.aspect_ratio ?? null,
    resolution: params.resolution ?? null,
    size: output.size,
    sha256: output.sha256,
    createdAt: new Date(output.generation_created_at * 1000).toISOString(),
  };
}

const picks = await readJson(path.join(root, "brand/gallery/picks.json"));
const { scenes } = await readJson(
  path.join(root, "assets/brand/scenes/scenes.json"),
);
const images = [];
for (const requestId of (await readdir(rawDir)).sort()) {
  const result = await readJson(path.join(rawDir, requestId, "result.json"))
    .catch(() => null);
  for (const output of result?.outputs ?? []) {
    const pick = picks[output.filename];
    if (pick?.pick) {
      images.push(credit(result, output, pick, requestId, scenes));
    }
  }
}

const credits = {
  description:
    "Provenance of shipped Bakery brand art. Generated with Higgsfield through its MCP server, driven by an OMP worker from the request files named here; art direction, picks and post-processing by the brand lead. Raw originals are not committed; generationId + sha256 identify them.",
  legacy: {
    files: [
      "assets/brand/bakery-logo-v1.png",
      "assets/brand/bakery-logo-v2.png",
      "assets/brand/bakery-favicon-master.png",
    ],
    tool:
      "built-in image generation (pre-Higgsfield); see bakery-logo-prompt.md and bakery-conveyor-prompts.md",
  },
  images,
};
await writeFile(
  path.join(root, "assets/brand/credits.json"),
  `${JSON.stringify(credits, null, 2)}\n`,
);
console.log(`credits.json: ${images.length} images`);
