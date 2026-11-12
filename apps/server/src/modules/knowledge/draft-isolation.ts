import {
  SERVER_DRAFT_SYSTEMD_LAUNCHER,
  systemdLauncherArgs,
} from "../../platform/server-exec.ts";
import { readDraftIsolationLauncher } from "@bakery/config";
import { DRAFT_LIMITS, type DraftCandidate } from "./drafts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const READY = encoder.encode("READY\n");
const WORKER_OUTPUT_LIMIT = DRAFT_LIMITS.stateBytes + DRAFT_LIMITS.bodyBytes +
  DRAFT_LIMITS.updateBytes + DRAFT_LIMITS.replacementBytes +
  DRAFT_LIMITS.metadataBytes + 64;
const STDERR_LIMIT = DRAFT_LIMITS.metadataBytes;
const DIAGNOSTIC_COMMAND_LIMIT = 1_024;
const NAMESPACE_STATUS_LIMIT = 4_096;
const DIAGNOSTIC_COMMAND_TIMEOUT_MS = 250;
const NAMESPACE_VALUE_LIMIT = 64;
const NAMESPACE_PREREQUISITE_PATHS = {
  unprivilegedUsernsClone: "/proc/sys/kernel/unprivileged_userns_clone",
  maxUserNamespaces: "/proc/sys/user/max_user_namespaces",
  apparmorRestrictUnprivilegedUserns:
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
} as const;

type NamespacePrerequisitePath = typeof NAMESPACE_PREREQUISITE_PATHS[
  keyof typeof NAMESPACE_PREREQUISITE_PATHS
];

export type DraftIsolationFailureKind =
  | "precondition"
  | "unprocessable"
  | "limit"
  | "timeout"
  | "unavailable";

export type DraftStartupFailureClass =
  | "cache"
  | "executable"
  | "hardening"
  | "source"
  | "unknown"
  | "user-manager";

type DiagnosticObservation<T> =
  | { status: "observed"; value: T }
  | {
    status: "denied" | "invalid" | "missing" | "overflow" | "unavailable";
  };

type NamespaceUnmatchedReason =
  | "format-unrecognized"
  | "known-errno-absent"
  | "namespace-stage-absent"
  | "probe-overflow"
  | "probe-timeout"
  | "probe-unavailable";

type NamespaceProbeOutcome = {
  status: "failed" | "timeout" | "overflow" | "no-match" | "matched";
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  unmatchedReason?: NamespaceUnmatchedReason;
  namespaceStageSeen?: boolean;
  knownErrnoSeen?: boolean;
};

type UnmatchedNamespaceProbeOutcome = NamespaceProbeOutcome & {
  status: "failed" | "timeout" | "overflow" | "no-match";
  unmatchedReason: NamespaceUnmatchedReason;
};

type NamespaceSetupMatch = {
  status: "denied" | "failed" | "missing";
  operation:
    | "cgroup"
    | "ipc"
    | "mount"
    | "namespace"
    | "network"
    | "pid"
    | "user"
    | "uts";
  errno:
    | "E2BIG"
    | "EACCES"
    | "EAGAIN"
    | "EBADF"
    | "EBUSY"
    | "EEXIST"
    | "EINVAL"
    | "EIO"
    | "ELOOP"
    | "EMFILE"
    | "ENAMETOOLONG"
    | "ENFILE"
    | "ENODEV"
    | "ENOENT"
    | "ENOMEM"
    | "ENOSPC"
    | "ENOSYS"
    | "ENOTDIR"
    | "ENOTSUP"
    | "ENXIO"
    | "EPERM"
    | "EROFS"
    | "EUSERS";
};

type NamespaceSetupObservation =
  | (NamespaceSetupMatch & {
    probe: NamespaceProbeOutcome & { status: "matched" };
    journalProbe?: never;
  })
  | (NamespaceSetupMatch & {
    probe: UnmatchedNamespaceProbeOutcome;
    journalProbe: NamespaceProbeOutcome & { status: "matched" };
  })
  | {
    status: "unavailable";
    probe: UnmatchedNamespaceProbeOutcome;
    journalProbe: UnmatchedNamespaceProbeOutcome;
  };

export type DraftNamespacePrerequisites = {
  userManagerVersion: DiagnosticObservation<string>;
  namespaceSetup: NamespaceSetupObservation;
  privateUsers: DiagnosticObservation<"no" | "yes">;
  unprivilegedUsernsClone: DiagnosticObservation<number>;
  maxUserNamespaces: DiagnosticObservation<number>;
  apparmorRestrictUnprivilegedUserns: DiagnosticObservation<number>;
};

export type DraftStartupDiagnostic = {
  failureClass: DraftStartupFailureClass;
  exitCode: number;
  signal: number;
  stderrOverflow: boolean;
  namespacePrerequisites?: DraftNamespacePrerequisites;
};

export class DraftIsolationError extends Error {
  override readonly name = "DraftIsolationError";

  constructor(
    readonly kind: DraftIsolationFailureKind,
    message: string,
    readonly startupDiagnostic?: DraftStartupDiagnostic,
  ) {
    super(message);
  }
}

export type IsolatedDraftEdit = {
  mutationId: string;
  startCursor: string;
  endCursor: string;
  expectedText: string;
  expectedDigest: string;
  replacement: string;
};

export type IsolatedDraftSlice = {
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};

export type DraftIsolation = {
  initialize(text: string, signal?: AbortSignal): Promise<DraftCandidate>;
  edit(
    currentState: Uint8Array,
    sourceState: Uint8Array,
    input: IsolatedDraftEdit,
    signal?: AbortSignal,
  ): Promise<DraftCandidate>;
  slice(
    state: Uint8Array,
    startUtf16: number,
    endUtf16: number,
    signal?: AbortSignal,
  ): Promise<IsolatedDraftSlice>;
  /** Imports one untrusted collaboration update into the committed state. */
  importUpdate(
    currentState: Uint8Array,
    update: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DraftCandidate>;
};

type IsolationOptions = {
  /**
   * `systemd` (default): a transient systemd unit with cgroup memory, task and
   * runtime limits and a sandboxed filesystem. `process`: for containers
   * without systemd, the fixed launcher (DRAFT_WORKER_LAUNCHER) execs Deno on
   * the fixed worker module with pinned flags; V8 caps its heap and
   * WebAssembly memory, the wall-clock deadline kills it, and it starts with
   * an empty environment. The launcher is the server's only run grant and
   * cannot be repurposed: it takes one UUID and nothing else (Deno itself
   * would be exec-anything through `deno eval`). In both, the worker runs with
   * no permission flags and remote imports denied: no network, environment,
   * file, FFI, import or subprocess access.
   */
  launcher?: "systemd" | "process";
  /** systemd launcher (infra/server-exec/draft-systemd.sh); tests point at a copy. */
  systemdLauncherPath?: string;
  /** Process launcher only: the fixed launcher script (tests point at a copy). */
  workerLauncherPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  journalctlPath?: string;
  denoPath?: string;
  workerPath?: string;
  /** Wall-clock budget from spawn to the worker's READY (no client bytes yet). */
  startupDeadlineMs?: number;
  /** Wall-clock budget for the work, from READY to exit. */
  totalDeadlineMs?: number;
  namespaceFileReader?: (
    path: NamespacePrerequisitePath,
    limit: number,
  ) => Promise<BoundedDiagnostic>;
};

function encodeFrames(frames: readonly Uint8Array[]): Uint8Array {
  const length = frames.reduce((total, frame) => total + 4 + frame.length, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, false);
    offset += 4;
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

function decodeFrames(value: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let offset = 0;
  while (offset < value.length) {
    if (offset + 4 > value.length) {
      throw new DraftIsolationError("unavailable", "WORKER_HEADER_TRUNCATED");
    }
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > value.length) {
      throw new DraftIsolationError("unavailable", "WORKER_FRAME_TRUNCATED");
    }
    result.push(value.slice(offset, offset + length));
    offset += length;
  }
  return result;
}

async function readReady(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const received = new Uint8Array(READY.length);
  let offset = 0;
  while (offset < received.length) {
    const next = await reader.read();
    if (next.done) {
      throw new DraftIsolationError("unavailable", "WORKER_READY_EOF");
    }
    if (next.value.length > received.length - offset) {
      throw new DraftIsolationError("unavailable", "WORKER_READY_INVALID");
    }
    received.set(next.value, offset);
    offset += next.value.length;
  }
  if (!received.every((byte, index) => byte === READY[index])) {
    throw new DraftIsolationError("unavailable", "WORKER_READY_INVALID");
  }
}

async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > limit) {
      throw new DraftIsolationError("unavailable", `${label}_OVERFLOW`);
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

type BoundedDiagnostic = {
  output: Uint8Array;
  overflow: boolean;
};

async function readBoundedDiagnostic(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<BoundedDiagnostic> {
  const output = new Uint8Array(limit);
  let retained = 0;
  let overflow = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const available = limit - retained;
    const length = Math.min(available, next.value.length);
    if (length > 0) {
      output.set(next.value.subarray(0, length), retained);
      retained += length;
    }
    if (length < next.value.length) overflow = true;
  }
  return { output: output.slice(0, retained), overflow };
}

function startupFailureClass(stderr: Uint8Array): DraftStartupFailureClass {
  const value = new TextDecoder("utf-8").decode(stderr).toLowerCase();
  if (
    value.includes("not found in cache") ||
    value.includes("specifier not found in cache") ||
    value.includes("cached-only")
  ) return "cache";
  if (
    value.includes("failed to connect to bus") ||
    value.includes("user manager") ||
    value.includes("no medium found")
  ) return "user-manager";
  if (
    value.includes("failed to set unit properties") ||
    value.includes("unknown assignment") ||
    value.includes("operation not permitted") ||
    value.includes("access denied") ||
    value.includes("namespace")
  ) return "hardening";
  if (
    value.includes("failed at step exec") ||
    value.includes("failed to locate executable") ||
    value.includes("cannot execute") ||
    value.includes("execve")
  ) return "executable";
  if (
    value.includes("module not found") ||
    value.includes("failed to load module") ||
    value.includes("could not find module") ||
    value.includes("error reading file")
  ) return "source";
  return "unknown";
}

function signalNumber(signal: Deno.Signal | null): number {
  if (signal === null) return 0;
  const signals: Readonly<Record<string, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGURG: 23,
    SIGXCPU: 24,
    SIGXFSZ: 25,
    SIGVTALRM: 26,
    SIGPROF: 27,
    SIGWINCH: 28,
    SIGIO: 29,
    SIGPWR: 30,
    SIGSYS: 31,
  };
  return signals[signal] ?? 0;
}

type BoundedCommandResult = {
  status: Deno.CommandStatus;
  stdout: BoundedDiagnostic;
  stderr: BoundedDiagnostic;
  timedOut: boolean;
};

async function boundedCommand(
  executable: string,
  args: readonly string[],
  outputLimit: number,
): Promise<BoundedCommandResult | undefined> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(executable, {
      args: executable === SERVER_DRAFT_SYSTEMD_LAUNCHER
        ? systemdLauncherArgs(args)
        : [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    return undefined;
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The bounded diagnostic command may already have exited.
    }
  }, DIAGNOSTIC_COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedDiagnostic(child.stdout.getReader(), outputLimit),
      readBoundedDiagnostic(child.stderr.getReader(), outputLimit),
      child.status,
    ]);
    return { status, stdout, stderr, timedOut };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function commandFailureObservation(
  result: BoundedCommandResult,
): DiagnosticObservation<never> {
  if (result.stdout.overflow || result.stderr.overflow) {
    return { status: "overflow" };
  }
  const stderr = new TextDecoder().decode(result.stderr.output).toLowerCase();
  if (
    stderr.includes("access denied") ||
    stderr.includes("permission denied") ||
    stderr.includes("operation not permitted")
  ) return { status: "denied" };
  if (
    stderr.includes("not found") ||
    stderr.includes("could not be found") ||
    stderr.includes("not loaded")
  ) return { status: "missing" };
  return { status: "unavailable" };
}

function numericObservation(
  diagnostic: BoundedDiagnostic,
): DiagnosticObservation<number> {
  if (diagnostic.overflow) return { status: "overflow" };
  const value = new TextDecoder().decode(diagnostic.output).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return { status: "invalid" };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { status: "observed", value: parsed }
    : { status: "invalid" };
}

async function readBoundedFile(
  path: NamespacePrerequisitePath,
  limit: number,
): Promise<BoundedDiagnostic> {
  const file = await Deno.open(path, { read: true });
  try {
    const output = new Uint8Array(limit);
    let retained = 0;
    while (retained < limit) {
      const count = await file.read(output.subarray(retained));
      if (count === null) {
        return { output: output.slice(0, retained), overflow: false };
      }
      retained += count;
    }
    const extra = new Uint8Array(1);
    return {
      output,
      overflow: await file.read(extra) !== null,
    };
  } finally {
    file.close();
  }
}

async function namespaceFileObservation(
  path: NamespacePrerequisitePath,
  reader: NonNullable<IsolationOptions["namespaceFileReader"]>,
): Promise<DiagnosticObservation<number>> {
  try {
    return numericObservation(await reader(path, NAMESPACE_VALUE_LIMIT));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { status: "missing" };
    if (
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotCapable
    ) {
      return { status: "denied" };
    }
    return { status: "unavailable" };
  }
}

async function userManagerVersionObservation(
  systemctlPath: string,
): Promise<DiagnosticObservation<string>> {
  const result = await boundedCommand(systemctlPath, [
    "--user",
    "show",
    "--property=Version",
    "--value",
  ], DIAGNOSTIC_COMMAND_LIMIT);
  if (!result) return { status: "unavailable" };
  if (!result.status.success) return commandFailureObservation(result);
  if (result.stdout.overflow) return { status: "overflow" };
  let value: string;
  try {
    value = decoder.decode(result.stdout.output).replace(/\r?\n$/, "");
  } catch {
    return { status: "invalid" };
  }
  if (value.length === 0) return { status: "missing" };
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  const fingerprint = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { status: "observed", value: `sha256:${fingerprint}` };
}

const NAMESPACE_ERRNOS = [
  ["Argument list too long", "E2BIG"],
  ["Permission denied", "EACCES"],
  ["Resource temporarily unavailable", "EAGAIN"],
  ["Bad file descriptor", "EBADF"],
  ["Device or resource busy", "EBUSY"],
  ["File exists", "EEXIST"],
  ["Invalid argument", "EINVAL"],
  ["Input/output error", "EIO"],
  ["Too many levels of symbolic links", "ELOOP"],
  ["Too many open files", "EMFILE"],
  ["File name too long", "ENAMETOOLONG"],
  ["Too many open files in system", "ENFILE"],
  ["No such device", "ENODEV"],
  ["No such file or directory", "ENOENT"],
  ["Cannot allocate memory", "ENOMEM"],
  ["No space left on device", "ENOSPC"],
  ["Function not implemented", "ENOSYS"],
  ["Not a directory", "ENOTDIR"],
  ["Operation not supported", "ENOTSUP"],
  ["No such device or address", "ENXIO"],
  ["Operation not permitted", "EPERM"],
  ["Read-only file system", "EROFS"],
  ["Too many users", "EUSERS"],
] as const satisfies ReadonlyArray<
  readonly [string, NamespaceSetupMatch["errno"]]
>;

const NAMESPACE_STAGE_PATTERNS = [
  ["Failed to apply namespace restrictions: ", "namespace", "exact"],
  ["Failed to fork child into new pid namespace: ", "pid", "exact"],
  ["Failed to join freshly allocated user namespace: ", "user", "exact"],
  ["Failed to open IPC namespace path ", "ipc", "field"],
  ["Failed to open network namespace path ", "network", "field"],
  ["Failed to open user namespace path ", "user", "field"],
  ["Failed to set up IPC namespacing: ", "ipc", "exact"],
  ["Failed to set up UTS namespacing: ", "uts", "exact"],
  ["Failed to set up cgroup namespacing: ", "cgroup", "exact"],
  ["Failed to set up mount namespacing", "mount", "mount-field"],
  ["Failed to set up network namespacing: ", "network", "exact"],
  ["Failed to set up pid namespace: ", "pid", "exact"],
  [
    "Failed to set up user namespacing for unprivileged user: ",
    "user",
    "exact",
  ],
  ["Failed to set up user namespacing: ", "user", "exact"],
  ["Failed to unshare user namespace: ", "user", "exact"],
] as const satisfies ReadonlyArray<
  readonly [
    string,
    NamespaceSetupMatch["operation"],
    "exact" | "field" | "mount-field",
  ]
>;

const GENERIC_NAMESPACE_STAGE_PREFIX = "Failed at step NAMESPACE spawning ";
const NON_FATAL_NAMESPACE_STAGE_PREFIXES = [
  "Failed to set up user namespacing for unprivileged user, ignoring: ",
  "PrivateIPC=yes is configured, but IPC namespace setup failed, ignoring: ",
  "PrivateNetwork=yes is configured, but network namespace setup not permitted, proceeding without: ",
] as const;

type NamespaceOutputInspection = {
  match?: NamespaceSetupMatch;
  namespaceStageSeen: boolean;
  knownErrnoSeen: boolean;
};

function namespaceErrnoAtLineEnd(
  line: string,
): (typeof NAMESPACE_ERRNOS)[number] | undefined {
  return NAMESPACE_ERRNOS.find(([message]) => line.endsWith(`: ${message}`));
}

const DRAFT_UNIT_NAME_PATTERN =
  /^bakery-draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ownedUnitMessage(line: string, unit: string): string {
  if (!DRAFT_UNIT_NAME_PATTERN.test(unit)) return line;
  const prefix = `${unit}.service: `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

function namespaceOutputInspection(
  output: Uint8Array,
  unit: string,
): NamespaceOutputInspection {
  let namespaceStageSeen = false;
  let knownErrnoSeen = false;
  for (const line of new TextDecoder().decode(output).split(/\r?\n/)) {
    const message = ownedUnitMessage(line, unit);
    const errno = namespaceErrnoAtLineEnd(message);
    knownErrnoSeen ||= errno !== undefined;
    const detailed = NAMESPACE_STAGE_PATTERNS.find(([prefix]) =>
      message.startsWith(prefix)
    );
    const genericSeen = message.startsWith(GENERIC_NAMESPACE_STAGE_PREFIX);
    namespaceStageSeen ||= detailed !== undefined || genericSeen ||
      NON_FATAL_NAMESPACE_STAGE_PREFIXES.some((prefix) =>
        message.startsWith(prefix)
      );
    if (!errno) continue;

    const [errnoMessage, errnoName] = errno;
    const errnoSuffix = `: ${errnoMessage}`;
    const detailedMatches = detailed !== undefined &&
      (detailed[2] === "exact"
        ? message === `${detailed[0]}${errnoMessage}`
        : detailed[2] === "field"
        ? message.length > detailed[0].length + errnoSuffix.length &&
          message.endsWith(errnoSuffix)
        : message === `${detailed[0]}${errnoSuffix}` ||
          ((message.startsWith(`${detailed[0]} `) ||
            message.startsWith(`${detailed[0]}: `)) &&
            message.length > detailed[0].length + errnoSuffix.length &&
            message.endsWith(errnoSuffix)));
    const genericMatches = genericSeen &&
      message.length > GENERIC_NAMESPACE_STAGE_PREFIX.length +
          errnoSuffix.length &&
      message.endsWith(errnoSuffix);
    if (!detailedMatches && !genericMatches) continue;

    const operation = detailedMatches && detailed ? detailed[1] : "namespace";
    const status = errnoName === "EACCES" || errnoName === "EPERM"
      ? "denied"
      : errnoName === "ENOENT"
      ? "missing"
      : "failed";
    return {
      match: { status, operation, errno: errnoName },
      namespaceStageSeen: true,
      knownErrnoSeen: true,
    };
  }
  return { namespaceStageSeen, knownErrnoSeen };
}

function namespaceProbeOutcome<S extends NamespaceProbeOutcome["status"]>(
  result: BoundedCommandResult | undefined,
  status: S,
): NamespaceProbeOutcome & { status: S } {
  if (!result) {
    return { status, exitCode: 255, stdoutBytes: 0, stderrBytes: 0 };
  }
  const code = result.status.code;
  return {
    status,
    exitCode: Number.isSafeInteger(code) && code >= 0 && code <= 255
      ? code
      : 255,
    stdoutBytes: Math.min(
      result.stdout.output.byteLength,
      NAMESPACE_STATUS_LIMIT,
    ),
    stderrBytes: Math.min(
      result.stderr.output.byteLength,
      NAMESPACE_STATUS_LIMIT,
    ),
  };
}

function unmatchedNamespaceProbeOutcome<
  S extends UnmatchedNamespaceProbeOutcome["status"],
>(
  result: BoundedCommandResult | undefined,
  status: S,
  unmatchedReason: NamespaceUnmatchedReason,
  inspection?: NamespaceOutputInspection,
): UnmatchedNamespaceProbeOutcome & { status: S } {
  return {
    ...namespaceProbeOutcome(result, status),
    unmatchedReason,
    ...(inspection && {
      namespaceStageSeen: inspection.namespaceStageSeen,
      knownErrnoSeen: inspection.knownErrnoSeen,
    }),
  };
}

type NamespaceProbe =
  | {
    match: NamespaceSetupMatch;
    outcome: NamespaceProbeOutcome & { status: "matched" };
  }
  | {
    match?: undefined;
    outcome: UnmatchedNamespaceProbeOutcome;
  };

function namespaceProbe(
  result: BoundedCommandResult | undefined,
  unit: string,
): NamespaceProbe {
  if (!result) {
    return {
      outcome: unmatchedNamespaceProbeOutcome(
        result,
        "failed",
        "probe-unavailable",
      ),
    };
  }
  if (result.timedOut) {
    return {
      outcome: unmatchedNamespaceProbeOutcome(
        result,
        "timeout",
        "probe-timeout",
      ),
    };
  }
  if (result.stdout.overflow || result.stderr.overflow) {
    return {
      outcome: unmatchedNamespaceProbeOutcome(
        result,
        "overflow",
        "probe-overflow",
      ),
    };
  }
  const stdout = namespaceOutputInspection(result.stdout.output, unit);
  const stderr = namespaceOutputInspection(result.stderr.output, unit);
  const match = stdout.match ?? stderr.match;
  if (match) {
    return { match, outcome: namespaceProbeOutcome(result, "matched") };
  }
  const inspection = {
    namespaceStageSeen: stdout.namespaceStageSeen || stderr.namespaceStageSeen,
    knownErrnoSeen: stdout.knownErrnoSeen || stderr.knownErrnoSeen,
  };
  const unmatchedReason = !inspection.namespaceStageSeen
    ? "namespace-stage-absent"
    : !inspection.knownErrnoSeen
    ? "known-errno-absent"
    : "format-unrecognized";
  return {
    outcome: unmatchedNamespaceProbeOutcome(
      result,
      result.status.success ? "no-match" : "failed",
      unmatchedReason,
      inspection,
    ),
  };
}

async function namespaceSetupObservation(
  systemctlPath: string,
  journalctlPath: string,
  unit: string,
): Promise<NamespaceSetupObservation> {
  const status = namespaceProbe(
    await boundedCommand(systemctlPath, [
      "--user",
      "status",
      `${unit}.service`,
      "--no-pager",
      "--lines=8",
      "--output=short",
      "--full",
    ], NAMESPACE_STATUS_LIMIT),
    unit,
  );
  if (status.match) {
    return { ...status.match, probe: status.outcome };
  }

  const journal = namespaceProbe(
    await boundedCommand(journalctlPath, [
      "--user",
      "--unit",
      `${unit}.service`,
      "--no-pager",
      "--lines",
      "20",
      "--output=cat",
    ], NAMESPACE_STATUS_LIMIT),
    unit,
  );
  if (journal.match) {
    return {
      ...journal.match,
      probe: status.outcome,
      journalProbe: journal.outcome,
    };
  }
  return {
    status: "unavailable",
    probe: status.outcome,
    journalProbe: journal.outcome,
  };
}

async function privateUsersObservation(
  systemctlPath: string,
  unit: string,
): Promise<DiagnosticObservation<"no" | "yes">> {
  const result = await boundedCommand(systemctlPath, [
    "--user",
    "show",
    `${unit}.service`,
    "--property=PrivateUsers",
    "--value",
  ], NAMESPACE_VALUE_LIMIT);
  if (!result) return { status: "unavailable" };
  if (!result.status.success) return commandFailureObservation(result);
  if (result.stdout.overflow) return { status: "overflow" };
  const value = new TextDecoder().decode(result.stdout.output).trim();
  if (value === "yes" || value === "no") {
    return { status: "observed", value };
  }
  return value.length === 0 ? { status: "missing" } : { status: "invalid" };
}

async function collectNamespacePrerequisites(
  systemctlPath: string,
  journalctlPath: string,
  unit: string,
  reader: NonNullable<IsolationOptions["namespaceFileReader"]>,
): Promise<DraftNamespacePrerequisites> {
  const [
    userManagerVersion,
    namespaceSetup,
    privateUsers,
    unprivilegedUsernsClone,
    maxUserNamespaces,
    apparmorRestrictUnprivilegedUserns,
  ] = await Promise.all([
    userManagerVersionObservation(systemctlPath),
    namespaceSetupObservation(systemctlPath, journalctlPath, unit),
    privateUsersObservation(systemctlPath, unit),
    namespaceFileObservation(
      NAMESPACE_PREREQUISITE_PATHS.unprivilegedUsernsClone,
      reader,
    ),
    namespaceFileObservation(
      NAMESPACE_PREREQUISITE_PATHS.maxUserNamespaces,
      reader,
    ),
    namespaceFileObservation(
      NAMESPACE_PREREQUISITE_PATHS.apparmorRestrictUnprivilegedUserns,
      reader,
    ),
  ]);
  return {
    userManagerVersion,
    namespaceSetup,
    privateUsers,
    unprivilegedUsernsClone,
    maxUserNamespaces,
    apparmorRestrictUnprivilegedUserns,
  };
}

function startupFailure(
  diagnostic: BoundedDiagnostic,
  status: Deno.CommandStatus,
  namespacePrerequisites?: DraftNamespacePrerequisites,
): DraftIsolationError {
  return new DraftIsolationError(
    "unavailable",
    "WORKER_STARTUP_FAILED",
    {
      failureClass: startupFailureClass(diagnostic.output),
      exitCode: status.code,
      signal: signalNumber(status.signal),
      stderrOverflow: diagnostic.overflow,
      ...(namespacePrerequisites ? { namespacePrerequisites } : {}),
    },
  );
}

function objectMetadata(frame: Uint8Array): Record<string, unknown> {
  if (frame.length === 0 || frame.length > DRAFT_LIMITS.metadataBytes) {
    throw new DraftIsolationError("unavailable", "WORKER_METADATA_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame));
  } catch {
    throw new DraftIsolationError("unavailable", "WORKER_METADATA_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DraftIsolationError("unavailable", "WORKER_METADATA_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new DraftIsolationError("unavailable", `WORKER_${field}_INVALID`);
  }
  return result;
}

function parseCandidate(frames: readonly Uint8Array[]): DraftCandidate {
  if (frames.length !== 5) {
    throw new DraftIsolationError("unavailable", "WORKER_FRAME_COUNT_INVALID");
  }
  const metadata = objectMetadata(frames[0]);
  if (metadata.ok !== true) throwWorkerFailure(metadata);
  const [state, update, frontiers, textFrame] = frames.slice(1);
  if (
    state.length === 0 || state.length > DRAFT_LIMITS.stateBytes ||
    update.length > DRAFT_LIMITS.updateBytes ||
    frontiers.length > DRAFT_LIMITS.updateBytes ||
    textFrame.length > DRAFT_LIMITS.bodyBytes
  ) {
    throw new DraftIsolationError("unavailable", "WORKER_OUTPUT_LIMIT");
  }
  return {
    state,
    update,
    frontiers,
    text: decoder.decode(textFrame),
    textDigest: stringField(metadata, "textDigest"),
    updateDigest: stringField(metadata, "updateDigest"),
  };
}

function throwWorkerFailure(metadata: Record<string, unknown>): never {
  const kind = metadata.kind;
  const failureKind: DraftIsolationFailureKind =
    kind === "precondition" || kind === "unprocessable" || kind === "limit"
      ? kind
      : "unavailable";
  const message = typeof metadata.message === "string"
    ? metadata.message
    : "WORKER_REJECTED";
  throw new DraftIsolationError(failureKind, message);
}

/**
 * A host without the systemd tools (a container, for example) reports a
 * missing executable as `NotFound`. That is a stable "isolation unavailable"
 * condition, not a worker startup failure. Other spawn errors, such as a
 * permission denial on a present file, keep their existing mapping.
 */
function hostIsolationUnavailable(): DraftIsolationError {
  return new DraftIsolationError(
    "unavailable",
    "HOST_ISOLATION_UNAVAILABLE",
    {
      failureClass: "executable",
      exitCode: 127,
      signal: 0,
      stderrOverflow: false,
    },
  );
}

async function systemctl(
  executable: string,
  args: readonly string[],
): Promise<Deno.CommandOutput> {
  try {
    return await new Deno.Command(executable, {
      args: executable === SERVER_DRAFT_SYSTEMD_LAUNCHER
        ? systemdLauncherArgs(["--user", ...args])
        : ["--user", ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw hostIsolationUnavailable();
    }
    throw error;
  }
}

/**
 * Ends a process-launched worker. The launcher execs Deno in place, so the
 * child pid is the worker; it has no run permission and can start nothing,
 * so killing the child ends the whole boundary.
 */
async function terminateProcess(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  await child.status.catch(() => undefined);
}

async function terminateBoundary(
  child: Deno.ChildProcess,
  systemctlPath: string,
  unit: string,
): Promise<void> {
  await systemctl(systemctlPath, [
    "kill",
    "--kill-who=all",
    "--signal=KILL",
    `${unit}.service`,
  ]).catch(() => undefined);
  try {
    child.kill("SIGKILL");
  } catch {
    // The systemd-run relay may already have exited after killing the cgroup.
  }
  await child.status.catch(() => undefined);
  await systemctl(systemctlPath, ["stop", `${unit}.service`]).catch(() =>
    undefined
  );
  await systemctl(systemctlPath, ["reset-failed", `${unit}.service`]).catch(
    () => undefined,
  );
}

async function verifyBoundaryRemoved(
  systemctlPath: string,
  unit: string,
): Promise<void> {
  const shown = await systemctl(systemctlPath, [
    "show",
    `${unit}.service`,
    "--property=LoadState",
    "--property=ActiveState",
    "--property=ControlGroup",
    "--property=MainPID",
  ]);
  const value = decoder.decode(shown.stdout);
  if (
    !shown.success ||
    !value.includes("LoadState=not-found") ||
    value.includes("ActiveState=active") ||
    !value.includes("ControlGroup=") ||
    !value.includes("MainPID=0")
  ) {
    throw new DraftIsolationError("unavailable", "WORKER_CGROUP_REMAINS");
  }
}

/**
 * The fixed launcher the process launcher starts, and the only path the
 * server's `--allow-run` grant names. It takes one UUID job id, ignores
 * everything else it is given, and execs Deno on the fixed worker module with
 * pinned flags; see infra/draft-worker/launch.sh.
 */

/**
 * The draft worker unit's fixed properties. RuntimeMaxSec is not among them:
 * it is the per-isolation backstop above both deadlines (runtimeMaxSeconds),
 * passed to infra/server-exec/draft-systemd.sh as its `run` operand. The
 * launcher pins the same list (tests/unit/server-exec-launchers_test.ts).
 */
export const SYSTEMD_UNIT_PROPERTIES: readonly string[] = Object.freeze([
  `--property=MemoryMax=${DRAFT_LIMITS.workerMemoryBytes}`,
  "--property=MemorySwapMax=0",
  `--property=TasksMax=${DRAFT_LIMITS.workerTasks}`,
  "--property=CPUQuota=100%",
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

export const DRAFT_WORKER_LAUNCHER = "/workspace/infra/draft-worker/launch.sh";

export function createDraftIsolation(
  options: IsolationOptions = {},
): DraftIsolation {
  const launcher = options.launcher ?? readDraftIsolationLauncher();
  const workerLauncherPath = options.workerLauncherPath ??
    DRAFT_WORKER_LAUNCHER;
  // In production every systemd call goes through the fixed launcher, the
  // only systemd path the server may run. Tests that inject their own
  // systemd-run, worker or Deno use the tools directly (their lanes grant
  // --allow-run broadly); the launcher pins the real worker and Deno.
  const systemdLauncher = options.systemdRunPath === undefined &&
    options.workerPath === undefined && options.denoPath === undefined;
  const systemdLauncherPath = options.systemdLauncherPath ??
    SERVER_DRAFT_SYSTEMD_LAUNCHER;
  const systemdRunPath = options.systemdRunPath ?? "/usr/bin/systemd-run";
  const systemctlPath = options.systemctlPath ??
    (systemdLauncher ? SERVER_DRAFT_SYSTEMD_LAUNCHER : "/usr/bin/systemctl");
  const journalctlPath = options.journalctlPath ??
    (systemdLauncher ? SERVER_DRAFT_SYSTEMD_LAUNCHER : "/usr/bin/journalctl");
  const denoPath = options.denoPath ?? Deno.execPath();
  const workerPath = options.workerPath ??
    new URL("./draft-import-worker.ts", import.meta.url).pathname;
  // Start-up and work are metered apart. Before READY the worker has read
  // nothing from the client, so its start-up time is the host's (a cold Deno
  // start can exceed a second under load), not something a client controls.
  // Only the work after READY spends workerRuntimeMs.
  const startupDeadlineMs = options.startupDeadlineMs ??
    DRAFT_LIMITS.workerStartupMs;
  const deadlineMs = options.totalDeadlineMs ?? DRAFT_LIMITS.workerRuntimeMs;
  // systemd's own wall-clock cap is the backstop if this process dies: both
  // budgets plus a second of slack, so the parent's deadline always fires first.
  const runtimeMaxSeconds = Math.ceil(
    (startupDeadlineMs + deadlineMs) / 1_000,
  ) + 1;
  const namespaceFileReader = options.namespaceFileReader ?? readBoundedFile;

  const run = async (
    frames: readonly Uint8Array[],
    signal?: AbortSignal,
  ): Promise<Uint8Array[]> => {
    if (frames[0]?.length > DRAFT_LIMITS.metadataBytes) {
      throw new DraftIsolationError("limit", "WORKER_METADATA_TOO_LARGE");
    }
    const jobId = crypto.randomUUID();
    const unit = `bakery-draft-${jobId}`;
    const systemdArgs = [
      "--user",
      "--pipe",
      "--wait",
      "--quiet",
      `--unit=${unit}`,
      ...SYSTEMD_UNIT_PROPERTIES,
      `--property=RuntimeMaxSec=${runtimeMaxSeconds}s`,
      denoPath,
      "run",
      "--cached-only",
      "--no-prompt",
      "--deny-import",
      "--frozen",
      workerPath,
    ];
    const systemd = launcher === "systemd";
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(
        systemd
          ? systemdLauncher ? systemdLauncherPath : systemdRunPath
          : workerLauncherPath,
        {
          args: systemd
            ? systemdLauncher
              ? ["run", jobId, String(runtimeMaxSeconds)]
              : systemdArgs
            : [jobId],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          // systemd-run needs the session bus from the environment, and the
          // transient unit does not inherit it. The launcher gets nothing: it
          // sets the worker's few variables itself, so no server secret can
          // reach the worker even if the launcher were changed to pass its own.
          ...(systemd ? {} : { clearEnv: true, env: {} }),
        },
      ).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw hostIsolationUnavailable();
      }
      throw new DraftIsolationError(
        "unavailable",
        "WORKER_STARTUP_FAILED",
        {
          failureClass: "executable",
          exitCode: 127,
          signal: 0,
          stderrOverflow: false,
        },
      );
    }
    const stdout = child.stdout.getReader();
    const stderr = child.stderr.getReader();
    const stderrOutput = readBoundedDiagnostic(stderr, STDERR_LIMIT);
    let timedOut = false;
    let aborted = false;
    let cleanup: Promise<void> | undefined;
    const cleanupBoundary = () =>
      cleanup ??= systemd
        ? terminateBoundary(child, systemctlPath, unit)
        : terminateProcess(child);
    const expire = () => {
      timedOut = true;
      void cleanupBoundary();
    };
    let timeout = setTimeout(expire, startupDeadlineMs);
    const abort = () => {
      aborted = true;
      void cleanupBoundary();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      try {
        await readReady(stdout);
      } catch (error) {
        if (
          error instanceof DraftIsolationError &&
          error.message === "WORKER_READY_EOF"
        ) {
          const [diagnostic, status] = await Promise.all([
            stderrOutput,
            child.status,
          ]);
          if (timedOut || aborted) {
            throw new DraftIsolationError(
              "timeout",
              "WORKER_DEADLINE_EXCEEDED",
            );
          }
          // The systemd launcher's EX_UNAVAILABLE: no systemd on this host.
          if (systemd && systemdLauncher && status.code === 69) {
            throw hostIsolationUnavailable();
          }
          const namespacePrerequisites = systemd && status.code === 226
            ? await collectNamespacePrerequisites(
              systemctlPath,
              journalctlPath,
              unit,
              namespaceFileReader,
            )
            : undefined;
          throw startupFailure(diagnostic, status, namespacePrerequisites);
        }
        throw error;
      }
      clearTimeout(timeout);
      timeout = setTimeout(expire, deadlineMs);
      const readyAt = performance.now();
      const input = encodeFrames(frames);
      const writer = child.stdin.getWriter();
      await writer.write(input);
      await writer.close();
      const [output, diagnostic, status] = await Promise.all([
        readBounded(stdout, WORKER_OUTPUT_LIMIT, "WORKER_STDOUT"),
        stderrOutput,
        child.status,
      ]);
      if (timedOut || aborted) {
        throw new DraftIsolationError("timeout", "WORKER_DEADLINE_EXCEEDED");
      }
      if (diagnostic.overflow) {
        throw new DraftIsolationError("unavailable", "WORKER_STDERR_OVERFLOW");
      }
      if (!status.success) {
        const elapsed = performance.now() - readyAt;
        throw new DraftIsolationError(
          // Only systemd kills on its own clock (RuntimeMaxSec). A process
          // child is time-killed only by our timer, reported above, so its
          // failed exit is a crash or a memory-cap kill, never a timeout.
          systemd && elapsed >= deadlineMs * 0.9 ? "timeout" : "unavailable",
          `WORKER_EXIT_${status.code}`,
        );
      }
      const decoded = decodeFrames(output);
      if (decoded.length === 1) {
        const failure = objectMetadata(decoded[0]);
        if (failure.ok !== true) throwWorkerFailure(failure);
      }
      return decoded;
    } catch (error) {
      if (timedOut || aborted) {
        throw new DraftIsolationError("timeout", "WORKER_DEADLINE_EXCEEDED");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      stdout.releaseLock();
      stderr.releaseLock();
      await cleanupBoundary();
      if (systemd) await verifyBoundaryRemoved(systemctlPath, unit);
    }
  };

  return {
    async initialize(text, signal) {
      return parseCandidate(
        await run([
          encoder.encode(JSON.stringify({ operation: "initialize" })),
          encoder.encode(text),
        ], signal),
      );
    },
    async edit(currentState, sourceState, input, signal) {
      return parseCandidate(
        await run([
          encoder.encode(JSON.stringify({
            operation: "edit",
            mutationId: input.mutationId,
            startCursor: input.startCursor,
            endCursor: input.endCursor,
            expectedDigest: input.expectedDigest,
          })),
          sourceState,
          currentState,
          encoder.encode(input.expectedText),
          encoder.encode(input.replacement),
        ], signal),
      );
    },
    async importUpdate(currentState, update, signal) {
      return parseCandidate(
        await run([
          encoder.encode(JSON.stringify({ operation: "import" })),
          currentState,
          update,
        ], signal),
      );
    },
    async slice(state, startUtf16, endUtf16, signal) {
      const frames = await run([
        encoder.encode(JSON.stringify({
          operation: "slice",
          startUtf16,
          endUtf16,
        })),
        state,
      ], signal);
      if (frames.length !== 2) {
        throw new DraftIsolationError(
          "unavailable",
          "WORKER_FRAME_COUNT_INVALID",
        );
      }
      const metadata = objectMetadata(frames[0]);
      if (metadata.ok !== true) throwWorkerFailure(metadata);
      if (frames[1].length > DRAFT_LIMITS.replacementBytes) {
        throw new DraftIsolationError("unavailable", "WORKER_SLICE_OVERFLOW");
      }
      return {
        text: decoder.decode(frames[1]),
        textDigest: stringField(metadata, "textDigest"),
        startCursor: stringField(metadata, "startCursor"),
        endCursor: stringField(metadata, "endCursor"),
      };
    },
  };
}
