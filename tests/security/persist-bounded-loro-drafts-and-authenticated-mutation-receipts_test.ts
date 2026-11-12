import { assert, assertEquals, assertRejects } from "@std/assert";
import { LoroDoc } from "loro-crdt";
import {
  createDraftIsolation,
  type DraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import {
  createDraftSliceCandidate,
  createInitialDraftCandidate,
  DRAFT_LIMITS,
} from "../../apps/server/src/modules/knowledge/drafts.ts";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";
import { authTestOrigin } from "../helpers/auth.ts";

async function validEditInput() {
  const initial = await createInitialDraftCandidate("target");
  const range = await createDraftSliceCandidate(initial.state, 0, 6);
  return {
    initial,
    input: {
      mutationId: crypto.randomUUID(),
      startCursor: range.startCursor,
      endCursor: range.endCursor,
      expectedText: range.text,
      expectedDigest: range.textDigest,
      replacement: "safe",
    },
  };
}

type ExpectedNamespaceProbeBase = {
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
};

type ExpectedNamespaceUnmatched = {
  unmatchedReason:
    | "format-unrecognized"
    | "known-errno-absent"
    | "namespace-stage-absent"
    | "probe-overflow"
    | "probe-timeout"
    | "probe-unavailable";
  namespaceStageSeen?: boolean;
  knownErrnoSeen?: boolean;
};

function expectedNamespaceProbe(
  status: "matched",
  exitCode: number,
  stdoutBytes: number,
  stderrBytes?: number,
): ExpectedNamespaceProbeBase & { status: "matched" };
function expectedNamespaceProbe<
  S extends "failed" | "timeout" | "overflow" | "no-match",
>(
  status: S,
  exitCode: number,
  stdoutBytes: number,
  stderrBytes?: number,
  unmatched?: ExpectedNamespaceUnmatched,
): ExpectedNamespaceProbeBase & ExpectedNamespaceUnmatched & { status: S };
function expectedNamespaceProbe(
  status: "failed" | "timeout" | "overflow" | "no-match" | "matched",
  exitCode: number,
  stdoutBytes: number,
  stderrBytes = 0,
  unmatched?: ExpectedNamespaceUnmatched,
) {
  const base = { status, exitCode, stdoutBytes, stderrBytes };
  if (status === "matched") return base;
  if (unmatched) return { ...base, ...unmatched };
  if (status === "timeout") {
    return { ...base, unmatchedReason: "probe-timeout" as const };
  }
  if (status === "overflow") {
    return { ...base, unmatchedReason: "probe-overflow" as const };
  }
  return {
    ...base,
    unmatchedReason: "namespace-stage-absent" as const,
    namespaceStageSeen: false,
    knownErrnoSeen: false,
  };
}

async function fakeDraftBoundary(
  systemdRun: string,
  diagnostic: {
    userManagerVersion?: string;
    namespaceStatus?: string;
    namespaceJournal?: string;
    privateUsers?: string;
    resetFailed?: string;
    cleanupShow?: string;
  } = {},
): Promise<{
  systemdRunPath: string;
  systemctlPath: string;
  journalctlPath: string;
  logPath: string;
  journalLogPath: string;
  diagnosticSequencePath: string;
  systemdRunLogPath: string;
}> {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-draft-boundary-",
  });
  const systemdRunPath = `${directory}/systemd-run`;
  const systemctlPath = `${directory}/systemctl`;
  const journalctlPath = `${directory}/journalctl`;
  const logPath = `${directory}/systemctl.log`;
  const journalLogPath = `${directory}/journalctl.log`;
  const diagnosticSequencePath = `${directory}/diagnostic-sequence.log`;
  const systemdRunLogPath = `${directory}/systemd-run.log`;
  await Deno.writeTextFile(
    systemdRunPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemdRunLogPath)}
${systemdRun}
`,
  );
  await Deno.writeTextFile(
    systemctlPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(diagnosticSequencePath)}
case "$*" in
  *--property=Version*)
    ${diagnostic.userManagerVersion ?? "printf '%s\\n' '255 (255.4)'"}
    ;;
  *--property=PrivateUsers*)
    ${diagnostic.privateUsers ?? "printf '%s\\n' 'no'"}
    ;;
  *status*)
    ${
      diagnostic.namespaceStatus ??
        "printf '%s\\n' 'Failed to set up user namespacing: Operation not permitted'; exit 3"
    }
    ;;
  *reset-failed*) ${diagnostic.resetFailed ?? ":"} ;;
  *show*) ${
      diagnostic.cleanupShow ??
        "printf '%s\\n' 'LoadState=not-found' 'ActiveState=inactive' 'ControlGroup=' 'MainPID=0'"
    } ;;
esac
`,
  );
  await Deno.writeTextFile(
    journalctlPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(journalLogPath)}
printf 'journalctl %s\\n' "$*" >> ${JSON.stringify(diagnosticSequencePath)}
${diagnostic.namespaceJournal ?? "exit 1"}
`,
  );
  await Promise.all([
    Deno.chmod(systemdRunPath, 0o700),
    Deno.chmod(systemctlPath, 0o700),
    Deno.chmod(journalctlPath, 0o700),
  ]);
  return {
    systemdRunPath,
    systemctlPath,
    journalctlPath,
    logPath,
    journalLogPath,
    diagnosticSequencePath,
    systemdRunLogPath,
  };
}

const DIRECT_NAMESPACE_PROBE_TIMEOUT_MS = 500;
const DIRECT_NAMESPACE_PROBE_OUTPUT_LIMIT = 256;

type DirectNamespaceProbeStatus =
  | "available"
  | "failed"
  | "missing"
  | "output-overflow"
  | "permission-denied"
  | "timeout";
type DirectNamespaceErrno =
  | "EACCES"
  | "EAGAIN"
  | "EINVAL"
  | "ENOSYS"
  | "ENOTSUP"
  | "EPERM"
  | "EUSERS"
  | "none";
type DirectNamespaceProbe = {
  status: DirectNamespaceProbeStatus;
  errno: DirectNamespaceErrno;
};
type PolicyObservationStatus =
  | "inconclusive"
  | "invalid"
  | "missing"
  | "observed"
  | "overflow"
  | "permission-denied"
  | "timeout"
  | "unavailable";
type NumericPolicyObservation =
  | { status: "observed"; value: number }
  | { status: Exclude<PolicyObservationStatus, "observed"> };
type FinitePolicyObservation<T extends string> =
  | { status: "observed"; value: T }
  | { status: Exclude<PolicyObservationStatus, "observed"> };
type NamespacePolicyBoundaryObservation = {
  hypothesis:
    "visible-sandbox-or-namespace-policy-may-explain-denial-causality-unproven";
  visibleBoundary:
    | "both"
    | "inconclusive"
    | "job-or-ancestor-sandbox"
    | "namespace-policy";
  process: {
    seccomp: NumericPolicyObservation;
    noNewPrivs: NumericPolicyObservation;
  };
  namespaceSysctls: {
    unprivilegedUsernsClone: NumericPolicyObservation;
    maxUserNamespaces: NumericPolicyObservation;
    apparmorRestrictUnprivilegedUserns: NumericPolicyObservation;
  };
  runnerService: {
    discovery: PolicyObservationStatus;
    noNewPrivileges: FinitePolicyObservation<"disabled" | "enabled">;
    privateUsers: FinitePolicyObservation<
      "disabled" | "enabled" | "identity" | "self"
    >;
    restrictNamespaces: FinitePolicyObservation<"all" | "none" | "selective">;
    systemCallFilter: FinitePolicyObservation<"configured" | "none">;
  };
};
type DirectNamespacePrerequisiteDiagnostic = {
  conclusion:
    | "direct-primitive-unavailable"
    | "direct-primitives-available-systemd-unit-failed"
    | "inconclusive";
  unshareVersion:
    | { status: "observed"; fingerprint: string }
    | { status: Exclude<DirectNamespaceProbeStatus, "available"> };
  user: DirectNamespaceProbe;
  mount: DirectNamespaceProbe;
  network: DirectNamespaceProbe;
  policyBoundary: NamespacePolicyBoundaryObservation;
};

type BoundedProbeOutput = { output: Uint8Array; overflow: boolean };
type BoundedProbeResult = {
  status: Deno.CommandStatus;
  stdout: BoundedProbeOutput;
  stderr: BoundedProbeOutput;
  timedOut: boolean;
};
type BoundedProbeExecution =
  | { status: "started"; result: BoundedProbeResult }
  | { status: "missing" | "permission-denied" | "failed" };

async function readBoundedProbeOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit = DIRECT_NAMESPACE_PROBE_OUTPUT_LIMIT,
): Promise<BoundedProbeOutput> {
  const output = new Uint8Array(limit);
  let retained = 0;
  let overflow = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const length = Math.min(
      output.length - retained,
      next.value.length,
    );
    if (length > 0) {
      output.set(next.value.subarray(0, length), retained);
      retained += length;
    }
    overflow ||= length < next.value.length;
  }
  return { output: output.slice(0, retained), overflow };
}

async function runBoundedProbe(
  executable: string,
  args: readonly string[],
): Promise<BoundedProbeExecution> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(executable, {
      args: [...args],
      clearEnv: true,
      env: { LC_ALL: "C" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { status: "missing" };
    if (
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotCapable
    ) return { status: "permission-denied" };
    return { status: "failed" };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Probe already exited.
    }
  }, DIRECT_NAMESPACE_PROBE_TIMEOUT_MS);
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedProbeOutput(child.stdout.getReader()),
      readBoundedProbeOutput(child.stderr.getReader()),
      child.status,
    ]);
    return {
      status: "started",
      result: { status, stdout, stderr, timedOut },
    };
  } catch {
    return { status: "failed" };
  } finally {
    clearTimeout(timeout);
  }
}

const DIRECT_NAMESPACE_ERRNOS = [
  ["Permission denied", "EACCES"],
  ["Resource temporarily unavailable", "EAGAIN"],
  ["Invalid argument", "EINVAL"],
  ["Function not implemented", "ENOSYS"],
  ["Operation not supported", "ENOTSUP"],
  ["Operation not permitted", "EPERM"],
  ["Too many users", "EUSERS"],
] as const;

function directNamespaceProbe(
  execution: BoundedProbeExecution,
): DirectNamespaceProbe {
  if (execution.status !== "started") {
    return { status: execution.status, errno: "none" };
  }
  const { result } = execution;
  if (result.timedOut) return { status: "timeout", errno: "none" };
  if (result.stdout.overflow || result.stderr.overflow) {
    return { status: "output-overflow", errno: "none" };
  }
  if (result.status.success) return { status: "available", errno: "none" };
  const stderr = new TextDecoder().decode(result.stderr.output).trimEnd();
  const errno = DIRECT_NAMESPACE_ERRNOS.find(([message]) =>
    stderr.endsWith(`: ${message}`)
  )?.[1];
  return errno
    ? { status: "failed", errno }
    : { status: "failed", errno: "none" };
}

type BoundedPolicyRead =
  | { status: "observed"; output: BoundedProbeOutput }
  | { status: "missing" | "permission-denied" | "unavailable" };
type BoundedPolicyReader = (
  path: string,
  limit: number,
) => Promise<BoundedPolicyRead>;

const POLICY_FILE_LIMIT = 4_096;
const POLICY_NUMERIC_LIMIT = 4_294_967_295;
const POLICY_PATHS = {
  processStatus: "/proc/self/status",
  processCgroup: "/proc/self/cgroup",
  unprivilegedUsernsClone: "/proc/sys/kernel/unprivileged_userns_clone",
  maxUserNamespaces: "/proc/sys/user/max_user_namespaces",
  apparmorRestrictUnprivilegedUserns:
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
} as const;

async function readBoundedPolicyFile(
  path: string,
  limit: number,
): Promise<BoundedPolicyRead> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { status: "missing" };
    if (
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotCapable
    ) return { status: "permission-denied" };
    return { status: "unavailable" };
  }
  try {
    return {
      status: "observed",
      output: await readBoundedProbeOutput(file.readable.getReader(), limit),
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    try {
      file.close();
    } catch {
      // Reading to EOF may already close the resource.
    }
  }
}

function unavailableNumericObservation(
  status: Exclude<PolicyObservationStatus, "observed">,
): NumericPolicyObservation {
  return { status };
}

function numericPolicyObservation(
  read: BoundedPolicyRead,
): NumericPolicyObservation {
  if (read.status !== "observed") {
    return unavailableNumericObservation(read.status);
  }
  if (read.output.overflow) return { status: "overflow" };
  const value = new TextDecoder().decode(read.output.output);
  if (!/^(?:0|[1-9][0-9]{0,9})\n?$/.test(value)) {
    return { status: "invalid" };
  }
  const numeric = Number.parseInt(value, 10);
  return numeric <= POLICY_NUMERIC_LIMIT
    ? { status: "observed", value: numeric }
    : { status: "invalid" };
}

function processStatusObservation(read: BoundedPolicyRead): {
  seccomp: NumericPolicyObservation;
  noNewPrivs: NumericPolicyObservation;
} {
  if (read.status !== "observed") {
    return {
      seccomp: unavailableNumericObservation(read.status),
      noNewPrivs: unavailableNumericObservation(read.status),
    };
  }
  if (read.output.overflow) {
    return {
      seccomp: { status: "overflow" },
      noNewPrivs: { status: "overflow" },
    };
  }
  const text = new TextDecoder().decode(read.output.output);
  const field = (name: "NoNewPrivs" | "Seccomp", maximum: number) => {
    const matches = [
      ...text.matchAll(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)$`, "gm")),
    ];
    if (matches.length === 0) return { status: "missing" } as const;
    if (matches.length !== 1 || !/^[0-9]+$/.test(matches[0][1])) {
      return { status: "invalid" } as const;
    }
    const value = Number.parseInt(matches[0][1], 10);
    return value <= maximum
      ? ({ status: "observed", value } as const)
      : ({ status: "invalid" } as const);
  };
  return { seccomp: field("Seccomp", 2), noNewPrivs: field("NoNewPrivs", 1) };
}

function runnerServiceUnit(read: BoundedPolicyRead):
  | { status: "observed"; unit: string }
  | { status: Exclude<PolicyObservationStatus, "observed"> } {
  if (read.status !== "observed") return { status: read.status };
  if (read.output.overflow) return { status: "overflow" };
  const text = new TextDecoder().decode(read.output.output);
  if (!/^[\x20-\x7e\n]*$/.test(text)) return { status: "invalid" };
  const units = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^0::\/(.*)$/.exec(line);
    if (!match) return { status: "invalid" };
    for (const segment of match[1].split("/")) {
      if (/^actions\.runner\.[A-Za-z0-9_.-]{1,96}\.service$/.test(segment)) {
        units.add(segment);
      }
    }
  }
  return units.size === 1
    ? { status: "observed", unit: [...units][0] }
    : { status: "inconclusive" };
}

function commandObservation<T extends string>(
  execution: BoundedProbeExecution,
  parse: (value: string) => T | undefined,
): FinitePolicyObservation<T> {
  if (execution.status !== "started") {
    return {
      status: execution.status === "permission-denied"
        ? "permission-denied"
        : execution.status === "failed"
        ? "unavailable"
        : execution.status,
    };
  }
  if (execution.result.timedOut) return { status: "timeout" };
  if (execution.result.stdout.overflow || execution.result.stderr.overflow) {
    return { status: "overflow" };
  }
  if (!execution.result.status.success) return { status: "inconclusive" };
  const parsed = parse(
    new TextDecoder().decode(execution.result.stdout.output).trimEnd(),
  );
  return parsed === undefined
    ? { status: "invalid" }
    : { status: "observed", value: parsed };
}

function booleanProperty(value: string): "disabled" | "enabled" | undefined {
  return value === "yes" ? "enabled" : value === "no" ? "disabled" : undefined;
}

function privateUsersProperty(
  value: string,
): "disabled" | "enabled" | "identity" | "self" | undefined {
  if (value === "yes") return "enabled";
  if (value === "no") return "disabled";
  if (value === "identity" || value === "self") return value;
  return undefined;
}

function restrictNamespacesProperty(
  value: string,
): "all" | "none" | "selective" | undefined {
  if (value === "yes") return "all";
  if (value === "no" || value === "") return "none";
  const normalized = value.startsWith("~") ? value.slice(1) : value;
  const namespaceTypes = new Set([
    "cgroup",
    "ipc",
    "mnt",
    "net",
    "pid",
    "time",
    "user",
    "uts",
  ]);
  const tokens = normalized.split(/[ \t]+/);
  return tokens.length > 0 && tokens.every((token) => namespaceTypes.has(token))
    ? "selective"
    : undefined;
}

function systemCallFilterProperty(
  value: string,
): "configured" | "none" | undefined {
  if (!/^[\x20-\x7e]*$/.test(value)) return undefined;
  return value === "" ? "none" : "configured";
}

function systemCallFilterObservation(
  execution: BoundedProbeExecution,
): FinitePolicyObservation<"configured" | "none"> {
  if (execution.status !== "started") {
    return commandObservation(execution, systemCallFilterProperty);
  }
  if (execution.result.timedOut) return { status: "timeout" };
  if (execution.result.stderr.overflow) return { status: "overflow" };
  if (!execution.result.status.success) return { status: "inconclusive" };
  if (execution.result.stdout.overflow) return { status: "overflow" };
  return commandObservation(execution, systemCallFilterProperty);
}

function absentRunnerService(
  status: PolicyObservationStatus,
): NamespacePolicyBoundaryObservation["runnerService"] {
  return {
    discovery: status,
    noNewPrivileges: { status: "inconclusive" },
    privateUsers: { status: "inconclusive" },
    restrictNamespaces: { status: "inconclusive" },
    systemCallFilter: { status: "inconclusive" },
  };
}

function unobservedPolicyBoundary(): NamespacePolicyBoundaryObservation {
  return {
    hypothesis:
      "visible-sandbox-or-namespace-policy-may-explain-denial-causality-unproven",
    visibleBoundary: "inconclusive",
    process: {
      seccomp: { status: "inconclusive" },
      noNewPrivs: { status: "inconclusive" },
    },
    namespaceSysctls: {
      unprivilegedUsernsClone: { status: "inconclusive" },
      maxUserNamespaces: { status: "inconclusive" },
      apparmorRestrictUnprivilegedUserns: { status: "inconclusive" },
    },
    runnerService: absentRunnerService("inconclusive"),
  };
}

async function observeRunnerService(
  discovery: ReturnType<typeof runnerServiceUnit>,
  runProbe: typeof runBoundedProbe,
): Promise<NamespacePolicyBoundaryObservation["runnerService"]> {
  if (discovery.status !== "observed") {
    return absentRunnerService(discovery.status);
  }
  const properties = [
    "NoNewPrivileges",
    "PrivateUsers",
    "RestrictNamespaces",
    "SystemCallFilter",
  ] as const;
  const results = await Promise.all(
    properties.map((property) =>
      runProbe("/usr/bin/systemctl", [
        "show",
        "--no-pager",
        "--value",
        `--property=${property}`,
        discovery.unit,
      ])
    ),
  );
  return {
    discovery: "observed",
    noNewPrivileges: commandObservation(results[0], booleanProperty),
    privateUsers: commandObservation(results[1], privateUsersProperty),
    restrictNamespaces: commandObservation(
      results[2],
      restrictNamespacesProperty,
    ),
    systemCallFilter: systemCallFilterObservation(results[3]),
  };
}

async function observeNamespacePolicyBoundary(
  read: BoundedPolicyReader = readBoundedPolicyFile,
  runProbe: typeof runBoundedProbe = runBoundedProbe,
): Promise<NamespacePolicyBoundaryObservation> {
  const [statusRead, cgroupRead, ...sysctlReads] = await Promise.all([
    read(POLICY_PATHS.processStatus, POLICY_FILE_LIMIT),
    read(POLICY_PATHS.processCgroup, POLICY_FILE_LIMIT),
    read(POLICY_PATHS.unprivilegedUsernsClone, 32),
    read(POLICY_PATHS.maxUserNamespaces, 32),
    read(POLICY_PATHS.apparmorRestrictUnprivilegedUserns, 32),
  ]);
  const process = processStatusObservation(statusRead);
  const namespaceSysctls = {
    unprivilegedUsernsClone: numericPolicyObservation(sysctlReads[0]),
    maxUserNamespaces: numericPolicyObservation(sysctlReads[1]),
    apparmorRestrictUnprivilegedUserns: numericPolicyObservation(
      sysctlReads[2],
    ),
  };
  const runnerService = await observeRunnerService(
    runnerServiceUnit(cgroupRead),
    runProbe,
  );
  const sandboxVisible =
    (process.seccomp.status === "observed" && process.seccomp.value === 2) ||
    (process.noNewPrivs.status === "observed" &&
      process.noNewPrivs.value === 1) ||
    (runnerService.noNewPrivileges.status === "observed" &&
      runnerService.noNewPrivileges.value === "enabled") ||
    (runnerService.restrictNamespaces.status === "observed" &&
      runnerService.restrictNamespaces.value !== "none") ||
    (runnerService.systemCallFilter.status === "observed" &&
      runnerService.systemCallFilter.value === "configured");
  const namespacePolicyVisible =
    (namespaceSysctls.unprivilegedUsernsClone.status === "observed" &&
      namespaceSysctls.unprivilegedUsernsClone.value === 0) ||
    (namespaceSysctls.maxUserNamespaces.status === "observed" &&
      namespaceSysctls.maxUserNamespaces.value === 0) ||
    (namespaceSysctls.apparmorRestrictUnprivilegedUserns.status ===
        "observed" &&
      namespaceSysctls.apparmorRestrictUnprivilegedUserns.value !== 0);
  const visibleBoundary = sandboxVisible && namespacePolicyVisible
    ? "both"
    : sandboxVisible
    ? "job-or-ancestor-sandbox"
    : namespacePolicyVisible
    ? "namespace-policy"
    : "inconclusive";
  return {
    hypothesis:
      "visible-sandbox-or-namespace-policy-may-explain-denial-causality-unproven",
    visibleBoundary,
    process,
    namespaceSysctls,
    runnerService,
  };
}

async function directNamespacePrerequisiteDiagnostic(
  startup: DraftIsolationError,
  unsharePath = "/usr/bin/unshare",
  runProbe: typeof runBoundedProbe = runBoundedProbe,
  observePolicy: () => Promise<NamespacePolicyBoundaryObservation> =
    observeNamespacePolicyBoundary,
): Promise<DirectNamespacePrerequisiteDiagnostic | undefined> {
  if (startup.startupDiagnostic?.exitCode !== 226) return undefined;
  const [
    version,
    userExecution,
    mountExecution,
    networkExecution,
    policyBoundary,
  ] = await Promise
    .all([
      runProbe(unsharePath, ["--version"]),
      runProbe(unsharePath, [
        "--user",
        "--map-root-user",
        "/usr/bin/true",
      ]),
      runProbe(unsharePath, [
        "--user",
        "--map-root-user",
        "--mount",
        "/usr/bin/true",
      ]),
      runProbe(unsharePath, [
        "--user",
        "--map-root-user",
        "--net",
        "/usr/bin/true",
      ]),
      observePolicy(),
    ]);
  let unshareVersion: DirectNamespacePrerequisiteDiagnostic["unshareVersion"];
  if (version.status !== "started") {
    unshareVersion = { status: version.status };
  } else if (version.result.timedOut) {
    unshareVersion = { status: "timeout" };
  } else if (
    version.result.stdout.overflow || version.result.stderr.overflow
  ) {
    unshareVersion = { status: "output-overflow" };
  } else if (!version.result.status.success) {
    unshareVersion = { status: "failed" };
  } else {
    const versionBytes = new Uint8Array(version.result.stdout.output.length);
    versionBytes.set(version.result.stdout.output);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", versionBytes.buffer),
    );
    unshareVersion = {
      status: "observed",
      fingerprint: `sha256:${
        Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        )
      }`,
    };
  }
  const user = directNamespaceProbe(userExecution);
  const mount = directNamespaceProbe(mountExecution);
  const network = directNamespaceProbe(networkExecution);
  const probes = [user, mount, network];
  const conclusion = unshareVersion.status === "observed" &&
      probes.every((probe) => probe.status === "available")
    ? "direct-primitives-available-systemd-unit-failed"
    : probes.some((probe) =>
        probe.status === "failed" && probe.errno !== "none"
      )
    ? "direct-primitive-unavailable"
    : "inconclusive";
  return {
    conclusion,
    unshareVersion,
    user,
    mount,
    network,
    policyBoundary,
  };
}

Deno.test("namespace policy boundary observation is bounded and redacted", async () => {
  const encode = (value: string): BoundedPolicyRead => ({
    status: "observed",
    output: { output: new TextEncoder().encode(value), overflow: false },
  });
  const command = (
    value: string,
    options: { timedOut?: boolean; overflow?: boolean } = {},
  ): BoundedProbeExecution => ({
    status: "started",
    result: {
      status: { success: true, code: 0, signal: null },
      stdout: {
        output: new TextEncoder().encode(value),
        overflow: options.overflow ?? false,
      },
      stderr: { output: new Uint8Array(), overflow: false },
      timedOut: options.timedOut ?? false,
    },
  });
  const reads = new Map<string, BoundedPolicyRead>([
    [
      POLICY_PATHS.processStatus,
      encode("Name:\tPRIVATE_TOKEN=do-not-emit\nNoNewPrivs:\t1\nSeccomp:\t2\n"),
    ],
    [
      POLICY_PATHS.processCgroup,
      encode("0::/system.slice/actions.runner.private-owned.service\n"),
    ],
    [POLICY_PATHS.unprivilegedUsernsClone, encode("1\n")],
    [POLICY_PATHS.maxUserNamespaces, encode("65536\n")],
    [POLICY_PATHS.apparmorRestrictUnprivilegedUserns, encode("0\n")],
  ]);
  const observed = await observeNamespacePolicyBoundary(
    (path) => Promise.resolve(reads.get(path) ?? { status: "missing" }),
    (_executable, args) => {
      const property = args.find((argument) =>
        argument.startsWith("--property=")
      );
      const values: Record<string, string> = {
        "--property=NoNewPrivileges": "yes\n",
        "--property=PrivateUsers": "no\n",
        "--property=RestrictNamespaces": "~user mnt\n",
        "--property=SystemCallFilter": "~@mount PRIVATE_TOKEN=do-not-emit\n",
      };
      return Promise.resolve(command(values[property ?? ""] ?? ""));
    },
  );
  assertEquals(observed.visibleBoundary, "job-or-ancestor-sandbox");
  assertEquals(observed.process, {
    seccomp: { status: "observed", value: 2 },
    noNewPrivs: { status: "observed", value: 1 },
  });
  assertEquals(observed.runnerService, {
    discovery: "observed",
    noNewPrivileges: { status: "observed", value: "enabled" },
    privateUsers: { status: "observed", value: "disabled" },
    restrictNamespaces: { status: "observed", value: "selective" },
    systemCallFilter: { status: "observed", value: "configured" },
  });
  const serialized = JSON.stringify(observed);
  assert(!serialized.includes("private-owned"));
  assert(!serialized.includes("PRIVATE_TOKEN"));
  assert(!serialized.includes("@mount"));

  const overflowed = await observeNamespacePolicyBoundary(
    (path) => Promise.resolve(reads.get(path) ?? { status: "missing" }),
    (_executable, args) => {
      const property = args.find((argument) =>
        argument.startsWith("--property=")
      );
      return Promise.resolve(command("PRIVATE_TOKEN=do-not-emit", {
        overflow: property === "--property=SystemCallFilter",
      }));
    },
  );
  assertEquals(overflowed.runnerService.systemCallFilter, {
    status: "overflow",
  });
  assert(!JSON.stringify(overflowed).includes("PRIVATE_TOKEN"));

  const denied = await observeNamespacePolicyBoundary(
    () => Promise.resolve({ status: "permission-denied" }),
    () => {
      throw new Error("runner service command must not run without discovery");
    },
  );
  assertEquals(denied.process.seccomp.status, "permission-denied");
  assertEquals(
    denied.namespaceSysctls.maxUserNamespaces.status,
    "permission-denied",
  );
  assertEquals(denied.runnerService.discovery, "permission-denied");
  assertEquals(denied.visibleBoundary, "inconclusive");
  assertEquals(processStatusObservation({ status: "missing" }), {
    seccomp: { status: "missing" },
    noNewPrivs: { status: "missing" },
  });

  const invalidReads = new Map(reads);
  invalidReads.set(
    POLICY_PATHS.processStatus,
    encode("NoNewPrivs:\t2\nSeccomp:\t9\nSeccomp:\t2\n"),
  );
  invalidReads.set(POLICY_PATHS.processCgroup, encode("hostile cgroup text\n"));
  invalidReads.set(POLICY_PATHS.unprivilegedUsernsClone, encode("-1\n"));
  invalidReads.set(POLICY_PATHS.maxUserNamespaces, encode("4294967296\n"));
  const invalid = await observeNamespacePolicyBoundary(
    (path) =>
      Promise.resolve(invalidReads.get(path) ?? { status: "unavailable" }),
    () => {
      throw new Error(
        "runner service command must not run after invalid discovery",
      );
    },
  );
  assertEquals(invalid.process.seccomp.status, "invalid");
  assertEquals(invalid.process.noNewPrivs.status, "invalid");
  assertEquals(
    invalid.namespaceSysctls.unprivilegedUsernsClone.status,
    "invalid",
  );
  assertEquals(invalid.namespaceSysctls.maxUserNamespaces.status, "invalid");
  assertEquals(invalid.runnerService.discovery, "invalid");

  const timedOut = await observeNamespacePolicyBoundary(
    (path) => Promise.resolve(reads.get(path) ?? { status: "missing" }),
    () =>
      Promise.resolve(command("PRIVATE_TOKEN=do-not-emit", { timedOut: true })),
  );
  assertEquals(timedOut.runnerService.noNewPrivileges.status, "timeout");
  assertEquals(timedOut.runnerService.privateUsers.status, "timeout");
  assertEquals(timedOut.runnerService.restrictNamespaces.status, "timeout");
  assertEquals(timedOut.runnerService.systemCallFilter.status, "timeout");
  assert(!JSON.stringify(timedOut).includes("PRIVATE_TOKEN"));
});

Deno.test("direct namespace prerequisite diagnostic is bounded and enum-only", async () => {
  const directory = await Deno.makeTempDir({ prefix: "bakery-unshare-probe-" });
  const unsharePath = `${directory}/unshare`;
  await Deno.writeTextFile(
    unsharePath,
    `#!/bin/sh
case "$*" in
  --version) printf '%s\\n' 'unshare test version' ;;
  *--mount*) printf '%s\\n' 'unshare: unshare failed: Operation not supported' >&2; exit 1 ;;
  *--net*) exec sleep 2 ;;
  *) exec /usr/bin/true ;;
esac
`,
  );
  await Deno.chmod(unsharePath, 0o700);
  try {
    const startup = new DraftIsolationError(
      "unavailable",
      "WORKER_STARTUP_FAILED",
      {
        failureClass: "unknown",
        exitCode: 226,
        signal: 0,
        stderrOverflow: false,
      },
    );
    const diagnostic = await directNamespacePrerequisiteDiagnostic(
      startup,
      unsharePath,
      runBoundedProbe,
      () => Promise.resolve(unobservedPolicyBoundary()),
    );
    assertEquals(diagnostic?.conclusion, "direct-primitive-unavailable");
    assertEquals(diagnostic?.user, { status: "available", errno: "none" });
    assertEquals(diagnostic?.mount, { status: "failed", errno: "ENOTSUP" });
    assertEquals(diagnostic?.network, { status: "timeout", errno: "none" });
    assertEquals(diagnostic?.unshareVersion.status, "observed");
    assertEquals(
      JSON.stringify(diagnostic).includes("unshare test version"),
      false,
    );

    await Deno.writeTextFile(
      unsharePath,
      `#!/bin/sh
case "$*" in
  --version) printf '%s\\n' 'unshare test version' ;;
  *) exec /usr/bin/true ;;
esac
`,
    );
    const available = await directNamespacePrerequisiteDiagnostic(
      startup,
      unsharePath,
      runBoundedProbe,
      () => Promise.resolve(unobservedPolicyBoundary()),
    );
    assertEquals(
      available?.conclusion,
      "direct-primitives-available-systemd-unit-failed",
    );
    assertEquals(available?.user.status, "available");
    assertEquals(available?.mount.status, "available");
    assertEquals(available?.network.status, "available");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("direct namespace prerequisite diagnostic fails closed", async () => {
  const startup = new DraftIsolationError(
    "unavailable",
    "WORKER_STARTUP_FAILED",
    {
      failureClass: "unknown",
      exitCode: 226,
      signal: 0,
      stderrOverflow: false,
    },
  );
  const diagnostic = await directNamespacePrerequisiteDiagnostic(
    startup,
    `/tmp/bakery-missing-unshare-${crypto.randomUUID()}`,
    runBoundedProbe,
    () => Promise.resolve(unobservedPolicyBoundary()),
  );
  assertEquals(diagnostic, {
    conclusion: "inconclusive",
    unshareVersion: { status: "missing" },
    user: { status: "missing", errno: "none" },
    mount: { status: "missing", errno: "none" },
    network: { status: "missing", errno: "none" },
    policyBoundary: unobservedPolicyBoundary(),
  });

  const emptyOutput = { output: new Uint8Array(), overflow: false };
  const successfulExecution: BoundedProbeExecution = {
    status: "started",
    result: {
      status: { success: true, code: 0, signal: null },
      stdout: emptyOutput,
      stderr: emptyOutput,
      timedOut: false,
    },
  };
  const unavailableVersions: readonly [
    BoundedProbeExecution,
    Exclude<
      DirectNamespacePrerequisiteDiagnostic["unshareVersion"]["status"],
      "observed"
    >,
  ][] = [
    [{ status: "missing" }, "missing"],
    [{ status: "permission-denied" }, "permission-denied"],
    [{ status: "failed" }, "failed"],
    [{
      status: "started",
      result: {
        ...successfulExecution.result,
        timedOut: true,
      },
    }, "timeout"],
    [{
      status: "started",
      result: {
        ...successfulExecution.result,
        stdout: { output: new Uint8Array(256), overflow: true },
      },
    }, "output-overflow"],
  ];
  for (const [versionExecution, expectedStatus] of unavailableVersions) {
    const versionUnavailable = await directNamespacePrerequisiteDiagnostic(
      startup,
      "/bounded/fixture/unshare",
      (_executable, args) =>
        Promise.resolve(
          args[0] === "--version" ? versionExecution : successfulExecution,
        ),
      () => Promise.resolve(unobservedPolicyBoundary()),
    );
    assertEquals(versionUnavailable?.conclusion, "inconclusive");
    assertEquals(versionUnavailable?.unshareVersion, {
      status: expectedStatus,
    });
    assertEquals(versionUnavailable?.user.status, "available");
    assertEquals(versionUnavailable?.mount.status, "available");
    assertEquals(versionUnavailable?.network.status, "available");
  }
});

Deno.test("pre-READY startup diagnostics are bounded, allowlisted, and reaped", async () => {
  const hostile = "PRIVATE_TOKEN=do-not-emit /home/runner/private-worker.ts";
  const fixtures = [
    {
      script:
        `printf '%s\\n' 'Failed to set unit properties: Unknown assignment' '${hostile}' >&2\nexit 73`,
      expected: {
        failureClass: "hardening",
        exitCode: 73,
        signal: 0,
        stderrOverflow: false,
      },
    },
    {
      script:
        `i=0; while [ "$i" -lt 7000 ]; do printf '%s\\n' '${hostile}' >&2; i=$((i + 1)); done\nexit 74`,
      expected: {
        failureClass: "unknown",
        exitCode: 74,
        signal: 0,
        stderrOverflow: true,
      },
    },
  ] as const;
  for (const fixture of fixtures) {
    const boundary = await fakeDraftBoundary(fixture.script);
    try {
      const error = await assertRejects(
        () => createDraftIsolation(boundary).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(error.kind, "unavailable");
      assertEquals(error.startupDiagnostic, fixture.expected);
      assert(!error.message.includes(hostile));
      assert(!JSON.stringify(error.startupDiagnostic).includes(hostile));
      const cleanup = await Deno.readTextFile(boundary.logPath);
      assert(cleanup.includes("kill --kill-who=all --signal=KILL"));
      assert(cleanup.includes("stop bakery-draft-"));
      assert(cleanup.includes("reset-failed bakery-draft-"));
      assert(cleanup.includes("show bakery-draft-"));
      const launch = await Deno.readTextFile(boundary.systemdRunLogPath);
      assert(!launch.includes("--collect"));
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        {
          recursive: true,
        },
      );
    }
  }
});

Deno.test("retained boundary cleanup reaps success and reports failure", async () => {
  const successful = await fakeDraftBoundary(`
while [ "$#" -gt 0 ] && [ "$1" != "--property=InaccessiblePaths=/var/tmp" ]; do
  shift
done
shift
exec "$@"`);
  try {
    const candidate = await createDraftIsolation(successful).initialize("x");
    assert(candidate.state.length > 0);
    const cleanup = await Deno.readTextFile(successful.logPath);
    assert(cleanup.includes("reset-failed bakery-draft-"));
    assert(cleanup.includes("show bakery-draft-"));
    const launch = await Deno.readTextFile(successful.systemdRunLogPath);
    assert(!launch.includes("--collect"));
  } finally {
    await Deno.remove(
      new URL(".", `file://${successful.systemdRunPath}`).pathname,
      { recursive: true },
    );
  }

  const failed = await fakeDraftBoundary("exit 73", {
    resetFailed: "exit 1",
    cleanupShow:
      "printf '%s\\n' 'LoadState=loaded' 'ActiveState=failed' 'ControlGroup=/user.slice/retained' 'MainPID=0'",
  });
  try {
    const error = await assertRejects(
      () => createDraftIsolation(failed).initialize("x"),
      DraftIsolationError,
      "WORKER_CGROUP_REMAINS",
    );
    assertEquals(error.kind, "unavailable");
    const cleanup = await Deno.readTextFile(failed.logPath);
    assert(cleanup.includes("reset-failed bakery-draft-"));
    assert(cleanup.includes("show bakery-draft-"));
  } finally {
    await Deno.remove(
      new URL(".", `file://${failed.systemdRunPath}`).pathname,
      { recursive: true },
    );
  }
});

Deno.test("missing systemd executables report host isolation unavailable", async () => {
  const boundary = await fakeDraftBoundary("exit 0");
  const directory = new URL(".", `file://${boundary.systemdRunPath}`).pathname;
  try {
    const { initial, input } = await validEditInput();
    const missingRun = createDraftIsolation({
      ...boundary,
      systemdRunPath: `${directory}absent-systemd-run`,
    });
    for (
      const attempt of [
        () => missingRun.initialize("x"),
        () => missingRun.edit(initial.state, initial.state, input),
        () => missingRun.slice(initial.state, 0, 6),
      ]
    ) {
      const error = await assertRejects(
        attempt,
        DraftIsolationError,
        "HOST_ISOLATION_UNAVAILABLE",
      );
      assertEquals(error.kind, "unavailable");
      assertEquals(error.startupDiagnostic, {
        failureClass: "executable",
        exitCode: 127,
        signal: 0,
        stderrOverflow: false,
      });
    }
    const launches = await Deno.readTextFile(boundary.systemdRunLogPath).catch(
      () => "",
    );
    assertEquals(launches, "");

    // A present launcher with an absent systemctl never leaks a raw Deno error.
    await Deno.writeTextFile(
      boundary.systemdRunPath,
      `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--property=InaccessiblePaths=/var/tmp" ]; do
  shift
done
shift
exec "$@"`,
    );
    const missingSystemctl = createDraftIsolation({
      ...boundary,
      systemctlPath: `${directory}absent-systemctl`,
    });
    const error = await assertRejects(
      () => missingSystemctl.initialize("x"),
      DraftIsolationError,
      "HOST_ISOLATION_UNAVAILABLE",
    );
    assertEquals(error.kind, "unavailable");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("present launcher still completes an edit and a non-executable one keeps its startup code", async () => {
  const boundary = await fakeDraftBoundary(`
while [ "$#" -gt 0 ] && [ "$1" != "--property=InaccessiblePaths=/var/tmp" ]; do
  shift
done
shift
exec "$@"`);
  const directory = new URL(".", `file://${boundary.systemdRunPath}`).pathname;
  try {
    const { initial, input } = await validEditInput();
    const isolation = createDraftIsolation(boundary);
    const edited = await isolation.edit(initial.state, initial.state, input);
    assert(edited.state.length > 0);
    const launch = await Deno.readTextFile(boundary.systemdRunLogPath);
    assert(launch.includes("bakery-draft-"));

    await Deno.chmod(boundary.systemdRunPath, 0o644);
    const error = await assertRejects(
      () => isolation.edit(initial.state, initial.state, input),
      DraftIsolationError,
      "WORKER_STARTUP_FAILED",
    );
    assertEquals(error.kind, "unavailable");
    assertEquals(error.startupDiagnostic?.failureClass, "executable");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("namespace failure observes only fixed bounded prerequisites", async () => {
  const versionFingerprint = async (value: string) => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
    return `sha256:${
      Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    }`;
  };
  const hostileVersion = "vendor\u001b[31m PRIVATE_TOKEN=do-not-emit";
  const probe = expectedNamespaceProbe;
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const paths = {
    unprivilegedUsernsClone: "/proc/sys/kernel/unprivileged_userns_clone",
    maxUserNamespaces: "/proc/sys/user/max_user_namespaces",
    apparmorRestrictUnprivilegedUserns:
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  } as const;
  const fixtures = [
    {
      diagnostic: {
        userManagerVersion: "printf '%s\\n' '254.26-1'",
        namespaceStatus:
          "printf '%s\\n' 'Failed to set up user namespacing: Operation not permitted'; exit 3",
        privateUsers: "printf '%s\\n' 'yes'",
      },
      read: (path: string) => {
        if (path === paths.unprivilegedUsernsClone) {
          return { output: new TextEncoder().encode("1\n"), overflow: false };
        }
        if (path === paths.maxUserNamespaces) {
          throw new Deno.errors.PermissionDenied("denied");
        }
        throw new Deno.errors.NotFound("missing");
      },
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint("254.26-1"),
        },
        namespaceSetup: {
          status: "denied",
          operation: "user",
          errno: "EPERM",
          probe: probe(
            "matched",
            3,
            bytes(
              "Failed to set up user namespacing: Operation not permitted\n",
            ),
          ),
        },
        privateUsers: { status: "observed", value: "yes" },
        unprivilegedUsernsClone: { status: "observed", value: 1 },
        maxUserNamespaces: { status: "denied" },
        apparmorRestrictUnprivilegedUserns: { status: "missing" },
      },
    },
    {
      diagnostic: {
        userManagerVersion: "printf '%s\\n' 'v259'",
        namespaceStatus:
          "printf '%s\\n' 'Failed at step NAMESPACE spawning /private/other-unit/worker PRIVATE_TOKEN=do-not-emit: Permission denied'; exit 3",
        privateUsers: "printf '%s\\n' 'no'",
      },
      read: () => {
        throw new Deno.errors.NotCapable(
          "Requires read access to procfs, run again with --allow-read",
        );
      },
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint("v259"),
        },
        namespaceSetup: {
          status: "denied",
          operation: "namespace",
          errno: "EACCES",
          probe: probe(
            "matched",
            3,
            bytes(
              "Failed at step NAMESPACE spawning /private/other-unit/worker PRIVATE_TOKEN=do-not-emit: Permission denied\n",
            ),
          ),
        },
        privateUsers: { status: "observed", value: "no" },
        unprivilegedUsernsClone: { status: "denied" },
        maxUserNamespaces: { status: "denied" },
        apparmorRestrictUnprivilegedUserns: { status: "denied" },
      },
    },
    {
      diagnostic: {
        userManagerVersion:
          "i=0; while [ $i -lt 1100 ]; do printf x; i=$((i + 1)); done; printf '\\n'",
        namespaceStatus:
          "i=0; while [ $i -lt 5000 ]; do printf x; i=$((i + 1)); done; printf '\\n'; exit 3",
        privateUsers: "printf '%s\\n' 'maybe'",
      },
      read: (path: string) => {
        if (path === paths.unprivilegedUsernsClone) {
          return { output: new TextEncoder().encode("-1\n"), overflow: false };
        }
        if (path === paths.maxUserNamespaces) {
          return { output: new Uint8Array(64), overflow: true };
        }
        return { output: new TextEncoder().encode("0\n"), overflow: false };
      },
      expected: {
        userManagerVersion: { status: "overflow" },
        namespaceSetup: {
          status: "unavailable",
          probe: probe("overflow", 3, 4096),
          journalProbe: probe("failed", 1, 0),
        },
        privateUsers: { status: "invalid" },
        unprivilegedUsernsClone: { status: "invalid" },
        maxUserNamespaces: { status: "overflow" },
        apparmorRestrictUnprivilegedUserns: { status: "observed", value: 0 },
      },
    },
    {
      diagnostic: {
        userManagerVersion:
          "printf 'vendor\\033[31m PRIVATE_TOKEN=do-not-emit\\n'",
        namespaceStatus:
          "printf '%s' 'Failed to set up user namespacing: Operation not perm'; exit 3",
        privateUsers: "exit 0",
      },
      read: () => {
        throw new Error("unavailable");
      },
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint(hostileVersion),
        },
        namespaceSetup: {
          status: "unavailable",
          probe: probe(
            "failed",
            3,
            bytes("Failed to set up user namespacing: Operation not perm"),
            0,
            {
              unmatchedReason: "known-errno-absent",
              namespaceStageSeen: true,
              knownErrnoSeen: false,
            },
          ),
          journalProbe: probe("failed", 1, 0),
        },
        privateUsers: { status: "missing" },
        unprivilegedUsernsClone: { status: "unavailable" },
        maxUserNamespaces: { status: "unavailable" },
        apparmorRestrictUnprivilegedUserns: { status: "unavailable" },
      },
    },
    {
      diagnostic: {
        userManagerVersion: "printf '%s\\n' '259 (259.7-1-arch vendor.build)'",
        namespaceStatus:
          "printf '%s\\n' 'Failed to set up mount namespacing: No such file or directory'; exit 3",
        privateUsers: "printf '%s\\n' 'Permission denied' >&2; exit 1",
      },
      read: () => ({
        output: new TextEncoder().encode("123\n"),
        overflow: false,
      }),
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint("259 (259.7-1-arch vendor.build)"),
        },
        namespaceSetup: {
          status: "missing",
          operation: "mount",
          errno: "ENOENT",
          probe: probe(
            "matched",
            3,
            bytes(
              "Failed to set up mount namespacing: No such file or directory\n",
            ),
          ),
        },
        privateUsers: { status: "denied" },
        unprivilegedUsernsClone: { status: "observed", value: 123 },
        maxUserNamespaces: { status: "observed", value: 123 },
        apparmorRestrictUnprivilegedUserns: {
          status: "observed",
          value: 123,
        },
      },
    },
    {
      diagnostic: {
        userManagerVersion: "exit 0",
        namespaceStatus:
          "printf '%s\\n' '{\"MESSAGE\":\"other-unit PRIVATE_TOKEN=do-not-emit\"}'; exit 3",
        privateUsers: "printf '%s\\n' 'no'",
      },
      read: () => {
        throw new Error("unavailable");
      },
      expected: {
        userManagerVersion: { status: "missing" },
        namespaceSetup: {
          status: "unavailable",
          probe: probe(
            "failed",
            3,
            bytes('{"MESSAGE":"other-unit PRIVATE_TOKEN=do-not-emit"}\n'),
          ),
          journalProbe: probe("failed", 1, 0),
        },
        privateUsers: { status: "observed", value: "no" },
        unprivilegedUsernsClone: { status: "unavailable" },
        maxUserNamespaces: { status: "unavailable" },
        apparmorRestrictUnprivilegedUserns: { status: "unavailable" },
      },
    },
    {
      diagnostic: {
        userManagerVersion: "printf '%s\\n' '259'",
        namespaceStatus:
          "printf '%s\\n' 'PRIVATE_TOKEN=do-not-emit /private/worker'; exit 0",
        privateUsers: "printf '%s\\n' 'no'",
      },
      read: () => {
        throw new Error("unavailable");
      },
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint("259"),
        },
        namespaceSetup: {
          status: "unavailable",
          probe: probe(
            "no-match",
            0,
            bytes("PRIVATE_TOKEN=do-not-emit /private/worker\n"),
          ),
          journalProbe: probe("failed", 1, 0),
        },
        privateUsers: { status: "observed", value: "no" },
        unprivilegedUsernsClone: { status: "unavailable" },
        maxUserNamespaces: { status: "unavailable" },
        apparmorRestrictUnprivilegedUserns: { status: "unavailable" },
      },
    },
    {
      diagnostic: {
        userManagerVersion: "printf '%s\\n' '259'",
        namespaceStatus: "exec sleep 1",
        privateUsers: "printf '%s\\n' 'no'",
      },
      read: () => {
        throw new Error("unavailable");
      },
      expected: {
        userManagerVersion: {
          status: "observed",
          value: await versionFingerprint("259"),
        },
        namespaceSetup: {
          status: "unavailable",
          probe: probe("timeout", 137, 0),
          journalProbe: probe("failed", 1, 0),
        },
        privateUsers: { status: "observed", value: "no" },
        unprivilegedUsernsClone: { status: "unavailable" },
        maxUserNamespaces: { status: "unavailable" },
        apparmorRestrictUnprivilegedUserns: { status: "unavailable" },
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const boundary = await fakeDraftBoundary("exit 226", fixture.diagnostic);
    const readPaths: string[] = [];
    try {
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: async (path, limit) => {
              assertEquals(limit, 64);
              readPaths.push(path);
              return await fixture.read(path);
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(error.kind, "unavailable");
      assertEquals(error.startupDiagnostic, {
        failureClass: "unknown",
        exitCode: 226,
        signal: 0,
        stderrOverflow: false,
        namespacePrerequisites: fixture.expected,
      });
      assertEquals(readPaths.sort(), Object.values(paths).sort());

      const systemdRunCalls =
        (await Deno.readTextFile(boundary.systemdRunLogPath))
          .trim().split("\n");
      assertEquals(systemdRunCalls.length, 1);

      const systemctlCalls = (await Deno.readTextFile(boundary.logPath)).trim()
        .split("\n");
      assertEquals(
        systemctlCalls.filter((call) =>
          call === "--user show --property=Version --value"
        ),
        ["--user show --property=Version --value"],
      );
      const namespaceStatusCalls = systemctlCalls.filter((call) =>
        call.includes(" status bakery-draft-")
      );
      assertEquals(namespaceStatusCalls.length, 1);
      assert(namespaceStatusCalls[0].endsWith(
        ".service --no-pager --lines=8 --output=short --full",
      ));
      const privateUsersCalls = systemctlCalls.filter((call) =>
        call.includes("--property=PrivateUsers")
      );
      assertEquals(privateUsersCalls.length, 1);
      assert(privateUsersCalls[0].startsWith("--user show bakery-draft-"));
      assert(privateUsersCalls[0].endsWith(
        ".service --property=PrivateUsers --value",
      ));
      const serialized = JSON.stringify(error.startupDiagnostic);
      assert(!serialized.includes("vendor.build"));
      assert(!serialized.includes("PRIVATE_TOKEN"));
      assert(!serialized.includes("other-unit"));
      assert(!serialized.includes("worker"));
      assert(!serialized.includes("\u001b"));
      assert(
        systemctlCalls.some((call) =>
          call.startsWith("--user kill --kill-who=all --signal=KILL")
        ),
      );
      assert(
        systemctlCalls.some((call) =>
          call.startsWith("--user stop bakery-draft-")
        ),
      );
      assert(
        systemctlCalls.some((call) =>
          call.startsWith("--user reset-failed bakery-draft-")
        ),
      );
      assert(
        systemctlCalls.some((call) => call.includes("--property=LoadState")),
      );
      const statusCallIndex = systemctlCalls.indexOf(namespaceStatusCalls[0]);
      const resetCallIndex = systemctlCalls.findIndex((call) =>
        call.startsWith("--user reset-failed bakery-draft-")
      );
      const cleanupShowIndex = systemctlCalls.findIndex((call) =>
        call.includes("--property=LoadState")
      );
      assert(statusCallIndex >= 0);
      assert(resetCallIndex > statusCallIndex);
      assert(cleanupShowIndex > resetCallIndex);
      const launch = await Deno.readTextFile(boundary.systemdRunLogPath);
      assert(!launch.includes("--collect"));
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("namespace diagnostics cover fixed Linux errno and systemd stage variants", async () => {
  const errnos = [
    ["Argument list too long", "E2BIG", "failed"],
    ["Permission denied", "EACCES", "denied"],
    ["Resource temporarily unavailable", "EAGAIN", "failed"],
    ["Bad file descriptor", "EBADF", "failed"],
    ["Device or resource busy", "EBUSY", "failed"],
    ["File exists", "EEXIST", "failed"],
    ["Invalid argument", "EINVAL", "failed"],
    ["Input/output error", "EIO", "failed"],
    ["Too many levels of symbolic links", "ELOOP", "failed"],
    ["Too many open files", "EMFILE", "failed"],
    ["File name too long", "ENAMETOOLONG", "failed"],
    ["Too many open files in system", "ENFILE", "failed"],
    ["No such device", "ENODEV", "failed"],
    ["No such file or directory", "ENOENT", "missing"],
    ["Cannot allocate memory", "ENOMEM", "failed"],
    ["No space left on device", "ENOSPC", "failed"],
    ["Function not implemented", "ENOSYS", "failed"],
    ["Not a directory", "ENOTDIR", "failed"],
    ["Operation not supported", "ENOTSUP", "failed"],
    ["No such device or address", "ENXIO", "failed"],
    ["Operation not permitted", "EPERM", "denied"],
    ["Read-only file system", "EROFS", "failed"],
    ["Too many users", "EUSERS", "failed"],
  ] as const;
  const stages = [
    [
      "namespace",
      (error: string) => `Failed to apply namespace restrictions: ${error}`,
    ],
    [
      "pid",
      (error: string) =>
        `Failed to fork child into new pid namespace: ${error}`,
    ],
    [
      "user",
      (error: string) =>
        `Failed to join freshly allocated user namespace: ${error}`,
    ],
    [
      "ipc",
      (error: string) =>
        `Failed to open IPC namespace path /private/PRIVATE_TOKEN: ${error}`,
    ],
    [
      "network",
      (error: string) =>
        `Failed to open network namespace path /private/PRIVATE_TOKEN: ${error}`,
    ],
    [
      "user",
      (error: string) =>
        `Failed to open user namespace path /private/PRIVATE_TOKEN: ${error}`,
    ],
    ["ipc", (error: string) => `Failed to set up IPC namespacing: ${error}`],
    ["uts", (error: string) => `Failed to set up UTS namespacing: ${error}`],
    [
      "cgroup",
      (error: string) => `Failed to set up cgroup namespacing: ${error}`,
    ],
    [
      "mount",
      (error: string) =>
        `Failed to set up mount namespacing in /private/PRIVATE_TOKEN: ${error}`,
    ],
    [
      "network",
      (error: string) => `Failed to set up network namespacing: ${error}`,
    ],
    ["pid", (error: string) => `Failed to set up pid namespace: ${error}`],
    [
      "user",
      (error: string) =>
        `Failed to set up user namespacing for unprivileged user: ${error}`,
    ],
    ["user", (error: string) => `Failed to set up user namespacing: ${error}`],
    [
      "user",
      (error: string) => `Failed to unshare user namespace: ${error}`,
    ],
    [
      "namespace",
      (error: string) =>
        `Failed at step NAMESPACE spawning /private/PRIVATE_TOKEN: ${error}`,
    ],
  ] as const;

  for (const [index, [message, errno, status]] of errnos.entries()) {
    const [operation, render] = stages[index % stages.length];
    const line = render(message);
    const boundary = await fakeDraftBoundary("exit 226", {
      namespaceStatus: `printf '%s\\n' ${JSON.stringify(line)}; exit 3`,
    });
    try {
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: () => {
              throw new Error("unavailable");
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(error.kind, "unavailable");
      assertEquals(
        error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
        {
          status,
          operation,
          errno,
          probe: {
            status: "matched",
            exitCode: 3,
            stdoutBytes: new TextEncoder().encode(`${line}\n`).byteLength,
            stderrBytes: 0,
          },
        },
      );
      const serialized = JSON.stringify(error.startupDiagnostic);
      assert(!serialized.includes("PRIVATE_TOKEN"));
      assert(!serialized.includes("/private/"));
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("namespace journal accepts only the generated unit prefix", async () => {
  const uuid = "00000000-0000-0000-0000-000000000000";
  const unit = `bakery-draft-${uuid}.service`;
  const message = "Failed to set up user namespacing: Invalid argument";
  const statusLine = `Oct 05 host systemd[123]: ${unit}: ${message}`;
  const journalLine = `${unit}: ${message}`;
  const boundary = await fakeDraftBoundary("exit 226", {
    namespaceStatus: `
unit=''
for argument in "$@"; do
  case "$argument" in bakery-draft-*.service) unit="$argument" ;; esac
done
printf 'Oct 05 host systemd[123]: %s: %s\\n' "$unit" ${JSON.stringify(message)}
exit 3`,
    namespaceJournal: `
unit=''
for argument in "$@"; do
  case "$argument" in bakery-draft-*.service) unit="$argument" ;; esac
done
printf '%s: %s\\n' "$unit" ${JSON.stringify(message)}
exit 3`,
  });
  try {
    const error = await assertRejects(
      () =>
        createDraftIsolation({
          ...boundary,
          namespaceFileReader: () => {
            throw new Error("unavailable");
          },
        }).initialize("x"),
      DraftIsolationError,
      "WORKER_STARTUP_FAILED",
    );
    assertEquals(
      error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
      {
        status: "failed",
        operation: "user",
        errno: "EINVAL",
        probe: expectedNamespaceProbe(
          "failed",
          3,
          new TextEncoder().encode(`${statusLine}\n`).byteLength,
          0,
          {
            unmatchedReason: "namespace-stage-absent",
            namespaceStageSeen: false,
            knownErrnoSeen: true,
          },
        ),
        journalProbe: expectedNamespaceProbe(
          "matched",
          3,
          new TextEncoder().encode(`${journalLine}\n`).byteLength,
        ),
      },
    );
  } finally {
    await Deno.remove(
      new URL(".", `file://${boundary.systemdRunPath}`).pathname,
      { recursive: true },
    );
  }
});

Deno.test("namespace journal rejects other-unit and embedded stage markers", async () => {
  const message = "Failed to set up user namespacing: Invalid argument";
  const otherUnit = "bakery-draft-00000000-0000-0000-0000-000000000000.service";
  const fixtures = [
    {
      script: `printf '%s: %s\\n' ${JSON.stringify(otherUnit)} ${
        JSON.stringify(message)
      }; exit 3`,
      line: `${otherUnit}: ${message}`,
    },
    {
      script: `
unit=''
for argument in "$@"; do
  case "$argument" in bakery-draft-*.service) unit="$argument" ;; esac
done
printf '%s: hostile %s\\n' "$unit" ${JSON.stringify(message)}
exit 3`,
      line:
        `bakery-draft-00000000-0000-0000-0000-000000000000.service: hostile ${message}`,
    },
  ] as const;

  for (const fixture of fixtures) {
    const boundary = await fakeDraftBoundary("exit 226", {
      namespaceStatus: "printf '%s\\n' 'unrelated: Invalid argument'; exit 3",
      namespaceJournal: fixture.script,
    });
    try {
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: () => {
              throw new Error("unavailable");
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(
        error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
        {
          status: "unavailable",
          probe: expectedNamespaceProbe(
            "failed",
            3,
            new TextEncoder().encode("unrelated: Invalid argument\n")
              .byteLength,
            0,
            {
              unmatchedReason: "namespace-stage-absent",
              namespaceStageSeen: false,
              knownErrnoSeen: true,
            },
          ),
          journalProbe: expectedNamespaceProbe(
            "failed",
            3,
            new TextEncoder().encode(`${fixture.line}\n`).byteLength,
            0,
            {
              unmatchedReason: "namespace-stage-absent",
              namespaceStageSeen: false,
              knownErrnoSeen: true,
            },
          ),
        },
      );
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("namespace diagnostics classify unmatched output without exposing it", async () => {
  const fixedStagePrefixes = [
    "Failed to apply namespace restrictions: ",
    "Failed to fork child into new pid namespace: ",
    "Failed to join freshly allocated user namespace: ",
    "Failed to set up IPC namespacing: ",
    "Failed to set up UTS namespacing: ",
    "Failed to set up cgroup namespacing: ",
    "Failed to set up network namespacing: ",
    "Failed to set up pid namespace: ",
    "Failed to set up user namespacing for unprivileged user: ",
    "Failed to set up user namespacing: ",
    "Failed to unshare user namespace: ",
  ] as const;
  const fixtures = [
    ...fixedStagePrefixes.map((prefix) => ({
      line: `${prefix}PRIVATE_TOKEN=/private/worker: Invalid argument` as const,
      evidence: {
        unmatchedReason: "format-unrecognized" as const,
        namespaceStageSeen: true,
        knownErrnoSeen: true,
      },
    })),
    {
      line:
        "other PRIVATE_TOKEN=/private/worker Failed to set up user namespacing: Invalid argument",
      evidence: {
        unmatchedReason: "namespace-stage-absent",
        namespaceStageSeen: false,
        knownErrnoSeen: true,
      },
    },
    {
      line:
        "Failed to set up user namespacing: Stale file handle PRIVATE_TOKEN=/private/worker",
      evidence: {
        unmatchedReason: "known-errno-absent",
        namespaceStageSeen: true,
        knownErrnoSeen: false,
      },
    },
    {
      line:
        "Failed to set up user namespacing for unprivileged user, ignoring: Invalid argument",
      evidence: {
        unmatchedReason: "format-unrecognized",
        namespaceStageSeen: true,
        knownErrnoSeen: true,
      },
    },
    {
      line:
        "PrivateIPC=yes is configured, but IPC namespace setup failed, ignoring: Invalid argument",
      evidence: {
        unmatchedReason: "format-unrecognized",
        namespaceStageSeen: true,
        knownErrnoSeen: true,
      },
    },
    {
      line:
        "PrivateNetwork=yes is configured, but network namespace setup not permitted, proceeding without: Invalid argument",
      evidence: {
        unmatchedReason: "format-unrecognized",
        namespaceStageSeen: true,
        knownErrnoSeen: true,
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const boundary = await fakeDraftBoundary("exit 226", {
      namespaceStatus: `printf '%s\\n' ${JSON.stringify(fixture.line)}; exit 3`,
    });
    try {
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: () => {
              throw new Error("unavailable");
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(
        error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
        {
          status: "unavailable",
          probe: {
            status: "failed",
            exitCode: 3,
            stdoutBytes: new TextEncoder().encode(`${fixture.line}\n`)
              .byteLength,
            stderrBytes: 0,
            ...fixture.evidence,
          },
          journalProbe: {
            status: "failed",
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 0,
            unmatchedReason: "namespace-stage-absent",
            namespaceStageSeen: false,
            knownErrnoSeen: false,
          },
        },
      );
      const serialized = JSON.stringify(error.startupDiagnostic);
      assert(!serialized.includes("PRIVATE_TOKEN"));
      assert(!serialized.includes("/private/"));
      assert(!serialized.includes("worker"));
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("namespace failure falls back to the owned bounded journal before cleanup", async () => {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const statusOutput = "PRIVATE_TOKEN=status-secret /private/status-worker\n";
  const probe = expectedNamespaceProbe;
  const fixtures = [
    {
      journal:
        "printf '%s\\n' 'Failed to set up network namespacing: Operation not permitted'",
      expected: {
        status: "denied",
        operation: "network",
        errno: "EPERM",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe(
          "matched",
          0,
          bytes(
            "Failed to set up network namespacing: Operation not permitted\n",
          ),
        ),
      },
    },
    {
      journal:
        "printf '%s\\n' 'Failed to set up mount namespacing: /private/PRIVATE_TOKEN=journal-secret: No such file or directory'",
      expected: {
        status: "missing",
        operation: "mount",
        errno: "ENOENT",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe(
          "matched",
          0,
          bytes(
            "Failed to set up mount namespacing: /private/PRIVATE_TOKEN=journal-secret: No such file or directory\n",
          ),
        ),
      },
    },
    {
      journal:
        "printf '%s\\n' 'Failed at step NAMESPACE spawning /private/worker: No such file or directory' >&2; exit 3",
      expected: {
        status: "missing",
        operation: "namespace",
        errno: "ENOENT",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe(
          "matched",
          3,
          0,
          bytes(
            "Failed at step NAMESPACE spawning /private/worker: No such file or directory\n",
          ),
        ),
      },
    },
    {
      journal: "exec sleep 1",
      expected: {
        status: "unavailable",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe("timeout", 137, 0),
      },
    },
    {
      journal:
        "i=0; while [ $i -lt 5000 ]; do printf x; i=$((i + 1)); done; printf ' PRIVATE_TOKEN=journal-secret\\n'; exit 3",
      expected: {
        status: "unavailable",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe("overflow", 3, 4096),
      },
    },
    {
      journal:
        "printf '%s\\n' 'Permission denied PRIVATE_TOKEN=journal-secret /private/journal-worker' >&2; exit 1",
      expected: {
        status: "unavailable",
        probe: probe("failed", 3, bytes(statusOutput)),
        journalProbe: probe(
          "failed",
          1,
          0,
          bytes(
            "Permission denied PRIVATE_TOKEN=journal-secret /private/journal-worker\n",
          ),
        ),
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const boundary = await fakeDraftBoundary("exit 226", {
      namespaceStatus:
        "printf '%s\\n' 'PRIVATE_TOKEN=status-secret /private/status-worker'; exit 3",
      namespaceJournal: fixture.journal,
    });
    try {
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: () => {
              throw new Error("unavailable");
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(
        error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
        fixture.expected,
      );

      const journalCalls = (await Deno.readTextFile(boundary.journalLogPath))
        .trim().split("\n");
      assertEquals(journalCalls.length, 1);
      assert(journalCalls[0].startsWith("--user --unit bakery-draft-"));
      assert(journalCalls[0].endsWith(
        ".service --no-pager --lines 20 --output=cat",
      ));
      const statusCall = (await Deno.readTextFile(boundary.logPath)).split("\n")
        .find((call) => call.includes(" status bakery-draft-"));
      assert(statusCall);
      const statusUnit = statusCall.match(
        /status (bakery-draft-[^ ]+\.service)/,
      )
        ?.[1];
      const journalUnit = journalCalls[0].match(
        /--unit (bakery-draft-[^ ]+\.service)/,
      )?.[1];
      assertEquals(journalUnit, statusUnit);

      const sequence = await Deno.readTextFile(boundary.diagnosticSequencePath);
      const journalIndex = sequence.indexOf("journalctl --user --unit");
      const resetIndex = sequence.indexOf("systemctl --user reset-failed");
      assert(journalIndex >= 0);
      assert(resetIndex > journalIndex);
      const serialized = JSON.stringify(error.startupDiagnostic);
      assert(!serialized.includes("PRIVATE_TOKEN"));
      assert(!serialized.includes("/private/"));
      assert(!serialized.includes("worker"));
    } finally {
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("namespace journal fallback fails closed when executable is missing or denied", async () => {
  for (const unavailable of ["missing", "denied"] as const) {
    const boundary = await fakeDraftBoundary("exit 226", {
      namespaceStatus: "printf '%s\\n' 'no namespace match'; exit 3",
      namespaceJournal:
        "printf '%s\\n' 'PRIVATE_TOKEN=journal-secret /private/journal-worker'",
    });
    try {
      if (unavailable === "missing") {
        await Deno.remove(boundary.journalctlPath);
      } else {
        await Deno.chmod(boundary.journalctlPath, 0o000);
      }
      const error = await assertRejects(
        () =>
          createDraftIsolation({
            ...boundary,
            namespaceFileReader: () => {
              throw new Error("unavailable");
            },
          }).initialize("x"),
        DraftIsolationError,
        "WORKER_STARTUP_FAILED",
      );
      assertEquals(
        error.startupDiagnostic?.namespacePrerequisites?.namespaceSetup,
        {
          status: "unavailable",
          probe: {
            status: "failed",
            exitCode: 3,
            stdoutBytes: 19,
            stderrBytes: 0,
            unmatchedReason: "namespace-stage-absent",
            namespaceStageSeen: false,
            knownErrnoSeen: false,
          },
          journalProbe: {
            status: "failed",
            exitCode: 255,
            stdoutBytes: 0,
            stderrBytes: 0,
            unmatchedReason: "probe-unavailable",
          },
        },
      );
      const serialized = JSON.stringify(error.startupDiagnostic);
      assert(!serialized.includes("PRIVATE_TOKEN"));
      assert(!serialized.includes("/private/"));
      assert(!serialized.includes("worker"));
      const systemctlCalls = await Deno.readTextFile(boundary.logPath);
      assert(
        systemctlCalls.indexOf(" status bakery-draft-") <
          systemctlCalls.indexOf(" reset-failed bakery-draft-"),
      );
    } finally {
      await Deno.chmod(boundary.journalctlPath, 0o700).catch(() => undefined);
      await Deno.remove(
        new URL(".", `file://${boundary.systemdRunPath}`).pathname,
        { recursive: true },
      );
    }
  }
});

Deno.test("real isolated adapter rejects malformed, oversized, wrong-root, and pending bytes", async () => {
  const isolation = createDraftIsolation();
  const { initial, input } = await validEditInput();
  await assertRejects(
    () => isolation.edit(new Uint8Array([1, 2, 3]), initial.state, input),
    DraftIsolationError,
  );
  await assertRejects(
    () =>
      isolation.edit(
        new Uint8Array(DRAFT_LIMITS.stateBytes + 1),
        initial.state,
        input,
      ),
    DraftIsolationError,
  );
  const wrongRoot = new LoroDoc();
  wrongRoot.getText("other").insert(0, "target");
  wrongRoot.commit();
  await assertRejects(
    () =>
      isolation.edit(
        wrongRoot.export({ mode: "snapshot" }),
        initial.state,
        input,
      ),
    DraftIsolationError,
  );
  const base = new LoroDoc();
  base.getText("body").insert(0, "seed");
  base.commit();
  const fork = base.fork();
  const from = fork.version();
  fork.getText("body").push("later");
  fork.commit();
  await assertRejects(
    () =>
      isolation.edit(
        fork.export({ mode: "update", from }),
        initial.state,
        input,
      ),
    DraftIsolationError,
  );
});

Deno.test("worker start-up does not spend the work budget: a slow start still completes", async () => {
  // Start-up happens before any client bytes reach the worker, and on a busy
  // host a cold Deno start alone can take over a second. Only the work after
  // READY is metered against workerRuntimeMs.
  const isolation = createDraftIsolation({
    workerPath: new URL(
      "../fixtures/draft-workers/slow-start.ts",
      import.meta.url,
    ).pathname,
  });
  const candidate = await isolation.initialize("slow start");
  assertEquals(candidate.text, "slow start");
});

Deno.test("a worker that never becomes ready times out at the start-up deadline", async () => {
  const isolation = createDraftIsolation({
    workerPath: new URL(
      "../fixtures/draft-workers/never-ready.ts",
      import.meta.url,
    ).pathname,
    startupDeadlineMs: 1_500,
  });
  const started = performance.now();
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  assertEquals(error.kind, "timeout", error.message);
  assert(performance.now() - started < 3_000, "start-up deadline not applied");
});

Deno.test("timeout, memory pressure, trap, and protocol overflow kill and reap boundaries", async () => {
  const fixtures = [
    ["timeout.ts", "timeout"],
    ["memory.ts", "unavailable"],
    ["trap.ts", "unavailable"],
    ["protocol-overflow.ts", "unavailable"],
  ] as const;
  for (const [name, expectedKind] of fixtures) {
    const isolation = createDraftIsolation({
      workerPath: new URL(`../fixtures/draft-workers/${name}`, import.meta.url)
        .pathname,
    });
    const started = performance.now();
    const error = await assertRejects(
      () => isolation.initialize("x"),
      DraftIsolationError,
    );
    const prerequisiteDiagnostic = await directNamespacePrerequisiteDiagnostic(
      error,
    );
    assertEquals(
      error.kind,
      expectedKind,
      `SAFE_STARTUP_DIAGNOSTIC:${
        JSON.stringify(error.startupDiagnostic ?? null)
      }:DIRECT_NAMESPACE_PREREQUISITES:${
        JSON.stringify(prerequisiteDiagnostic ?? null)
      }`,
    );
    assert(
      performance.now() - started < 2_000,
      `${name} exceeded the total scheduler-variance boundary`,
    );
  }
});

async function openAndSlice(fixture: DraftFixture) {
  const opened = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(opened.status, 201);
  const draft = await responseJson(opened) as {
    id: string;
    epoch: number;
    checkpointId: string;
  };
  const sliced = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
  ));
  assertEquals(sliced.status, 200);
  return {
    draft,
    slice: await responseJson(sliced) as {
      checkpointId: string;
      startCursor: string;
      endCursor: string;
      text: string;
      textDigest: string;
    },
  };
}

function editBody(
  draft: { epoch: number },
  slice: {
    checkpointId: string;
    startCursor: string;
    endCursor: string;
    text: string;
    textDigest: string;
  },
) {
  return {
    epoch: draft.epoch,
    sourceCheckpointId: slice.checkpointId,
    startCursor: slice.startCursor,
    endCursor: slice.endCursor,
    expectedText: slice.text,
    expectedDigest: slice.textDigest,
    replacement: "changed",
    mutationId: crypto.randomUUID(),
  };
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("forged authority, cross-organization scope, and wrong live task expose no draft bytes", async () => {
  const fixture = await openDraftFixture();
  const foreignOrganizationId = crypto.randomUUID();
  const now = new Date();
  try {
    const { draft, slice } = await openAndSlice(fixture);
    const forged = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      "POST",
      {
        ...editBody(draft, slice),
        actorId: crypto.randomUUID(),
        origin: "forged",
        taskId: fixture.ids.taskId,
      },
    ));
    assertEquals(forged.status, 400);

    await fixture.pgDatabase.query(
      `insert into public.organization (
         id,name,slug,"createdAt","updatedAt"
       ) values ($1,'Foreign Draft',$2,$3,$3)`,
      [foreignOrganizationId, `foreign-${foreignOrganizationId}`, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id,name,slug,metadata,created_at,updated_at
       ) values ($1,'Foreign Draft',$2,'{}'::jsonb,$3,$3)`,
      [foreignOrganizationId, `foreign-${foreignOrganizationId}`, now],
    );
    await fixture.pgDatabase.query(
      `insert into public.member (
         id,"organizationId","userId",role,status,"createdAt","joinedAt","updatedAt"
       ) values ($1,$2,$3,'developer','active',$4,$4,$4)`,
      [
        crypto.randomUUID(),
        foreignOrganizationId,
        fixture.ids.providerUserId,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id,organization_id,principal_id,role,status,joined_at,
         created_at,updated_at,version
       ) values ($1,$2,$3,'developer','active',$4,$4,$4,1)`,
      [
        crypto.randomUUID(),
        foreignOrganizationId,
        fixture.ids.principalId,
        now,
      ],
    );
    const cross = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
      {},
      foreignOrganizationId,
    ));
    assertEquals(cross.status, 404);
    assertEquals(JSON.stringify(await cross.json()).includes("target"), false);

    await fixture.pgDatabase.query(
      "update bakery.tasks set archived_at=current_timestamp where id=$1",
      [fixture.ids.taskId],
    );
    const archivedRead = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(archivedRead.status, 404);
    const archivedWrite = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      "POST",
      editBody(draft, slice),
    ));
    assertEquals(archivedWrite.status, 404);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id=$1",
      [foreignOrganizationId],
    );
    await fixture.pgDatabase.query(
      "delete from public.organization where id=$1",
      [foreignOrganizationId],
    );
    await cleanup(fixture);
  }
});

Deno.test("revocation between preparation and commit discards the isolated candidate", async () => {
  const real = createDraftIsolation();
  let revoke = false;
  const isolation: DraftIsolation = {
    initialize: real.initialize,
    slice: real.slice,
    importUpdate: real.importUpdate,
    async edit(current, source, input, signal) {
      const candidate = await real.edit(current, source, input, signal);
      if (revoke) {
        await fixture.pgDatabase.query(
          `update bakery.organization_memberships
              set status='inactive'
            where organization_id=$1 and principal_id=$2`,
          [fixture.ids.organizationId, fixture.ids.principalId],
        );
      }
      return candidate;
    },
  };
  const fixture = await openDraftFixture(undefined, {
    draftIsolation: isolation,
  });
  try {
    const { draft, slice } = await openAndSlice(fixture);
    revoke = true;
    const response = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      "POST",
      editBody(draft, slice),
    ));
    assert(
      response.status === 403 || response.status === 404,
      `revoked authority returned ${response.status}`,
    );
    const facts = await fixture.pgDatabase.query<{
      updates: number;
      receipts: number;
      text_content: string;
    }>(
      `select
         (select count(*)::int from bakery.artifact_draft_updates
           where draft_id=$1) as updates,
         (select count(*)::int from bakery.artifact_draft_receipts
           where draft_id=$1) as receipts,
         c.text_content
       from bakery.artifact_drafts d
       join bakery.artifact_draft_checkpoints c on c.id=d.current_checkpoint_id
      where d.id=$1`,
      [draft.id],
    );
    assertEquals(facts.rows[0]?.updates, 0);
    assertEquals(facts.rows[0]?.receipts, 0);
    assertEquals(facts.rows[0]?.text_content, "alpha target omega 😀");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("routes answer 503 when host isolation is missing and readiness stays healthy", async () => {
  const boundary = await fakeDraftBoundary(`
while [ "$#" -gt 0 ] && [ "$1" != "--property=InaccessiblePaths=/var/tmp" ]; do
  shift
done
shift
exec "$@"`);
  const directory = new URL(".", `file://${boundary.systemdRunPath}`).pathname;
  const working = createDraftIsolation(boundary);
  const missing = createDraftIsolation({
    ...boundary,
    systemdRunPath: `${directory}absent-systemd-run`,
  });
  let active: DraftIsolation = working;
  const isolation: DraftIsolation = {
    initialize: (...args) => active.initialize(...args),
    slice: (...args) => active.slice(...args),
    edit: (...args) => active.edit(...args),
    importUpdate: (...args) => active.importUpdate(...args),
  };
  const fixture = await openDraftFixture(undefined, {
    draftIsolation: isolation,
  });
  try {
    const { draft, slice } = await openAndSlice(fixture);
    active = missing;
    const expectUnavailable = async (response: Response) => {
      assertEquals(response.status, 503);
      const problem = await response.json() as { code: string; type: string };
      assertEquals(problem.code, "DEPENDENCY_UNAVAILABLE");
      assert(problem.type.endsWith("/problems/dependency-unavailable"));
    };
    await expectUnavailable(
      await fixture.app.fetch(jsonDraftRequest(
        fixture,
        `/v1/drafts/${draft.id}/edits`,
        "POST",
        editBody(draft, slice),
      )),
    );
    await expectUnavailable(
      await fixture.app.fetch(draftRequest(
        fixture,
        `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
      )),
    );
    const ready = await fixture.app.fetch(
      new Request(`${authTestOrigin}/health/ready`),
    );
    assertEquals(ready.status, 200);
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});
