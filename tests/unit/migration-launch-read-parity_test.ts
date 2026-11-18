import { assert, assertEquals } from "@std/assert";

/**
 * The migration runner reads every registered module's migration directory,
 * and Deno allows a read only for a path a launch explicitly named. That makes
 * the same list exist twice: `apps/server/package.json` for a plain
 * `pnpm migrate`, and `infra/compose.yaml` for the containerized stack. #549
 * added the `artifact-kinds` module to the first and not the second, so every
 * fresh worktree stack died on `NotCapable: Requires read access to
 * .../artifact-kinds/migrations/bakery` while a host-run migrate was fine.
 *
 * This walks the tree the way the runner does and requires both launch paths to
 * name every module that actually holds baked migrations, so the next module
 * added cannot leave one launch path unreadable.
 */
const REPO = new URL("../../", import.meta.url);
const MODULES = new URL("apps/server/src/modules/", REPO);
const PACKAGE_JSON = new URL("apps/server/package.json", REPO);
const COMPOSE = new URL("infra/compose.yaml", REPO);

/** Modules that keep a `migrations/bakery/` directory, in tree order. */
async function modulesWithBakedMigrations(): Promise<string[]> {
  const found: string[] = [];
  for await (const module of Deno.readDir(MODULES)) {
    if (!module.isDirectory) continue;
    const bakery = new URL(`${module.name}/migrations/bakery/`, MODULES);
    let sawFile = false;
    try {
      for await (const entry of Deno.readDir(bakery)) {
        if (entry.isFile && entry.name.endsWith(".sql")) sawFile = true;
      }
    } catch {
      continue; // this module keeps no baked migrations
    }
    if (sawFile) found.push(module.name);
  }
  return found;
}

/**
 * The `--allow-read=` path list in a launch command, split into entries. Both
 * the package script and the compose service spell the same relative paths.
 */
function allowReadEntries(command: string): string[] {
  const match = command.match(/--allow-read=([^\s"']+)/);
  assert(match, `no --allow-read= list in: ${command.slice(0, 120)}`);
  return match[1].split(",").filter(Boolean);
}

/**
 * Every module whose migration directory a launch path must be allowed to read.
 *
 * The two launches run from different working directories: the package script
 * from `apps/server`, the compose service from the repository root. So the same
 * directory is spelled `src/modules/x/migrations` in one and
 * `apps/server/src/modules/x/migrations` in the other; each caller passes the
 * prefix its own launch uses.
 */
function expectedEntries(modules: string[], prefix: string): string[] {
  return modules.map((name) => `${prefix}modules/${name}/migrations`);
}

Deno.test("every launch path may read every baked migration directory", async () => {
  const modules = await modulesWithBakedMigrations();
  assert(modules.length > 0, "found no baked migration directories");
  const subject = modules.join(", ");

  const pkg = JSON.parse(await Deno.readTextFile(PACKAGE_JSON));
  assert(
    typeof pkg.scripts?.migrate === "string",
    "apps/server/package.json has no migrate script",
  );
  const fromPackage = allowReadEntries(pkg.scripts.migrate);
  for (const entry of expectedEntries(modules, "src/")) {
    assert(
      fromPackage.includes(entry),
      `package.json migrate cannot read ${entry} (modules: ${subject})`,
    );
  }

  const compose = await Deno.readTextFile(COMPOSE);
  const migrateService = compose.slice(compose.indexOf("\n  migrate:"));
  assert(
    migrateService.length > 0,
    "infra/compose.yaml has no migrate service",
  );
  const fromCompose = allowReadEntries(migrateService);
  for (const entry of expectedEntries(modules, "apps/server/src/")) {
    assert(
      fromCompose.includes(entry),
      `infra/compose.yaml migrate cannot read ${entry} (modules: ${subject})`,
    );
  }

  // The two launches drive the same runner; a module one can read and the other
  // cannot is the exact drift this test exists to catch. Compare the module
  // names, since the two spell the shared prefix differently.
  const moduleOf = (entry: string) =>
    entry.replace(/^(?:apps\/server\/)?src\//, "").replace(
      /\/migrations$/,
      "",
    );
  assertEquals(
    fromCompose.map(moduleOf).sort(),
    fromPackage.map(moduleOf).sort(),
    "compose and package.json disagree about which migration directories are readable",
  );
});
