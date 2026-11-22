/**
 * Gives a coding harness the inputs its step declared.
 *
 * The assignment pins each declared input slot (`contextInputs`). Before the
 * harness starts, the pinned bytes are written into a context directory inside
 * the attempt root, and the rendered `CONTEXT.md` index is appended to the
 * prompt, so the step is told which files it has and which digest each one was
 * pinned to instead of guessing.
 *
 * Three rules carry over from the check runner:
 * - A step with no pinned inputs is untouched: no directory, no prompt text.
 * - The bytes are the ones admission pinned. They come from the attempt's
 *   context route and are checked against the pinned digest after they are
 *   written; a mismatch refuses the attempt before the harness starts.
 * - The index names where the bytes are and carries no instruction taken from
 *   an input.
 */

import { join } from "node:path";
import type { WorkerContextInput } from "./client.ts";
import {
  describeSeedingFault,
  fetcherForAttempt,
  seedContext,
} from "./context-seed.ts";
import { renderContextDocument } from "./context-document.ts";
import type { JobAssignment } from "./types.ts";

/** Reads the bytes the server pinned for one attempt. */
export type ReadAttemptContext = (
  attemptId: string,
) => Promise<readonly WorkerContextInput[]>;

/** The step key the index shows for a harness step; the assignment carries no run. */
const HARNESS_CONTEXT_STEP_KEY = "harness";

export type HarnessContext =
  | Readonly<{
    ok: true;
    /** The directory the inputs were written to; absent when there are none. */
    contextDir?: string;
    /** Text to append to the prompt; empty when there are no inputs. */
    promptSection: string;
  }>
  | Readonly<{
    ok: false;
    /** Suffix the adapter appends to its own fault prefix. */
    code:
      | "CONTEXT_READER_MISSING"
      | "CONTEXT_UNREADABLE"
      | "CONTEXT_UNMATERIALIZABLE";
    detail: string;
    status: number;
    retryable: boolean;
  }>;

/**
 * Writes the assignment's pinned inputs under `attemptRoot` and renders the
 * prompt section that names them.
 */
export async function prepareHarnessContext(options: {
  assignment: JobAssignment;
  /** The attempt's private root; removed with it when the attempt ends. */
  attemptRoot: string;
  /** What the step is asked to do, one sentence, shown as the index's goal. */
  goal: string;
  /** Where the harness edits files, shown as the index's output directory. */
  workDir: string;
  readAttemptContext?: ReadAttemptContext;
}): Promise<HarnessContext> {
  const pins = options.assignment.contextInputs ?? [];
  if (pins.length === 0) return { ok: true, promptSection: "" };
  const read = options.readAttemptContext;
  if (read === undefined) {
    return {
      ok: false,
      code: "CONTEXT_READER_MISSING",
      detail:
        "The assignment pins context inputs but this harness has no reader for them; no process started.",
      status: 500,
      retryable: false,
    };
  }
  const contextDir = join(options.attemptRoot, "context");
  try {
    const fetch = await fetcherForAttempt(() =>
      read(options.assignment.attemptId)
    );
    const seeding = await seedContext(
      {
        // The assignment names a job and an attempt, never a run, so the job id
        // is the most specific identifier the worker holds.
        runId: options.assignment.jobId,
        stepKey: HARNESS_CONTEXT_STEP_KEY,
        goal: options.goal,
        outputs: [],
        contextDir,
        outputDir: options.workDir,
      },
      pins,
      fetch,
    );
    if (!seeding.ok) {
      return {
        ok: false,
        code: "CONTEXT_UNMATERIALIZABLE",
        detail: seeding.faults.map(describeSeedingFault).join("; "),
        status: 500,
        retryable: false,
      };
    }
    return {
      ok: true,
      contextDir,
      promptSection:
        `\n\nContext for this step (CONTEXT.md in ${contextDir}):\n\n${
          renderContextDocument(seeding.document)
        }`,
    };
  } catch (error) {
    // The reader throwing is the host talking, not the run: nothing was
    // materialized and nothing is claimed about the pins.
    return {
      ok: false,
      code: "CONTEXT_UNREADABLE",
      detail: `The attempt's pinned inputs could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status: 503,
      retryable: true,
    };
  }
}
