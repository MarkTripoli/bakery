import { dirname, join } from "node:path";
import { NativeExecutorError } from "./executor.ts";
import { GIT_EXECUTABLE } from "./git-executable.ts";
import {
  defaultGitSpawn,
  GIT_KILL_LIMITS,
  type GitKillLimits,
  type GitResult,
  runGit,
} from "./git-process.ts";

export {
  defaultGitSpawn,
  type GitChild,
  type GitKillLimits,
  type GitResult,
  type GitSpawn,
  runGit,
} from "./git-process.ts";
import { prepareHarnessHome } from "./harness-common.ts";

/**
 * Throwaway detached `git worktree` of the operator repository, shared by the
 * executors that must read a candidate revision without touching the harness
 * working tree: the `quality.check` runner (issue #83) and the independent
 * reviewer (issue #94). Each attempt gets a fresh 0700 root under its own
 * subdirectory of the worker state directory, with an isolated HOME and TMPDIR
 * and the worktree at an exact revision, proven by reading HEAD back.
 *
 * Cleanup first gives the owner full access to every directory it created,
 * without following a symlink, so a locked or read-only tree cannot outlive its
 * attempt. It touches only paths below the attempt root.
 */

/** Code-owned deadlines of the git calls that prepare and remove a worktree. */
export const ATTEMPT_WORKTREE_LIMITS = Object.freeze({
  /** Deadline of each git call that prepares or removes the worktree. */
  gitMs: 60_000,
  /** Deadline of the worktree checkout itself, which can be large. */
  checkoutMs: 5 * 60 * 1000,
  /** How long a git child that was sent SIGTERM may take to exit before SIGKILL. */
  killGraceMs: GIT_KILL_LIMITS.killGraceMs,
  /** How long to wait for exit after SIGKILL before giving up on the child. */
  exitWaitMs: GIT_KILL_LIMITS.exitWaitMs,
});

/** What one executor needs to prepare, add and remove attempt worktrees. */
export type AttemptWorktreeOptions = {
  /** The operator repository that holds the revision (the harness repository). */
  readonly repository: string;
  /** Private worker state root; attempt roots live in a subdirectory of it. */
  readonly stateDir: string;
  /**
   * Credential and state files of the worker. The attempt root must sit
   * outside and beside none of them and no child environment value may name one.
   */
  readonly credentialPaths?: readonly string[];
  /** Test seam: overrides of the code-owned git deadlines. */
  readonly limits?: {
    readonly gitMs?: number;
    readonly checkoutMs?: number;
    readonly killGraceMs?: number;
    readonly exitWaitMs?: number;
  };
};

/** Where one executor keeps its attempt roots and how it names a refusal. */
export type AttemptScope = {
  /** Subdirectory of the worker state directory that holds the attempt roots. */
  readonly directory: string;
  /** Code of the `NativeExecutorError` thrown for an unsafe attempt root. */
  readonly unsafeRootCode: string;
};

export type AttemptLayout = {
  readonly root: string;
  readonly worktree: string;
  readonly home: string;
  readonly tmp: string;
};

export function git(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  limits?: GitKillLimits,
): Promise<GitResult | "aborted"> {
  return runGit(
    defaultGitSpawn,
    GIT_EXECUTABLE,
    cwd,
    args,
    timeoutMs,
    signal,
    limits,
  );
}

function assertOutsideCredentials(
  root: string,
  credentialPaths: readonly string[],
  scope: AttemptScope,
): void {
  for (const path of credentialPaths) {
    if (
      root === path || root.startsWith(`${path}/`) ||
      path.startsWith(`${root}/`) || dirname(root) === dirname(path)
    ) throw new NativeExecutorError(scope.unsafeRootCode);
  }
}

/** Creates the fresh 0700 attempt root with its isolated HOME and TMPDIR. */
export async function prepareAttemptRoot(
  options: AttemptWorktreeOptions,
  scope: AttemptScope,
  attemptId: string,
): Promise<AttemptLayout> {
  const base = join(options.stateDir, scope.directory);
  const root = join(base, attemptId);
  assertOutsideCredentials(root, options.credentialPaths ?? [], scope);
  await Deno.mkdir(base, { recursive: true, mode: 0o700 });
  await Deno.chmod(base, 0o700);
  await Deno.remove(root, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(root, { mode: 0o700 });
  try {
    await Deno.chmod(root, 0o700);
    const home = await prepareHarnessHome(root);
    const tmp = join(root, "tmp");
    await Deno.mkdir(tmp, { mode: 0o700 });
    await Deno.chmod(tmp, 0o700);
    return { root, worktree: join(root, "worktree"), home, tmp };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Gives the owner full access to every directory under `path`, so the tree can
 * be deleted. A command may have locked a directory (mode 000) or made a tree
 * read-only; neither can be unlinked from. Nothing is followed: `lstat` says
 * what each path is, a symlink is left alone and never chmodded through, and
 * only paths below `path` are touched. It runs after the commands' process
 * groups were cut, and it never throws: removal is best effort either way.
 */
async function makeTreeRemovable(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (!info.isDirectory) return;
    if (((info.mode ?? 0) & 0o700) !== 0o700) await Deno.chmod(path, 0o700);
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory) await makeTreeRemovable(join(path, entry.name));
    }
  } catch {
    // Gone, or not ours to change: removal reports nothing worse than before.
  }
}

/**
 * `git worktree add` locks its record as "initializing" until it has finished.
 * A checkout cut off in that window (deadline, cancellation, a lost worker)
 * leaves the record locked with no directory behind it, and neither
 * `worktree remove --force` nor `worktree prune` removes a locked record, so it
 * would stay in the operator's repository for good. Unlocking the path of an
 * attempt that is being discarded lets the prune that follows drop it. Only the
 * attempt's own path is named, so a lock somebody else holds is never touched.
 * Best effort: git refuses for a path that is unregistered or not locked.
 */
async function unlockAbandonedRecord(
  repository: string,
  worktree: string,
  gitMs: number,
  limits?: GitKillLimits,
): Promise<void> {
  await git(
    repository,
    ["worktree", "unlock", worktree],
    gitMs,
    undefined,
    limits,
  )
    .catch(() => undefined);
}

/** Removes leftover attempt roots and stale worktree records of a crashed worker. */
export async function sweepAttempts(
  options: AttemptWorktreeOptions,
  scope: AttemptScope,
): Promise<void> {
  const base = join(options.stateDir, scope.directory);
  const gitMs = options.limits?.gitMs ?? ATTEMPT_WORKTREE_LIMITS.gitMs;
  try {
    for await (const entry of Deno.readDir(base)) {
      const path = join(base, entry.name);
      await makeTreeRemovable(path);
      await Deno.remove(path, { recursive: true }).catch(() => undefined);
      await unlockAbandonedRecord(
        options.repository,
        join(path, "worktree"),
        gitMs,
        options.limits,
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await git(
    options.repository,
    ["worktree", "prune"],
    gitMs,
    undefined,
    options.limits,
  )
    .catch(() => undefined);
}

/** Always runs: removes the worktree, the attempt root and the stale record. */
export async function removeAttempt(
  options: AttemptWorktreeOptions,
  layout: AttemptLayout,
  worktreeAdded: boolean,
): Promise<void> {
  const gitMs = options.limits?.gitMs ?? ATTEMPT_WORKTREE_LIMITS.gitMs;
  // Before git or Deno try to delete: a locked or read-only tree stops both.
  await makeTreeRemovable(layout.root);
  if (worktreeAdded) {
    await git(
      options.repository,
      ["worktree", "remove", "--force", layout.worktree],
      gitMs,
      undefined,
      options.limits,
    ).catch(() => undefined);
  }
  await Deno.remove(layout.root, { recursive: true }).catch(() => undefined);
  // `added: false` also covers a checkout that was cut off after git had
  // already registered (and locked) the record.
  if (!worktreeAdded) {
    await unlockAbandonedRecord(
      options.repository,
      layout.worktree,
      gitMs,
      options.limits,
    );
  }
  await git(
    options.repository,
    ["worktree", "prune"],
    gitMs,
    undefined,
    options.limits,
  )
    .catch(() => undefined);
}

export type WorktreeState = "ready" | "unavailable" | "aborted";

/** Adds the detached worktree and proves its HEAD is exactly the revision. */
export async function addWorktree(
  options: AttemptWorktreeOptions,
  layout: AttemptLayout,
  revision: string,
  signal: AbortSignal,
): Promise<{ state: WorktreeState; added: boolean }> {
  const gitMs = options.limits?.gitMs ?? ATTEMPT_WORKTREE_LIMITS.gitMs;
  const checkoutMs = options.limits?.checkoutMs ??
    ATTEMPT_WORKTREE_LIMITS.checkoutMs;
  const added = await git(
    options.repository,
    ["worktree", "add", "--quiet", "--detach", layout.worktree, revision],
    checkoutMs,
    signal,
    options.limits,
  );
  if (added === "aborted") return { state: "aborted", added: false };
  if (added.code !== 0) return { state: "unavailable", added: false };
  const head = await git(
    layout.worktree,
    ["rev-parse", "--verify", "HEAD"],
    gitMs,
    signal,
    options.limits,
  );
  if (head === "aborted") return { state: "aborted", added: true };
  return head.code === 0 && head.stdout.trim() === revision
    ? { state: "ready", added: true }
    : { state: "unavailable", added: true };
}
