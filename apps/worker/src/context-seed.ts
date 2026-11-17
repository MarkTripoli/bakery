/**
 * Turns a job assignment's pinned inputs into the files a step reads.
 *
 * The assignment carries `contextInputs`: slot, path, digest, size and media
 * type, pinned at admission. This module is the wire between that and
 * `materializeContext`, which writes bytes and then the index. It exists as its
 * own step because the two halves have different sources of truth: the
 * assignment says what the bytes should be, and the fetcher is the only thing
 * that can produce them. Keeping them apart means the writer never has to know
 * how bytes arrive, and the fetcher never has to know how they are laid out.
 *
 * Every value the index needs comes from the assignment. Nothing here derives a
 * path, a digest or a media type, because a value derived twice is a value that
 * can disagree with itself.
 */

import type { JobAssignment } from "./types.ts";
import type { ContextDocument, ContextInputEntry } from "./context-document.ts";
import {
  type ContextMaterializeFault,
  materializeContext,
} from "./context-materialize.ts";

/**
 * Produces the bytes one pinned input describes.
 *
 * It takes the whole pin rather than an id, because the contract does not
 * currently carry an identifier to fetch by: `StepContextInput` declares slot,
 * path, digest, sizeBytes, mediaType and kind, and nothing that dereferences to
 * content. Passing the pin keeps this module neutral about how that gap is
 * closed - a carried payload and a fetched artifact both arrive as bytes, and
 * the digest comparison below is what makes either trustworthy.
 */
export type PinnedBytesFetcher = (
  pin: NonNullable<JobAssignment["contextInputs"]>[number],
) => Promise<Uint8Array>;

/**
 * The fields of a `ContextDocument` that the step itself cannot supply.
 *
 * They are passed in rather than defaulted, so a caller has to say what the
 * step is for. A default goal would be an empty one, and a step told to achieve
 * nothing reads its inputs and does nothing.
 */
export type ContextDocumentFacts = {
  readonly runId: string;
  readonly stepKey: string;
  readonly goal: string;
  readonly outputs: readonly string[];
  readonly contextDir: string;
  readonly outputDir: string;
};

export type ContextSeeding =
  | { readonly ok: true; readonly document: ContextDocument }
  | { readonly ok: false; readonly faults: readonly ContextMaterializeFault[] };

/**
 * Writes the assignment's pinned inputs into `facts.contextDir`.
 *
 * A step with no `contextInputs` still gets an index, because the index is how a
 * step learns what it is for; only the input list is empty. An assignment whose
 * inputs cannot be produced fails as a whole: no bytes, no index, and the attempt
 * refused, since a step that starts with some of its inputs cannot tell which
 * ones are missing.
 */
export async function seedContext(
  facts: ContextDocumentFacts,
  contextInputs: JobAssignment["contextInputs"],
  fetchBytes: PinnedBytesFetcher,
): Promise<ContextSeeding> {
  const pinned = contextInputs ?? [];
  const entries: ContextInputEntry[] = [];
  const inputs: { entry: ContextInputEntry; bytes: Uint8Array }[] = [];
  for (const pin of pinned) {
    const bytes = await fetchBytes(pin);
    const entry: ContextInputEntry = {
      slot: pin.slot,
      path: pin.path,
      digest: pin.digest,
      sizeBytes: pin.sizeBytes,
      mediaType: pin.mediaType,
    };
    entries.push(entry);
    inputs.push({ entry, bytes });
  }
  const document: ContextDocument = {
    runId: facts.runId,
    stepKey: facts.stepKey,
    goal: facts.goal,
    outputs: facts.outputs,
    inputs: entries,
    contextDir: facts.contextDir,
    outputDir: facts.outputDir,
  };
  const result = await materializeContext(facts.contextDir, document, inputs);
  if (result.faults.length > 0) return { ok: false, faults: result.faults };
  return { ok: true, document: result.document };
}

/** One line describing what went wrong, for a fault the attempt reports. */
export function describeSeedingFault(
  fault: ContextMaterializeFault,
): string {
  switch (fault.reason) {
    case "context_input_path_unsafe":
      return `input ${fault.slot} declares a path that leaves the context directory`;
    case "context_input_path_repeated":
      return `input ${fault.slot} reuses the path ${fault.path}`;
    case "context_input_digest_mismatch":
      return `input ${fault.slot} at ${fault.path} hashes to ${fault.actual} but the pin declares ${fault.declared}`;
  }
}
