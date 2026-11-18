// The two rules a still set keeps getting wrong, as code.
//
// 1. Every still must be distinct. A capture that silently writes the same
//    frame twice under two names ("light" and "dark") produces a set that looks
//    complete and proves nothing. This module refuses that outcome.
// 2. Every still must record what it was. A manifest with a hash per file makes
//    the set checkable later, and makes "the file changed" observable.
//
// Import from a capture script:
//
//   import { assertDistinct, writeManifest } from "../stills.mjs";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/** SHA-256 of a file's bytes. */
export async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

/**
 * Groups `files` by content hash and throws naming every duplicate group.
 *
 * Two stills that hash the same mean one of them is not the state it claims:
 * the capture did not actually change the page between shots, or the shot was
 * taken before the state settled.
 */
export async function assertDistinct(files) {
  const byHash = new Map();
  for (const file of files) {
    const hash = await sha256(file);
    const group = byHash.get(hash);
    if (group === undefined) byHash.set(hash, [file]);
    else group.push(file);
  }
  const duplicates = [...byHash.values()].filter((group) => group.length > 1);
  if (duplicates.length > 0) {
    const detail = duplicates
      .map((group) => group.map((file) => basename(file)).join(" == "))
      .join("; ");
    throw new Error(
      `duplicate stills (identical bytes, so neither proves its own state): ${detail}`,
    );
  }
  return byHash.size;
}

/**
 * Writes a manifest beside the stills: one entry per file with its size and
 * hash, plus whatever the caller wants to record about how the set was made.
 */
export async function writeManifest(out, { schema, files, ...rest }) {
  const entries = [];
  for (const file of files) {
    const info = await stat(file);
    entries.push({
      path: relative(out, file),
      bytes: info.size,
      sha256: await sha256(file),
    });
  }
  const duplicateGroups = files.length - (await assertDistinct(files));
  const manifest = {
    schema,
    generatedAt: new Date().toISOString(),
    distinct: duplicateGroups === 0,
    files: entries,
    ...rest,
  };
  const path = join(out, "manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
