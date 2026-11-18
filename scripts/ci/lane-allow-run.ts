/**
 * What each test lane may spawn (#259). Deno checks a run grant against the
 * spawned path only, so a grant that names a shell, `env`, `deno` or
 * `systemd-run` is a grant of every executable on the host, and the rig host
 * shares the owner's account. The lists live here, apart from the lane runner,
 * so a test can pin each one exactly: adding a program to a lane is then a
 * reviewed change to this file and to that test.
 */

/** What a lane may spawn: nothing, anything (a bare `--allow-run`), or these. */
export type AllowRun =
  | { kind: "none" }
  | { kind: "any" }
  | { kind: "list"; entries: string[] };

/** Where the lane runner finds what only it knows. */
export type AllowRunContext = {
  /** `Deno.execPath()`: the test process's own Deno binary. */
  execPath: string;
  /** The path of a fixed launcher under `infra/server-exec`. */
  serverLauncher: (name: string) => string;
  /** Whether the owner opted in to a real harness CLI (provider lane only). */
  providerRealCli: boolean;
};

/** Lanes that run a real stack and so spawn what they start: a bare grant. */
export const BARE_ALLOW_RUN_LANES = [
  "rails",
  "integration",
  "recovery",
  "security",
  "e2e",
  "connected",
] as const;

/**
 * Basenames no lane's list may name, because each runs an arbitrary command
 * given its arguments. The lane's own Deno binary is the one exception, and is
 * pinned by position in the list rather than by name.
 */
export const REFUSED_BASENAMES = [
  "sh",
  "bash",
  "dash",
  "zsh",
  "env",
  "deno",
  "systemd-run",
] as const;

export function allowRunFor(lane: string, context: AllowRunContext): AllowRun {
  const { execPath, serverLauncher } = context;
  if (lane === "native") return { kind: "any" };
  if ((BARE_ALLOW_RUN_LANES as readonly string[]).includes(lane)) {
    return { kind: "any" };
  }
  if (lane === "unit") {
    return {
      kind: "list",
      entries: [
        "zip",
        "unzip",
        "node",
        "git",
        "/usr/bin/git",
        "/usr/bin/stat",
        "/usr/bin/prlimit",
        "/usr/bin/setsid",
        "/usr/bin/kill",
        // The server's fixed launchers (infra/server-exec) are how its git and
        // systemd calls run; the unit tests exercise them through the real
        // spawn path, so the lane names them exactly.
        serverLauncher("git.sh"),
        serverLauncher("draft-systemd.sh"),
        // For the type-level probes: a few guarantees are about what the
        // compiler REJECTS, and the only honest way to assert that is to
        // compile a snippet.
        execPath,
      ],
    };
  }
  if (lane === "provider") {
    // Provider conformance runs fixtures only: a stray host binary fails the
    // lane. The owner's opt-in for a real harness CLI widens it to any.
    return context.providerRealCli ? { kind: "any" } : {
      kind: "list",
      entries: ["git", "/usr/bin/git", "/usr/bin/setsid", "/usr/bin/kill"],
    };
  }
  if (lane === "contract") {
    // Only the release-evidence permission probes spawn anything: their own
    // Deno binary, to see what a narrower grant refuses.
    return { kind: "list", entries: [execPath] };
  }
  return { kind: "none" };
}

/** The `--allow-run` flag for a lane, or none when it may spawn nothing. */
export function allowRunFlags(
  lane: string,
  context: AllowRunContext,
): string[] {
  const grant = allowRunFor(lane, context);
  if (grant.kind === "none") return [];
  if (grant.kind === "any") return ["--allow-run"];
  return [`--allow-run=${grant.entries.join(",")}`];
}
