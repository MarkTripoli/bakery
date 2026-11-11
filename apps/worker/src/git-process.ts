/**
 * Running git as a child process with a deadline, an abort signal and a stop
 * that cannot be ignored.
 *
 * Three places start git: the worktree helper, the harness and the reviewer.
 * They share this module so that none of them can hang on a child that traps
 * SIGTERM, and none leaves git's own children behind. It lives apart from
 * attempt-worktree.ts and harness-common.ts, which re-export from it, because
 * each of them needs it and they import each other's neighbours.
 *
 * A stop is: SIGTERM, a short grace period, SIGKILL, and a bounded wait for the
 * exit. The signals go to the child's whole process group, because git's hooks,
 * credential helpers and remote transports are not the child and would
 * otherwise outlive it. The child is started through setsid so that it leads a
 * group of its own; without setsid it is signalled alone.
 */
import {
  type GroupSignal,
  signalProcessGroup,
  spawnInOwnProcessGroup,
} from "./process-group.ts";

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

/** What a stop does to a git child. */
export type StoppableGitChild = {
  /**
   * Sends the signal to the child and, when it leads a process group, to the
   * whole group. May return a promise, which is awaited.
   */
  kill(signal: GroupSignal): void | Promise<void>;
  /**
   * Kills whatever is left of the child's process group once the child has
   * exited. Absent for a child that leads no group of its own.
   */
  sweep?(): void | Promise<void>;
};

/** The things done to a git child; Deno's child process provides the first. */
export type GitChild = StoppableGitChild & {
  output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
};

/** Starts a git child. A seam, so tests can stand in a child that never exits. */
export type GitSpawn = (
  executable: string,
  options: { args: string[]; cwd: string },
) => GitChild | Promise<GitChild>;

/** A started process and the part of it a stop acts on. */
export type GitProcess = {
  readonly child: Deno.ChildProcess;
  readonly stop: StoppableGitChild;
};

/**
 * Starts `executable` as the leader of its own process group, with stdin
 * closed, stdout piped and stderr piped or discarded. `executable` is git, or a
 * stand-in under test. A failure to start is thrown.
 */
export async function startGitProcess(
  executable: string,
  { args, cwd }: { args: string[]; cwd: string },
  stderr: "piped" | "null" = "piped",
): Promise<GitProcess> {
  const launch = await spawnInOwnProcessGroup(executable, args);
  const child = new Deno.Command(launch.command, {
    args: launch.args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr,
  }).spawn();
  return {
    child,
    stop: {
      kill: async (signal) => {
        if (launch.grouped) await signalProcessGroup(child.pid, signal);
        // The child itself, in case setsid forked and it is not the leader.
        try {
          child.kill(signal);
        } catch {
          // Already gone: the signal has nothing left to do.
        }
      },
      sweep: launch.grouped
        ? async () => {
          await signalProcessGroup(child.pid, "SIGKILL");
        }
        : undefined,
    },
  };
}

export const defaultGitSpawn: GitSpawn = async (executable, options) => {
  const { child, stop } = await startGitProcess(executable, options);
  return { ...stop, output: () => child.output() };
};

/** A timer that can be cancelled, so no path leaves one running. */
export function after(ms: number) {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"elapsed">((resolve) => {
    id = setTimeout(() => resolve("elapsed"), ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

async function signalChild(
  child: StoppableGitChild,
  signal: GroupSignal,
): Promise<void> {
  try {
    await child.kill(signal);
  } catch {
    // Already gone: the signal has nothing left to do.
  }
}

async function sweepChild(child: StoppableGitChild): Promise<void> {
  try {
    await child.sweep?.();
  } catch {
    // Nothing left to sweep.
  }
}

/**
 * Stops a child: SIGTERM, then SIGKILL if it has not exited within
 * `killGraceMs`, then waits at most `exitWaitMs` for it to go. A child that
 * exits on SIGTERM may still have left members of its group, so those are
 * killed too; a SIGKILL already went to the whole group. `exited` must settle
 * when the child has exited and never reject. Timers started here are pushed to
 * `timers` so the caller can cancel them on every path.
 */
export async function stopChild(
  child: StoppableGitChild,
  exited: Promise<unknown>,
  limits: GitKillLimits,
  timers: Array<{ cancel: () => void }>,
): Promise<void> {
  const killGraceMs = limits.killGraceMs ?? GIT_KILL_LIMITS.killGraceMs;
  const exitWaitMs = limits.exitWaitMs ?? GIT_KILL_LIMITS.exitWaitMs;
  await signalChild(child, "SIGTERM");
  const grace = after(killGraceMs);
  timers.push(grace);
  if ((await Promise.race([exited, grace.promise])) === "elapsed") {
    await signalChild(child, "SIGKILL");
    const exit = after(exitWaitMs);
    timers.push(exit);
    await Promise.race([exited, exit.promise]);
    return;
  }
  await sweepChild(child);
}

const decoder = new TextDecoder();

/** How a git call ended; a call that finished carries its raw output. */
export type RawGitOutcome =
  | {
    readonly kind: "done";
    readonly code: number;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
  }
  | { readonly kind: "deadline" }
  | { readonly kind: "aborted" };

/**
 * Runs git with a deadline and returns its output as bytes. `aborted` when
 * `signal` fired and `deadline` when only the deadline did. A stop is
 * {@link stopChild}: a child that traps SIGTERM, or one that cannot be reaped,
 * ends the call on schedule instead of holding the caller for as long as it
 * likes. A failure to start is thrown.
 */
export async function runGitRaw(
  spawn: GitSpawn,
  executable: string,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  limits: GitKillLimits = {},
): Promise<RawGitOutcome> {
  const child = await spawn(executable, { args: [...args], cwd });
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
        kind: "done",
        code: first.output.code,
        stdout: first.output.stdout,
        stderr: first.output.stderr,
      };
    }
    await stopChild(child, settled, limits, timers);
    return { kind: reason === "signal" ? "aborted" : "deadline" };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    for (const timer of timers) timer.cancel();
  }
}

/**
 * Runs git with a deadline and returns its output as text. Returns `"aborted"`
 * when `signal` fired and a `code: -1` result when only the deadline did.
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
  const outcome = await runGitRaw(
    spawn,
    executable,
    cwd,
    args,
    timeoutMs,
    signal,
    limits,
  );
  if (outcome.kind === "aborted") return "aborted";
  if (outcome.kind === "deadline") {
    return { code: -1, stdout: "", stderr: "git deadline" };
  }
  return {
    code: outcome.code,
    stdout: decoder.decode(outcome.stdout),
    stderr: decoder.decode(outcome.stderr),
  };
}
