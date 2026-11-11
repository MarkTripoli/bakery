import { assert, assertEquals } from "@std/assert";
import { existsSync } from "node:fs";
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
 * text under `apps`, `packages` and `scripts` (TypeScript data migrations under
 * `migrations/data` included; `.sql` migrations are not source files it reads) and
 * does not see SQL assembled at run time or a write that never spells the column
 * name. The application
 * role's grants (`select, insert`, no update) are the database-side bound.
 */
const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);
const writerFile = "apps/server/src/modules/workflows/postgres.ts";
const guardFile = "apps/server/src/modules/workflows/validation.ts";
const pinColumns = /\b(?:compiler_version|semantic_digest)\b/;

/**
 * The file view the scan reads through. The rails lane has no write
 * permission, so a test that needs a planted file cannot create one on disk;
 * it supplies an in-memory view and the walk and skip logic run unchanged.
 */
type FileView = Readonly<{
  entries: (
    directory: string,
  ) => readonly { name: string; isDirectory: boolean; isFile: boolean }[];
  text: (path: string) => string;
  exists: (path: string) => boolean;
}>;

const diskView: FileView = {
  entries: (directory) => [...Deno.readDirSync(directory)],
  text: (path) => Deno.readTextFileSync(path),
  exists: (path) => existsSync(path),
};

function* walk(directory: string, view: FileView): Generator<string> {
  for (const entry of view.entries(directory)) {
    if (entry.isDirectory) {
      if (!skipDirectories.has(entry.name)) {
        yield* walk(join(directory, entry.name), view);
      }
    } else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      yield join(directory, entry.name);
    }
  }
}

const read = (relativePath: string) =>
  Deno.readTextFileSync(join(root, relativePath));

/** Every source file under `base`'s production roots that names a pin column. */
function pinNamers(base: string, view: FileView = diskView): string[] {
  const namers: string[] = [];
  for (const top of productionRoots) {
    const start = join(base, top);
    if (!view.exists(start)) continue;
    for (const file of walk(start, view)) {
      if (pinColumns.test(view.text(file))) {
        namers.push(relative(base, file));
      }
    }
  }
  return namers.sort();
}

/** An in-memory tree: path (relative to `/repo`) -> file text. */
function memoryView(files: Readonly<Record<string, string>>): FileView {
  const paths = Object.keys(files).map((path) => join("/repo", path));
  const children = (directory: string) => {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    const names = new Map<string, boolean>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [first, ...tail] = rest.split("/");
      names.set(first, names.get(first) === true || tail.length > 0);
    }
    return [...names].map(([name, isDirectory]) => ({
      name,
      isDirectory,
      isFile: !isDirectory,
    }));
  };
  return {
    entries: children,
    text: (path) => files[relative("/repo", path)] ?? "",
    exists: (path) => children(path).length > 0,
  };
}

Deno.test("only the publish path names the workflow_versions pin columns", () => {
  assertEquals(
    pinNamers(root),
    [writerFile],
    "another module names a pin column; it would write a pin that " +
      "assertCompilerPinTogether never checked",
  );
});

Deno.test("a TypeScript data migration that names a pin column is found, and a SQL migration is not", () => {
  // The database migrations that add the columns are SQL, which the scan never
  // reads. A TypeScript data migration is application code that runs against
  // the table, so it must not escape the rail by living under `migrations`.
  const data =
    "apps/server/src/modules/auth/migrations/data/0999_pin_backfill.ts";
  const bakery = "apps/server/src/modules/work/migrations/bakery/0999_pin.ts";
  const view = memoryView({
    [data]:
      "await sql`update bakery.workflow_versions set compiler_version = ${v}`;",
    [bakery]: "export const column = 'semantic_digest';",
    "apps/server/src/modules/work/migrations/bakery/0998_pin.sql":
      "alter table bakery.workflow_versions add column compiler_version text;",
    "apps/server/src/modules/work/clean.ts": "export const x = 1;",
    "apps/server/node_modules/pkg/index.ts": "const c = 'compiler_version';",
  });
  assertEquals(pinNamers("/repo", view), [bakery, data].sort());
});

Deno.test("the in-memory view agrees with the disk view on the real tree", () => {
  // Guards the test double: if memoryView drifted from Deno.readDirSync, the
  // planted-file test above would stop meaning anything.
  const real = [...walk(join(root, "packages", "integration-sdk"), diskView)]
    .map((path) => relative(root, path))
    .sort();
  const files: Record<string, string> = {};
  for (const path of real) {
    files[path] = Deno.readTextFileSync(join(root, path));
  }
  const mirrored = [
    ...walk("/repo/packages/integration-sdk", memoryView(files)),
  ]
    .map((path) => relative("/repo", path))
    .sort();
  assertEquals(mirrored, real);
});

Deno.test("the one insert is guarded first, on the values it then binds", () => {
  const source = read(writerFile);
  assertEquals(
    source.split("insert into bakery.workflow_versions").length - 1,
    1,
    "workflows/postgres.ts must hold exactly one workflow_versions insert",
  );
  const fn = source.indexOf("export async function insertWorkflowVersion(");
  assert(fn > 0, "insertWorkflowVersion is gone; the write path moved");
  const body = source.slice(fn, source.indexOf("const PUBLISH_ISSUE_MAX", fn));
  const guardAt = body.indexOf(
    "assertCompilerPinTogether(row.compilerVersion, row.semanticDigest)",
  );
  const insertAt = body.indexOf("insert into bakery.workflow_versions");
  assert(guardAt > 0, "insertWorkflowVersion does not guard both pin values");
  assert(
    guardAt < insertAt,
    "assertCompilerPinTogether must run before the insert it protects",
  );
  const bound = body.slice(insertAt);
  assert(
    bound.includes("row.compilerVersion,") &&
      bound.includes("row.semanticDigest,"),
    "the insert must bind the same two values the guard checked",
  );
});

Deno.test("publishWorkflowVersion writes through that helper, not around it", () => {
  const source = read(writerFile);
  assert(
    source.includes("await insertWorkflowVersion(transaction, {"),
    "the publish path no longer calls insertWorkflowVersion",
  );
});

Deno.test("the guard lives with the pin it protects", () => {
  const source = read(guardFile);
  assert(source.includes("export function assertCompilerPinTogether("));
  assert(source.includes("export function compilerPinOf("));
});
