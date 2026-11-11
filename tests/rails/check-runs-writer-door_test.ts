import { assert, assertEquals } from "@std/assert";
import { extname, join, relative } from "node:path";

/**
 * `bakery.check_runs` is the evidence the delivery gate trusts. The
 * application database role may insert into it, so the database cannot tell a
 * verified row from a forged one: only the code path decides. Two paths are
 * allowed to write, and each derives the row's identities itself:
 *
 * - the `quality.check` finalizer, which recomputes every identity and the
 *   verdict from the job's admission pins and rejects a worker report that
 *   disagrees before it inserts anything;
 * - the metadata recorder, which stores what the pure rule validators judged
 *   from a trusted snapshot.
 *
 * Any other module that writes the table (a harness result handler, a route, a
 * script) would put a row in front of the gate that no verifier saw. This rail
 * fails on such a writer, so adding one is a reviewed decision that edits this
 * list, not an accident.
 *
 * It is a guardrail against the accidental writer, not a proof. It reads
 * source text of `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` files under `apps`,
 * `packages`, `ee` and `scripts`, so it does not see: SQL assembled at run
 * time (an interpolated table name, `join`, a helper that takes the statement
 * text), SQL in migrations or other file types, a write through a view,
 * function or differently named relation, or a writer reached by a driver call
 * that never spells the statement. It does tolerate a statement split across
 * lines, a string concatenation (`"insert into " + "bakery.check_runs"`) and an
 * escaped line break inside one literal. The application role's grants are the
 * database-side bound: `select, insert` only, no update or delete.
 */
const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);
const writerFiles = new Set([
  "apps/server/src/modules/delivery/finalize-quality-check.ts",
  "apps/server/src/modules/delivery/metadata-checks.ts",
]);

/** Optional quoting and schema, then the table name. */
const TABLE = String.raw`(?:"?bakery"?\s*\.\s*)?"?check_runs"?\b`;
const writePatterns: readonly RegExp[] = [
  new RegExp(String.raw`\binsert\s+into\s+${TABLE}`, "gi"),
  new RegExp(String.raw`\bupdate\s+(?:only\s+)?${TABLE}`, "gi"),
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${TABLE}`, "gi"),
  new RegExp(String.raw`\bmerge\s+into\s+${TABLE}`, "gi"),
  new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${TABLE}`, "gi"),
  new RegExp(String.raw`\bcopy\s+${TABLE}`, "gi"),
];

/**
 * Source text as SQL would read it: adjacent string literals joined, whichever
 * quotes they use, and an escaped line break or tab turned into a space. Line
 * breaks are kept so reported line numbers stay right.
 */
function joinLiterals(code: string): string {
  return code
    .replace(/["'`]\s*\+\s*["'`]/g, (match) => match.replace(/[^\n]/g, ""))
    .replace(/\\[nrt]/g, " ");
}

function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(
    /(^|[^:])\/\/[^\n]*/g,
    (match, lead: string) => lead + blank(match.slice(lead.length)),
  );
}

/** Lines of `source` that write `check_runs`, as `path:line`. */
export function checkRunsWriteViolations(
  path: string,
  source: string,
): string[] {
  const code = joinLiterals(stripComments(source));
  const lines = new Set<number>();
  for (const pattern of writePatterns) {
    for (const match of code.matchAll(pattern)) {
      lines.add(code.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (!skipDirectories.has(entry.name)) {
        files.push(...await sourceFiles(path));
      }
    } else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Test code that lives inside a production root: the two packages that keep
 * their tests beside their sources, and any file named as a test. A directory
 * that merely contains `test` or `tests` in its name is production code.
 */
const TEST_ROOTS = ["apps/web/tests/", "packages/ui/tests/"];

export function isTestPath(path: string): boolean {
  return TEST_ROOTS.some((root) => path.startsWith(root)) ||
    /[._]test\.[cm]?[jt]sx?$/.test(path);
}

Deno.test("only the finalizer and the metadata recorder write check_runs", async () => {
  const violations: string[] = [];
  let scanned = 0;
  for (const directory of productionRoots) {
    for (const path of await sourceFiles(join(root, directory))) {
      const repositoryPath = relative(root, path);
      if (isTestPath(repositoryPath) || writerFiles.has(repositoryPath)) {
        continue;
      }
      scanned++;
      violations.push(
        ...checkRunsWriteViolations(
          repositoryPath,
          await Deno.readTextFile(path),
        ),
      );
    }
  }
  assert(scanned > 0, "the rail scanned no production file");
  assertEquals(violations, []);
});

Deno.test("each allowed writer still inserts into check_runs", async () => {
  for (const path of writerFiles) {
    const source = await Deno.readTextFile(join(root, path));
    assert(
      checkRunsWriteViolations(path, source).length > 0,
      `${path} no longer writes check_runs; remove it from the allowed list`,
    );
  }
});

Deno.test("only real test code is exempt from the scan", () => {
  for (
    const path of [
      "apps/web/tests/helpers/seed.ts",
      "packages/ui/tests/a.test.ts",
      "apps/server/src/modules/x/y_test.ts",
      "scripts/z.test.mjs",
    ]
  ) assert(isTestPath(path), path);
  for (
    const path of [
      "apps/server/src/test/writer.ts",
      "apps/server/src/modules/tests/writer.ts",
      "packages/persistence/src/__tests__/writer.ts",
      "scripts/tests/writer.ts",
      "apps/server/src/modules/delivery/latest.ts",
    ]
  ) assert(!isTestPath(path), path);
});

Deno.test("the detector sees a write split across lines, concatenated or escaped", () => {
  const writes = [
    'q("insert into " + "bakery.check_runs (id) values ($1)")',
    "q(`insert into ` +\n  'bakery.check_runs (id) values ($1)')",
    "q('insert into ' +\n    \"bakery\" + '.check_runs (id) values ($1)')",
    'q("update\\nbakery.check_runs set result = 1")',
    'q("delete from " +\n  "bakery." + "check_runs where true")',
  ];
  for (const source of writes) {
    assertEquals(checkRunsWriteViolations("x.ts", source).length, 1, source);
  }
  // Line numbers survive the joining.
  assertEquals(
    checkRunsWriteViolations(
      "x.ts",
      'const a = 1;\nconst b = "insert into " +\n  "bakery.check_runs (id)";\n',
    ),
    ["x.ts:2"],
  );
  // Joining literals must not invent a write out of unrelated strings.
  assertEquals(
    checkRunsWriteViolations(
      "x.ts",
      'q("select 1 from " + "bakery.check_runs"); q("insert into " + "other")',
    ),
    [],
  );
});

Deno.test("the detector flags every write form and ignores reads and comments", () => {
  const flagged = [
    "insert into bakery.check_runs (id) values ($1)",
    'INSERT INTO "bakery"."check_runs" (id) values ($1)',
    "insert\n  into check_runs (id) values ($1)",
    "update bakery.check_runs set result = 'passed'",
    "update only bakery.check_runs set result = 'passed'",
    "delete from bakery.check_runs where id = $1",
    "merge into bakery.check_runs using x on true",
    "truncate table bakery.check_runs",
    "copy bakery.check_runs from stdin",
  ];
  for (const sql of flagged) {
    assertEquals(
      checkRunsWriteViolations("x.ts", `await q(\`${sql}\`);`).length,
      1,
      sql,
    );
  }
  const clean = [
    "select * from bakery.check_runs where run_id = $1",
    "select id from bakery.check_runs_archive",
    "insert into bakery.check_runs_archive (id) values ($1)",
    "// insert into bakery.check_runs (id) values ($1)",
    "/* update bakery.check_runs set result = 'passed' */",
    "const line = 1; // delete from bakery.check_runs",
  ];
  for (const source of clean) {
    assertEquals(checkRunsWriteViolations("x.ts", source), [], source);
  }
});
