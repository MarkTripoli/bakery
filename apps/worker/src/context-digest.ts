import { join, resolve } from "node:path";
import { sha256Hex } from "./harness-common.ts";
import type { ContextDocument } from "./context-document.ts";

/**
 * One input whose declared digest does not match the bytes on disk.
 *
 * Both digests are carried because "they differ" is useless to an operator: if
 * `declared` is wrong the materialisation wrote the wrong bytes, and if `actual`
 * is wrong something changed the file after it was written. The two need
 * different responses, so the fault has to say which side is which.
 */
export type ContextDigestFault = {
  readonly reason: "context_input_digest_mismatch";
  /** The slot whose bytes disagree with the index. */
  readonly slot: string;
  /** The path, relative to the context directory, that was read. */
  readonly path: string;
  /** The digest the index declares for this input. */
  readonly declared: string;
  /** The digest of the bytes found on disk. */
  readonly actual: string;
};

/** Reads the bytes at a path relative to the context directory. */
export type ContextFileReader = (relativePath: string) => Promise<Uint8Array>;

/**
 * Compares every input the index declares against the bytes actually present in
 * the attempt's context directory.
 *
 * This is deliberately not part of `validateContextDocument`: that function
 * judges a document on its own terms, whereas this needs the filesystem and is
 * asynchronous. Keeping them apart means the document validator stays a pure
 * synchronous check for callers who have no directory at all.
 *
 * It hashes the bytes itself and never accepts a digest from the caller that
 * wrote the file. A gate that recomputes the same value from the same source can
 * only ever agree with itself, so the comparison only means something when each
 * side has a genuinely different origin: the index on one side, the disk on the
 * other.
 *
 * Every mismatch is returned rather than the first, because a materialisation
 * fault usually corrupts several inputs at once and a caller told about one will
 * find the rest on the next run.
 */
export async function verifyContextDocument(
  options: {
    readonly contextDir: string;
    readonly document: ContextDocument;
    readonly read?: ContextFileReader;
  },
): Promise<readonly ContextDigestFault[]> {
  const read = options.read ?? defaultReader(options.contextDir);
  const faults: ContextDigestFault[] = [];
  for (const input of options.document.inputs) {
    const bytes = await read(input.path);
    const actual = await sha256Hex(bytes);
    if (actual === input.digest) continue;
    faults.push({
      reason: "context_input_digest_mismatch",
      slot: input.slot,
      path: input.path,
      declared: input.digest,
      actual,
    });
  }
  return faults;
}

/**
 * Resolves an input path inside the context directory.
 *
 * The refusal for a path that climbs belongs to the document validator, which
 * runs before this does; reaching here with one would mean the caller skipped
 * that check, so the path is resolved and read rather than judged twice.
 */
function defaultReader(contextDir: string): ContextFileReader {
  const root = resolve(contextDir);
  return (relativePath) => Deno.readFile(join(root, relativePath));
}
