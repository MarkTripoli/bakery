import {
  type ContextDocument,
  type ContextInputEntry,
} from "./context-document.ts";

/**
 * The part of a run's input pin that describes the bytes.
 *
 * Stated here rather than imported from the server so the worker keeps its own
 * boundary: the server's pin carries an artifact id and a version id that the
 * index has no use for, and the worker should not depend on the server module
 * that happens to store them today. `RunInputPin` is structurally assignable
 * to this, so a caller holding one passes it without a conversion.
 */
export type PinnedInputBytes = {
  /** Digest of the bytes pinned at admission. */
  readonly sha256: string;
  readonly sizeBytes: number;
};

/**
 * One declared input, as the workflow compiler produced it, joined to the pin
 * that fixes the bytes.
 *
 * `slot`, `path` and `mediaType` are declared: they are a statement about what
 * the step may expect to find, so they are required here and no default is
 * supplied for them. Inventing any one of the three would put a guess into the
 * index, and the index exists so a step never has to guess what it is reading.
 *
 * `pin` is what the server fixed at admission. Only the fields that describe
 * the bytes are taken from it; nothing about naming comes from the pin.
 */
export type DeclaredContextInput = {
  /** The slot name the workflow declared, which the step sees in its context. */
  readonly slot: string;
  /** Where the bytes sit inside the context directory, relative to it. */
  readonly path: string;
  /** The declared media type of the bytes. */
  readonly mediaType: string;
  /** The pin recorded at admission, carrying the digest and size. */
  readonly pin: PinnedInputBytes;
};

/**
 * What a step is asked to do, combined with everything the index must state.
 *
 * The layout directories are passed in rather than derived: the attempt root
 * owns them, so the index reports where things are instead of deciding it.
 */
export type ContextDocumentSource = {
  readonly runId: string;
  readonly stepKey: string;
  readonly goal: string;
  readonly outputs: readonly string[];
  readonly inputs: readonly DeclaredContextInput[];
  readonly contextDir: string;
  readonly outputDir: string;
};

/**
 * Joins declared inputs to their pins and builds the document an attempt's
 * index is rendered from.
 *
 * The result is unvalidated on purpose: a caller that renders it is expected to
 * run `validateContextDocument` first, so a refused path is reported with the
 * renderer's own reason rather than repaired here.
 */
export function buildContextDocument(
  source: ContextDocumentSource,
): ContextDocument {
  return {
    runId: source.runId,
    stepKey: source.stepKey,
    goal: source.goal,
    outputs: source.outputs,
    inputs: source.inputs.map((input): ContextInputEntry => ({
      slot: input.slot,
      path: input.path,
      digest: input.pin.sha256,
      sizeBytes: input.pin.sizeBytes,
      mediaType: input.mediaType,
    })),
    contextDir: source.contextDir,
    outputDir: source.outputDir,
  };
}
