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
 * The boundary every job and the probe run in. Exported so the probe proves the
 * boundary a job will have, and so a test can swap in a weaker one and see the
 * probe refuse it.
 */
export function boundaryArgs(): string[] {
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
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/root",
    "--tmpfs",
    "/mnt",
    "--tmpfs",
    "/media",
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
}>;

type Output = { code: number; stdout: string };

async function run(bin: string, args: string[]): Promise<Output | null> {
  try {
    const out = await new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return null;
  }
}

export function createBwrapRuntime(
  options: BwrapRuntimeOptions = {},
): ContainmentRuntime {
  const env = options.env ?? Deno.env.toObject();
  const bin = options.bwrap ?? "bwrap";
  const boundary = options.boundary ?? boundaryArgs;
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
        return unsupported(
          "the host does not allow unprivileged user namespaces, so bubblewrap cannot contain a job here",
        );
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
          "/code",
          "--chdir",
          "/code",
          "--",
          ...limitArgs(spec.limits),
          ...spec.command,
        ],
        limits: spec.limits,
        // `--die-with-parent` and the PID namespace end the job with the
        // client; nothing else outlives it.
        cleanup: () => Promise.resolve({ oomKilled: false }),
      }));
    },
  };
}
