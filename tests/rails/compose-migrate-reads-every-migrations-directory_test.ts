import { assert } from "@std/assert";

// Every entry point that runs `apps/server/src/tasks.ts migrate` (or boots the
// server, which migrates first) does so under an explicit `--allow-read` list
// of migration directories. That list is the only thing that lets the runner
// enumerate them, and every copy is maintained by hand.
//
// It has gone stale twice: `apps/server/src/modules/artifact-kinds/migrations`
// was missing from the compose migrate service, so every local stack died in the
// migrate container with `NotCapable: Requires read access to
// .../artifact-kinds/migrations` before the server could start; later the same
// directory and `mcp` were still missing from the deploy script, the browser
// and e2e harnesses, and the 0049 data-migration test, each of which spawns its
// own migrate process. Nothing caught it, because the unit and rails lanes run
// migrations in-process with the lane's own permissions and never execute these
// commands.
//
// This rail enumerates the migration directories that actually exist and asks
// whether every command names each one. It reads the files rather than
// importing them: each is the artifact a process actually reads, and a
// TypeScript view of it could drift from what that process sees.

const ROOT = new URL("../../", import.meta.url);
const SERVER_SRC = new URL("../../apps/server/src/", import.meta.url);

/**
 * Where each copy of the list lives, and the directory its relative paths start
 * from (`apps/server` for commands run from the server package).
 */
const ENTRY_POINTS = [
  { file: "infra/compose.yaml", base: "" },
  { file: "apps/server/package.json", base: "apps/server/" },
  { file: "scripts/deploy/runtime.sh", base: "apps/server/" },
  { file: "tests/browser/playwright.config.ts", base: "" },
  {
    file:
      "tests/e2e/implement-oauth-protected-mcp-server-and-transport-parity_test.ts",
    base: "",
  },
  {
    file:
      "tests/integration/implement-applications-repositories-and-immutable-onboarding-profiles_test.ts",
    base: "apps/server/",
  },
] as const;

/** Every directory under apps/server/src that holds a `migrations` child. */
async function migrationRoots(dir: URL, prefix = ""): Promise<string[]> {
  const roots: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue;
    const child = new URL(`${entry.name}/`, dir);
    const relative = `${prefix}${entry.name}`;
    if (entry.name === "migrations") {
      roots.push(`apps/server/src/${relative}`);
      continue;
    }
    roots.push(...await migrationRoots(child, `${relative}/`));
  }
  return roots;
}

/**
 * The migration directories a file grants, as repository-relative paths. A file
 * may hold several commands (package.json has `migrate` and `startup`); each
 * line that grants migration directories is returned on its own.
 */
async function grants(
  entry: typeof ENTRY_POINTS[number],
): Promise<string[][]> {
  const text = await Deno.readTextFile(new URL(entry.file, ROOT));
  return text
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/--allow-read=([^\s"'`]+)/);
      if (!match || !line.includes("migrations")) return [];
      const paths = match[1]
        .split(",")
        .filter((path) => path.endsWith("migrations"))
        .map((path) =>
          path.startsWith("apps/") ? path : `${entry.base}${path}`
        );
      // A command that grants only a few directories is a generator for one
      // module (auth:migrations:generate), not a migrate entry point.
      return paths.length >= 5 ? [paths] : [];
    });
}

Deno.test("every migrate entry point may read every migrations directory", async () => {
  const roots = await migrationRoots(SERVER_SRC);
  assert(
    roots.length >= 5,
    `expected the migration directories to be discoverable, found ${roots.length}; the walk is broken rather than the lists`,
  );
  for (const entry of ENTRY_POINTS) {
    const lists = await grants(entry);
    assert(
      lists.length > 0,
      `${entry.file} no longer grants read access to the migrations directories; this rail needs rewriting rather than deleting if that moved`,
    );
    for (const granted of lists) {
      const have = new Set(granted);
      const missing = roots.filter((root) => !have.has(root)).sort();
      assert(
        missing.length === 0,
        `${entry.file} cannot read these migrations directories, so a process it starts dies with NotCapable before it can migrate: ${
          missing.join(", ")
        }`,
      );
    }
  }
});

Deno.test("no migrate entry point grants a migrations directory that does not exist", async () => {
  // The other direction: a rename leaves the old path granted and the new one
  // unreadable, and the failure looks identical to the case above.
  const roots = new Set(await migrationRoots(SERVER_SRC));
  for (const entry of ENTRY_POINTS) {
    for (const granted of await grants(entry)) {
      const stale = granted.filter((path) => !roots.has(path)).sort();
      assert(
        stale.length === 0,
        `${entry.file} grants read access to paths that hold no migrations: ${
          stale.join(", ")
        }`,
      );
    }
  }
});
