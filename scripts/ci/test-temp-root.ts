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
 *                          its entry count is reported as `homeEntries` and its
 *                          names (one level into a directory, capped) as
 *                          `homeNames`, with `homeNamesTruncated`
 *
 * Run with `--allow-read --allow-write=<base>`; it touches nothing else.
 */
import { basename, dirname, isAbsolute, join } from "node:path";
import { laneEnvPaths, MINIMAL_GIT_CONFIG } from "./lane-environment.ts";
import { entriesOf, removeTreeSync } from "./temp-tree.ts";

export const LANE_ROOT_PREFIX = "bakery-lane-";

/**
 * What the pinned mise writes into any HOME it runs under (#246): the settings
 * file of the Rust tool the operator's global configuration pins, as
 * `.rustup/settings.toml` and nothing else. It is not a test that depended on a
 * real home, so it is not reported; a `.rustup` that holds anything more is.
 */
export function isMiseHomeEntry(home: string, name: string): boolean {
  if (name !== ".rustup") return false;
  const inside = entriesOf(join(home, name));
  return inside.length === 1 && inside[0] === "settings.toml";
}

/** At most this many names are reported for what a lane wrote into its home. */
const HOME_NAME_LIMIT = 20;
const HOME_NAME_LENGTH = 80;

/**
 * The names to report for what a lane wrote into its home (#246): each top-level
 * entry, and for a directory its immediate children (`.cache/deno`, not just
 * `.cache`), so the writer can be found; at most twenty names, each at most
 * eighty characters, with `truncated` saying there were more.
 */
export function homeNamesOf(
  home: string,
  entries: readonly string[],
): { names: string[]; truncated: boolean } {
  const all: string[] = [];
  for (const entry of entries) {
    const children = entriesOf(join(home, entry));
    if (children.length === 0) all.push(entry);
    else for (const child of children) all.push(`${entry}/${child}`);
  }
  return {
    names: all.slice(0, HOME_NAME_LIMIT).map((name) =>
      name.slice(0, HOME_NAME_LENGTH)
    ),
    truncated: all.length > HOME_NAME_LIMIT,
  };
}

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
      const homeTop = isolated
        ? entriesOf(paths.home).filter((name) =>
          !isMiseHomeEntry(paths.home, name)
        ).sort()
        : undefined;
      const homeEntries = homeTop?.length;
      const homeNames = homeTop === undefined
        ? undefined
        : homeNamesOf(paths.home, homeTop);
      const left = entriesOf(root).filter((name) =>
        !(isolated && name === "env")
      );
      removeTreeSync(root);
      console.log(
        JSON.stringify({
          leaked: left.length,
          prefixes: prefixesOf(left),
          ...(homeEntries === undefined ? {} : {
            homeEntries,
            // The names, one level into a directory, so the writer can be found (capped).
            homeNames: homeNames!.names,
            homeNamesTruncated: homeNames!.truncated,
          }),
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
