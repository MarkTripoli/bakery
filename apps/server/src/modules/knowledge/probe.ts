/**
 * Asking a sandboxed subprocess what a stored blob's bytes are (chapter 25
 * §17.6).
 *
 * The server never parses an uploaded file itself. It resolves a blob it owns
 * to a path in the store, hands that path to `infra/server-exec/artifact-probe.sh`
 * and reads back one frame. Everything the subprocess could do to the server is
 * bounded here as well as there, because a limit that only exists inside a
 * child is a limit the child chooses:
 *
 * - **Isolation.** The launcher runs the worker in a systemd transient unit
 *   with `PrivateNetwork`, a memory cap, a CPU quota and a wall-clock limit. On
 *   a host with no user bus that unit cannot start, and this module reports
 *   `sandbox-unavailable` rather than running the parser in-process.
 * - **Time.** A child that outlives its budget is killed here too; the unit's
 *   `RuntimeMaxSec` is the backstop, not the only bound.
 * - **Output.** The frame is read with a cap, so a worker that writes for ever
 *   cannot fill the server's memory.
 * - **Input.** Only a path and a size cross into the child, and the size is
 *   compared with the blob row before the child is started: a 900 MB file is
 *   described as too large by the server, which costs it nothing.
 */
import {
  ARTIFACT_PROBE_MEMORY_MAX_BYTES,
  ARTIFACT_PROBE_TIMEOUT_MS,
  type ArtifactProbeFailureCode,
  ArtifactProbeFrameSchema,
  type ArtifactProbeResult,
} from "@bakery/contracts/artifact-probe";

/** The unit properties the launcher pins; the test holds both lists equal. */
export const ARTIFACT_PROBE_UNIT_PROPERTIES: readonly string[] = Object.freeze([
  `--property=MemoryMax=${ARTIFACT_PROBE_MEMORY_MAX_BYTES}`,
  "--property=MemorySwapMax=0",
  "--property=TasksMax=32",
  "--property=CPUQuota=100%",
  `--property=RuntimeMaxSec=${ARTIFACT_PROBE_TIMEOUT_MS / 1000}s`,
  "--property=TimeoutStopSec=100ms",
  "--property=KillMode=control-group",
  "--property=SendSIGKILL=yes",
  "--property=OOMPolicy=kill",
  "--property=PrivateNetwork=yes",
  "--property=RestrictAddressFamilies=AF_UNIX",
  "--property=ProtectSystem=strict",
  "--property=ProtectHome=read-only",
  "--property=PrivateDevices=yes",
  "--property=NoNewPrivileges=yes",
  "--property=LockPersonality=yes",
  "--property=RestrictSUIDSGID=yes",
  "--property=RemoveIPC=yes",
  "--property=TemporaryFileSystem=/tmp:ro",
  "--property=InaccessiblePaths=/var/tmp",
]);

const repositoryRoot = new URL("../../../../", import.meta.url);

/** Path the server's `--allow-run` grant may name, and nothing else. */
export const SERVER_ARTIFACT_PROBE_LAUNCHER =
  new URL("infra/server-exec/artifact-probe.sh", repositoryRoot).pathname;

const FRAME_LIMIT = 4_096;

export type ArtifactProbeInput = Readonly<{
  /** Absolute path to the bytes, already resolved from an owned blob. */
  path: string;
  /** The size the blob row records, checked before the child starts. */
  sizeBytes: number;
}>;

export type ArtifactProbeOptions = Readonly<{
  /** Overridden by tests; production uses the fixed launcher. */
  launcherPath?: string;
  timeoutMs?: number;
}>;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > FRAME_LIMIT) {
      overflow = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow };
}

function refused(code: ArtifactProbeFailureCode, limit?: number) {
  return limit === undefined
    ? { status: "refused", code } as const
    : { status: "refused", code, limit } as const;
}

/**
 * Runs the probe and always answers with a result: a refusal here is a fact
 * about this attempt, and the caller stores it rather than retrying into the
 * same wall.
 */
export async function probeArtifactBytes(
  input: ArtifactProbeInput,
  options: ArtifactProbeOptions = {},
): Promise<ArtifactProbeResult> {
  const launcherPath = options.launcherPath ?? SERVER_ARTIFACT_PROBE_LAUNCHER;
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PROBE_TIMEOUT_MS;

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(launcherPath, {
      args: [crypto.randomUUID()],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    // The launcher could not be started at all: a missing file or a host with
    // no systemd. Either way nothing ran, so nothing was measured.
    return refused("sandbox-unavailable");
  }

  const request = new TextEncoder().encode(
    JSON.stringify({ path: input.path, sizeBytes: input.sizeBytes }),
  );
  const writer = child.stdin.getWriter();
  await writer.write(request).catch(() => {});
  await writer.close().catch(() => {});

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      // Signals reach the launcher's own process group, so a child of the
      // launcher cannot outlive it and keep the pipes open. `child.status` is
      // what this awaits, and it stays pending while a grandchild holds stdout.
      child.kill("SIGKILL");
    } catch {
      // The child may already have exited.
    }
  }, timeoutMs);

  try {
    // Race the child against its own budget: a launcher whose grandchild holds
    // the pipes open would otherwise keep `child.status` pending for ever, and
    // the timer above would have changed nothing.
    const elapsed = await Promise.race([
      Promise.all([readBounded(child.stdout), child.status]).then((
        [out, st],
      ) => ({
        out,
        st,
        late: false,
      })),
      new Promise<{ late: true }>((resolve) =>
        setTimeout(() => resolve({ late: true }), timeoutMs + 1_000)
      ),
    ]);
    if (elapsed.late || timedOut) return refused("timeout", timeoutMs);
    const { out: output, st: status } = elapsed;
    // 69 is EX_UNAVAILABLE from the launcher: no user bus, no systemd.
    if (status.code === 69) return refused("sandbox-unavailable");
    if (status.code === 137) {
      return refused("memory", ARTIFACT_PROBE_MEMORY_MAX_BYTES);
    }
    if (output.overflow) return refused("malformed");
    if (!status.success || output.bytes.byteLength === 0) {
      return refused("unreadable");
    }
    const parsed = ArtifactProbeFrameSchema.safeParse(
      JSON.parse(new TextDecoder().decode(output.bytes)),
    );
    // A frame that does not match the schema is this code's defect, not the
    // file's, and saying so is more useful than a confident wrong answer.
    if (!parsed.success) return refused("malformed");
    return parsed.data.result;
  } catch {
    return refused("unreadable");
  } finally {
    clearTimeout(timer);
  }
}
