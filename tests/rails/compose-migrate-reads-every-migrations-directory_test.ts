import { assert } from "@std/assert";

// The compose `migrate` service runs `apps/server/src/tasks.ts migrate` under an
// explicit `--allow-read` list of migration directories. That list is the only
// thing that lets the runner enumerate them, and it is maintained by hand.
//
// It had gone stale: `apps/server/src/modules/artifact-kinds/migrations` was
// missing, so every local stack died in the migrate container with
// `NotCapable: Requires read access to .../artifact-kinds/migrations` before the
// server could start. Nothing caught it, because the unit and rails lanes run
// migrations in-process with the lane's own permissions and never execute the
// container's command.
//
// This rail enumerates the migration directories that actually exist and asks
// whether the compose command names each one. It reads `infra/compose.yaml`
// rather than importing it: the file is the deployment artifact, and a
// TypeScript view of it could drift from what Docker reads.

const COMPOSE = new URL("../../infra/compose.yaml", import.meta.url);
const SERVER_SRC = new URL("../../apps/server/src/", import.meta.url);

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

Deno.test("the compose migrate service may read every migrations directory", async () => {
  const compose = await Deno.readTextFile(COMPOSE);
  const command = compose
    .split("\n")
    .find((line) =>
      line.includes("--allow-read=") && line.includes("migrations")
    );
  assert(
    command !== undefined,
    "infra/compose.yaml no longer grants the migrate service read access to the migrations directories; this rail needs rewriting rather than deleting if that moved",
  );
  const granted = new Set(
    (command.match(/--allow-read=([^\s]+)/)?.[1] ?? "")
      .split(",")
      .filter((entry) => entry.endsWith("migrations")),
  );

  const roots = await migrationRoots(SERVER_SRC);
  assert(
    roots.length >= 5,
    `expected the migration directories to be discoverable, found ${roots.length}; the walk is broken rather than the compose file`,
  );

  const missing = roots.filter((root) => !granted.has(root)).sort();
  assert(
    missing.length === 0,
    `infra/compose.yaml's migrate service cannot read these migrations directories, so a local stack dies in the migrate container before the server starts: ${
      missing.join(", ")
    }`,
  );
});

Deno.test("the compose migrate allow-read list names no directory that does not exist", async () => {
  // The other direction: a rename leaves the old path granted and the new one
  // unreadable, and the failure looks identical to the case above.
  const compose = await Deno.readTextFile(COMPOSE);
  const command = compose
    .split("\n")
    .find((line) =>
      line.includes("--allow-read=") && line.includes("migrations")
    );
  assert(command !== undefined, "the migrate allow-read line moved");
  const granted = (command.match(/--allow-read=([^\s]+)/)?.[1] ?? "")
    .split(",")
    .filter((entry) => entry.endsWith("migrations"));

  const roots = new Set(await migrationRoots(SERVER_SRC));
  const stale = granted.filter((entry) => !roots.has(entry)).sort();
  assert(
    stale.length === 0,
    `infra/compose.yaml's migrate service grants read access to paths that hold no migrations: ${
      stale.join(", ")
    }`,
  );
});
