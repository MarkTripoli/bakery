const SEMANTIC_HEADER =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([A-Za-z0-9][A-Za-z0-9._/-]*\))?!?: [^\s].*$/;
export const MAX_SUBJECT_LENGTH = 72;

export const SEMANTIC_RULE_TEXT =
  "Use Conventional Commits for every authored commit and pull request title: " +
  "the type must be one of feat, fix, docs, style, refactor, perf, test, " +
  "build, ci, chore, or revert; an optional `(scope)` and optional `!` may " +
  "follow the type, then `: ` must precede an imperative summary starting " +
  "with a non-space character. Keep the subject single-line and at most 72 " +
  'characters. Commit subjects may also use `Revert "…"`; pull request titles ' +
  "must also fit once GitHub appends the ` (#<number>)` squash suffix, so a " +
  "title's practical limit is 72 minus that suffix.";

export function isSemanticTitle(value: string): boolean {
  return value === value.trim() && value.length <= MAX_SUBJECT_LENGTH &&
    SEMANTIC_HEADER.test(value);
}
/** Squash-merge appends ` (#<number>)`; the squashed subject must also fit. */
export function isSemanticPullRequestTitle(
  title: string,
  pullRequestNumber: number,
): boolean {
  return Number.isInteger(pullRequestNumber) && pullRequestNumber > 0 &&
    isSemanticTitle(title) &&
    isSemanticTitle(`${title} (#${pullRequestNumber})`);
}

export function isSemanticCommitSubject(value: string): boolean {
  return isSemanticTitle(value) || /^Revert ".*"$/.test(value);
}

function commitSubject(message: string): string {
  return message.replace(/\r\n/g, "\n").split("\n", 1)[0];
}

function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

function requireValid(value: string, label: string): void {
  if (!isSemanticTitle(value)) {
    fail(`${label} must match Conventional Commits syntax: ${value}`);
  }
}

export async function listCommitSubjects(
  base: string,
  head: string,
): Promise<readonly { sha: string; subject: string }[]> {
  const result = await new Deno.Command("git", {
    args: ["log", "--no-merges", "--format=%H%x00%s", `${base}..${head}`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || "git log failed",
    );
  }
  return new TextDecoder().decode(result.stdout).split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\0");
      return {
        sha: line.slice(0, separator),
        subject: line.slice(separator + 1),
      };
    });
}

async function validateCommitRange(base: string, head: string): Promise<void> {
  if (!base || !head) fail("commit range requires base and head SHAs");
  let subjects: readonly { sha: string; subject: string }[];
  try {
    subjects = await listCommitSubjects(base, head);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const invalid = subjects.filter(({ subject }) =>
    !isSemanticCommitSubject(subject)
  );
  if (invalid.length) {
    fail(
      "Non-semantic commit subject(s):\n" +
        invalid.map(({ sha, subject }) => `- ${sha.slice(0, 12)} ${subject}`)
          .join(
            "\n",
          ),
    );
  }
}

function requireValidPullRequestTitle(
  title: string,
  pullRequestNumber: number,
): void {
  if (isSemanticPullRequestTitle(title, pullRequestNumber)) return;
  const suffix = ` (#${pullRequestNumber})`;
  const squashedSubject = `${title}${suffix}`;
  if (
    Number.isInteger(pullRequestNumber) &&
    pullRequestNumber > 0 &&
    isSemanticTitle(title) &&
    squashedSubject.length > MAX_SUBJECT_LENGTH
  ) {
    fail(
      `Squashed PR subject "${squashedSubject}" would be ` +
        `${squashedSubject.length} characters, over ${MAX_SUBJECT_LENGTH}; ` +
        `keep the title at most ${MAX_SUBJECT_LENGTH - suffix.length}.`,
    );
  }
  fail(
    `PR title must match Conventional Commits syntax and leave room for ` +
      `the squash suffix "${suffix}": ${title}`,
  );
}

if (import.meta.main) {
  const [mode, ...args] = Deno.args;
  if (mode === "--title") {
    const pullRequestNumberFlag = args.indexOf("--pull-request-number");
    if (pullRequestNumberFlag === -1) {
      requireValid(args.join(" "), "PR title");
    } else if (pullRequestNumberFlag + 1 >= args.length) {
      fail(
        "Usage: validate-semantic.ts --title <title...> " +
          "[--pull-request-number <n>]",
      );
    } else {
      const title = [
        ...args.slice(0, pullRequestNumberFlag),
        ...args.slice(pullRequestNumberFlag + 2),
      ].join(" ");
      const rawNumber = args[pullRequestNumberFlag + 1];
      if (!/^[1-9][0-9]*$/.test(rawNumber)) {
        fail(
          `--pull-request-number must be a positive integer, got "${rawNumber}"`,
        );
      }
      requireValidPullRequestTitle(title, Number(rawNumber));
    }
  } else if (mode === "--commit-message-file" && args.length === 1) {
    const message = await Deno.readTextFile(args[0]);
    const subject = commitSubject(message);
    if (!isSemanticCommitSubject(subject)) {
      fail(`Commit subject must match Conventional Commits syntax: ${subject}`);
    }
  } else if (mode === "--commit-range" && args.length === 2) {
    await validateCommitRange(args[0], args[1]);
  } else {
    fail(
      "Usage: validate-semantic.ts --title <title...> " +
        "[--pull-request-number <n>] | " +
        "--commit-message-file <path> | --commit-range <base> <head>",
    );
  }
}
