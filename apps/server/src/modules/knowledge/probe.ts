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
import type { PgDatabase } from "../../platform/database.ts";
import {
  ARTIFACT_PROBE_MEMORY_MAX_BYTES,
  ARTIFACT_PROBE_TIMEOUT_MS,
  type ArtifactProbeFailureCode,
  ArtifactProbeFrameSchema,
  type ArtifactProbeResult,
  ArtifactProbeSelfTestFrameSchema,
} from "@bakery/contracts/artifact-probe";
import { readBlobProbe, writeBlobProbe } from "./blob-probes.ts";

/** The unit properties the launcher pins; the test holds both lists equal. */
export const ARTIFACT_PROBE_UNIT_PROPERTIES: readonly string[] = Object.freeze([
  // The unit must start where Deno can resolve the worker's imports and its
  // lockfile: a bare specifier is resolved from the working directory, not from
  // the module's path, so a unit that starts in $HOME fails with 226 before it
  // reads a byte. The value is the repository root, which the launcher computes
  // and which ProtectSystem=strict also makes read-only.
  "--property=WorkingDirectory=@REPO_ROOT@",
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

type LauncherExchange = Readonly<{
  /** The launcher's own exit code, or null when it was never started. */
  code: number | null;
  bytes: Uint8Array;
  overflow: boolean;
  timedOut: boolean;
  /** The exchange outlived its budget and was abandoned. */
  late: boolean;
}>;

/**
 * One exchange with the launcher: send a frame, bounded read, bounded wait.
 *
 * Both the probe and the sandbox self-test go through this, so the bounds are
 * the same for asking "what is this file" and for asking "is this sandbox
 * sealed". A preflight with weaker bounds than the thing it guards would let a
 * hostile file hold the server open through the check instead of the probe.
 */
async function runLauncher(
  request: unknown,
  launcherPath: string,
  timeoutMs: number,
): Promise<LauncherExchange> {
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
    return {
      code: null,
      bytes: new Uint8Array(),
      overflow: false,
      timedOut: false,
      late: false,
    };
  }

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(request))).catch(
    () => {},
  );
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
        late: false as const,
      })),
      new Promise<{ late: true }>((resolve) =>
        setTimeout(() => resolve({ late: true }), timeoutMs + 1_000)
      ),
    ]);
    if (elapsed.late) {
      return {
        code: null,
        bytes: new Uint8Array(),
        overflow: false,
        timedOut: false,
        late: true,
      };
    }
    return {
      code: elapsed.st.code,
      bytes: elapsed.out.bytes,
      overflow: elapsed.out.overflow,
      timedOut,
      late: false,
    };
  } catch {
    return {
      code: null,
      bytes: new Uint8Array(),
      overflow: false,
      timedOut,
      late: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exit codes that mean the host could not build the unit at all.
 *
 * 69 is the launcher's own EX_UNAVAILABLE; 218 and 226 are what systemd returns
 * when it cannot set up the namespaces the properties ask for. They arrive as
 * the unit's status, which is why they are read here as well as in the
 * launcher: a host that cannot build the sandbox must never look like a file
 * that could not be read.
 */
const SANDBOX_SETUP_FAILURES: readonly number[] = Object.freeze([69, 218, 226]);

/**
 * Whether a worker inside the unit is actually cut off from the network.
 *
 * The properties say `PrivateNetwork=yes`; on some hosts systemd accepts that
 * and then logs "proceeding without", leaving the unit on the host's own
 * network. The unit's configuration therefore cannot answer this question and
 * the kernel must: a connect that succeeds means there is no sandbox, and
 * everything the probe would do afterwards would be done with the server's
 * privileges.
 *
 * Cached per process, because the answer is a property of the machine and not
 * of the file: re-asking for every probe would pay a unit start each time to
 * learn the same thing. `forgetSandboxPreflight` exists for tests, which need
 * to ask twice in one process.
 */
const preflight = new Map<string, Promise<boolean>>();

/** Test-only: drops the cached answer so the next call asks the host again. */
export function forgetSandboxPreflight(): void {
  preflight.clear();
}

export function sandboxHoldsNetwork(
  options: ArtifactProbeOptions = {},
): Promise<boolean> {
  const launcherPath = options.launcherPath ?? SERVER_ARTIFACT_PROBE_LAUNCHER;
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PROBE_TIMEOUT_MS;
  const key = `${launcherPath}\u0000${timeoutMs}`;
  const cached = preflight.get(key);
  if (cached !== undefined) return cached;
  const answer = askSandboxHoldsNetwork(launcherPath, timeoutMs);
  preflight.set(key, answer);
  return answer;
}

async function askSandboxHoldsNetwork(
  launcherPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const exchange = await runLauncher(
    { selfTest: "network" },
    launcherPath,
    timeoutMs,
  );
  // Everything that is not a clear "the connect failed" is a "no": a sandbox
  // that cannot be asked is not a sandbox that can be trusted, and the cost of
  // being wrong in this direction is a missing preview rather than a stranger's
  // file running with the server's network.
  if (exchange.late || exchange.timedOut) return false;
  if (exchange.code === null) return false;
  if (SANDBOX_SETUP_FAILURES.includes(exchange.code)) return false;
  if (exchange.overflow || exchange.bytes.byteLength === 0) return false;
  try {
    const parsed = ArtifactProbeSelfTestFrameSchema.safeParse(
      JSON.parse(new TextDecoder().decode(exchange.bytes)),
    );
    if (!parsed.success) return false;
    return parsed.data.reachable === false;
  } catch {
    return false;
  }
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

  // Fail closed before the file is touched: if the sandbox is not sealed on
  // this host, the answer is about the host, not the bytes, and the bytes are
  // never handed to a process that could reach the network with them.
  if (!(await sandboxHoldsNetwork(options))) {
    return refused("sandbox-unavailable");
  }

  const exchange = await runLauncher(
    { path: input.path, sizeBytes: input.sizeBytes },
    launcherPath,
    timeoutMs,
  );
  if (exchange.late || exchange.timedOut) return refused("timeout", timeoutMs);
  if (exchange.code === null) return refused("sandbox-unavailable");
  if (SANDBOX_SETUP_FAILURES.includes(exchange.code)) {
    return refused("sandbox-unavailable");
  }
  if (exchange.code === 137) {
    return refused("memory", ARTIFACT_PROBE_MEMORY_MAX_BYTES);
  }
  if (exchange.overflow) return refused("malformed");
  if (exchange.code !== 0 || exchange.bytes.byteLength === 0) {
    return refused("unreadable");
  }
  try {
    const parsed = ArtifactProbeFrameSchema.safeParse(
      JSON.parse(new TextDecoder().decode(exchange.bytes)),
    );
    // A frame that does not match the schema is this code's defect, not the
    // file's, and saying so is more useful than a confident wrong answer.
    if (!parsed.success) return refused("malformed");
    return parsed.data.result;
  } catch {
    return refused("unreadable");
  }
}

/**
 * The probe result for a blob: the stored one when there is one, otherwise a
 * fresh run whose answer is recorded.
 *
 * `force` re-runs even when a row exists, which is what an operator asks for
 * after a describer changes — the bytes are the same, so nothing else would
 * ever invalidate the row. A `sandbox-unavailable` answer is never stored, so a
 * host that comes back to life is asked again by the next reader without
 * anything having to clear a cache.
 */
export async function probeBlob(
  database: Pick<PgDatabase, "query">,
  input: {
    organizationId: string;
    blobId: string;
    path: string;
    sizeBytes: number;
    force?: boolean;
  },
  options: ArtifactProbeOptions = {},
): Promise<ArtifactProbeResult> {
  if (input.force !== true) {
    const stored = await readBlobProbe(database, input);
    if (stored !== null) return stored.result;
  }
  const result = await probeArtifactBytes(input, options);
  await writeBlobProbe(database, { ...input, result });
  return result;
}
