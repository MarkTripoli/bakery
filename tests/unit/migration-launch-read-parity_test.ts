import { assert, assertEquals } from "@std/assert";
import { BAKERY_MIGRATION_SOURCES } from "../../apps/server/src/migration-sources.ts";

/**
 * The migration runner reads every registered module's migration directory,
 * and Deno allows a read only for a path a launch explicitly named. That makes
 * the same list exist twice: `apps/server/package.json` for a plain
 * `pnpm migrate`, and `infra/compose.yaml` for the containerized stack. #549
 * added the `artifact-kinds` module to the first and not the second, so every
 * fresh worktree stack died on `NotCapable: Requires read access to
 * .../artifact-kinds/migrations/bakery` while a host-run migrate was fine.
 *
 * The set of directories is not guessed here: `BAKERY_MIGRATION_SOURCES` is the
 * registry the runner itself loads (`tasks.ts`), and `tests/rails/
 * migration-sources-registry_test.ts` proves it covers every directory on disk.
 * So this test asks one question only — do both launch paths name every root the
 * registry declares? — and cannot drift from the runner.
 *
 * Deriving the set from the tree instead was the earlier mistake: the platform
 * source roots at `platform/migrations` (its first migration creates the
 * pgcrypto extension) while modules root at `migrations/bakery`, so a walk of
 * `modules/&#42;/migrations/bakery/` skipped the platform bootstrap entirely and
 * would report agreement while `pnpm migrate` could not read it.
 */
const REPO = new URL("../../", import.meta.url);
const PACKAGE_JSON = new URL("apps/server/package.json", REPO);
const COMPOSE = new URL("infra/compose.yaml", REPO);

/**
 * Every registered root, relative to `apps/server` and with the layer folder
 * dropped.
 *
 * The registry roots at the layer (`migrations/bakery`, or `migrations` for the
 * platform source, which has no layer). A launch grants a directory and Deno
 * allows a read anywhere beneath it, so the grant that covers a root names its
 * `migrations` ancestor — `src/modules/auth/migrations` covers
 * `src/modules/auth/migrations/bakery`. Comparing at the `migrations` directory
 * is therefore the question the runner actually needs answered.
 */
function registeredRoots(): string[] {
  const serverPrefix = new URL("apps/server/", REPO).pathname;
  const roots = BAKERY_MIGRATION_SOURCES.map((source) => {
    const path = new URL(source.root).pathname.slice(serverPrefix.length)
      .replace(/\/$/, "");
    const at = path.lastIndexOf("/migrations");
    return at === -1 ? path : path.slice(0, at + "/migrations".length);
  });
  return [...new Set(roots)].sort();
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
 * directory is spelled `src/platform/migrations` in one and
 * `apps/server/src/platform/migrations` in the other; each caller passes the
 * prefix its own launch uses.
 */
function expectedEntries(roots: string[], prefix: string): string[] {
  return roots.map((root) => `${prefix}${root}`);
}

Deno.test("every launch path may read every registered migration root", async () => {
  const roots = registeredRoots();
  assert(roots.length > 0, "BAKERY_MIGRATION_SOURCES is empty");
  const subject = roots.join(", ");

  const pkg = JSON.parse(await Deno.readTextFile(PACKAGE_JSON));
  assert(
    typeof pkg.scripts?.migrate === "string",
    "apps/server/package.json has no migrate script",
  );
  const fromPackage = allowReadEntries(pkg.scripts.migrate);
  for (const entry of expectedEntries(roots, "")) {
    assert(
      fromPackage.includes(entry),
      `package.json migrate cannot read ${entry} (registered: ${subject})`,
    );
  }

  const compose = await Deno.readTextFile(COMPOSE);
  const migrateService = compose.slice(compose.indexOf("\n  migrate:"));
  assert(
    migrateService.length > 0,
    "infra/compose.yaml has no migrate service",
  );
  const fromCompose = allowReadEntries(migrateService);
  for (const entry of expectedEntries(roots, "apps/server/")) {
    assert(
      fromCompose.includes(entry),
      `infra/compose.yaml migrate cannot read ${entry} (registered: ${subject})`,
    );
  }

  // The two launches drive the same runner; a root one can read and the other
  // cannot is the exact drift this test exists to catch. Compare in the space
  // both were asserted against above, dropping each launch's own prefix.
  const rootOf = (entry: string) =>
    entry.replace(/^(?:apps\/server\/)?src\//, "");
  assertEquals(
    fromCompose.map(rootOf).sort(),
    fromPackage.map(rootOf).sort(),
    "compose and package.json disagree about which migration directories are readable",
  );
});
