import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  BAKERY_MIGRATION_SOURCES,
} from "../../apps/server/src/migration-sources.ts";

const root = new URL("../..", import.meta.url).pathname;
const SERVER_PACKAGE = JSON.parse(
  await Deno.readTextFile(`${root}apps/server/package.json`),
) as { scripts: Record<string, string> };

/** Every `**\/migrations/**\/*.sql` file in the tree, as a repo-relative path. */
async function* sqlFiles(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* sqlFiles(path);
    } else if (entry.name.endsWith(".sql")) {
      yield path.slice(root.length).replaceAll("\\", "/");
    }
  }
}

/**
 * The directory a migration file belongs to, found by walking up to the closest
 * ancestor named `migrations` or `bakery`.
 *
 * Modules layer their migrations under `migrations/bakery/`, while the platform
 * source holds SQL directly in `migrations/`; both are registered roots, so the
 * answer is "the directory the registry would name", not a fixed depth.
 */
export function migrationDirectory(path: string): string | undefined {
  const match = /^(.+)\/[^/]+\.sql$/.exec(path);
  if (!match) return undefined;
  const parts = match[1]!.split("/");
  // Prefer the layer folder (`bakery`, `provider`) directly under `migrations`,
  // because that is the unit a source registers: the auth module registers
  // `migrations/bakery` and Better Auth registers `migrations/provider`, and
  // stopping at the bare `migrations` ancestor would merge two sources into one.
  for (let index = parts.length - 1; index > 0; index -= 1) {
    if (parts[index - 1] === "migrations" && parts[index] !== undefined) {
      return parts.slice(0, index + 1).join("/");
    }
  }
  const migrations = parts.lastIndexOf("migrations");
  return migrations === -1
    ? undefined
    : parts.slice(0, migrations + 1).join("/");
}

Deno.test("every bakery migration directory is registered (rail B3)", async () => {
  // The registry stores roots relative to apps/server (which is what Deno's
  // --allow-read wants); the walk yields repo-relative paths, so compare in the
  // same space.
  const registered = new Set(
    BAKERY_MIGRATION_SOURCES.map((source) =>
      "apps/server/" +
      new URL(source.root).pathname
        .slice(`${root}apps/server/`.length)
        .replace(/\/$/, "")
    ),
  );
  const unregistered = new Set<string>();
  const unaccountable: string[] = [];
  for await (const file of sqlFiles(join(root, "apps"))) {
    const directory = migrationDirectory(file);
    if (directory === undefined) {
      unaccountable.push(file);
      continue;
    }
    // Provider migrations belong to Better Auth and are registered separately.
    if (directory.includes("/auth/migrations/provider")) continue;
    // A registered root may be the directory itself or an ancestor of it: the
    // platform source grants `platform/migrations` while a module grants
    // `migrations/bakery`. Either way the file is read by a registered source.
    const covered = [...registered].some((entry) =>
      directory === entry || directory.startsWith(`${entry}/`)
    );
    if (!covered) unregistered.add(directory);
  }
  assertEquals(
    [...unregistered],
    [],
    "a migrations directory exists that BAKERY_MIGRATION_SOURCES does not list",
  );
  assertEquals(
    unaccountable,
    [],
    "a .sql file lives outside a migrations/<layer>/ directory",
  );
});

Deno.test("every registered source points at a directory that exists", async () => {
  for (const source of BAKERY_MIGRATION_SOURCES) {
    const path = new URL(source.root).pathname;
    const stat = await Deno.stat(path).catch(() => null);
    assert(stat?.isDirectory === true, `${path} is registered but absent`);
  }
});

Deno.test("a module is registered once and owns only bakery migrations", () => {
  const roots = BAKERY_MIGRATION_SOURCES.map((source) =>
    new URL(source.root).pathname
  );
  assertEquals(new Set(roots).size, roots.length);
  for (const source of BAKERY_MIGRATION_SOURCES) {
    assertEquals(source.owner, "bakery");
  }
});

Deno.test("the allow-read list in package.json agrees with the registry", () => {
  // This is the second copy of the same fact that rail B3 exists to remove. The
  // scripts still need a literal list because Deno takes flags, not imports, so
  // the rail holds the two equal instead of letting them drift.
  const registered = BAKERY_MIGRATION_SOURCES.map((source) => {
    const path = new URL(source.root).pathname;
    return path.slice(`${root}apps/server/`.length).replace(/\/$/, "");
  }).sort();
  for (const script of ["startup", "migrate"]) {
    const command = SERVER_PACKAGE.scripts[script];
    assert(command, `apps/server/package.json has no "${script}" script`);
    const flags = command
      .split(" ")
      .filter((part) => part.startsWith("--allow-read="))
      .flatMap((part) => part.slice("--allow-read=".length).split(","));
    const migrationFlags = flags
      .filter((flag) => flag.includes("/migrations"))
      .map((flag) => flag.replace(/\/$/, ""))
      .sort();
    // Deno needs a directory it may read; an ancestor of the registered root
    // grants everything inside it, which is why package.json names
    // `migrations` where the registry names `migrations/bakery`. The rule is
    // coverage in both directions, not string equality.
    for (const entry of registered) {
      assert(
        migrationFlags.some((flag) =>
          entry === flag || entry.startsWith(`${flag}/`)
        ),
        `the ${script} script cannot read ${entry}`,
      );
    }
    for (const flag of migrationFlags) {
      assert(
        registered.some((entry) =>
          entry === flag || entry.startsWith(`${flag}/`)
        ),
        `the ${script} script grants ${flag}, which covers no registered source`,
      );
    }
  }
});

Deno.test("no provider package ships SQL or a migration", async () => {
  // Section 12.1: provider packages are pure adapters. A migration in one would
  // put a table outside the core's ownership and outside this registry.
  for await (const file of sqlFiles(join(root, "packages"))) {
    if (file.startsWith("packages/integration-")) {
      assert(false, `a provider package contains SQL: ${file}`);
    }
  }
});

Deno.test("a provider package contains no data-changing statement", async () => {
  const statement = /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;
  for (
    const entry of await Array.fromAsync(Deno.readDir(join(root, "packages")))
  ) {
    if (!entry.isDirectory || !entry.name.startsWith("integration-")) continue;
    for await (const file of filesUnder(join(root, "packages", entry.name))) {
      const text = await Deno.readTextFile(file);
      assert(
        !statement.test(text),
        `${file} contains a data-changing statement; providers never write SQL`,
      );
    }
  }
});

async function* filesUnder(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules") continue;
      yield* filesUnder(path);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield path;
    }
  }
}
