/**
 * Running git as a child process with a deadline, an abort signal and an
 * escalating stop.
 *
 * Moved unchanged out of attempt-worktree.ts so that the harness and reviewer
 * git runners can use it without importing the worktree module (a cycle). The
 * only edit is that the two kill defaults, which used to be read from
 * ATTEMPT_WORKTREE_LIMITS, are defined here and ATTEMPT_WORKTREE_LIMITS points
 * at them. attempt-worktree.ts re-exports everything here.
 */

/** Code-owned limits of stopping a git child. */
export const GIT_KILL_LIMITS = Object.freeze({
  /** How long a git child that was sent SIGTERM may take to exit before SIGKILL. */
  killGraceMs: 2_000,
  /** How long to wait for exit after SIGKILL before giving up on the child. */
  exitWaitMs: 5_000,
});

export type GitResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** How a stopped git child is escalated; the defaults are the code-owned limits. */
export type GitKillLimits = {
  readonly killGraceMs?: number;
  readonly exitWaitMs?: number;
};

/** The two things done to a git child; Deno's child process provides both. */
export type GitChild = {
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
};

/** Starts a git child. A seam, so tests can stand in a child that never exits. */
export type GitSpawn = (
  executable: string,
  options: { args: string[]; cwd: string },
) => GitChild;

export const defaultGitSpawn: GitSpawn = (executable, { args, cwd }) => {
  const child = new Deno.Command(executable, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return { kill: (signal) => child.kill(signal), output: () => child.output() };
};

/** A timer that can be cancelled, so no path leaves one running. */
function after(ms: number) {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"elapsed">((resolve) => {
    id = setTimeout(() => resolve("elapsed"), ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

function signalChild(child: GitChild, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    child.kill(signal);
  } catch {
    // Already gone: the signal has nothing left to do.
  }
}

const decoder = new TextDecoder();

/**
 * Runs git with a deadline. Returns `"aborted"` when `signal` fired and a
 * `code: -1` result when only the deadline did. A stop sends SIGTERM, waits
 * `killGraceMs`, then sends SIGKILL, and waits at most `exitWaitMs` for the
 * exit: a child that traps SIGTERM, or one that cannot be reaped, ends the call
 * on schedule instead of holding the attempt for as long as it likes.
 */
export async function runGit(
  spawn: GitSpawn,
  executable: string,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  limits: GitKillLimits = {},
): Promise<GitResult | "aborted"> {
  const killGraceMs = limits.killGraceMs ?? GIT_KILL_LIMITS.killGraceMs;
  const exitWaitMs = limits.exitWaitMs ?? GIT_KILL_LIMITS.exitWaitMs;
  const child = spawn(executable, { args: [...args], cwd });
  const settled = child.output().then(
    (output) => ({ output }) as const,
    (error: unknown) => ({ error }) as const,
  );
  let reason: "deadline" | "signal" | undefined;
  let wake!: () => void;
  const stopRequested = new Promise<"stop">((resolve) => {
    wake = () => resolve("stop");
  });
  const stop = (why: "deadline" | "signal") => {
    if (reason !== undefined) return;
    reason = why;
    wake();
  };
  const deadline = setTimeout(() => stop("deadline"), timeoutMs);
  const onAbort = () => stop("signal");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timers: Array<{ cancel: () => void }> = [];
  try {
    const first = await Promise.race([settled, stopRequested]);
    if (first !== "stop") {
      if ("error" in first) throw first.error;
      return {
        code: first.output.code,
        stdout: decoder.decode(first.output.stdout),
        stderr: decoder.decode(first.output.stderr),
      };
    }
    signalChild(child, "SIGTERM");
    const grace = after(killGraceMs);
    timers.push(grace);
    if ((await Promise.race([settled, grace.promise])) === "elapsed") {
      signalChild(child, "SIGKILL");
      const exit = after(exitWaitMs);
      timers.push(exit);
      await Promise.race([settled, exit.promise]);
    }
    return reason === "signal"
      ? "aborted"
      : { code: -1, stdout: "", stderr: "git deadline" };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    for (const timer of timers) timer.cancel();
  }
}
