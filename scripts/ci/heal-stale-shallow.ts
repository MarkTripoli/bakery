/**
 * Completes a runner workspace's git history before a gate that needs it.
 *
 * The Paper provenance gate refuses a repository that git reports as shallow.
 * A persistent runner can carry a leftover `.git/shallow` entry for a commit of
 * the repository's pre-recreation history: no ref reaches it and the current
 * server does not have it, so `git fetch --unshallow` cannot remove it and
 * `git rev-parse --is-shallow-repository` stays `true` for good. Runs 43023722608
 * and 43056515091 failed on bakery-hetzner-4 this way (entry 38f398e8..., a
 * commit of the archived repository); hetzner-1 and -2 had no such entry.
 *
 * This drops only entries that provably belong to no history the checkout can
 * see: the commit is absent from the repository, or git positively reports that
 * no branch, remote-tracking ref or tag contains it. An entry that some ref
 * reaches is a real boundary and is kept, so a genuinely incomplete checkout
 * still fails the gate. Anything git cannot answer is an error and changes
 * nothing.
 */

export type GitResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<GitResult>;

export const runGit: GitRunner = async (cwd, args) => {
  const out = await new Deno.Command("git", {
    args: [...args],
    cwd,
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    code: out.code,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
};

export type DroppedEntry = Readonly<{
  sha: string;
  reason: "object-absent" | "no-ref-contains-it";
  /** Subject line of the commit when it exists locally, to say where it came from. */
  subject: string | null;
}>;

export type HealResult = Readonly<{
  shallowBefore: boolean;
  shallowAfter: boolean;
  dropped: readonly DroppedEntry[];
  /** Entries that a ref reaches: real boundaries, left exactly as they were. */
  kept: readonly string[];
}>;

export type HealOptions = Readonly<{ git?: GitRunner }>;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Fixed text only: a path, a git message or a hash never appears in an error. */
function refusal(code: "GIT_COMMAND_FAILED" | "SHALLOW_FILE_MALFORMED") {
  return new Error(code);
}

export async function healStaleShallow(
  repo: string,
  options: HealOptions = {},
): Promise<HealResult> {
  const git = options.git ?? runGit;
  const ask = async (...args: string[]): Promise<GitResult> =>
    await git(repo, args);
  const mustSucceed = async (...args: string[]): Promise<string> => {
    const result = await ask(...args);
    if (result.code !== 0) throw refusal("GIT_COMMAND_FAILED");
    return result.stdout.trim();
  };

  const shallowText = await mustSucceed("rev-parse", "--is-shallow-repository");
  if (shallowText !== "true" && shallowText !== "false") {
    throw refusal("GIT_COMMAND_FAILED");
  }
  if (shallowText === "false") {
    return { shallowBefore: false, shallowAfter: false, dropped: [], kept: [] };
  }

  const gitDir = await mustSucceed("rev-parse", "--absolute-git-dir");
  const file = `${gitDir}/shallow`;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { shallowBefore: true, shallowAfter: true, dropped: [], kept: [] };
    }
    throw refusal("GIT_COMMAND_FAILED");
  }
  const entries = text.split("\n").filter((line) => line.length > 0);
  if (!entries.every((entry) => SHA.test(entry))) {
    throw refusal("SHALLOW_FILE_MALFORMED");
  }

  const kept: string[] = [];
  const dropped: DroppedEntry[] = [];
  for (const sha of [...new Set(entries)]) {
    // `cat-file -e` exits 0 for an object that exists and 1 for one that does
    // not; any other exit is git failing, which is not an answer.
    const exists = await ask("cat-file", "-e", sha);
    if (exists.code !== 0 && exists.code !== 1) {
      throw refusal("GIT_COMMAND_FAILED");
    }
    if (exists.code === 1) {
      dropped.push({ sha, reason: "object-absent", subject: null });
      continue;
    }
    // Which branch, remote-tracking ref or tag has the entry in its history.
    // Exit 0 with no output is git's positive "none"; a non-zero exit is not.
    const holders = await mustSucceed(
      "for-each-ref",
      "--contains",
      sha,
      "--count=1",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    );
    if (holders.length > 0) {
      kept.push(sha);
      continue;
    }
    const subject = await ask("log", "-1", "--format=%s", sha);
    dropped.push({
      sha,
      reason: "no-ref-contains-it",
      subject: subject.code === 0 ? subject.stdout.trim() || null : null,
    });
  }

  if (dropped.length > 0) {
    if (kept.length === 0) {
      await Deno.remove(file);
    } else {
      const staged = `${file}.heal-${crypto.randomUUID()}`;
      await Deno.writeTextFile(staged, kept.join("\n") + "\n");
      await Deno.rename(staged, file);
    }
  }
  const after = await mustSucceed("rev-parse", "--is-shallow-repository");
  return {
    shallowBefore: true,
    shallowAfter: after === "true",
    dropped,
    kept,
  };
}

async function main(): Promise<number> {
  const repo = Deno.cwd();
  const runner = Deno.env.get("RUNNER_NAME") ?? "unknown-runner";
  const version = (await runGit(repo, ["--version"])).stdout.trim();
  let result: HealResult;
  try {
    result = await healStaleShallow(repo);
  } catch (error) {
    console.error(
      `history: runner=${runner} ${version}: could not inspect git history (${
        error instanceof Error ? error.message : "unknown"
      }); nothing changed`,
    );
    return 1;
  }
  const short = (sha: string) => sha.slice(0, 12);
  console.log(
    `history: runner=${runner} ${version} shallow-before=${result.shallowBefore} shallow-after=${result.shallowAfter}`,
  );
  for (const entry of result.dropped) {
    console.log(
      `history: dropped stale shallow entry ${
        short(entry.sha)
      } (${entry.reason}${
        entry.subject === null ? "" : `: "${entry.subject}"`
      })`,
    );
  }
  for (const sha of result.kept) {
    console.log(`history: kept real shallow boundary ${short(sha)}`);
  }
  if (result.shallowAfter) {
    console.error(
      "history: the repository is still shallow because of a real boundary; the provenance gate will refuse it",
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main());
