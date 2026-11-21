import type {
  ContainmentProbe,
  ContainmentRuntime,
  PluginJobLimits,
  PluginJobSpec,
  RunningPluginJob,
} from "./plugin-job-runtime.ts";

/**
 * The Docker containment runtime for plugin jobs (#29, B14.02, slice B).
 *
 * Off by default. The Docker socket is root-equivalent on its host, so a
 * worker only uses this runtime when its operator turns it on with
 * `BAKERY_PLUGIN_JOBS_DOCKER=1`. Without the flag, or when Docker is not
 * reachable, or when the probe below fails, plugin jobs are refused with the
 * reason; they never run outside a boundary.
 */

export const DOCKER_FLAG = "BAKERY_PLUGIN_JOBS_DOCKER";
/** The image jobs and the probe run in. Never pulled at probe time. */
export const DEFAULT_JOB_IMAGE = "denoland/deno:2.9.1";
export const IMAGE_ENV = "BAKERY_PLUGIN_JOB_IMAGE";

/**
 * The hardening every job container gets. Exported so the probe and a job are
 * built from the same list: the probe proves the boundary a job will have, not
 * a similar one.
 */
export function hardeningArgs(
  name: string,
  limits: PluginJobLimits,
): string[] {
  return [
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--pids-limit",
    String(limits.pids),
    "--memory",
    String(limits.memoryBytes),
    "--memory-swap",
    String(limits.memoryBytes),
    "--cpus",
    String(limits.cpus),
    "--ipc",
    "none",
    // Docker would keep a job's stdout and stderr in a log file on the host,
    // past every cap the runner enforces. Nothing reads that log.
    "--log-driver",
    "none",
  ];
}

export type DockerRuntimeOptions = Readonly<{
  /** Environment to read the flag from. */
  env?: Readonly<Record<string, string | undefined>>;
  image?: string;
  docker?: string;
  /** Builds the hardening list; a test swaps this to prove the probe notices. */
  hardening?: typeof hardeningArgs;
}>;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;

type Output = { code: number; stdout: string; stderr: string };

async function docker(bin: string, args: string[]): Promise<Output> {
  const output = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Runs inside the probe container, in plain `sh` so any job image works. It
 * counts network interfaces other than loopback and reads whether the root
 * filesystem is mounted read-only, then reports both. The mount table is the
 * proof, not a write attempt: a job's user usually cannot write `/` anyway, so
 * a failed write would pass even when `--read-only` was dropped.
 */
const PROBE_PROGRAM = [
  "extra=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | grep -v '^lo$' | wc -l | tr -d ' ')",
  `opts=$(awk '$2=="/" {o=$4} END {print o}' /proc/mounts)`,
  'case ",$opts," in *,ro,*) ro=true;; *) ro=false;; esac',
  'echo "{\\"extra\\":$extra,\\"readOnlyRoot\\":$ro}"',
].join("\n");

export function createDockerRuntime(
  options: DockerRuntimeOptions = {},
): ContainmentRuntime {
  const env = options.env ?? Deno.env.toObject();
  const bin = options.docker ?? "docker";
  const image = options.image ?? env[IMAGE_ENV] ?? DEFAULT_JOB_IMAGE;
  const harden = options.hardening ?? hardeningArgs;
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
    runtime: "docker",
    reason,
  });

  return {
    name: "docker",
    async probe() {
      if (env[DOCKER_FLAG] !== "1") {
        return unsupported(
          `the Docker runtime is not enabled on this worker (set ${DOCKER_FLAG}=1)`,
        );
      }
      const have = await docker(bin, ["image", "inspect", image]).catch(() =>
        null
      );
      if (have === null) return unsupported("Docker is not installed");
      if (have.code !== 0) {
        return unsupported(
          `Docker is not reachable or the job image ${image} is missing`,
        );
      }
      const name = `bakery-plugin-probe-${crypto.randomUUID()}`;
      const run = await docker(bin, [
        "run",
        "--rm",
        ...harden(name, probeLimits),
        "--entrypoint",
        "sh",
        image,
        "-c",
        PROBE_PROGRAM,
      ]);
      await docker(bin, ["rm", "-fv", name]).catch(() => undefined);
      if (run.code !== 0) {
        return unsupported("the containment probe could not run");
      }
      let seen: { extra?: unknown; readOnlyRoot?: unknown };
      try {
        seen = JSON.parse(run.stdout.trim().split("\n").pop() ?? "");
      } catch {
        return unsupported("the containment probe gave no readable answer");
      }
      if (seen.extra !== 0) {
        return unsupported(
          "a job could reach a network interface, so jobs are refused",
        );
      }
      if (seen.readOnlyRoot !== true) {
        return unsupported(
          "the root filesystem is not read-only, so jobs are refused",
        );
      }
      return { supported: true, runtime: "docker" };
    },

    async start(spec: PluginJobSpec): Promise<RunningPluginJob> {
      // The name a caller gives is a label for people. The container gets a
      // name nobody else holds, so this attempt can neither remove another's
      // container nor be removed by one, and `docker run` cannot collide.
      // A fixed prefix, because Docker refuses a name that starts with `-` or `.`
      // and an empty or odd label would otherwise end the job as a bare crash.
      const name = `bakery-plugin-${
        spec.name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60)
      }-${crypto.randomUUID().slice(0, 8)}`;
      // Create, wait for it, then start. A single `docker run` creates and starts
      // in one step, so a kill that lands while the daemon is still creating
      // finds nothing to remove and the container appears afterwards and stays.
      // Awaiting the create means a kill always has a container to remove.
      const created = await docker(bin, [
        "create",
        "-i",
        ...harden(name, spec.limits),
        "--volume",
        `${spec.codeDir}:/code:ro`,
        "--workdir",
        "/code",
        "--entrypoint",
        spec.command[0] ?? "",
        image,
        ...spec.command.slice(1),
      ]).catch(() => null);
      if (created === null || created.code !== 0) {
        await docker(bin, ["rm", "-fv", name]).catch(() => undefined);
        throw new Error("PLUGIN_JOB_CREATE_FAILED");
      }
      const child = new Deno.Command(bin, {
        args: ["start", "-a", "-i", name],
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const writer = child.stdin.getWriter();
      const encoder = new TextEncoder();
      const reader = child.stdout
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let removal: Promise<void> | null = null;
      let oomKilled = false;
      // Every caller gets the same promise, so one that arrives while the
      // removal is still running waits for it instead of returning early.
      const kill = (): Promise<void> => {
        removal ??= (async () => {
          // End the docker client first. A job that floods stdout leaves it
          // blocked on a full pipe nobody reads, and a blocked client stalls
          // the container's removal as well.
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          await reader.cancel().catch(() => undefined);
          // Read the memory-kill flag before the container goes away.
          const inspected = await docker(bin, [
            "inspect",
            "-f",
            "{{.State.OOMKilled}}",
            name,
          ]).catch(() => null);
          oomKilled = inspected?.stdout.trim() === "true";
          await docker(bin, ["rm", "-fv", name]).catch(() => undefined);
        })();
        return removal;
      };
      async function* lines(): AsyncGenerator<string> {
        let pending = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          // A line the job never ends is cut off by the host's line cap.
          if (
            byteLength(pending) > spec.limits.lineBytes &&
            !pending.includes("\n")
          ) {
            yield pending;
            return;
          }
          let at: number;
          while ((at = pending.indexOf("\n")) >= 0) {
            yield pending.slice(0, at);
            pending = pending.slice(at + 1);
          }
        }
        if (pending.length > 0) yield pending;
      }
      return {
        write: async (line) => {
          try {
            await writer.write(encoder.encode(`${line}\n`));
          } catch {
            // The job already ended; the host reads that from `exited`.
          }
        },
        lines: lines(),
        exited: (async () => {
          const status = await child.status;
          await kill();
          return { code: status.code, oomKilled };
        })(),
        kill,
      };
    },
  };
}
