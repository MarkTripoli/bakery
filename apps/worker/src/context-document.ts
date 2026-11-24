/**
 * The index a worker reads before it starts: what the step is for, what it must
 * produce, and exactly which input bytes it will find in its context directory.
 *
 * The index is a map, not the material itself. Its whole job is to let the
 * model see, up front, that the files beside it are the ones admission pinned,
 * so a step never has to guess whether it is reading current or pinned bytes.
 */

export type ContextInputEntry = {
  /** The slot the workflow declared, such as `brief`. */
  readonly slot: string;
  /** Where the bytes live inside the context directory, relative to it. */
  readonly path: string;
  /** Digest of the bytes pinned at admission. */
  readonly digest: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
};

export type ContextFactEntry = {
  readonly wording: string;
  readonly recordedAt: string;
};

export type ContextDocument = {
  readonly runId: string;
  readonly stepKey: string;
  /** What this step is asked to achieve, one paragraph at most. */
  readonly goal: string;
  /** The output slots the step must publish, by name. */
  readonly outputs: readonly string[];
  readonly inputs: readonly ContextInputEntry[];
  readonly facts?: readonly ContextFactEntry[];
  readonly factsOmitted?: number;
  readonly contextDir: string;
  readonly outputDir: string;
};

/**
 * A directory entry never starts with `/` and never climbs: an input slot is a
 * name the workflow chose, so anything that could escape the directory is
 * refused rather than sanitised into something that silently points elsewhere.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  return path.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".."
  );
}

function codeCell(value: string): string {
  return "`" + value.replaceAll("`", "\\`") + "`";
}

/**
 * Renders CONTEXT.md.
 *
 * Two things are deliberately kept out of it: the input bytes themselves (they
 * are files beside it, and inlining them would put content into the prompt that
 * the digest on this index does not cover) and any instruction taken from an
 * input (a summarised brief is a claim the step could be steered by; the index
 * names where the real bytes are instead).
 */
export function renderContextDocument(document: ContextDocument): string {
  const lines: string[] = [];
  lines.push("# Context", "");
  lines.push(
    "This directory is read-only and belongs to this attempt. Every file listed",
    "below was pinned when the run was admitted: its digest is what the server",
    "serves, and a later change to the same artifact does not change it here.",
    "",
  );
  lines.push(`- Run: ${codeCell(document.runId)}`);
  lines.push(`- Step: ${codeCell(document.stepKey)}`);
  lines.push(`- Context directory: ${codeCell(document.contextDir)}`);
  lines.push(`- Output directory: ${codeCell(document.outputDir)}`, "");
  lines.push("## Goal", "", document.goal.trim(), "");
  lines.push("## Outputs", "");
  if (document.outputs.length === 0) {
    lines.push("This step declares no outputs.");
  } else {
    lines.push(
      "Publish each of these when the step is done; the server validates it.",
      "",
    );
    for (const output of document.outputs) {
      lines.push(`- ${codeCell(output)}`);
    }
  }
  lines.push("", "## Inputs", "");
  if (document.inputs.length === 0) {
    lines.push("This step declares no inputs.");
  } else {
    lines.push(
      "Read these from this directory. Do not fetch an artifact again to get a",
      "newer copy: the bytes here are the ones this run was pinned to.",
      "",
      "| Slot | Path | Digest | Size | Type |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const input of document.inputs) {
      lines.push(
        `| ${codeCell(input.slot)} | ${codeCell(input.path)} | ${
          codeCell(input.digest)
        } | ${input.sizeBytes} bytes | ${codeCell(input.mediaType)} |`,
      );
    }
  }
  const facts = document.facts ?? [];
  const omitted = document.factsOmitted ?? 0;
  if (facts.length > 0 || omitted > 0) {
    lines.push("", "## Remembered facts", "");
    lines.push(
      "What this repository had learned when this step started, as it was",
      "written into this context. A newer wording may exist since; this file",
      "does not change afterwards.",
      "",
    );
    for (const fact of facts) {
      lines.push(`- ${fact.wording.trim()}`, `  - recorded ${fact.recordedAt}`);
    }
    if (omitted > 0) {
      lines.push(
        "",
        `${omitted} more ${
          omitted === 1 ? "fact was" : "facts were"
        } left out to stay inside this step's limit.`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export type ContextFault = { readonly reason: string };

/**
 * Refuses a document whose inputs cannot be described safely. A path that would
 * leave the context directory is a fault of the run's own declaration, so it is
 * reported rather than repaired.
 */
export function validateContextDocument(
  document: ContextDocument,
): ContextFault | null {
  if (document.goal.trim() === "") return { reason: "context_goal_missing" };
  const slots = new Set<string>();
  const paths = new Set<string>();
  for (const input of document.inputs) {
    // A slot is how the reader knows WHAT it is reading, so an empty one is as
    // unsafe as a path that climbs: it renders a table row with a blank name and
    // nothing downstream can tell what the file is. Reached in practice when a
    // slot is declared optional upstream and defaults to nothing.
    if (input.slot.trim() === "") {
      return { reason: "context_input_slot_missing" };
    }
    if (!isSafeRelativePath(input.path)) {
      return { reason: "context_input_path_unsafe" };
    }
    if (slots.has(input.slot)) return { reason: "context_input_slot_repeated" };
    if (paths.has(input.path)) return { reason: "context_input_path_repeated" };
    slots.add(input.slot);
    paths.add(input.path);
  }
  return null;
}
