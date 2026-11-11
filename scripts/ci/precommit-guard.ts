import { findSuppressionViolations } from "./check-suppressions.ts";

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

function isCodePath(path: string): boolean {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match !== null && CODE_EXTENSIONS.has(`.${match[1].toLowerCase()}`);
}

async function stagedCodeFiles(): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACM",
      "-z",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    const message = new TextDecoder().decode(output.stderr).trim();
    console.error(`[bakery] could not list staged files: ${message}`);
    Deno.exit(1);
  }
  return new TextDecoder()
    .decode(output.stdout)
    .split("\0")
    .filter(Boolean)
    .filter(isCodePath)
    .filter((path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    });
}

function normalise(path: string): string {
  return path.replace(/^(\.\/)+/, "");
}

/** True when `path` falls under a deno.json exclude entry. An entry ending in
 *  `/` matches that directory and everything below it; any other entry
 *  matches the exact path or a directory of that name. Entries are literal:
 *  `*` is not expanded. */
export function isExcluded(path: string, excludes: Iterable<string>): boolean {
  const target = normalise(path);
  for (const raw of excludes) {
    const entry = normalise(raw);
    if (entry === "") continue;
    const directory = entry.endsWith("/") ? entry : `${entry}/`;
    if (target === entry || target.startsWith(directory)) return true;
  }
  return false;
}

/** Paths excluded from `deno fmt` / `deno lint` in deno.json; passing only
 *  excluded files makes Deno exit 1 with "No target files found". Entries
 *  ending in `/` exclude every file under that directory. */
async function excludedPaths(tool: "fmt" | "lint"): Promise<string[]> {
  const config = JSON.parse(await Deno.readTextFile("deno.json")) as {
    fmt?: { exclude?: string[] };
    lint?: { exclude?: string[] };
  };
  return config[tool]?.exclude ?? [];
}

async function run(command: string, args: string[]): Promise<number> {
  const child = new Deno.Command(command, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

async function main(): Promise<void> {
  const files = await stagedCodeFiles();
  if (files.length === 0) return;

  const deno = Deno.execPath();
  const fmtExcluded = await excludedPaths("fmt");
  const fmtFiles = files.filter((file) => !isExcluded(file, fmtExcluded));
  const fmtCode = fmtFiles.length === 0
    ? 0
    : await run(deno, ["fmt", "--check", ...fmtFiles]);
  if (fmtCode !== 0) {
    console.error(
      "[bakery] deno fmt --check failed. Run `deno fmt` on these files, then re-stage.",
    );
    Deno.exit(1);
  }

  const lintExcluded = await excludedPaths("lint");
  const lintFiles = files.filter((file) => !isExcluded(file, lintExcluded));
  const lintCode = lintFiles.length === 0 ? 0 : await run(deno, [
    "lint",
    ...lintFiles,
  ]);
  if (lintCode !== 0) {
    console.error(
      "[bakery] deno lint failed. Fix the issues before committing.",
    );
    Deno.exit(1);
  }

  const violations = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    violations.push(...findSuppressionViolations(file, text));
  }
  if (violations.length > 0) {
    console.error("[bakery] suppression guard failed:");
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
}

if (import.meta.main) {
  await main();
}
