import { assert, assertEquals } from "@std/assert";

/**
 * Fixtures for the real-process review and repair proof (issue #94): the
 * fixed profile the run is pinned to and the operator repository that holds
 * the candidate commits. Nothing here talks to a database or a server.
 *
 * The profile lists two commands. `unit` is required and passes only on a
 * commit whose `status.txt` says `ok`; `lint` is a warning that passes on any
 * commit that has the file. The repository history is linear:
 *
 * - `base`: the inspected snapshot the profile pins (no `status.txt`);
 * - `broken`: adds `status.txt` with `broken`, so `unit` fails (exit 3);
 * - `fixed`: sets `status.txt` to `ok`, so every check passes;
 * - `followUp`: adds a second file on top of `fixed`, so checks still pass.
 */

export type LoopCommand = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly mode: "require" | "warn";
};

export const LOOP_COMMANDS: readonly LoopCommand[] = Object.freeze([
  {
    id: "unit",
    argv: [
      "/bin/sh",
      "-c",
      "grep -qx ok status.txt || { echo 'unit tests failed: status.txt is not ok' >&2; exit 3; }",
    ],
    mode: "require",
  },
  {
    id: "lint",
    argv: ["/bin/sh", "-c", "test -f status.txt"],
    mode: "warn",
  },
]);

/** Every effect the reviewed preset needs: the profile cap is five entries. */
export const LOOP_EFFECTS = Object.freeze(
  [
    "artifact_only",
    "repository_revision",
    "evidence_only",
    "review_evidence",
  ] as const,
);

/** The fixed-policy draft an admin publishes; the server derives the checker. */
export function loopFixedPolicy() {
  return {
    schemaVersion: 1 as const,
    commands: LOOP_COMMANDS.map(({ id, argv }) => ({ id, argv: [...argv] })),
    allowedEffects: [...LOOP_EFFECTS],
    lockedConfiguration: { branches: true, worktree: true, checker: true },
    decisions: LOOP_COMMANDS.map(({ id, mode }) => ({ commandId: id, mode })),
  };
}

const GIT_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

/** Runs git with the host configuration ignored and returns trimmed stdout. */
export async function git(
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [...args],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  assertEquals(
    output.code,
    0,
    `git ${args.join(" ")}: ${new TextDecoder().decode(output.stderr)}`,
  );
  return new TextDecoder().decode(output.stdout).trim();
}

export type LoopCommits = {
  /** The operator repository the production worker is configured with. */
  readonly repository: string;
  readonly base: string;
  readonly broken: string;
  readonly fixed: string;
  readonly followUp: string;
};

async function commit(
  repository: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${repository}/${name}`, content);
    await git(["add", name], repository);
  }
  await git([
    "-c",
    "user.name=Review Proof",
    "-c",
    "user.email=review-proof@example.test",
    "commit",
    "--quiet",
    "-m",
    message,
  ], repository);
  const sha = await git(["rev-parse", "HEAD"], repository);
  assert(/^[0-9a-f]{40}$/.test(sha));
  return sha;
}

/**
 * Clones `source` (the inspected snapshot) into `repository` and commits
 * `broken`, `fixed` and `followUp` on top of it. The clone is clean afterwards,
 * which the worker's readiness check requires of its harness repository.
 */
export async function createLoopCommits(
  source: string,
  repository: string,
): Promise<LoopCommits> {
  await git(["clone", "--quiet", source, repository]);
  const base = await git(["rev-parse", "HEAD"], repository);
  const broken = await commit(
    repository,
    { "status.txt": "broken\n" },
    "feat(proof): add a status file that is not ok",
  );
  const fixed = await commit(
    repository,
    { "status.txt": "ok\n" },
    "fix(proof): make the status file ok",
  );
  const followUp = await commit(
    repository,
    { "NOTES.md": "A follow-up change on top of the fixed commit.\n" },
    "docs(proof): add a note",
  );
  assertEquals(new Set([base, broken, fixed, followUp]).size, 4);
  assertEquals(await git(["status", "--porcelain"], repository), "");
  return { repository, base, broken, fixed, followUp };
}

/** Worktrees git lists for `repository`, the main one first. */
export async function listWorktrees(repository: string): Promise<string[]> {
  const listing = await git(["worktree", "list", "--porcelain"], repository);
  return listing.split("\n").filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}
