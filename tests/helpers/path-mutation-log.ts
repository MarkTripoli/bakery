/**
 * In-process changes to `PATH`, recorded so a refused spawn can name what moved
 * it (#229).
 *
 * #304 taught a refused spawn to print the PATH the lane started with, the PATH
 * now, where the program resolves in each, and the lane's grant; what it could
 * not say is which code changed the PATH. That is the one fact still missing for
 * the two incidents on 2026-11-12, and it is the fact that turns "did not happen
 * today" into a named cause when it happens again.
 *
 * Observation only: the value written, the error thrown and the moment of the
 * change are the caller's; this module copies what it sees and never throws.
 */

/** One in-process change to `PATH`. */
export type PathMutation = {
  /** When it happened, ISO 8601. */
  readonly at: string;
  /** Whether `PATH` was set to a value or removed. */
  readonly action: "set" | "delete";
  /** `PATH` immediately before the change. */
  readonly previous: string | undefined;
  /** `PATH` immediately after it, undefined for a deletion. */
  readonly next: string | undefined;
  /** The first frame outside this module and the preload, as `file:line`. */
  readonly site: string;
};

/** How many changes one process remembers; the rest are counted, not kept. */
export const MAX_PATH_MUTATIONS = 5;

/** How much of one PATH value a report prints. */
const MAX_VALUE = 400;

/** How much of a frame's location a report prints. */
const MAX_SITE = 200;

const recorded: PathMutation[] = [];
let dropped = 0;

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...(cut)` : value;
}

/**
 * The frame that changed the PATH: the first one in neither this module nor the
 * preload that installed the recorder.
 */
export function mutationSite(stack: string | undefined): string {
  if (stack === undefined) return "(unknown)";
  for (const frame of stack.split("\n").slice(1)) {
    const match = /(file:\/\/[^\s)]+):(\d+):(\d+)/.exec(frame);
    if (match === null) continue;
    const url = match[1];
    if (
      url.endsWith("/path-mutation-log.ts") ||
      url.endsWith("/temp-cleanup-preload.ts")
    ) {
      continue;
    }
    const path = decodeURIComponent(url.slice("file://".length));
    return bounded(`${path}:${match[2]}`, MAX_SITE);
  }
  return "(unknown)";
}

/** Records one change; after MAX_PATH_MUTATIONS the oldest is dropped. */
export function recordPathMutation(mutation: PathMutation): void {
  if (recorded.length >= MAX_PATH_MUTATIONS) {
    recorded.shift();
    dropped += 1;
  }
  recorded.push(mutation);
}

/** The changes this process recorded, oldest first. */
export function pathMutations(): readonly PathMutation[] {
  return [...recorded];
}

/** How many changes were dropped because the log is bounded. */
export function droppedPathMutations(): number {
  return dropped;
}

/** Forgets everything recorded; a test that asserts the log starts empty uses it. */
export function clearPathMutations(): void {
  recorded.length = 0;
  dropped = 0;
}

/** One PATH value as a report prints it: one line, no control characters, cut. */
function line(value: string | undefined): string {
  if (value === undefined) return "(unset)";
  const flat = Array.from(
    value,
    (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? "?" : character;
    },
  ).join("");
  return bounded(flat, MAX_VALUE);
}

/**
 * The recorded changes as report lines, or nothing at all: a healthy run prints
 * no part of this.
 */
export function describePathMutations(
  mutations: readonly PathMutation[],
  dropped: number = 0,
): string {
  if (mutations.length === 0) return "";
  const lines = [
    `  PATH changes in this process: ${mutations.length}${
      dropped > 0 ? ` (+${dropped} earlier, dropped)` : ""
    }`,
    ...mutations.map((mutation, index) =>
      `    [${index + 1}] ${bounded(mutation.at, MAX_SITE)} ${
        mutation.action === "delete" ? "removed" : "set"
      } by ${bounded(mutation.site, MAX_SITE)}: ${line(mutation.previous)} -> ${
        line(mutation.next)
      }`
    ),
  ];
  return lines.join("\n");
}
