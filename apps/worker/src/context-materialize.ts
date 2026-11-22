/**
 * Puts a step's pinned inputs on disk before it starts.
 *
 * The order matters and is the whole of this module: bytes first, the index
 * last. A step that finds `CONTEXT.md` therefore finds every byte the index
 * names, because the index is written only after the last input is in place.
 * The reverse order would let a step read an index that promises files the
 * writer has not written yet, and "it was there a moment later" is not
 * something a step can wait for.
 *
 * Each input is also checked against the pin it came from, over the bytes that
 * were actually written rather than the bytes that were meant to be written.
 * That distinction is the point: a writer that compares its own intention with
 * the server's digest is comparing two things it already believes are equal.
 */

import { dirname, join } from "node:path";
import { sha256Hex } from "./harness-common.ts";
import {
  type ContextDocument,
  type ContextInputEntry,
  isSafeRelativePath,
  renderContextDocument,
} from "./context-document.ts";

/** One input to write: the entry the index will declare, and its bytes. */
export type PinnedInputBytes = {
  readonly entry: ContextInputEntry;
  readonly bytes: Uint8Array;
};

export type ContextMaterializeFault =
  | {
    /** The slot's path would leave the context directory. */
    readonly reason: "context_input_path_unsafe";
    readonly slot: string;
    readonly path: string;
  }
  | {
    /** What was written does not hash to the digest admission pinned. */
    readonly reason: "context_input_digest_mismatch";
    readonly slot: string;
    readonly path: string;
    readonly declared: string;
    readonly actual: string;
  }
  | {
    /** A path is already taken; two slots cannot share one file. */
    readonly reason: "context_input_path_repeated";
    readonly slot: string;
    readonly path: string;
  };

export type ContextMaterializeResult = {
  /** The document a step will read, once it has been written. */
  readonly document: ContextDocument;
  /** Every fault found. A clean materialisation returns an empty array. */
  readonly faults: readonly ContextMaterializeFault[];
};

/**
 * Writes the input bytes into `contextDir` and the index over them.
 *
 * Every input is checked before any input is written, so a context directory
 * either holds all of a step's inputs or none of them. The weaker order - write
 * each input and check it as you go - leaves a partial directory behind when
 * the third input is bad, and a step cannot tell a partial directory from a
 * complete one without reading the index, which is exactly the thing that was
 * never written.
 */
export async function materializeContext(
  contextDir: string,
  document: ContextDocument,
  inputs: readonly PinnedInputBytes[],
): Promise<ContextMaterializeResult> {
  const checked: PinnedInputBytes[] = [];
  const taken = new Set<string>();
  for (const input of inputs) {
    const { slot, path, digest } = input.entry;
    if (!isSafeRelativePath(path)) {
      return {
        document,
        faults: [{ reason: "context_input_path_unsafe", slot, path }],
      };
    }
    if (taken.has(path)) {
      return {
        document,
        faults: [{ reason: "context_input_path_repeated", slot, path }],
      };
    }
    taken.add(path);
    // The digest is checked over the bytes themselves, not over what the caller
    // said about them. A mismatch means the pin and the bytes disagree, and no
    // ordering of writes makes that safe to publish.
    const actual = await sha256Hex(input.bytes);
    if (actual !== digest) {
      return {
        document,
        faults: [{
          reason: "context_input_digest_mismatch",
          slot,
          path,
          declared: digest,
          actual,
        }],
      };
    }
    checked.push(input);
  }
  await Deno.mkdir(contextDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const input of checked) {
    const target = join(contextDir, input.entry.path);
    await Deno.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await Deno.writeFile(target, input.bytes, { mode: 0o600 });
    written.push(target);
  }
  // Last, deliberately: the index is the promise that the bytes above are all
  // there, so it is only written once they are.
  const index = join(contextDir, "CONTEXT.md");
  await Deno.writeTextFile(index, renderContextDocument(document), {
    mode: 0o600,
  });
  written.push(index);
  await sealContextDirectory(contextDir, written);
  return { document, faults: [] };
}

/**
 * Closes a step's inputs so it cannot quietly overwrite one.
 *
 * The files go 0400 and the index with them. Directories are left writable on
 * purpose: removing an attempt's private root walks it, and a 0500 directory
 * cannot be walked for deletion, so closing directories would trade one fault for
 * a leak on every failed cleanup. A step can therefore add a file beside its
 * inputs. That is caught, and named, by the tree check in `context-digest.ts`
 * after the step ends - an added file is as much a change to the tree as an
 * edited one.
 *
 * Like the modes, this is a barrier against a mistake rather than against a
 * decision: the step runs as the same user and can chmod its way back. The check
 * after the run is what actually holds.
 */
export async function sealContextDirectory(
  _contextDir: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    await Deno.chmod(file, 0o400).catch(() => undefined);
  }
}
