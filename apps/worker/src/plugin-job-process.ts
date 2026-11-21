import type {
  ContainmentProbe,
  PluginJobLimits,
  RunningPluginJob,
} from "./plugin-job-runtime.ts";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;

/**
 * Starts one contained job as a child process and wraps it as a
 * `RunningPluginJob`: one JSON line in, one line out, and a kill that always
 * waits for the boundary to be gone. The runtime supplies the command that
 * builds the boundary and a `cleanup` that tears down whatever outlives the
 * client process (a container, for Docker).
 */
export function startProcessJob(
  options: Readonly<{
    bin: string;
    args: readonly string[];
    limits: PluginJobLimits;
    /** Runs after the client is ended; returns whether memory limits killed the job. */
    cleanup(): Promise<{ oomKilled: boolean }>;
  }>,
): RunningPluginJob {
  const child = new Deno.Command(options.bin, {
    args: [...options.args],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let removal: Promise<void> | null = null;
  let oomKilled = false;

  // Every caller gets the same promise, so one that arrives while the removal
  // is still running waits for it instead of returning early.
  const kill = (): Promise<void> => {
    removal ??= (async () => {
      // End the client first. A job that floods stdout leaves it blocked on a
      // full pipe nobody reads, and a blocked client stalls the teardown too.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await reader.cancel().catch(() => undefined);
      oomKilled = (await options.cleanup().catch(() => ({ oomKilled: false })))
        .oomKilled;
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
        byteLength(pending) > options.limits.lineBytes &&
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
}

/**
 * Runs inside the probe boundary, in plain `sh` so any image works. It
 * counts network interfaces other than loopback and reads whether the root
 * filesystem is mounted read-only, then reports both. The mount table is the
 * proof, not a write attempt: a job's user usually cannot write `/` anyway, so
 * a failed write would pass even when `--read-only` was dropped.
 */
export const PROBE_PROGRAM = [
  "extra=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | grep -v '^lo$' | wc -l | tr -d ' ')",
  `opts=$(awk '$2=="/" {o=$4} END {print o}' /proc/mounts)`,
  'case ",$opts," in *,ro,*) ro=true;; *) ro=false;; esac',
  'echo "{\\"extra\\":$extra,\\"readOnlyRoot\\":$ro}"',
].join("\n");

/**
 * Reads the probe program's answer and decides. Shared by every runtime so
 * none can judge its own boundary more leniently than another.
 */
export function judgeProbeOutput(
  runtime: string,
  stdout: string,
): ContainmentProbe {
  const unsupported = (reason: string): ContainmentProbe => ({
    supported: false,
    runtime,
    reason,
  });
  let seen: { extra?: unknown; readOnlyRoot?: unknown };
  try {
    seen = JSON.parse(stdout.trim().split("\n").pop() ?? "");
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
  return { supported: true, runtime };
}
