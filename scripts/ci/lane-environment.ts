/**
 * The environment of the lanes that run a real stack (#246), defense in depth
 * for the owner-account rule (#207). The security, integration and e2e lanes
 * start with an empty HOME, no CODEX_HOME and no BAKERY_CODEX_AUTH_SOURCE_DIR,
 * their own XDG directories and a minimal git config, so no path a test derives
 * from HOME, CODEX_HOME, XDG_* or git's global config reaches the operator's
 * Codex login or settings, including paths a source scan cannot see.
 *
 * What this is not: a sandbox. The lanes run with a global `--allow-read`, so a
 * test that names an absolute path can still read it, and only the Codex login
 * is in scope: every other credential the operator's environment holds
 * (OPENAI_API_KEY, GITHUB_TOKEN, AWS_*, SSH_AUTH_SOCK, DOCKER_CONFIG ...)
 * passes through to the lane unchanged, as PATH, database URLs and TMPDIR do.
 *
 * Only what the lanes need to keep working is carried across, and only by name:
 * the module cache (`DENO_DIR`) and the browser cache stay pinned where they
 * are, because they hold no credentials and an empty one would make every run
 * download them again; `BAKERY_TEST_CODEX_AUTH_DIR`, the dedicated and explicit
 * opt-in of #207, stays the operator's decision.
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
 * The caches a lane keeps pointing at the operator's own: the module cache and
 * the browser cache. The variable wins when it is set and not empty; otherwise
 * the module cache is where `deno info` says it is (`denoInfoDir`, which the
 * caller asks for only when it is needed) and the browser cache is
 * `$HOME/.cache/ms-playwright`. A cache that cannot be found is left out, and
 * the lane then finds its own.
 */
export function pinnedCaches(options: {
  environment: Readonly<Record<string, string>>;
  denoInfoDir: string | undefined;
}): Record<string, string> {
  const { environment } = options;
  const pinned: Record<string, string> = {};
  const set = (name: string): string | undefined =>
    environment[name] !== undefined && environment[name]!.length > 0
      ? environment[name]
      : undefined;
  const denoDir = set("DENO_DIR") ?? options.denoInfoDir;
  if (denoDir !== undefined && denoDir.length > 0) pinned.DENO_DIR = denoDir;
  const home = set("HOME");
  const browsers = set("PLAYWRIGHT_BROWSERS_PATH") ??
    (home === undefined ? undefined : join(home, ".cache", "ms-playwright"));
  if (browsers !== undefined) pinned.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return pinned;
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
