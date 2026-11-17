// Re-anchors the design reference images to the app, licensed by a UX ruling
// instead of a Paper re-export.
//
// Kept out of render-paper-references.mjs on purpose: the K-0 source identity
// pins that file's bytes, so editing it invalidates every K-0 digest. This
// script only imports from it.
//
//   node packages/ui/scripts/reanchor-design-references.mjs \
//     --ruling 248#6934310296 --app <sha> --evidence <path,...>
//
// The identity it writes is the one comparePaper's uxRulingRefreshIssue
// verifies; see docs/technical-design/ui-baselines/README.md.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  lookupArtboard,
  readDesignManifest,
  renderAndFillCase,
} from "./render-paper-references.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const baselinePath = join(
  root,
  "docs/technical-design/ui-baselines/paper-baselines.json",
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The ruling identity binds a refresh to its licensing ruling: the revision
 * names it, and the digest covers the ruling, the app sha and every re-anchored
 * case's id, path and bytes. Widening the set of refreshed baselines therefore
 * requires re-declaring the identity, which is what comparePaper's
 * uxRulingRefreshIssue checks. Kept byte-identical to that verifier's material
 * so the two cannot drift apart.
 */
export function uxRulingIdentity({ ruling, app, cases }) {
  const material = [
    `ruling\0${ruling}`,
    `app\0${app}`,
    ...cases.map((entry) =>
      `case\0${entry.id}\0${entry.imagePath}\0${entry.imageSha256}`
    ).sort(),
  ].join("\n");
  return {
    revision: `ux-ruling:${ruling}; app:${app}`,
    digest: sha256(Buffer.from(material, "utf8")),
  };
}

function parseArguments(rawArgv) {
  const argv = rawArgv.filter((argument) => argument !== "--");
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--ruling") options.ruling = argv[++index];
    else if (flag === "--app") options.app = argv[++index];
    else if (flag === "--evidence") options.evidence = argv[++index];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.ruling || !options.app || !options.evidence) {
    throw new Error(
      "usage: --ruling <issue>#<comment> --app <sha> --evidence <path,...>",
    );
  }
  return {
    ruling: options.ruling,
    app: options.app,
    evidence: options.evidence.split(","),
  };
}

async function loadBaseline() {
  return JSON.parse(await readFile(baselinePath, "utf8"));
}

async function saveBaseline(baseline) {
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const baseline = await loadBaseline();
  if (baseline.schemaVersion !== 2) {
    throw new Error(
      `paper-baselines.json is schemaVersion ${baseline.schemaVersion}; design references require schemaVersion 2`,
    );
  }
  const designCases = (baseline.cases ?? []).filter((designCase) =>
    designCase.reference === "design"
  );
  for (const designCase of designCases) {
    designCase.designRuling = args.ruling;
  }

  const browser = await chromium.launch();
  try {
    for (const designCase of designCases) {
      const manifest = await readDesignManifest(baseline, designCase);
      const artboard = lookupArtboard(
        manifest,
        designCase.design,
        baseline,
        designCase,
      );
      designCase.frameId = artboard.nodeId;
      designCase.artboard = {
        width: artboard.width,
        height: artboard.height,
      };
      await renderAndFillCase(browser, baseline, designCase);
    }
  } finally {
    await browser.close();
  }

  // Only the top-level source moves: per-case bytes are already pinned by
  // imageSha256, which the ruling verifier cross-checks against the digest, so
  // a hand-edited image is still caught.
  const identity = uxRulingIdentity({
    ruling: args.ruling,
    app: args.app,
    cases: designCases,
  });
  baseline.source = {
    revision: identity.revision,
    digest: identity.digest,
    manifestPath: baseline.source?.manifestPath,
    ...(baseline.source?.fileId ? { fileId: baseline.source.fileId } : {}),
    ...(baseline.source?.pageId ? { pageId: baseline.source.pageId } : {}),
    inputs: args.evidence,
  };
  await saveBaseline(baseline);
  console.log(
    `Re-anchored ${designCases.length} design reference(s) under ${identity.revision}`,
  );
}

if (import.meta.main) await main();
