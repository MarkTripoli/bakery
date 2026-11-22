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

/**
 * One way a step's context tree differs from the index it was given.
 *
 * A superset of the input comparison above, because a step can also add a file
 * beside its inputs or delete one. Both are changes to what the step read: an
 * added file is an input nobody pinned, and a deleted one is an input that is
 * now missing from an output that cites it.
 */
export type ContextTreeFault =
  | ContextVerificationFault
  | {
    readonly reason: "context_entry_unexpected";
    /** The path found in the tree that the index does not declare. */
    readonly path: string;
  }
  | {
    readonly reason: "context_entry_missing";
    /** The slot whose declared path is gone. */
    readonly slot: string;
    readonly path: string;
  };

/** The index file's own name, which is part of the tree but not an input. */
const CONTEXT_INDEX_FILE = "CONTEXT.md";

/**
 * Compares the whole tree with the index, not just the inputs it names.
 *
 * The index is the step's statement of what it was given. So the tree must hold
 * exactly those paths, plus the index itself, and nothing else: a new file is a
 * read the step invented, and it would otherwise be invisible to every later
 * check because no pin ever mentioned it.
 *
 * Unreadable entries are skipped rather than reported: a host that cannot list a
 * directory is a fault of the host, and this function's job is to answer about
 * the run. The exceptions inside it still surface as a throw.
 */
export async function verifyContextTree(options: {
  readonly contextDir: string;
  readonly document: ContextDocument;
  readonly read?: ContextFileReader;
}): Promise<readonly ContextTreeFault[]> {
  const declared = new Set(options.document.inputs.map((input) => input.path));
  const faults: ContextTreeFault[] = [];
  const read = options.read ??
    ((relativePath: string) =>
      Deno.readFile(join(options.contextDir, relativePath)));
  // Each input is read here rather than delegated, because the two functions
  // disagree about a missing file: `verifyContextDocument` treats it as a broken
  // directory and throws, while for this caller a missing input is exactly the
  // statement it was asked for. Delegating would turn a finding into a crash.
  for (const input of options.document.inputs) {
    if (!isSafeRelativePath(input.path)) {
      faults.push({
        reason: "context_input_path_unsafe",
        slot: input.slot,
        path: input.path,
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await read(input.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        faults.push({
          reason: "context_entry_missing",
          slot: input.slot,
          path: input.path,
        });
        continue;
      }
      throw error;
    }
    const actual = await sha256Hex(bytes);
    if (actual !== input.digest) {
      faults.push({
        reason: "context_input_digest_mismatch",
        slot: input.slot,
        path: input.path,
        declared: input.digest,
        actual,
      });
    }
  }
  const seen = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    const directory = relative === ""
      ? options.contextDir
      : join(options.contextDir, relative);
    for await (const entry of Deno.readDir(directory)) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (path === CONTEXT_INDEX_FILE) continue;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      seen.add(path);
      if (!declared.has(path)) {
        faults.push({ reason: "context_entry_unexpected", path });
      }
    }
  };
  await walk("");
  for (const input of options.document.inputs) {
    if (!seen.has(input.path) && isSafeRelativePath(input.path)) {
      const already = faults.some((fault) =>
        fault.reason === "context_entry_missing" && fault.path === input.path
      );
      if (!already) {
        faults.push({
          reason: "context_entry_missing",
          slot: input.slot,
          path: input.path,
        });
      }
    }
  }
  return faults;
}
