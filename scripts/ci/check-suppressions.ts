const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SELF_PATH = "scripts/ci/check-suppressions.ts";

const TS_IGNORE = ["@ts", "ignore"].join("-");
const TS_NOCHECK = ["@ts", "nocheck"].join("-");
const TS_EXPECT_ERROR = ["@ts", "expect", "error"].join("-");

const TS_IGNORE_PATTERN = new RegExp(`${TS_IGNORE}\\b`);
const TS_NOCHECK_PATTERN = new RegExp(`${TS_NOCHECK}\\b`);
const TS_EXPECT_ERROR_PATTERN = new RegExp(
  `${TS_EXPECT_ERROR}\\b:?(\\s*(\\S.*))?`,
);
const BARE_DENO_LINT_IGNORE = /\/\/\s*deno-lint-ignore(?:-file)?\s*$/;

export type SuppressionViolation = {
  path: string;
  line: number;
  reason: string;
  text: string;
};

export function findSuppressionViolations(
  path: string,
  text: string,
): SuppressionViolation[] {
  const violations: SuppressionViolation[] = [];
  const lines = text.split(/\r\n|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (TS_IGNORE_PATTERN.test(line)) {
      violations.push({
        path,
        line: lineNumber,
        reason: `${TS_IGNORE} is banned; use ${TS_EXPECT_ERROR} instead`,
        text: trimmed,
      });
      continue;
    }

    if (TS_NOCHECK_PATTERN.test(line)) {
      violations.push({
        path,
        line: lineNumber,
        reason:
          `${TS_NOCHECK} is banned; fix the file or narrow the suppression`,
        text: trimmed,
      });
      continue;
    }

    const expectError = TS_EXPECT_ERROR_PATTERN.exec(line);
    if (expectError && !expectError[2]) {
      violations.push({
        path,
        line: lineNumber,
        reason: `${TS_EXPECT_ERROR} needs an inline reason`,
        text: trimmed,
      });
      continue;
    }

    if (BARE_DENO_LINT_IGNORE.test(line)) {
      violations.push({
        path,
        line: lineNumber,
        reason: "deno-lint-ignore must name the rule(s) it suppresses",
        text: trimmed,
      });
    }
  }
  return violations;
}

function isCodePath(path: string): boolean {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match !== null && CODE_EXTENSIONS.has(`.${match[1].toLowerCase()}`);
}

async function trackedFiles(): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    const message = new TextDecoder().decode(output.stderr).trim();
    console.error(message || "git ls-files failed");
    Deno.exit(1);
  }
  return new TextDecoder()
    .decode(output.stdout)
    .split("\0")
    .filter(Boolean);
}

async function main(): Promise<void> {
  const requested = Deno.args.filter((argument) => argument !== "--");
  const candidates = requested.length > 0 ? requested : await trackedFiles();
  const files = candidates.filter(isCodePath).filter((path) =>
    path !== SELF_PATH
  );

  const violations: SuppressionViolation[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    violations.push(...findSuppressionViolations(file, text));
  }

  if (violations.length === 0) return;

  console.error("Suppression guard failed:");
  for (const violation of violations) {
    console.error(
      `  ${violation.path}:${violation.line}: ${violation.reason}`,
    );
    console.error(`    ${violation.text}`);
  }
  console.error(
    'See docs/engineering-rules.md "Local validation contract" for the allowed forms.',
  );
  Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
