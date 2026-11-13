import { assert, assertEquals } from "@std/assert";
import { basename, dirname } from "node:path";

/**
 * Asserts the process runs the way the security, integration and e2e lanes
 * start it (#246): an empty HOME under the lane's own root, no pointer at the
 * operator's Codex login, a git config of the lane's own and the operator's
 * mise directories. Each of those
 * three lanes has a one-case file that calls this, so a lane that stops
 * isolating fails the lane itself, not only a rail.
 */
export function assertIsolatedLaneHome(): void {
  const home = Deno.env.get("HOME");
  assert(home !== undefined && home.length > 0, "HOME is set");
  const env = dirname(home);
  assertEquals(basename(home), "home");
  assertEquals(basename(env), "env");
  assert(
    basename(dirname(env)).startsWith("bakery-lane-"),
    `HOME is under a lane root: ${home}`,
  );
  // Nothing of an operator's login or settings is there.
  for (const name of [".codex", ".config", ".gitconfig", ".ssh", ".aws"]) {
    let exists = true;
    try {
      Deno.lstatSync(`${home}/${name}`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${name} must not exist in the lane HOME`);
  }
  assertEquals(Deno.env.get("CODEX_HOME"), undefined);
  assertEquals(Deno.env.get("BAKERY_CODEX_AUTH_SOURCE_DIR"), undefined);
  assertEquals(Deno.env.get("GIT_CONFIG_GLOBAL"), `${env}/gitconfig`);
  assertEquals(Deno.env.get("GIT_CONFIG_NOSYSTEM"), "1");
  // The mise directories are the operator's, never the lane's: under the
  // lane's empty HOME a `docker` or `git` that is a mise shim cannot find mise's
  // installed tools, configuration or trust record, and hangs.
  for (
    const name of [
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "MISE_CACHE_DIR",
      "MISE_STATE_DIR",
    ]
  ) {
    const directory = Deno.env.get(name);
    if (directory === undefined) continue;
    assert(
      !directory.startsWith(env),
      `${name} is the operator's, not under the lane's own directory: ${directory}`,
    );
  }
  // A sentinel home the rail plants as the operator's: this lane is not in it,
  // and the mise directories the rail set (all four, under the sentinel) reach
  // the lane unchanged.
  const sentinel = Deno.env.get("BAKERY_LANE_HOME_SENTINEL");
  if (sentinel !== undefined) {
    assert(!home.startsWith(sentinel), "the lane HOME is outside the sentinel");
    assertEquals(Deno.env.get("MISE_DATA_DIR"), `${sentinel}/mise-data`);
    assertEquals(Deno.env.get("MISE_CONFIG_DIR"), `${sentinel}/mise-config`);
    assertEquals(Deno.env.get("MISE_CACHE_DIR"), `${sentinel}/mise-cache`);
    assertEquals(Deno.env.get("MISE_STATE_DIR"), `${sentinel}/mise-state`);
  }
}
