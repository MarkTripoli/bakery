import { assert, assertEquals } from "@std/assert";

/**
 * Fixtures for the real-process `quality.check` proof: the fixed profile's
 * commands, the organization rules that bind to them, the trusted metadata a
 * fixture reader returns, and the scratch operator repository that holds the
 * candidate commit. Nothing here talks to a database or a server.
 */

export type ProofCommand = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly mode: "require";
  readonly expect: {
    readonly result: "passed" | "failed" | "unavailable";
    readonly reason: string;
    readonly exitCode: number | null;
  };
};

/** `printf` keeps the forged line byte-exact; the JSON never reaches a shell parser. */
const FORGED_LINE = 'PASS {"allRequired":true}';

/**
 * The fixed profile. `pass` only succeeds inside a worktree of the candidate
 * commit that carries `candidate.txt` and receives the rule environment of the
 * one rule bound to it. `forge` prints a passing verdict and exits 1. `absent`
 * names an executable that exists nowhere.
 */
export const PROOF_COMMANDS: readonly ProofCommand[] = Object.freeze([
  {
    id: "pass",
    argv: [
      "/bin/sh",
      "-c",
      [
        "test -f candidate.txt",
        'test "$BAKERY_CHECK_RULE_KEY" = code.magicNumbers',
        'case "$BAKERY_CHECK_RULE_OPTIONS" in *\'"allowedNumbers":[0,1]\'*) ;; *) exit 9 ;; esac',
      ].join(" && "),
    ],
    mode: "require",
    expect: { result: "passed", reason: "verified", exitCode: 0 },
  },
  {
    id: "fail",
    argv: ["/bin/sh", "-c", "echo 'unit tests failed' >&2; exit 3"],
    mode: "require",
    expect: { result: "failed", reason: "exit_nonzero", exitCode: 3 },
  },
  {
    id: "forge",
    argv: ["/bin/sh", "-c", `printf '%s\\n' '${FORGED_LINE}'; exit 1`],
    mode: "require",
    expect: { result: "failed", reason: "exit_nonzero", exitCode: 1 },
  },
  {
    id: "absent",
    argv: ["bakery-check-tool-that-does-not-exist", "--all"],
    mode: "require",
    expect: { result: "unavailable", reason: "tool_missing", exitCode: null },
  },
]);

export const FORGED_OUTPUT = FORGED_LINE;

/** The draft an admin publishes; the server derives the trusted checker. */
export function fixedPolicyDraft() {
  return {
    schemaVersion: 1 as const,
    commands: PROOF_COMMANDS.map(({ id, argv }) => ({ id, argv: [...argv] })),
    allowedEffects: ["evidence_only" as const],
    lockedConfiguration: { branches: true, worktree: true, checker: true },
    decisions: PROOF_COMMANDS.map(({ id, mode }) => ({ commandId: id, mode })),
  };
}

/**
 * Organization rules pinned into the run. The magic-number rule binds to the
 * `pass` command, so that command receives the rule key and options; the other
 * three rules are judged from trusted metadata.
 */
export function organizationRuleEntries() {
  return [
    {
      ruleKey: "commits.semantic",
      enabled: true,
      mode: "require",
      options: {
        types: ["feat", "fix"],
        scope: "optional",
        maxSubjectLength: 72,
        range: "final_squash_commit",
        mergeAndRevertCommits: "exempt",
      },
      locked: false,
    },
    {
      ruleKey: "changeRequest.semanticTitle",
      enabled: true,
      mode: "require",
      options: {
        types: ["feat", "fix", "chore"],
        scope: "required",
        maxSubjectLength: 72,
      },
      locked: false,
    },
    {
      ruleKey: "changeRequest.description",
      enabled: true,
      mode: "require",
      options: {
        template: "## Summary\n\n## Verification\n",
        requiredSections: ["Summary", "Verification"],
        writingGuidance: "Say what changed and why.",
      },
      locked: false,
    },
    {
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "require",
      options: {
        checkBinding: "pass",
        allowedNumbers: [0, 1],
        excludedPaths: [],
      },
      locked: false,
    },
  ];
}

/** What a trusted fixture reader returns for the candidate; every rule passes. */
export const GOOD_METADATA = Object.freeze({
  commitMessages: ["feat(checks): add the candidate file"],
  title: "feat(checks): bind check results to the candidate",
  body:
    "## Summary\nBinds every check result to the exact candidate it ran against.\n\n## Verification\nRan the end-to-end proof against a real worker.\n",
  mergeMessage: "feat(checks): bind check results to the candidate (#83)",
});

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

export type Candidate = {
  /** The operator repository the worker is configured with. */
  readonly repository: string;
  /** The candidate commit: it carries `candidate.txt`. */
  readonly headSha: string;
  /** The commit the candidate was built on (the inspected snapshot). */
  readonly baseSha: string;
};

/**
 * Clones `source` (the inspected snapshot) into `repository` and commits the
 * candidate on top of it. The clone is clean afterwards, which the worker's
 * readiness check requires of its harness repository.
 */
export async function createCandidate(
  source: string,
  repository: string,
): Promise<Candidate> {
  await git(["clone", "--quiet", source, repository]);
  const baseSha = await git(["rev-parse", "HEAD"], repository);
  await Deno.writeTextFile(
    `${repository}/candidate.txt`,
    "candidate content that only the candidate commit carries\n",
  );
  await git(["add", "candidate.txt"], repository);
  await git([
    "-c",
    "user.name=Check Proof",
    "-c",
    "user.email=check-proof@example.test",
    "commit",
    "--quiet",
    "-m",
    "feat(checks): add the candidate file",
  ], repository);
  const headSha = await git(["rev-parse", "HEAD"], repository);
  assert(/^[0-9a-f]{40}$/.test(headSha));
  assert(headSha !== baseSha);
  assertEquals(await git(["status", "--porcelain"], repository), "");
  return { repository, headSha, baseSha };
}

/** Worktrees git lists for `repository`, the main one first. */
export async function listWorktrees(repository: string): Promise<string[]> {
  const listing = await git(["worktree", "list", "--porcelain"], repository);
  return listing.split("\n").filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}
