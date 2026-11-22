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
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PgDatabase } from "../../platform/database.ts";
import {
  ARTIFACT_PROBE_MAX_BYTES,
  ARTIFACT_PROBE_MEMORY_MAX_BYTES,
  ARTIFACT_PROBE_TIMEOUT_MS,
  type ArtifactProbeFailureCode,
  ArtifactProbeFrameSchema,
  type ArtifactProbeResult,
  ArtifactProbeSelfTestFrameSchema,
} from "@bakery/contracts/artifact-probe";
import { readBlobProbe, writeBlobProbe } from "./blob-probes.ts";
import { spoolBlob, type SpooledBlob, SpoolUnavailableError } from "./spool.ts";

/** The unit properties the launcher pins; the test holds both lists equal. */
export const ARTIFACT_PROBE_UNIT_PROPERTIES: readonly string[] = Object.freeze([
  // The unit must start where Deno can resolve the worker's imports and its
  // lockfile: a bare specifier is resolved from the working directory, not from
  // the module's path, so a unit that starts in $HOME fails with 226 before it
  // reads a byte. The value is the repository root, which the launcher computes.
  // `ProtectSystem=strict` is declared to make it read-only, but a host whose
  // user manager cannot set up the mount runs it writable and says so only in
  // the journal -- which is why `sandboxHoldsFilesystem` asks instead of
  // assuming.
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
  // The one directory outside the repository the unit may read: where the
  // server spools a blob whose store cannot hand over a path. The launcher adds
  // it only when the deployment configured one, which is why the placeholder is
  // compared rather than a path -- a hard-coded directory here would be a grant
  // the server believes it has and the launcher never makes.
  "--property=ReadOnlyPaths=@SPOOL_DIR@",
]);

// Five levels, not four: this file sits in `modules/knowledge/`, one directory
// deeper than `platform/server-exec.ts`, which is where the four-level form was
// copied from. With four the constant named `<repo>/apps/infra/...`, which does
// not exist, so every probe without an explicit launcher path answered
// `sandbox-unavailable` -- and every test passed one, so nothing noticed.
const repositoryRoot = new URL("../../../../../", import.meta.url);

/** Path the server's `--allow-run` grant may name, and nothing else. */
export const SERVER_ARTIFACT_PROBE_LAUNCHER =
  new URL("infra/server-exec/artifact-probe.sh", repositoryRoot).pathname;

const FRAME_LIMIT = 4_096;

export type ArtifactProbeInput = Readonly<{
  /** Absolute path to the bytes, already resolved from an owned blob. */
  path?: string;
  /**
   * Bytes to spool when the store cannot hand over a path (S3, bytea). Read
   * lazily so a refusal about the host or the size costs no read at all.
   */
  readBytes?: () => Promise<Uint8Array>;
  /** The size the blob row records, checked before the child starts. */
  sizeBytes: number;
}>;

export type ArtifactProbeOptions = Readonly<{
  /** Overridden by tests; production uses the fixed launcher. */
  launcherPath?: string;
  timeoutMs?: number;
  /**
   * Where to put a copy when the input has bytes instead of a path
   * (`BAKERY_PROBE_SPOOL_DIR`, read through `RuntimeConfig`). Absent means a
   * store that cannot hand over a path cannot be probed: the answer is
   * `sandbox-unavailable`, never a description produced some other way.
   *
   * It must not live under a home directory. The launcher mounts it as
   * `ReadOnlyPaths=` inside a unit that also sets `ProtectHome=read-only`, so a
   * spool under `/home` is readable by the server and invisible to the sandbox,
   * which reads as an unreadable file rather than a misconfigured host. A private
   * directory under the runtime dir (`/run/user/<uid>/...`, mode 700) is what the
   * launcher was proven with on mini1.
   */
  spoolDir?: string;
  /**
   * How long a "not sealed" preflight answer is believed before the host is
   * asked again. Tests set it to 0 to re-ask immediately; production uses the
   * module's own window.
   */
  preflightRetryMs?: number;
}>;

async function readBounded(
  stream: AsyncIterable<Uint8Array>,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for await (const value of stream) {
    if (size + value.byteLength > FRAME_LIMIT) {
      overflow = true;
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
  spoolDir?: string,
): Promise<LauncherExchange> {
  let child: ChildProcess;
  try {
    child = spawn(
      launcherPath,
      [
        randomUUID(),
        ...(spoolDir === undefined ? [] : [`--spool-dir=${spoolDir}`]),
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        // Its own process group, so the kill below reaches the launcher and
        // anything it started: a grandchild holding the pipes open would
        // otherwise keep this waiting for ever.
        detached: true,
      },
    );
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

  // `spawn` reports a missing launcher as an event, not a throw, and an exit
  // that never comes must not hang the caller: both settle this promise.
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("error", () => resolve({ code: null, signal: null }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  child.stdin?.on("error", () => {});
  child.stdin?.end(JSON.stringify(request));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group may already be gone; the process itself may not be.
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
    }
  }, timeoutMs);

  try {
    // Race the child against its own budget: a launcher whose grandchild holds
    // the pipes open would otherwise keep the exit pending for ever, and the
    // timer above would have changed nothing.
    const elapsed = await Promise.race([
      Promise.all([
        readBounded(child.stdout ?? (async function* () {})()),
        exited,
      ]).then((
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
      // A unit killed by a signal has no exit code of its own; 137 is what the
      // shell and systemd report for SIGKILL, and the memory refusal is read
      // from it.
      code: elapsed.st.code ??
        (elapsed.st.signal === "SIGKILL" ? 137 : null),
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
/**
 * How long a "not sealed" answer is believed before the host is asked again.
 *
 * A sealed answer is a property of the machine and is kept for the process. An
 * unsealed one may be a bad minute -- a bus that was restarting, a unit that
 * lost a race -- and caching it for the process lifetime would disable probing
 * until the server restarted. Meanwhile the answer stays fail-closed: every
 * probe in the window is refused, and the window is short.
 */
const PREFLIGHT_RETRY_MS = 30_000;

type PreflightEntry = {
  readonly promise: Promise<boolean>;
  /** Undefined while the question is still being asked. */
  sealed?: boolean;
  askedAt: number;
};

const preflight = new Map<string, PreflightEntry>();

/** Test-only: drops the cached answers so the next call asks the host again. */
export function forgetSandboxPreflight(): void {
  preflight.clear();
}

function cachedPreflight(
  question: "network" | "filesystem",
  options: ArtifactProbeOptions,
  ask: (launcherPath: string, timeoutMs: number) => Promise<boolean>,
): Promise<boolean> {
  const launcherPath = options.launcherPath ?? SERVER_ARTIFACT_PROBE_LAUNCHER;
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PROBE_TIMEOUT_MS;
  const retryMs = options.preflightRetryMs ?? PREFLIGHT_RETRY_MS;
  // Both seals are properties of the machine, so both are cached per process,
  // and the question is part of the key: a host can hold one and not the other.
  const key = `${question}\u0000${launcherPath}\u0000${timeoutMs}`;
  const now = Date.now();
  const cached = preflight.get(key);
  if (cached !== undefined) {
    // Sealed is kept. Unsealed is kept only for the retry window, and an answer
    // still in flight is shared rather than asked twice.
    if (cached.sealed === true) return cached.promise;
    if (cached.sealed === undefined) return cached.promise;
    if (now - cached.askedAt < retryMs) return cached.promise;
  }
  const entry: PreflightEntry = {
    promise: ask(launcherPath, timeoutMs),
    askedAt: now,
  };
  entry.promise.then((sealed) => {
    // Only the entry that is still current may record its answer: a slow first
    // ask must not overwrite a newer one.
    if (preflight.get(key) === entry) {
      entry.sealed = sealed;
      entry.askedAt = Date.now();
    }
  }).catch(() => {});
  preflight.set(key, entry);
  return entry.promise;
}

export function sandboxHoldsNetwork(
  options: ArtifactProbeOptions = {},
): Promise<boolean> {
  return cachedPreflight("network", options, askSandboxHoldsNetwork);
}

/**
 * Whether the unit is read-only where it matters.
 *
 * The same lesson as the network, on the other side: a host whose user manager
 * cannot set up read-only mounts accepts `ProtectSystem=strict` and
 * `ReadOnlyPaths=` and runs the unit with a writable filesystem, saying so only
 * in the journal. A parser reading a stranger's file must not be able to write
 * to the repository while it does, so the server asks the only question with an
 * answer -- can a file be created? -- and refuses to name a file when it can.
 */
export function sandboxHoldsFilesystem(
  options: ArtifactProbeOptions = {},
): Promise<boolean> {
  return cachedPreflight("filesystem", options, askSandboxHoldsFilesystem);
}

async function askSandboxHoldsFilesystem(
  launcherPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const exchange = await runLauncher(
    { selfTest: "filesystem" },
    launcherPath,
    timeoutMs,
  );
  // Every uncertain answer is a "no", exactly as for the network: a sandbox that
  // cannot be asked is not a sandbox that can be trusted, and the cost of being
  // wrong here is a missing preview rather than a writable unit reading a
  // stranger's file.
  if (exchange.late || exchange.timedOut) return false;
  if (exchange.code === null) return false;
  if (SANDBOX_SETUP_FAILURES.includes(exchange.code)) return false;
  if (exchange.overflow || exchange.bytes.byteLength === 0) return false;
  try {
    const parsed = ArtifactProbeSelfTestFrameSchema.safeParse(
      JSON.parse(new TextDecoder().decode(exchange.bytes)),
    );
    if (!parsed.success) return false;
    if (parsed.data.selfTest !== "filesystem") return false;
    // Same rule as the network: a permission error is not a seal.
    if (parsed.data.detail === "NotCapable") return false;
    return parsed.data.writable === false;
  } catch {
    return false;
  }
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
    if (parsed.data.selfTest !== "network") return false;
    // "NotCapable" is Deno's own permission error, not the sandbox: a worker
    // started without `--allow-net` answers it on every host, so accepting it
    // would make this preflight unable to fail. QA found exactly that on mini1.
    if (parsed.data.detail === "NotCapable") return false;
    return parsed.data.reachable === false;
  } catch {
    return false;
  }
}

/**
 * Either a path the sandbox may read, or the refusal that stops this attempt.
 *
 * The spool is checked before the bytes are read, so an oversize blob is
 * refused without its bytes ever being loaded into the server.
 */
async function resolveInput(
  input: ArtifactProbeInput,
  options: ArtifactProbeOptions,
): Promise<
  | { path: string; release: () => Promise<void> }
  | { refused: ArtifactProbeResult }
> {
  if (input.path !== undefined) {
    return { path: input.path, release: async () => {} };
  }
  if (input.sizeBytes > ARTIFACT_PROBE_MAX_BYTES) {
    return { refused: refused("too-large", ARTIFACT_PROBE_MAX_BYTES) };
  }
  if (input.readBytes === undefined) {
    // Nothing to spool and nothing to read: this is a caller defect, and saying
    // "the sandbox is unavailable" is the safe answer because it offers no
    // preview rather than an invented one.
    return { refused: refused("sandbox-unavailable") };
  }
  if (options.spoolDir === undefined) {
    return { refused: refused("sandbox-unavailable") };
  }
  let spooled: SpooledBlob;
  try {
    const bytes = await input.readBytes();
    spooled = await spoolBlob({
      dir: options.spoolDir,
      bytes,
      sizeBytes: input.sizeBytes,
      maxBytes: ARTIFACT_PROBE_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof SpoolUnavailableError) {
      return { refused: refused("sandbox-unavailable") };
    }
    throw error;
  }
  return { path: spooled.path, release: spooled.release };
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
  return (await probeArtifactAttempt(input, options)).result;
}

/** The same attempt, with the answer's subject kept for the caller that stores. */
export async function probeArtifactAttempt(
  input: ArtifactProbeInput,
  options: ArtifactProbeOptions = {},
): Promise<ProbeAttempt> {
  // A size the server already knows is decided before anything else: it needs
  // no sandbox to answer, it reads nothing, and "too large" is a more useful
  // answer than "no sandbox" for a file nobody was going to read anyway.
  if (input.sizeBytes > ARTIFACT_PROBE_MAX_BYTES) {
    return {
      result: refused("too-large", ARTIFACT_PROBE_MAX_BYTES),
      about: "file",
    };
  }
  // Fail closed before the file is touched: if the sandbox is not sealed on
  // this host, the answer is about the host, not the bytes, and the bytes are
  // never handed to a process that could reach the network with them.
  if (!(await sandboxHoldsNetwork(options))) {
    return { result: refused("sandbox-unavailable"), about: "host" };
  }
  // Both seals, in the same order, for the same reason: a writable sandbox
  // reading a stranger's file can leave something behind, and the spool copy is
  // exactly the file it would be positioned to overwrite.
  if (!(await sandboxHoldsFilesystem(options))) {
    return { result: refused("sandbox-unavailable"), about: "host" };
  }

  const resolved = await resolveInput(input, options);
  if ("refused" in resolved) {
    // A size the server already knew is a fact about the file; a spool it could
    // not use is a fact about the host.
    return {
      result: resolved.refused,
      about: resolved.refused.status === "refused" &&
          resolved.refused.code === "too-large"
        ? "file"
        : "host",
    };
  }
  try {
    return await readFrame(resolved.path, input.sizeBytes, options);
  } finally {
    // Every path through this function -- a refusal, a crash, a timeout, a
    // cancelled request -- releases the copy before the caller sees an answer.
    await resolved.release();
  }
}

/**
 * What a probe attempt answered, and what the answer is about.
 *
 * `about` is the difference between a fact worth keeping and an afternoon worth
 * forgetting. A refusal about the FILE -- too large, unreadable, malformed bytes
 * -- is true tomorrow and is stored. A refusal about the HOST -- a timeout, a
 * launcher that exited non-zero, a frame that did not parse, a sandbox that
 * could not be asked -- says nothing about the bytes, and storing it would turn
 * one bad minute into a permanent verdict on a healthy file.
 */
type ProbeAttempt = {
  readonly result: ArtifactProbeResult;
  readonly about: "file" | "host";
};

async function readFrame(
  path: string,
  sizeBytes: number,
  options: ArtifactProbeOptions,
): Promise<ProbeAttempt> {
  const exchange = await runLauncher(
    { path, sizeBytes },
    options.launcherPath ?? SERVER_ARTIFACT_PROBE_LAUNCHER,
    options.timeoutMs ?? ARTIFACT_PROBE_TIMEOUT_MS,
    // A spooled copy is only readable because the launcher was told about the
    // directory that holds it. Passing the path without the grant would produce
    // an `unreadable` answer for a file that is perfectly fine, so the two
    // travel together.
    // The trailing separator matters: `/var/lib/bakery-evil` is not inside
    // `/var/lib/bakery`, and a prefix test without it would grant the first
    // while naming the second.
    options.spoolDir !== undefined &&
      path.startsWith(`${options.spoolDir}/`)
      ? options.spoolDir
      : undefined,
  );
  if (exchange.late || exchange.timedOut) {
    return {
      result: refused(
        "timeout",
        options.timeoutMs ?? ARTIFACT_PROBE_TIMEOUT_MS,
      ),
      about: "host",
    };
  }
  if (exchange.overflow) {
    // The worker wrote more than the bound and this side stopped reading on
    // purpose. That is a defect in this code, not a property of the file, and it
    // is decided before the exit code: a child killed by the broken pipe has no
    // code of its own, and reading that as "the host could not run the probe"
    // would hide the flood behind a host fault.
    return { result: refused("malformed"), about: "host" };
  }
  if (exchange.code === null) {
    return { result: refused("sandbox-unavailable"), about: "host" };
  }
  if (SANDBOX_SETUP_FAILURES.includes(exchange.code)) {
    return { result: refused("sandbox-unavailable"), about: "host" };
  }
  if (exchange.code === 137) {
    // The unit was killed for using too much memory, which the file's own size
    // and shape caused: that is a fact about the bytes, and it is kept.
    return {
      result: refused("memory", ARTIFACT_PROBE_MEMORY_MAX_BYTES),
      about: "file",
    };
  }
  if (exchange.code !== 0 || exchange.bytes.byteLength === 0) {
    // The launcher or the worker failed without answering. Nothing was learned
    // about the bytes, so nothing is stored about them.
    return { result: refused("unreadable"), about: "host" };
  }
  try {
    const parsed = ArtifactProbeFrameSchema.safeParse(
      JSON.parse(new TextDecoder().decode(exchange.bytes)),
    );
    // A frame that does not match the schema is this code's defect, not the
    // file's, and saying so is more useful than a confident wrong answer.
    if (!parsed.success) return { result: refused("malformed"), about: "host" };
    return { result: parsed.data.result, about: "file" };
  } catch {
    return { result: refused("unreadable"), about: "host" };
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
  input:
    & Readonly<{
      organizationId: string;
      blobId: string;
      force?: boolean;
    }>
    & ArtifactProbeInput,
  options: ArtifactProbeOptions = {},
): Promise<ArtifactProbeResult> {
  if (input.force !== true) {
    const stored = await readBlobProbe(database, input);
    if (stored !== null) return stored.result;
  }
  const attempt = await probeArtifactAttempt(input, options);
  // Only a refusal about the file is stored. A timeout, a launcher exit or any
  // other host-side answer is this attempt's, not the blob's: storing it would
  // make one bad minute a permanent verdict on a healthy file.
  if (attempt.about === "file") {
    await writeBlobProbe(database, { ...input, result: attempt.result });
  }
  return attempt.result;
}
