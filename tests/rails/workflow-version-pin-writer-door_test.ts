import { assert, assertEquals } from "@std/assert";
import { extname, join, relative } from "node:path";

/**
 * `bakery.workflow_versions.compiler_version` and `.semantic_digest` are the
 * compiler's pin for a published version and are set together or not at all.
 * The PostgreSQL responsibility boundary forbids a CHECK constraint, and the
 * application role may insert into the table, so the only enforcement is the
 * code path: `publishWorkflowVersion` runs `assertCompilerPinTogether` on the
 * exact values it inserts. Any other module that names either column in
 * application code would write a pin that guard never saw, so this rail fails
 * on such a writer. Adding one is a reviewed decision that edits this list.
 *
 * It is a guardrail against the accidental writer, not a proof: it reads source
 * text under `apps`, `packages` and `scripts` and does not see SQL assembled at
 * run time or a write that never spells the column name. The application
 * role's grants (`select, insert`, no update) are the database-side bound.
 */
const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);
const writerFile = "apps/server/src/modules/workflows/postgres.ts";
const guardFile = "apps/server/src/modules/workflows/validation.ts";
const pinColumns = /\b(?:compiler_version|semantic_digest)\b/;

function* walk(directory: string): Generator<string> {
  for (const entry of Deno.readDirSync(directory)) {
    if (entry.isDirectory) {
      if (!skipDirectories.has(entry.name) && entry.name !== "migrations") {
        yield* walk(join(directory, entry.name));
      }
    } else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      yield join(directory, entry.name);
    }
  }
}

const read = (relativePath: string) =>
  Deno.readTextFileSync(join(root, relativePath));

Deno.test("only the publish path names the workflow_versions pin columns", () => {
  const namers: string[] = [];
  for (const top of productionRoots) {
    for (const file of walk(join(root, top))) {
      if (pinColumns.test(Deno.readTextFileSync(file))) {
        namers.push(relative(root, file));
      }
    }
  }
  assertEquals(
    namers.sort(),
    [writerFile],
    "another module names a pin column; it would write a pin that " +
      "assertCompilerPinTogether never checked",
  );
});

Deno.test("the publish insert is preceded by the together guard on its own values", () => {
  const source = read(writerFile);
  const insertAt = source.indexOf("insert into bakery.workflow_versions");
  assert(insertAt > 0, "publishWorkflowVersion no longer inserts a version");
  const guardAt = source.indexOf("assertCompilerPinTogether(");
  assert(
    guardAt > 0,
    "the publish path does not call assertCompilerPinTogether",
  );
  assert(
    guardAt < insertAt,
    "assertCompilerPinTogether must run before the insert it protects",
  );
  const guardCall = source.slice(guardAt, source.indexOf(";", guardAt));
  assert(
    guardCall.includes("pinValues[0]") && guardCall.includes("pinValues[1]"),
    "the guard must check both values the insert binds",
  );
  assert(
    source.slice(insertAt, insertAt + 1500).includes("pinValues[0],") &&
      source.slice(insertAt, insertAt + 1500).includes("pinValues[1],"),
    "the insert must bind the same pinValues the guard checked",
  );
});

Deno.test("the guard lives with the pin it protects", () => {
  const source = read(guardFile);
  assert(source.includes("export function assertCompilerPinTogether("));
  assert(source.includes("export function compilerPinOf("));
});
