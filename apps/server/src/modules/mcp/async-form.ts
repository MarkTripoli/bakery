import { z } from "zod";

/**
 * How an Admin declares that a tool is asynchronous (#439, chapter 25 section
 * 15.4, "long-running tools"). The tool accepts a job and answers with a handle;
 * the paired read tool, given the handle, reports the job's status. The step
 * waits durably between looks, and every look is one read, so a job that takes
 * hours costs one read per interval and no more.
 *
 * The declaration lives on the classification of the submitting tool, which must
 * be write_reconcilable: the submit goes through the effect ledger under the
 * step's one effect key exactly as any such write does (a replay finds its own
 * effect and never submits twice), and the paired read is the one the step
 * already pins.
 */

/** A dotted path into a JSON answer: field names only, no wildcards, no indexes. */
const PATH = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,7}$/;
const ARGUMENT = /^[A-Za-z0-9_.-]{1,128}$/;
const STATUS_VALUE = z.string().min(1).max(64).describe(
  "One status value an asynchronous tool's paired read can answer with.",
);

export const ASYNC_POLL_MIN_MS = 1_000;
export const ASYNC_POLL_MAX_MS = 600_000;
export const ASYNC_POLL_DEFAULT_MS = 15_000;

export const AsyncFormSchema = z.object({
  handlePath: z.string().regex(PATH).describe(
    "Where the submit answer carries the job's handle, as a dotted path of field names.",
  ),
  handleArgument: z.string().regex(ARGUMENT).describe(
    "The argument of the paired read tool that takes the handle.",
  ),
  statusPath: z.string().regex(PATH).describe(
    "Where the paired read's answer carries the job's status, as a dotted path of field names.",
  ),
  doneValues: z.array(STATUS_VALUE).min(1).max(8).describe(
    "Status values that mean the job finished; the step completes with that answer.",
  ),
  failedValues: z.array(STATUS_VALUE).max(8).default([]).describe(
    "Status values that mean the job failed; the step fails. Any other value means still running.",
  ),
  pollEveryMs: z.number().int().min(ASYNC_POLL_MIN_MS).max(ASYNC_POLL_MAX_MS)
    .default(ASYNC_POLL_DEFAULT_MS).describe(
      "How long the waiting step leaves between two looks, in milliseconds.",
    ),
}).strict().refine(
  (form) => !form.doneValues.some((value) => form.failedValues.includes(value)),
  { message: "a status value cannot both finish and fail the job" },
).describe(
  "An asynchronous tool's declaration: where the handle is, how the status is read and which values end the job.",
);

export type AsyncForm = z.output<typeof AsyncFormSchema>;

/** Reads a stored declaration back; null when it is absent, and a refusal for one that is not valid. */
export function readAsyncForm(value: unknown): AsyncForm | null {
  if (value === null || value === undefined) return null;
  return AsyncFormSchema.parse(value);
}

/** The value at a dotted path of a JSON answer, or undefined when any step of it is missing. */
export function valueAtPath(answer: unknown, path: string): unknown {
  let current: unknown = answer;
  for (const segment of path.split(".")) {
    if (
      current === null || typeof current !== "object" ||
      Array.isArray(current) || !Object.hasOwn(current, segment)
    ) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A handle is a short string or a whole number; anything else is not one. */
export function handleOf(
  answer: unknown,
  path: string,
): string | number | null {
  const value = valueAtPath(answer, path);
  if (typeof value === "string" && value.length > 0 && value.length <= 512) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

export type AsyncStatus = "done" | "failed" | "running";

/** What a paired read's answer says about the job; anything unlisted is still running. */
export function asyncStatusOf(answer: unknown, form: AsyncForm): AsyncStatus {
  const value = valueAtPath(answer, form.statusPath);
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
  if (text === null) return "running";
  if (form.doneValues.includes(text)) return "done";
  if (form.failedValues.includes(text)) return "failed";
  return "running";
}
