/**
 * The environment of the lanes that run a real stack (#246), defense in depth
 * for the owner-account rule (#207). The security, integration and e2e lanes
 * start with an empty HOME, no CODEX_HOME and no BAKERY_CODEX_AUTH_SOURCE_DIR,
 * their own XDG directories and a minimal git config, so no test can reach the
 * operator's real login or settings by any path, including ones a source scan
 * cannot see.
 *
 * Only what the lanes need to keep working is carried across, and only by name:
 * the module cache (`DENO_DIR`) and the browser cache stay pinned where they
 * are, because they hold no credentials and an empty one would make every run
 * download them again; `BAKERY_TEST_CODEX_AUTH_DIR`, the dedicated and explicit
 * opt-in of #207, stays the operator's decision. Everything else of the
 * operator's environment (PATH, database URLs, TMPDIR) passes through.
 *
 * The functions here are pure: the lane runner makes the directories.
 */
import { join } from "node:path";

/** The lanes that run with an isolated HOME. */
export const ISOLATED_HOME_LANES: readonly string[] = [
  "security",
  "integration",
  "e2e",
];

/** Variables that point at the operator's Codex login; the lane never sees them. */
const REMOVED = ["CODEX_HOME", "BAKERY_CODEX_AUTH_SOURCE_DIR"] as const;

/** A committer and a default branch, nothing of the operator's identity or credentials. */
export const MINIMAL_GIT_CONFIG = [
  "[user]",
  "\tname = Bakery Test",
  "\temail = test@example.test",
  "[init]",
  "\tdefaultBranch = main",
  "[commit]",
  "\tgpgsign = false",
  "[tag]",
  "\tgpgsign = false",
  "",
].join("\n");

/** Where the isolated lane keeps its home, XDG directories and git config under `root`. */
export function laneEnvPaths(root: string) {
  const base = join(root, "env");
  return {
    base,
    home: join(base, "home"),
    config: join(base, "xdg-config"),
    data: join(base, "xdg-data"),
    state: join(base, "xdg-state"),
    cache: join(base, "xdg-cache"),
    gitconfig: join(base, "gitconfig"),
    directories: [
      join(base, "home"),
      join(base, "xdg-config"),
      join(base, "xdg-data"),
      join(base, "xdg-state"),
      join(base, "xdg-cache"),
    ],
  };
}

/**
 * The full environment for a lane run, or `null` for a lane that is not
 * isolated (the caller keeps its existing behavior). `environment` is the
 * operator's; `root` is a fresh directory this run owns; `pinned` are the
 * caches to keep (their values are paths in the operator's home, by design).
 */
export function isolatedLaneEnvironment(options: {
  lane: string;
  environment: Readonly<Record<string, string>>;
  root: string;
  pinned: Readonly<Record<string, string>>;
}): Record<string, string> | null {
  if (!ISOLATED_HOME_LANES.includes(options.lane)) return null;
  const paths = laneEnvPaths(options.root);
  const env: Record<string, string> = { ...options.environment };
  for (const key of REMOVED) delete env[key];
  Object.assign(env, options.pinned, {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    XDG_CACHE_HOME: paths.cache,
    GIT_CONFIG_GLOBAL: paths.gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  return env;
}
