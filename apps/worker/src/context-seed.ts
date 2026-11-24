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
import type { WorkerContextInput } from "./client.ts";
import type {
  ContextDocument,
  ContextFactEntry,
  ContextInputEntry,
} from "./context-document.ts";
import {
  type ContextMaterializeFault,
  materializeContext,
} from "./context-materialize.ts";

/**
 * Produces the bytes one pinned input describes.
 *
 * It takes the whole pin rather than an id, so the adapter never has to know
 * how the bytes are obtained. That mattered when no fetch route existed and it
 * still does: the route serves every pinned input of an attempt at once, keyed
 * by version, so a caller keyed by the pin can take either shape.
 */
export type PinnedBytesFetcher = (
  pin: NonNullable<JobAssignment["contextInputs"]>[number],
) => Promise<Uint8Array>;

/** Decodes one served input into the bytes the adapter writes. */
export function decodeContextInput(item: WorkerContextInput): Uint8Array {
  const binary = atob(item.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Builds a fetcher over the route that serves an attempt's pinned inputs.
 *
 * The route answers for the whole attempt at once, so the list is read once and
 * then keyed by DIGEST. That is the only value the two sides share: the served
 * items carry an artifact version id and the assignment's pins do not, so a
 * version-keyed lookup would have nothing to look up on the pin side. Keying by
 * digest is also the safer key - a served item whose bytes are not the bytes the
 * pin describes is what `materializeContext` refuses, and it can only refuse
 * that if the lookup finds the item.
 *
 * A pin the route did not serve is an error rather than empty bytes: the
 * assignment and the server disagree about what was pinned, and writing an
 * empty file would turn that disagreement into a digest mismatch blamed on the
 * wrong side.
 */
export async function fetcherForAttempt(
  readAttemptContext: () => Promise<readonly WorkerContextInput[]>,
): Promise<PinnedBytesFetcher> {
  const served = new Map<string, WorkerContextInput>();
  for (const item of await readAttemptContext()) {
    served.set(item.digest, item);
  }
  return (pin) => {
    const item = served.get(pin.digest);
    if (item === undefined) {
      throw new Error(
        `the attempt context served no bytes for input ${pin.slot}`,
      );
    }
    return Promise.resolve(decodeContextInput(item));
  };
}

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
  readonly facts?: readonly ContextFactEntry[];
  readonly factsOmitted?: number;
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
    facts: facts.facts ?? [],
    factsOmitted: facts.factsOmitted ?? 0,
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
