/**
 * Line-count evidence for development metrics (chapter 18, issue #46).
 *
 * A pull request's changed lines are counted from the provider's own file
 * list of its diff (`GET /repos/{owner}/{repo}/pulls/{number}/files`) at the
 * head commit it merged with. The counter sorts every file into one category
 * or one exclusion by its path, and keeps what it could not count apart:
 *
 * - excluded: lock files, vendored trees, generated, minified and source-map
 *   output. Their lines are real but say nothing about the work, so they are
 *   counted as files and never as lines.
 * - binary: a file the provider lists with no patch and no line totals. Its
 *   lines are unknown, never zero, so a count holding one is not complete.
 * - truncated: the provider listed fewer files than the pull request
 *   changed, or the list ran past the page cap. The count is then partial.
 *
 * The result is the stored artifact: a counter version, the totals of what
 * was counted, one entry per category, and a coverage word. Changing any rule
 * here changes COUNTER_VERSION, so a count made under old rules is never
 * read as a current one.
 */

/** The version of the rules below; part of the artifact's identity. */
export const COUNTER_VERSION = "loc-1";

/** Pages of 100 files one count reads: GitHub lists at most 3,000 files. */
export const MAX_LINE_COUNT_PAGES = 30;

/** The categories a counted file falls in. */
export const LineCategory = Object.freeze(
  {
    Source: "source",
    Test: "test",
    Docs: "docs",
    Config: "config",
  } as const,
);
export type LineCategory = typeof LineCategory[keyof typeof LineCategory];

/** How much of a pull request's diff a count covers. */
export const LineCoverage = Object.freeze(
  {
    /** Every changed file was listed and every counted file had line totals. */
    Complete: "complete",
    /** Every file was listed, but at least one is binary: lines unknown. */
    Binary: "binary",
    /** The provider's list stopped before every changed file. */
    Truncated: "truncated",
  } as const,
);
export type LineCoverage = typeof LineCoverage[keyof typeof LineCoverage];

/** One file of the provider's list, as the counter reads it. */
export type DiffFile = Readonly<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Whether the provider sent a patch for the file. */
  hasPatch: boolean;
}>;

export type CategoryCount = {
  category: LineCategory;
  added: number;
  deleted: number;
  files: number;
};

/** The stored artifact of one count. */
export type LineCount = Readonly<{
  counterVersion: string;
  coverage: LineCoverage;
  /** Added lines over counted files; complete only when coverage is. */
  added: number;
  deleted: number;
  countedFiles: number;
  excludedFiles: number;
  binaryFiles: number;
  /** One entry per category with at least one file, in category order. */
  categories: readonly CategoryCount[];
}>;

const LOCK_FILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "gemfile.lock",
  "composer.lock",
  "flake.lock",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "generated",
  "dist",
  "build",
  "__snapshots__",
]);
const EXCLUDED_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];
const DOC_SUFFIXES = [".md", ".mdx", ".rst", ".adoc", ".txt"];
const CONFIG_SUFFIXES = [
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".lock",
];
const TEST_PATTERN =
  /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$/;

/** The category a path falls in, or null when its lines are excluded. */
export function classify(path: string): LineCategory | null {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? lower;
  if (LOCK_FILES.has(name)) return null;
  if (segments.slice(0, -1).some((part) => EXCLUDED_DIRECTORIES.has(part))) {
    return null;
  }
  if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return null;
  if (TEST_PATTERN.test(lower)) return LineCategory.Test;
  if (
    segments[0] === "docs" || DOC_SUFFIXES.some((s) => name.endsWith(s))
  ) return LineCategory.Docs;
  if (
    (name.startsWith(".") && !name.includes(".", 1)) ||
    CONFIG_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    name === "dockerfile" || name === "makefile"
  ) return LineCategory.Config;
  return LineCategory.Source;
}

/**
 * Whether the provider could not give the file's lines. GitHub sends no patch
 * and zero totals for a binary file; a pure rename or a mode change also has
 * no patch, but its status says so and it really changed no line.
 */
function isBinary(file: DiffFile): boolean {
  if (file.hasPatch || file.additions !== 0 || file.deletions !== 0) {
    return false;
  }
  return file.status !== "renamed" && file.status !== "unchanged" &&
    file.status !== "changed";
}

const CATEGORY_ORDER: readonly LineCategory[] = [
  LineCategory.Source,
  LineCategory.Test,
  LineCategory.Docs,
  LineCategory.Config,
];

/**
 * Counts one pull request's diff. `expectedFiles` is the provider's own
 * changed-file total for the pull request, null when unknown; `listCut` says
 * the list stopped at the page cap with more to read. A list shorter than the
 * total, or cut, is truncated, whatever it held.
 */
export function countLines(
  files: readonly DiffFile[],
  input: { expectedFiles: number | null; listCut: boolean },
): LineCount {
  const byCategory = new Map<LineCategory, CategoryCount>();
  let excludedFiles = 0;
  let binaryFiles = 0;
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    const category = classify(file.filename);
    if (category === null) {
      excludedFiles += 1;
      continue;
    }
    if (isBinary(file)) {
      binaryFiles += 1;
      continue;
    }
    const entry = byCategory.get(category) ??
      { category, added: 0, deleted: 0, files: 0 };
    entry.added += file.additions;
    entry.deleted += file.deletions;
    entry.files += 1;
    byCategory.set(category, entry);
    added += file.additions;
    deleted += file.deletions;
  }
  const truncated = input.listCut ||
    (input.expectedFiles !== null && files.length < input.expectedFiles);
  const categories = CATEGORY_ORDER.flatMap((category) => {
    const entry = byCategory.get(category);
    return entry === undefined ? [] : [entry];
  });
  return {
    counterVersion: COUNTER_VERSION,
    coverage: truncated
      ? LineCoverage.Truncated
      : binaryFiles > 0
      ? LineCoverage.Binary
      : LineCoverage.Complete,
    added,
    deleted,
    countedFiles: categories.reduce((total, entry) => total + entry.files, 0),
    excludedFiles,
    binaryFiles,
    categories,
  };
}
