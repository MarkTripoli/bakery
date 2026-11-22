import {
  judgeProbeOutput,
  PROBE_PROGRAM,
  startProcessJob,
} from "./plugin-job-process.ts";
import type {
  ContainmentProbe,
  ContainmentRuntime,
  PluginJobLimits,
  PluginJobSpec,
  RunningPluginJob,
} from "./plugin-job-runtime.ts";

/**
 * The bubblewrap containment runtime for plugin jobs (#29, B14.02, slice B).
 *
 * It needs no daemon and no root, only unprivileged user namespaces. Many hosts
 * block those (Ubuntu 24.04 does by default through AppArmor), and then the
 * probe says so and jobs are refused; nothing here falls back to running bare.
 *
 * What it bounds: no network (own namespace), a read-only root with the home,
 * run and mount directories hidden, own PID and IPC namespaces, no
 * capabilities, no new privileges, a CPU-seconds cap, a data-size cap, a
 * process-count cap and no file larger than zero bytes written outside tmpfs.
 * The host still enforces the wall-clock and output limits.
 */

export const BWRAP_FLAG = "BAKERY_PLUGIN_JOBS_BWRAP";

/**
 * Host directories a job must not see into. Each is hidden behind an empty
 * tmpfs only when it exists: the root is bound read-only, so bubblewrap cannot
 * create a mount point for a directory the host does not have, and a host
 * without `/media` (Arch has none) would otherwise never start a job.
 */
export const HIDDEN_DIRS = [
  "/run",
  "/home",
  "/root",
  "/mnt",
  "/media",
  "/var/tmp",
] as const;

/**
 * Where a job's code appears. It sits under `/tmp`, the one directory the
 * boundary always creates itself, so mounting it needs nothing from the host.
 */
export const BWRAP_CODE_MOUNT = "/tmp/code";

/** What a job's own `PATH` is. The worker's environment never reaches it. */
const JOB_PATH = "/usr/local/bin:/usr/bin:/bin";

export type BoundaryOptions = Readonly<{
  /** Extra host directories to hide, such as the worker's state directory. */
  hide?: readonly string[];
  /** Whether a host directory exists; a test swaps this. */
  exists?: (path: string) => boolean;
}>;

function directoryExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The boundary every job and the probe run in. Exported so the probe proves the
 * boundary a job will have, and so a test can swap in a weaker one and see the
 * probe refuse it.
 */
export function boundaryArgs(options: BoundaryOptions = {}): string[] {
  const exists = options.exists ?? directoryExists;
  const hidden = [
    ...new Set([...HIDDEN_DIRS, ...(options.hide ?? [])]),
  ].filter((path) => exists(path));
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    // The worker's environment holds its secrets; a job starts with nothing
    // but what it needs to run.
    "--clearenv",
    "--setenv",
    "PATH",
    JOB_PATH,
    "--setenv",
    "HOME",
    "/tmp",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...hidden.flatMap((path) => ["--tmpfs", path]),
  ];
}

/** The `prlimit` wrapper that caps what bubblewrap itself cannot. */
export function limitArgs(limits: PluginJobLimits): string[] {
  return [
    "prlimit",
    `--cpu=${Math.max(1, Math.ceil(limits.timeoutMs / 1000) * limits.cpus)}`,
    `--data=${limits.memoryBytes}`,
    `--nproc=${limits.pids}`,
    "--nofile=256",
    "--core=0",
  ];
}

export type BwrapRuntimeOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  bwrap?: string;
  /** Builds the boundary; a test swaps this to prove the probe notices. */
  boundary?: typeof boundaryArgs;
  /** Host directories to hide beyond the defaults, such as the worker's state directory. */
  hide?: readonly string[];
}>;

type Output = { code: number; stdout: string; stderr: string };

async function run(bin: string, args: string[]): Promise<Output | null> {
  try {
    const out = await new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch {
    return null;
  }
}

/**
 * Why bubblewrap could not start the probe, in words an operator can act on.
 * Only a refusal to make the namespace is blamed on the host's policy; any
 * other failure says what bubblewrap printed, so a setup mistake is not
 * reported as a missing kernel feature.
 */
export function refusalReason(stderr: string): string {
  const said = stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  if (
    /uid map|user namespace|setting up uid|Operation not permitted/i.test(said)
  ) {
    return "the host does not allow unprivileged user namespaces, so bubblewrap cannot contain a job here";
  }
  return said.length > 0
    ? `bubblewrap could not start the boundary: ${said}`
    : "bubblewrap could not start the boundary and said nothing";
}

export function createBwrapRuntime(
  options: BwrapRuntimeOptions = {},
): ContainmentRuntime {
  const env = options.env ?? Deno.env.toObject();
  const bin = options.bwrap ?? "bwrap";
  const boundary = () =>
    (options.boundary ?? boundaryArgs)({
      hide: options.hide,
    });
  const probeLimits: PluginJobLimits = {
    cpus: 1,
    memoryBytes: 128 * 1024 * 1024,
    pids: 32,
    timeoutMs: 30_000,
    outputBytes: 4096,
    lineBytes: 4096,
  };
  const unsupported = (reason: string): ContainmentProbe => ({
    supported: false,
    runtime: "bwrap",
    reason,
  });

  return {
    name: "bwrap",
    codeMount: BWRAP_CODE_MOUNT,
    async probe() {
      if (env[BWRAP_FLAG] !== "1") {
        return unsupported(
          `the bubblewrap runtime is not enabled on this worker (set ${BWRAP_FLAG}=1)`,
        );
      }
      const version = await run(bin, ["--version"]);
      if (version === null || version.code !== 0) {
        return unsupported("bubblewrap is not installed");
      }
      const limits = await run("prlimit", ["--version"]);
      if (limits === null || limits.code !== 0) {
        return unsupported("prlimit is not installed, so limits cannot be set");
      }
      const probe = await run(bin, [
        ...boundary(),
        "--",
        ...limitArgs(probeLimits),
        "sh",
        "-c",
        PROBE_PROGRAM,
      ]);
      if (probe === null || probe.code !== 0) {
        return unsupported(refusalReason(probe?.stderr ?? ""));
      }
      return judgeProbeOutput("bwrap", probe.stdout);
    },

    start(spec: PluginJobSpec): Promise<RunningPluginJob> {
      return Promise.resolve(startProcessJob({
        bin,
        args: [
          ...boundary(),
          "--ro-bind",
          spec.codeDir,
          BWRAP_CODE_MOUNT,
          "--chdir",
          BWRAP_CODE_MOUNT,
          "--",
          ...limitArgs(spec.limits),
          ...spec.command,
        ],
        limits: spec.limits,
        // The client itself starts with only a path to find `prlimit` by.
        env: { PATH: Deno.env.get("PATH") ?? JOB_PATH },
        // `--die-with-parent` and the PID namespace end the job with the
        // client; nothing else outlives it.
        cleanup: () => Promise.resolve({ oomKilled: false }),
      }));
    },
  };
}
