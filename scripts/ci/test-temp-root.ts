/**
 * The temp root of one test lane run (#242). The lane runner points the unit
 * lane's `TMPDIR` at a root made here, and sweeps it afterwards: whatever is
 * still inside was left by something the test preload could not clean (a killed
 * worker, Node's `mkdtemp`). The sweep reports it and removes it.
 *
 *   create <base>          prints the path of a new `<base>/bakery-lane-XXXXXX`
 *   skeleton <base> <root> makes the isolated HOME, XDG directories and git
 *                          config of #246 under `<root>/env`
 *   sweep <base> <root>    prints {"leaked":n,"prefixes":{...}} and removes <root>;
 *                          `<root>/env` is the lane's own home, not a leak, and
 *                          its entry count is reported as `homeEntries`
 *
 * Run with `--allow-read --allow-write=<base>`; it touches nothing else.
 */
import { basename, dirname, isAbsolute } from "node:path";
import { laneEnvPaths, MINIMAL_GIT_CONFIG } from "./lane-environment.ts";
import { entriesOf, removeTreeSync } from "./temp-tree.ts";

export const LANE_ROOT_PREFIX = "bakery-lane-";

/** Groups entry names by their name minus the random suffix. */
export function prefixesOf(names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) {
    const prefix = name.replace(/-?[A-Za-z0-9_]{6,}$/, "") || name;
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12),
  );
}

if (import.meta.main) {
  const [command, base, root] = Deno.args;
  if (!base || !isAbsolute(base)) {
    console.error("test-temp-root: <base> must be an absolute path");
    Deno.exit(2);
  }
  if (command === "create") {
    console.log(
      await Deno.makeTempDir({ dir: base, prefix: LANE_ROOT_PREFIX }),
    );
  } else if (command === "skeleton" || command === "sweep") {
    // Only ever a root this tool made, directly under the base it was given.
    if (
      !root || dirname(root) !== base.replace(/\/+$/, "") ||
      !basename(root).startsWith(LANE_ROOT_PREFIX)
    ) {
      console.error(
        `test-temp-root: refusing to ${command} a path that is not a lane root`,
      );
      Deno.exit(2);
    }
    if (command === "skeleton") {
      const paths = laneEnvPaths(root);
      for (const directory of paths.directories) {
        Deno.mkdirSync(directory, { recursive: true });
      }
      Deno.writeTextFileSync(paths.gitconfig, MINIMAL_GIT_CONFIG);
    } else {
      const paths = laneEnvPaths(root);
      const isolated = entriesOf(root).includes("env");
      const homeEntries = isolated ? entriesOf(paths.home).length : undefined;
      const left = entriesOf(root).filter((name) =>
        !(isolated && name === "env")
      );
      removeTreeSync(root);
      console.log(
        JSON.stringify({
          leaked: left.length,
          prefixes: prefixesOf(left),
          ...(homeEntries === undefined ? {} : { homeEntries }),
        }),
      );
    }
  } else {
    console.error(
      "usage: test-temp-root.ts create <base> | skeleton <base> <root> | sweep <base> <root>",
    );
    Deno.exit(2);
  }
}
