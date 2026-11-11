import { assert, assertEquals } from "@std/assert";
import { extname, join, posix, relative } from "node:path";

/**
 * `bakery.review_cycles`, `bakery.review_findings` and
 * `bakery.delivery_decisions` are the evidence the delivery gate and the repair
 * loop trust (issue #94). The application database role may insert into them,
 * so the database cannot tell a verified row from a forged one: only the code
 * path decides. One module is allowed to write, `review-store.ts`, and its
 * callers hand it values the review finalizer derived from the job's own pins,
 * the stored session rows and the #83 check rows, never from a worker report.
 *
 * Any other module that writes the tables (a result handler, a route, a script)
 * would put a row in front of the gate that no verifier saw. This rail fails on
 * such a writer, so adding one is a reviewed decision that edits this list, not
 * an accident.
 *
 * It is a guardrail against the accidental writer, not a proof. It reads source
 * text of `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` files under `apps`,
 * `packages`, `ee` and `scripts`, so it does not see: SQL assembled at run time
 * (an interpolated table name, `join`, a helper that takes the statement text),
 * SQL in migrations or other file types, a write through a view, function or
 * differently named relation, a write that reaches a table through its parent
 * (`delete from bakery.workflow_runs` cascades to all three), or a writer
 * reached by a driver call that never spells the statement. It does tolerate a
 * statement split across lines, a string concatenation
 * (`"insert into " + "bakery.review_cycles"`) and an escaped line break inside
 * one literal. The application role's grants are the database-side bound:
 * `select, insert` only, no update or delete.
 *
 * The SQL scan cannot see a caller that hands the store's writers
 * (`insertReviewCycle`, `insertReviewFindings`, `insertDeliveryDecision`) values
 * nobody verified, so the writers are also kept behind the module. One case
 * fails when a file outside `apps/server/src/modules/delivery/` imports
 * `review-store.ts`, by a relative path or by a package or alias path that
 * ends in `modules/delivery/review-store`, with or without the extension; a
 * second case keeps the writers out of `delivery/index.ts`, the module's
 * public door. Inside the module only `finalize-review.ts` calls the writers;
 * the other module files are reviewed code, not scanned for it.
 *
 * The import scan is the same kind of guardrail, and it reads text too. It sees
 * a string literal after `from`, `import`, `import(` or `require(` (adjacent
 * literals joined, comments ignored, a statement split across lines). It does
 * not see: a specifier built at run time (a variable, a template with
 * `${...}`, `new URL(..., import.meta.url)`), an import map or package
 * `exports` entry that renames the file (`#store`), a `file:///` URL (the
 * comment stripper reads its `//` as a comment), a re-export that reaches the
 * store through another module file, a path written differently from the suffix
 * above, or a file type outside the extensions listed. A string that only
 * names the path outside an import is not flagged. Test files are exempt, as in
 * the SQL scan.
 */
const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "ee", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);
const writerFiles = new Set([
  "apps/server/src/modules/delivery/review-store.ts",
]);
const guardedTables = [
  "review_cycles",
  "review_findings",
  "delivery_decisions",
] as const;

/** Optional quoting and schema, then the table name. */
const table = (name: string) =>
  String.raw`(?:"?bakery"?\s*\.\s*)?"?${name}"?\b`;

function writePatterns(name: string): readonly RegExp[] {
  const target = table(name);
  return [
    new RegExp(String.raw`\binsert\s+into\s+${target}`, "gi"),
    new RegExp(String.raw`\bupdate\s+(?:only\s+)?${target}`, "gi"),
    new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${target}`, "gi"),
    new RegExp(String.raw`\bmerge\s+into\s+${target}`, "gi"),
    new RegExp(
      String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${target}`,
      "gi",
    ),
    new RegExp(String.raw`\bcopy\s+${target}`, "gi"),
  ];
}

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

/** Lines of `source` that write one of the guarded tables, as `path:line`. */
export function reviewTableWriteViolations(
  path: string,
  source: string,
  names: readonly string[] = guardedTables,
): string[] {
  const code = joinLiterals(stripComments(source));
  const lines = new Set<number>();
  for (const name of names) {
    for (const pattern of writePatterns(name)) {
      for (const match of code.matchAll(pattern)) {
        lines.add(code.slice(0, match.index).split("\n").length);
      }
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
 * Test code that lives inside a production root: the three packages that keep
 * their tests beside their sources, and any file named as a test. A directory
 * that merely contains `test` or `tests` in its name is production code.
 */
const TEST_ROOTS = ["apps/web/tests/", "packages/ui/tests/", "ee/tests/"];

export function isTestPath(path: string): boolean {
  return TEST_ROOTS.some((root) => path.startsWith(root)) ||
    /[._]test\.[cm]?[jt]sx?$/.test(path);
}

/** Production source files, repository-relative and absolute, test code left out. */
async function productionFiles(): Promise<
  { repositoryPath: string; path: string }[]
> {
  const files: { repositoryPath: string; path: string }[] = [];
  for (const directory of productionRoots) {
    // The community build deletes ee/, so an absent root has nothing to scan.
    if (!await Deno.stat(join(root, directory)).then(() => true, () => false)) {
      continue;
    }
    for (const path of await sourceFiles(join(root, directory))) {
      const repositoryPath = relative(root, path);
      if (!isTestPath(repositoryPath)) files.push({ repositoryPath, path });
    }
  }
  return files;
}

const storeFile = "apps/server/src/modules/delivery/review-store.ts";
const storeSuffix = "modules/delivery/review-store";
const moduleDirectory = "apps/server/src/modules/delivery/";

/** True for the delivery module's own files, the only allowed importers of the store. */
export function isDeliveryModulePath(path: string): boolean {
  return path.startsWith(moduleDirectory);
}

/** A string literal after `from`, `import`, `import(` or `require(`. */
const specifierPattern =
  /\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`\n]*)\1/g;

/** True when `specifier`, written in the file at `path`, names the store. */
function namesStore(path: string, specifier: string): boolean {
  const bare = specifier.replace(/\.[cm]?[jt]sx?$/, "");
  if (bare.startsWith("./") || bare.startsWith("../")) {
    return posix.join(posix.dirname(path), bare) ===
      storeFile.replace(/\.ts$/, "");
  }
  return bare === storeSuffix || bare.endsWith(`/${storeSuffix}`);
}

/**
 * Lines of `source` that import `review-store.ts`, as `path:line`, wherever
 * `path` is: the caller decides which files may.
 */
export function reviewStoreImportViolations(
  path: string,
  source: string,
): string[] {
  const code = joinLiterals(stripComments(source));
  const lines = new Set<number>();
  for (const match of code.matchAll(specifierPattern)) {
    if (namesStore(path, match[2])) {
      lines.add(code.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

Deno.test("only the review store writes the review and decision tables", async () => {
  const violations: string[] = [];
  let scanned = 0;
  for (const { repositoryPath, path } of await productionFiles()) {
    if (writerFiles.has(repositoryPath)) continue;
    scanned++;
    violations.push(
      ...reviewTableWriteViolations(
        repositoryPath,
        await Deno.readTextFile(path),
      ),
    );
  }
  assert(scanned > 0, "the rail scanned no production file");
  assertEquals(violations, []);
});

Deno.test("only the delivery module imports the review store", async () => {
  const violations: string[] = [];
  let scanned = 0;
  for (const { repositoryPath, path } of await productionFiles()) {
    if (isDeliveryModulePath(repositoryPath)) continue;
    scanned++;
    violations.push(
      ...reviewStoreImportViolations(
        repositoryPath,
        await Deno.readTextFile(path),
      ),
    );
  }
  assert(scanned > 0, "the rail scanned no production file");
  assertEquals(violations, []);
});

Deno.test("the module index keeps the store writers private to the delivery module", async () => {
  // The import scan exempts the module's own files, and `index.ts` is one of
  // them, so a re-export of a writer there would let any caller reach it by the
  // module path. The writers stay out of the index: only `finalize-review.ts`
  // imports them, from `review-store.ts`, with values the finalizer derived.
  const index = await Deno.readTextFile(
    join(root, "apps/server/src/modules/delivery/index.ts"),
  );
  for (
    const writer of [
      "insertReviewCycle",
      "insertReviewFindings",
      "insertDeliveryDecision",
    ]
  ) assert(!index.includes(writer), `index.ts re-exports ${writer}`);
});

Deno.test("the allowed writer still inserts into each guarded table", async () => {
  for (const path of writerFiles) {
    const source = await Deno.readTextFile(join(root, path));
    for (const name of guardedTables) {
      assert(
        reviewTableWriteViolations(path, source, [name]).length > 0,
        `${path} no longer writes ${name}; remove it from the guarded list`,
      );
    }
  }
});

Deno.test("only real test code is exempt from the scan", () => {
  for (
    const path of [
      "apps/web/tests/helpers/seed.ts",
      "packages/ui/tests/a.test.ts",
      "ee/tests/integration/x.ts",
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
      "apps/server/src/modules/delivery/candidate.ts",
    ]
  ) assert(!isTestPath(path), path);
});

Deno.test("the detector sees a write split across lines, concatenated or escaped", () => {
  const writes = [
    'q("insert into " + "bakery.review_cycles (id) values ($1)")',
    "q(`insert into ` +\n  'bakery.review_findings (id) values ($1)')",
    "q('insert into ' +\n    \"bakery\" + '.delivery_decisions (id) values ($1)')",
    'q("update\\nbakery.review_cycles set status = 1")',
    'q("delete from " +\n  "bakery." + "review_findings where true")',
  ];
  for (const source of writes) {
    assertEquals(
      reviewTableWriteViolations("x.ts", source).length,
      1,
      source,
    );
  }
  // Line numbers survive the joining.
  assertEquals(
    reviewTableWriteViolations(
      "x.ts",
      'const a = 1;\nconst b = "insert into " +\n  "bakery.delivery_decisions (id)";\n',
    ),
    ["x.ts:2"],
  );
  // Joining literals must not invent a write out of unrelated strings.
  assertEquals(
    reviewTableWriteViolations(
      "x.ts",
      'q("select 1 from " + "bakery.review_cycles"); q("insert into " + "other")',
    ),
    [],
  );
});

Deno.test("the detector flags every write form on every guarded table and ignores reads and comments", () => {
  for (const name of guardedTables) {
    const flagged = [
      `insert into bakery.${name} (id) values ($1)`,
      `INSERT INTO "bakery"."${name}" (id) values ($1)`,
      `insert\n  into ${name} (id) values ($1)`,
      `update bakery.${name} set status = 'x'`,
      `update only bakery.${name} set status = 'x'`,
      `delete from bakery.${name} where id = $1`,
      `merge into bakery.${name} using x on true`,
      `truncate table bakery.${name}`,
      `copy bakery.${name} from stdin`,
    ];
    for (const sql of flagged) {
      assertEquals(
        reviewTableWriteViolations("x.ts", `await q(\`${sql}\`);`).length,
        1,
        sql,
      );
    }
    const clean = [
      `select * from bakery.${name} where run_id = $1`,
      `select id from bakery.${name}_archive`,
      `insert into bakery.${name}_archive (id) values ($1)`,
      `// insert into bakery.${name} (id) values ($1)`,
      `/* update bakery.${name} set status = 'x' */`,
      `const line = 1; // delete from bakery.${name}`,
    ];
    for (const source of clean) {
      assertEquals(reviewTableWriteViolations("x.ts", source), [], source);
    }
  }
});

Deno.test("the import detector flags every way to name the store from outside the module", () => {
  const outside = "apps/server/src/modules/work/x.ts";
  const flagged = [
    'import { insertReviewCycle } from "../delivery/review-store.ts";',
    "import { insertReviewCycle } from '../delivery/review-store.ts';",
    "import { insertReviewCycle } from `../delivery/review-store.ts`;",
    'import { insertReviewCycle } from "../delivery/review-store";',
    'import { insertReviewCycle } from "../delivery/review-store.js";',
    'import type { ReviewCycleRow } from "../delivery/review-store.ts";',
    'import * as store from "../delivery/review-store.ts";',
    'import "../delivery/review-store.ts";',
    'export * from "../delivery/review-store.ts";',
    'export { insertDeliveryDecision } from "../delivery/review-store.ts";',
    'const store = await import("../delivery/review-store.ts");',
    'const store = require("../delivery/review-store.ts");',
    'import {\n  insertReviewFindings,\n} from\n  "../delivery/review-store.ts";',
    'import("../delivery/review-" + "store.ts");',
    'import { a } from "../../../../../apps/server/src/modules/delivery/review-store.ts";',
    'import { a } from "@bakery/server/src/modules/delivery/review-store.ts";',
    'import { a } from "@bakery/server/src/modules/delivery/review-store";',
    'import { a } from "apps/server/src/modules/delivery/review-store.ts";',
  ];
  for (const source of flagged) {
    assertEquals(
      reviewStoreImportViolations(outside, source).length,
      1,
      source,
    );
  }
  // The same specifier counts from any depth and any root, not only the server.
  assertEquals(
    reviewStoreImportViolations(
      "packages/persistence/src/a.ts",
      'import { a } from "../../../apps/server/src/modules/delivery/review-store.ts";',
    ),
    ["packages/persistence/src/a.ts:1"],
  );
  assertEquals(
    reviewStoreImportViolations(
      "apps/server/src/app.ts",
      'import { a } from "./modules/delivery/review-store.ts";',
    ),
    ["apps/server/src/app.ts:1"],
  );
  // Line numbers survive the joining and the comment stripping.
  assertEquals(
    reviewStoreImportViolations(
      outside,
      '// from "../delivery/review-store.ts"\nconst a = 1;\nimport {\n  b,\n} from\n  "../delivery/review-store.ts";\n',
    ),
    [`${outside}:5`],
  );
});

Deno.test("the import detector ignores other files, comments and bare mentions", () => {
  const outside = "apps/server/src/modules/work/x.ts";
  const clean = [
    'import { a } from "../delivery/index.ts";',
    'import { a } from "../delivery/review-store-archive.ts";',
    'import { a } from "../delivery/review-stores.ts";',
    'import { a } from "../delivery/not-review-store.ts";',
    'import { a } from "../delivery/review-store.sql";',
    'import { a } from "../delivery/review-store/index.ts";',
    'import { a } from "./review-store.ts";',
    'import { a } from "../projects/review-store.ts";',
    'import { a } from "@bakery/server/src/modules/work/review-store.ts";',
    'import { a } from "@bakery/server/src/modules/delivery/review-store-x.ts";',
    'import { a } from "review-store";',
    '// import { a } from "../delivery/review-store.ts";',
    '/* import("../delivery/review-store.ts") */',
    'const path = "../delivery/review-store.ts";',
    'log("import from ../delivery/review-store.ts")',
  ];
  for (const source of clean) {
    assertEquals(reviewStoreImportViolations(outside, source), [], source);
  }
});

Deno.test("only the delivery module's own files are exempt from the import scan", () => {
  for (
    const path of [
      "apps/server/src/modules/delivery/finalize-review.ts",
      "apps/server/src/modules/delivery/index.ts",
      "apps/server/src/modules/delivery/review-store.ts",
    ]
  ) assert(isDeliveryModulePath(path), path);
  for (
    const path of [
      "apps/server/src/modules/delivery-extra/x.ts",
      "apps/server/src/modules/work/delivery/x.ts",
      "apps/server/src/modules/work/x.ts",
      "apps/server/src/app.ts",
      "packages/persistence/src/repository-admission.ts",
    ]
  ) assert(!isDeliveryModulePath(path), path);
});

Deno.test("the import detector still sees the finalizer import the store", async () => {
  // The scan above is only worth its pass if the detector reads the real
  // import: the allowed caller must still be found, at the store's own path.
  const path = "apps/server/src/modules/delivery/finalize-review.ts";
  const source = await Deno.readTextFile(join(root, path));
  assert(
    reviewStoreImportViolations(path, source).length > 0,
    `${path} no longer imports ${storeFile}; update the rail`,
  );
  assert(
    await Deno.stat(join(root, storeFile)).then(() => true, () => false),
    `${storeFile} moved; update the rail`,
  );
});
