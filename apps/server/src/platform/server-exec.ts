/**
 * Fixed-argv launchers: the only executables the server's `--allow-run`
 * grant names. A general exec wrapper (git, prlimit, systemd-run, Deno) in
 * that grant would let the server run anything; each launcher accepts one
 * operation with validated operands and execs exactly one command line. The
 * launchers sit beside the server in the repository, so the same paths work
 * on a host checkout and in the image (/workspace).
 */
const repositoryRoot = new URL("../../../../", import.meta.url);

/** infra/server-exec/git.sh: every git command the server runs. */
export const SERVER_GIT_LAUNCHER =
  new URL("infra/server-exec/git.sh", repositoryRoot).pathname;

/** infra/server-exec/dispatch.sh: the dispatcher child of run-dispatch.ts. */
export const SERVER_DISPATCH_LAUNCHER =
  new URL("infra/server-exec/dispatch.sh", repositoryRoot).pathname;

/** infra/server-exec/draft-systemd.sh: the systemd draft worker unit. */
export const SERVER_DRAFT_SYSTEMD_LAUNCHER =
  new URL("infra/server-exec/draft-systemd.sh", repositoryRoot).pathname;

export class UnsupportedGitInvocationError extends Error {
  constructor() {
    super("GIT_INVOCATION_UNSUPPORTED");
    this.name = "UnsupportedGitInvocationError";
  }
}

const OBJECT_TYPES = new Set(["blob", "tree", "commit", "tag"]);
const FETCH_CONFIG = [
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "http.followRedirects=false",
  "-c",
  "protocol.version=2",
];
const FETCH_FLAGS = ["fetch", "--no-tags", "--depth=1", "--filter=blob:none"];
const LS_TREE = ["ls-tree", "-r", "-z", "--full-tree", "FETCH_HEAD", "--"];

function same(
  args: readonly string[],
  offset: number,
  expected: readonly string[],
): boolean {
  return expected.every((value, index) => args[offset + index] === value);
}

/**
 * The git launcher's argv for one of the server's git invocations against
 * `gitDirectory`. Only the shapes the server's call sites use are accepted;
 * anything else is a programming error, not an input, and throws.
 */
export function gitLauncherArgs(
  gitDirectory: string,
  args: readonly string[],
): string[] {
  const [command, ...rest] = args;
  if (command === "cat-file" && rest.length === 2) {
    const [flag, object] = rest as [string, string];
    if (flag === "-t") return ["cat-file-type", gitDirectory, object];
    if (flag === "-s") return ["cat-file-size", gitDirectory, object];
    if (OBJECT_TYPES.has(flag)) {
      return ["cat-file", gitDirectory, flag, object];
    }
  }
  if (command === "rev-parse") {
    if (rest.length === 1 && rest[0] === "--is-bare-repository") {
      return ["is-bare", gitDirectory];
    }
    if (rest.length === 1 && rest[0] === "--is-shallow-repository") {
      return ["is-shallow", gitDirectory];
    }
    const target =
      rest.length === 3 && same(rest, 0, ["--verify", "--end-of-options"])
        ? rest[2]
        : rest.length === 2 && rest[0] === "--verify"
        ? rest[1]
        : undefined;
    if (target?.endsWith("^{commit}")) {
      return [
        "verify-commit",
        gitDirectory,
        target.slice(0, -"^{commit}".length),
      ];
    }
  }
  if (
    command === "hash-object" && rest.length === 4 && rest[0] === "-t" &&
    OBJECT_TYPES.has(rest[1]!) && same(rest, 2, ["--stdin", "--no-filters"])
  ) {
    return ["hash-object", gitDirectory, rest[1]!];
  }
  if (command === "init" && rest.length === 1 && rest[0] === "--bare") {
    return ["init-bare", gitDirectory];
  }
  if (same(args, 0, LS_TREE) && args.length <= LS_TREE.length + 1) {
    return ["ls-tree", gitDirectory, ...args.slice(LS_TREE.length)];
  }
  if (
    same(args, 0, FETCH_CONFIG) &&
    same(args, FETCH_CONFIG.length, FETCH_FLAGS) &&
    args[FETCH_CONFIG.length + FETCH_FLAGS.length] === "--" &&
    args.length === FETCH_CONFIG.length + FETCH_FLAGS.length + 3
  ) {
    const [url, revision] = args.slice(-2) as [string, string];
    return ["fetch", gitDirectory, url, revision];
  }
  throw new UnsupportedGitInvocationError();
}

const DRAFT_UNIT =
  /^bakery-draft-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.service$/;

/**
 * The systemd draft launcher's argv for one of draft isolation's systemctl or
 * journalctl calls (argv as written for those tools, `--user` first). Each
 * names one bakery-draft-<uuid>.service unit; only the shapes the draft
 * isolation uses are accepted, anything else throws.
 */
export function systemdLauncherArgs(args: readonly string[]): string[] {
  const unitOf = (value: string | undefined) => {
    const match = DRAFT_UNIT.exec(value ?? "");
    if (!match) throw new UnsupportedSystemdInvocationError();
    return match[1]!;
  };
  const shapes: [string, readonly string[], number][] = [
    ["kill", ["--user", "kill", "--kill-who=all", "--signal=KILL", "UNIT"], 4],
    ["stop", ["--user", "stop", "UNIT"], 2],
    ["reset-failed", ["--user", "reset-failed", "UNIT"], 2],
    [
      "show-boundary",
      [
        "--user",
        "show",
        "UNIT",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=ControlGroup",
        "--property=MainPID",
      ],
      2,
    ],
    [
      "show-private-users",
      ["--user", "show", "UNIT", "--property=PrivateUsers", "--value"],
      2,
    ],
    [
      "status",
      [
        "--user",
        "status",
        "UNIT",
        "--no-pager",
        "--lines=8",
        "--output=short",
        "--full",
      ],
      2,
    ],
    [
      "journal",
      [
        "--user",
        "--unit",
        "UNIT",
        "--no-pager",
        "--lines",
        "20",
        "--output=cat",
      ],
      2,
    ],
  ];
  if (
    args.length === 4 &&
    same(args, 0, ["--user", "show", "--property=Version", "--value"])
  ) {
    return ["manager-version"];
  }
  for (const [operation, shape, unitIndex] of shapes) {
    if (args.length !== shape.length) continue;
    const matches = shape.every((value, index) =>
      index === unitIndex || args[index] === value
    );
    if (matches) return [operation, unitOf(args[unitIndex])];
  }
  throw new UnsupportedSystemdInvocationError();
}

export class UnsupportedSystemdInvocationError extends Error {
  constructor() {
    super("SYSTEMD_INVOCATION_UNSUPPORTED");
    this.name = "UnsupportedSystemdInvocationError";
  }
}
