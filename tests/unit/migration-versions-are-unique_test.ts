import { assert, assertEquals } from "@std/assert";

/**
 * The migration runner sorts every module's migrations together and refuses a
 * repeated version with `DATA_MIGRATION_NAME_INVALID` (data-migrate.ts). Two
 * branches that each take "the next number" can therefore both be green on
 * their own and only fail once both are merged, which is a merge-time failure
 * in the one place nobody is running SQL.
 *
 * This walks the tree the same way the runner does, so the collision surfaces
 * in a normal unit lane instead.
 */
const MODULES = new URL("../../apps/server/src/modules/", import.meta.url);

async function migrationVersions(): Promise<
  { version: string; path: string }[]
> {
  const found: { version: string; path: string }[] = [];
  for await (const module of Deno.readDir(MODULES)) {
    if (!module.isDirectory) continue;
    const bakery = new URL(`${module.name}/migrations/bakery/`, MODULES);
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(bakery)) entries.push(entry);
    } catch {
      continue; // this module keeps no baked migrations
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
      found.push({ version: entry.name, path: `${module.name}/${entry.name}` });
    }
  }
  return found;
}

Deno.test("no two modules claim the same migration version", async () => {
  const versions = await migrationVersions();
  assert(
    versions.length > 100,
    `expected the baked migration set, found ${versions.length}`,
  );

  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const { version, path } of versions) {
    const prefix = version.slice(0, 4);
    const owner = seen.get(prefix);
    if (owner === undefined) {
      seen.set(prefix, path);
    } else {
      collisions.push(`${prefix}: ${owner} and ${path}`);
    }
  }
  assertEquals(
    collisions,
    [],
    "two branches took the same migration number; the runner rejects the " +
      "merged tree with DATA_MIGRATION_NAME_INVALID",
  );
});

Deno.test("a migration file name matches the runner's accepted shape", async () => {
  // The same expression the runner applies before it will execute a file.
  const accepted = /^\d{4}_[a-z0-9_]+$/;
  const rejected = (await migrationVersions())
    .map(({ version }) => version.replace(/\.sql$/, ""))
    .filter((version) => !accepted.test(version));
  assertEquals(rejected, []);
});

Deno.test("the notifications migration sorts after every migration it follows", async () => {
  // Lexicographic on the version prefix is how the runner orders the set, so a
  // renumber has to keep the file where it was or the inbox table would be
  // created before the tables its foreign keys name.
  const versions = (await migrationVersions())
    .map(({ version }) => version.replace(/\.sql$/, ""))
    .sort((left, right) => left.localeCompare(right));
  const notifications = versions.findIndex((version) =>
    version.endsWith("_notifications")
  );
  assert(notifications > 0, "the notifications migration is missing");
  assert(
    versions[notifications] > "0171",
    "notifications must follow the artifact-kinds migration it merges after",
  );
});
