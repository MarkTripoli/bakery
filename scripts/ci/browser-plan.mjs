// Projects of the serial auth chain: `desktop-auth-bootstrap` observes the
// empty install and seeds the one admin, then `desktop-shared-admin` specs
// reuse it. The chain must run whole, in one place, before anything else
// touches that admin. The three real-* projects are empty unless an operator
// opts in; they ride with the chain.
export const CHAIN_PROJECTS = [
  "desktop-auth-bootstrap",
  "desktop-shared-admin",
  "desktop-real-api",
  "desktop-real-harness",
  "desktop-real-m1",
];
// Fixture projects have no shared admin; Playwright `--shard` slices each one
// on its own so a shard gets a mix of the heavy desktop and light mobile tests
// (one `--shard` over both is contiguous and left two shards with 3x the work).
export const FIXTURE_PROJECTS = ["desktop", "mobile"];

/**
 * Reads the web-lane shard from the environment. `BAKERY_BROWSER_SHARD` is
 * `<index>/<total>` (one-based); `BAKERY_BROWSER_STATEFUL_SHARD` is the index
 * of the shard that owns the auth chain (default 1).
 */
export function readBrowserShard(env = process.env) {
  const raw = env.BAKERY_BROWSER_SHARD;
  if (raw === undefined || raw === "") return null;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(raw);
  if (!match) throw new Error("Invalid BAKERY_BROWSER_SHARD");
  const index = Number(match[1]);
  const total = Number(match[2]);
  const stateful = Number(env.BAKERY_BROWSER_STATEFUL_SHARD ?? "1");
  if (
    index > total || !Number.isInteger(stateful) || stateful < 1 ||
    stateful > total
  ) throw new Error("Invalid BAKERY_BROWSER_SHARD");
  return { index, total, stateful };
}

export function browserCommands(lane, selection, shard = null) {
  switch (lane) {
    case "web": {
      if (!selection.full) {
        const narrow = [
          { packageDir: "apps/web", mode: "core", requireCore: true },
          ...(selection.webSpecs.length
            ? [{ packageDir: "apps/web", mode: "affected", requireCore: false }]
            : []),
        ];
        // Core and affected selections are small: shard 1 owns them and the
        // other shards have nothing to run.
        return shard && shard.index !== 1 ? [] : narrow;
      }
      if (!shard) {
        return [{ packageDir: "apps/web", mode: "full", requireCore: true }];
      }
      const owner = shard.index === shard.stateful;
      const base = {
        packageDir: "apps/web",
        mode: "full",
        requireCore: true,
        presentOnly: true,
      };
      return [
        // The chain runs first so its empty-install observation precedes the
        // seed, and so fixture specs that read the bootstrapped API run after.
        ...(owner ? [{ ...base, projects: CHAIN_PROJECTS }] : []),
        ...FIXTURE_PROJECTS.map((project) => ({
          ...base,
          projects: [project],
          shard: `${shard.index}/${shard.total}`,
          // Shards without the chain start from the same bootstrapped state
          // the chain leaves behind in the unsharded run.
          seedAdmin: !owner,
        })),
      ];
    }
    case "storybook":
      return selection.storybook
        ? [{ packageDir: "packages/ui", mode: "full", requireCore: false }]
        : [];
    default:
      throw new Error("Expected web or storybook browser lane");
  }
}
