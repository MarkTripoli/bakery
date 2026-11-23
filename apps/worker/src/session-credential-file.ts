/**
 * Handing a session's operation credential to the command line inside it (#404).
 *
 * The credential that lets an agent call Bakery's own operations is minted at
 * claim and comes back once, on the assignment. Two rules decide how it reaches
 * the `bakery` CLI in the session, and both come from the contract's own words:
 * it "must never be copied into job input, a log, an artifact or a subprocess
 * environment".
 *
 * - **A file, not a variable.** The worker writes it to an owner-only file in
 *   the attempt's private state and removes it when the attempt ends, whatever
 *   ended it. The child environment carries only the path, so `ps` output, a
 *   crash dump and a child's `/proc/<pid>/environ` show where the file is and
 *   never what is in it.
 * - **One place writes and one place deletes.** Writing is a wrapper around the
 *   whole executor rather than a step inside each adapter, because a harness
 *   that forgot it would produce a session whose CLI silently does not exist,
 *   and a harness that forgot to delete it would leave a credential on disk.
 *   The `finally` covers success, failure, cancellation and a lost lease alike.
 *
 * The path is a pure function of the state root, the attempt and the fence. The
 * adapters derive it from the same helper to put it in their child environment,
 * so there is no second copy of the naming rule to drift.
 */

import type { JobAssignment } from "./types.ts";
import type { WorkerExecutor } from "./executor.ts";

/** Directory under the worker's private state that holds live credentials. */
const SESSION_CREDENTIAL_DIRECTORY = "session-credentials";

/** The file's own name; the attempt and fence are the directory's names. */
const SESSION_CREDENTIAL_FILE = "credential";

/**
 * Where this attempt's credential lives, or null when it holds none.
 *
 * Null rather than a path to a file that will never exist: an action that is not
 * a session has no credential, and telling its child where one would be invites
 * a command that waits on a file that is never written.
 */
export function sessionCredentialPath(
  stateDir: string | undefined,
  assignment: Pick<JobAssignment, "attemptId" | "fence" | "sessionCredential">,
): string | null {
  if (
    stateDir === undefined || stateDir.trim() === "" ||
    typeof assignment.sessionCredential !== "string" ||
    assignment.sessionCredential.trim() === ""
  ) return null;
  // The fence is part of the path so a re-claim writes a new file rather than
  // overwriting the one an earlier lease was still using.
  return `${stateDir}/${SESSION_CREDENTIAL_DIRECTORY}/${assignment.attemptId}/${
    String(assignment.fence)
  }/${SESSION_CREDENTIAL_FILE}`;
}

/**
 * The two variables a session's child environment gets, and nothing else.
 *
 * The gateway URL is not a secret and the CLI cannot find it otherwise; the
 * credential is not here at all. Returned as an empty map for an action without
 * a credential so callers can spread it unconditionally.
 */
export function sessionEnvironment(
  stateDir: string | undefined,
  gatewayUrl: string | undefined,
  assignment: Pick<JobAssignment, "attemptId" | "fence" | "sessionCredential">,
): Readonly<Record<string, string>> {
  const path = sessionCredentialPath(stateDir, assignment);
  if (path === null || gatewayUrl === undefined || gatewayUrl.trim() === "") {
    return {};
  }
  return {
    BAKERY_SESSION_CREDENTIAL_FILE: path,
    BAKERY_URL: gatewayUrl,
  };
}

export class SessionCredentialFileError extends Error {
  override readonly name = "SessionCredentialFileError";
}

/**
 * Writes this attempt's credential, owner-only, or answers null when it has none.
 *
 * A file already at the path is from an earlier claim of this attempt at this
 * fence, so it is removed and replaced rather than appended to. A symlink there
 * is refused: following it would write the credential wherever it points. The
 * file itself is created with `createNew`, so nothing can be inserted between the
 * removal and the write.
 */
export async function writeSessionCredentialFile(
  stateDir: string,
  assignment: Pick<
    JobAssignment,
    "attemptId" | "fence" | "sessionCredential"
  >,
): Promise<string | null> {
  const path = sessionCredentialPath(stateDir, assignment);
  const credential = assignment.sessionCredential;
  if (path === null || typeof credential !== "string") return null;
  const directory = path.slice(0, path.lastIndexOf("/"));
  try {
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    await Deno.chmod(directory, 0o700);
    const existing = await Deno.lstat(path).catch(() => null);
    if (existing !== null) {
      // A stale file from a previous claim of the same attempt and fence: it
      // cannot be trusted (it may be a symlink someone placed) so it is
      // replaced, not appended to.
      if (existing.isSymlink) {
        throw new SessionCredentialFileError(
          "SESSION_CREDENTIAL_PATH_UNSAFE",
        );
      }
      await Deno.remove(path);
    }
    const handle = await Deno.open(path, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    try {
      await handle.write(new TextEncoder().encode(credential));
    } finally {
      handle.close();
    }
    await Deno.chmod(path, 0o600);
  } catch (error) {
    if (error instanceof SessionCredentialFileError) throw error;
    throw new SessionCredentialFileError("SESSION_CREDENTIAL_WRITE_FAILED");
  }
  return path;
}

/**
 * Removes a credential file and the empty folders it lived in.
 *
 * Missing is success: the end of an attempt runs once, and an attempt that never
 * got a credential has nothing here. `Deno.remove` on a symlink removes the link
 * and never its target, so one call covers both the file this wrote and a link
 * someone left in its place — which is why the write refuses a link but the
 * removal does not need to tell them apart.
 *
 * The two folders above the file are named for the attempt and the fence, so
 * leaving them behind grew the worker's state with one empty pair per attempt
 * until the next restart. They are removed only when empty, which is what an
 * attempt that failed before writing needs to be safe.
 */
export async function removeSessionCredentialFile(path: string): Promise<void> {
  await Deno.remove(path).catch(() => undefined);
  let directory = path.slice(0, path.lastIndexOf("/"));
  for (let level = 0; level < 2; level += 1) {
    const removed = await Deno.remove(directory)
      .then(() => true)
      .catch(() => false);
    // Stops at the credentials root, and stops early when another attempt still
    // has a file in this folder, which a non-empty directory answers.
    if (!removed) return;
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
}

/** Clears anything a killed worker left behind, before any attempt starts. */
export async function clearSessionCredentials(stateDir: string): Promise<void> {
  const root = `${stateDir}/${SESSION_CREDENTIAL_DIRECTORY}`;
  const info = await Deno.lstat(root).catch(() => null);
  if (info === null) return;
  if (info.isSymlink || !info.isDirectory) {
    // A directory replaced by a link is not ours to recurse into.
    await Deno.remove(root).catch(() => undefined);
    return;
  }
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
}

/**
 * Wraps an executor so every attempt has its credential file for exactly as long
 * as it runs.
 *
 * The wrapper is around `execute` rather than inside an adapter, so the answer to
 * "does this harness clean up after itself" is not per adapter. A write that
 * fails fails the attempt before anything spawns: a session that cannot be given
 * its credential must not run believing it has one.
 */
export function withSessionCredentialFile(
  inner: WorkerExecutor,
  options: Readonly<{ stateDir: string }>,
): WorkerExecutor {
  return {
    ...inner,
    async initialize() {
      // A crashed worker may have left a live-looking file behind. Nothing is
      // running at start, so anything there is stale.
      await clearSessionCredentials(options.stateDir);
      await inner.initialize?.();
    },
    async execute(assignment, signal, output, preparedSkills) {
      const path = await writeSessionCredentialFile(
        options.stateDir,
        assignment,
      );
      if (path === null) {
        return await inner.execute(assignment, signal, output, preparedSkills);
      }
      try {
        return await inner.execute(assignment, signal, output, preparedSkills);
      } finally {
        // Success, failure, cancellation and a lost lease all end here, so a
        // credential never outlives the attempt that owned it.
        await removeSessionCredentialFile(path);
      }
    },
  };
}
