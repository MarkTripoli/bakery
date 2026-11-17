import { join, resolve } from "node:path";
import { sha256Hex } from "./harness-common.ts";
import {
  type ContextDocument,
  isSafeRelativePath,
} from "./context-document.ts";

/**
 * One input that could not be verified, and why.
 *
 * Two shapes rather than one with an optional field, because the two are
 * different faults with different responses: a mismatch means the bytes are not
 * the bytes the index declares, while an unsafe path means the index itself is
 * malformed and the bytes were never read. A single struct with nullable fields
 * would let a caller read `actual` off a fault that never computed one.
 */
export type ContextVerificationFault =
  | {
    readonly reason: "context_input_digest_mismatch";
    /** The slot whose bytes disagree with the index. */
    readonly slot: string;
    /** The path, relative to the context directory, that was read. */
    readonly path: string;
    /** The digest the index declares for this input. */
    readonly declared: string;
    /** The digest of the bytes found on disk. */
    readonly actual: string;
  }
  | {
    readonly reason: "context_input_path_unsafe";
    /** The slot whose declared path cannot be trusted. */
    readonly slot: string;
    /** The declared path, reported as written rather than resolved. */
    readonly path: string;
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
 *
 * The asymmetry is part of the contract: an unreadable directory THROWS, because
 * a broken host is not a statement about the run's declaration or its
 * materialisation, and folding it into this vocabulary would invite a caller to
 * read "the disk is broken" as "your workflow is wrong". A mismatch never
 * throws; it is a result.
 */
export async function verifyContextDocument(
  options: {
    readonly contextDir: string;
    readonly document: ContextDocument;
    readonly read?: ContextFileReader;
  },
): Promise<readonly ContextVerificationFault[]> {
  const read = options.read ?? defaultReader(options.contextDir);
  const faults: ContextVerificationFault[] = [];
  for (const input of options.document.inputs) {
    // This function refuses an unsafe path rather than trusting its caller. The
    // obligation is the reader's, not the compiler's: it reads the filesystem,
    // and a filesystem reader that trusts its input is one refactor away from
    // reading outside its directory. Today the compiler refuses these upstream,
    // so this fires only for a document that did not come from the compiler -
    // that is a fact about the current producer, not a licence to drop the
    // guard, and stating it here keeps a later reader from deleting a branch
    // that no test would miss.
    if (!isSafeRelativePath(input.path)) {
      faults.push({
        reason: "context_input_path_unsafe",
        slot: input.slot,
        path: input.path,
      });
      continue;
    }
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
 * The caller has already refused a path that climbs, but this does not rely on
 * that: the check above is what makes it safe to read here.
 */
function defaultReader(contextDir: string): ContextFileReader {
  const root = resolve(contextDir);
  return (relativePath) => Deno.readFile(join(root, relativePath));
}
