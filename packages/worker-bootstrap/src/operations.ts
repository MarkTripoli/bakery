import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { BootstrapError } from "./errors.ts";
import { readRecord } from "./bounded-read.ts";
import { checkRoot, installed, sha256OfFile } from "./install.ts";
import {
  hasUnsafeCharacter,
  hasVisibleCharacter,
  PAIRING_FILE,
  readPairingBinding,
  TOKEN_FILE,
} from "./pairing.ts";
import {
  describeChanges,
  environmentFilePath,
  environmentFileText,
  LINUX_SERVICE,
  LINUX_UNIT_PATH,
  MACOS_LABEL,
  planLinuxService,
  planMacService,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceSpec,
  type SystemChange,
  workerPath,
} from "./service.ts";

/**
 * Looking at an installation, and stopping it (#18, slice 3): `status`,
 * `doctor` and `drain`. They read the install root and ask injected probes
 * about the machine, and say only fixed words plus a few facts this code read
 * itself (the release, the organization name it recorded). They change nothing:
 * `drain` returns the exact command for the operator, because stopping a
 * service is a privilege this code never takes.
 */

export type ServiceState =
  | "active"
  | "inactive"
  | "failed"
  | "absent"
  | "unknown";

/** What a command may ask of the machine. Everything is injected so tests use a temp root and fakes. */
export type Probes = Readonly<{
  /** The service manager's answer for the worker service. */
  serviceState: () => Promise<ServiceState>;
  /** Runs a program and says whether it exited 0; never throws. */
  runs: (argv: readonly string[]) => Promise<boolean>;
  /** Free bytes where the root lives, or null when it cannot be told. */
  freeBytes: (path: string) => Promise<number | null>;
  /** The effective user id, or null where there is none. */
  uid: () => number | null;
}>;

export type InstallationState =
  | Readonly<{ state: "not-installed" }>
  | Readonly<{
    state: "installed";
    release: string;
    target: string;
    /** Whether the binary on disk still has the digest its record signed. */
    intact: boolean;
  }>
  | Readonly<{ state: "unreadable" }>;

export type PairingState =
  | Readonly<{ state: "unpaired" }>
  | Readonly<{
    state: "paired";
    organizationName: string;
    serverOrigin: string;
    machineName: string;
    boundAt: string;
  }>
  | Readonly<{ state: "unreadable" }>;

export type StatusReport = Readonly<{
  installation: InstallationState;
  pairing: PairingState;
  service: ServiceState;
}>;

/**
 * Text read back from the install root is printed to a person's terminal, and
 * the root is a directory anyone with write access to it could have edited: it
 * is shown only if it is short, draws something and has no control, line-break
 * or direction-changing character, exactly as the pairing preview is.
 */
function shown(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length <= max &&
    hasVisibleCharacter(value) && !hasUnsafeCharacter(value);
}

/**
 * Whether the installed binary is exactly what was signed. The path is looked
 * at before it is read: it must be a regular file (not a link, FIFO or device)
 * of the recorded size, so a name swapped for something endless is "not intact"
 * rather than something this command reads; only then is it hashed, with a
 * deadline.
 */
async function binaryIsIntact(
  root: string,
  record: { size?: unknown; sha256: string },
  hash: HashFile,
  deadlineMs: number,
): Promise<boolean> {
  const path = workerPath(root);
  try {
    const info = await lstat(path);
    if (
      !info.isFile() || typeof record.size !== "number" ||
      info.size !== record.size
    ) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    try {
      return await Promise.race([
        hash(path).then(
          (digest) => digest === record.sha256,
          () => false,
        ),
        stalled,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Hashing a release-sized file takes seconds; a file that takes minutes is not what was signed. */
const HASH_DEADLINE_MS = 60_000;

/** How a file's SHA-256 is computed; replaced only to prove the file is looked at before it is read. */
export type HashFile = (path: string) => Promise<string>;

export type StatusOptions = Readonly<{
  hash?: HashFile;
  hashDeadlineMs?: number;
}>;

async function readInstallation(
  root: string,
  options: StatusOptions,
): Promise<InstallationState> {
  try {
    const found = await installed(root);
    if (found === null) return { state: "not-installed" };
    if (!shown(found.record.release, 100) || !shown(found.record.target, 100)) {
      return { state: "unreadable" };
    }
    const intact = await binaryIsIntact(
      root,
      found.record,
      options.hash ?? sha256OfFile,
      options.hashDeadlineMs ?? HASH_DEADLINE_MS,
    );
    return {
      state: "installed",
      release: found.record.release,
      target: found.record.target,
      intact,
    };
  } catch {
    return { state: "unreadable" };
  }
}

async function readPairing(root: string): Promise<PairingState> {
  let text: string;
  try {
    text = await readRecord(join(root, PAIRING_FILE));
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { state: "unpaired" }
      : { state: "unreadable" };
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.version !== 1 || !shown(value.organizationName) ||
      !shown(value.serverOrigin, 300) || !shown(value.name) ||
      !shown(value.boundAt, 40)
    ) return { state: "unreadable" };
    return {
      state: "paired",
      organizationName: value.organizationName,
      serverOrigin: value.serverOrigin,
      machineName: value.name,
      boundAt: value.boundAt,
    };
  } catch {
    return { state: "unreadable" };
  }
}

/** What is installed, whom it is paired with and whether the service is running. Reads only. */
export async function installationStatus(
  root: string,
  probes: Probes,
  options: StatusOptions = {},
): Promise<StatusReport> {
  return {
    installation: await readInstallation(root, options),
    pairing: await readPairing(root),
    service: await probes.serviceState().catch(() => "unknown" as const),
  };
}

/** The report as lines a person reads: fixed words, and facts read from the root. */
export function describeStatus(report: StatusReport): string {
  const lines: string[] = [];
  const { installation, pairing } = report;
  lines.push(
    installation.state === "installed"
      ? `Installed: release ${installation.release} for ${installation.target}${
        installation.intact
          ? ""
          : " (the file on disk no longer matches its signed digest)"
      }`
      : installation.state === "not-installed"
      ? "Installed: no"
      : "Installed: the record cannot be read",
  );
  lines.push(
    pairing.state === "paired"
      ? `Paired: ${pairing.organizationName} (${pairing.serverOrigin}) as ${pairing.machineName} since ${pairing.boundAt}`
      : pairing.state === "unpaired"
      ? "Paired: no"
      : "Paired: the record cannot be read",
  );
  lines.push(`Service: ${report.service}`);
  return `${lines.join("\n")}\n`;
}

export type CheckStatus = "ok" | "attention" | "failed";
export type Check = Readonly<
  { id: string; status: CheckStatus; message: string }
>;

const MIN_FREE_BYTES = 256 * 1024 * 1024;

async function modeOf(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).mode & 0o777;
  } catch {
    return null;
  }
}

const ok = (id: string, message: string): Check => ({
  id,
  status: "ok",
  message,
});
const attention = (id: string, message: string): Check => ({
  id,
  status: "attention",
  message,
});
const failed = (id: string, message: string): Check => ({
  id,
  status: "failed",
  message,
});

/**
 * The prerequisites and the installation's own condition, one check each, in a
 * fixed order. A check never throws and never says anything but its fixed
 * sentence; none installs a package, changes a setting or asks for a privilege.
 */
export async function doctor(
  root: string,
  probes: Probes,
  options: StatusOptions = {},
): Promise<readonly Check[]> {
  const checks: Check[] = [];
  checks.push(
    probes.uid() === 0
      ? failed(
        "unprivileged",
        "Running as root. Run as an ordinary user or the service account.",
      )
      : ok("unprivileged", "Not running as root."),
  );
  try {
    await checkRoot(root);
    checks.push(ok("root", "The install root is this user's own and private."));
  } catch (error) {
    checks.push(
      failed(
        "root",
        error instanceof BootstrapError
          ? "The install root must be an absolute path to a directory only this user can write to."
          : "The install root cannot be read.",
      ),
    );
  }
  const status = await installationStatus(root, probes, options);
  const { installation, pairing } = status;
  checks.push(
    installation.state === "installed" && installation.intact
      ? ok("install", "The installed worker matches its signed digest.")
      : installation.state === "installed"
      ? failed(
        "install",
        "The installed worker does not match its signed digest. Reinstall it.",
      )
      : installation.state === "not-installed"
      ? failed("install", "No worker is installed in this root.")
      : failed(
        "install",
        "The record of the installed release cannot be read.",
      ),
  );
  checks.push(
    pairing.state === "paired"
      ? ok("pairing", "Paired with an organization.")
      : pairing.state === "unpaired"
      ? attention(
        "pairing",
        "Not paired yet. Run pair with a setup code from Bakery.",
      )
      : failed("pairing", "The record of the pairing cannot be read."),
  );
  const code = await modeOf(join(root, TOKEN_FILE));
  checks.push(
    code === null
      ? ok("code-file", "No setup code is waiting on disk.")
      : (code & 0o077) === 0
      ? ok("code-file", "The setup code file is readable by its owner only.")
      : failed(
        "code-file",
        "The setup code file can be read by other users. Remove it and get new settings.",
      ),
  );
  const settings = await modeOf(environmentFilePath(root));
  checks.push(
    settings === null
      ? attention(
        "settings-file",
        "No settings file yet; it is written when the service is set up.",
      )
      : (settings & 0o077) === 0
      ? ok("settings-file", "The settings file is readable by its owner only.")
      : failed(
        "settings-file",
        "The settings file can be read by other users.",
      ),
  );
  const free = await probes.freeBytes(root).catch(() => null);
  checks.push(
    free === null
      ? attention("disk", "Free disk space could not be read.")
      : free >= MIN_FREE_BYTES
      ? ok("disk", "There is enough free disk space.")
      : failed("disk", "Less than 256 MiB of disk space is free."),
  );
  checks.push(
    (await probes.runs([
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "true",
      ]).catch(() => false))
      ? ok("sandbox", "Bubblewrap and user namespaces work.")
      : attention(
        "sandbox",
        "Bubblewrap or user namespaces are missing: this machine will not take native work until they work. Setup does not install packages.",
      ),
  );
  checks.push(
    status.service === "active"
      ? ok("service", "The service is running.")
      : status.service === "absent"
      ? attention("service", "The service is not installed.")
      : status.service === "unknown"
      ? attention("service", "The service state could not be read.")
      : failed("service", "The service is installed but not running."),
  );
  return checks;
}

/** The exit code a set of checks earns: 0 all well, 1 something to look at, 2 something failed. */
export function doctorExitCode(checks: readonly Check[]): 0 | 1 | 2 {
  if (checks.some((check) => check.status === "failed")) return 2;
  return checks.some((check) => check.status === "attention") ? 1 : 0;
}

export function describeChecks(checks: readonly Check[]): string {
  const mark = { ok: "ok       ", attention: "attention", failed: "FAILED   " };
  return `${
    checks.map((check) => `${mark[check.status]} ${check.id}: ${check.message}`)
      .join("\n")
  }\n`;
}

/**
 * How to drain: stop claiming new work and finish what is running. The worker
 * does that itself when the service manager stops it (it has up to its drain
 * time, 45 seconds in the unit), so draining is a stop, and the command is for
 * the operator to run: this code never stops a service.
 */
export function planDrain(
  target: "linux" | "macos",
  uid: number,
): readonly SystemChange[] {
  if (target === "linux") {
    return [{
      actor: "administrator",
      description:
        "Stop the worker: it takes no new work and finishes what it has, for up to its drain time.",
      command: ["systemctl", "stop", LINUX_SERVICE],
    }];
  }
  if (!Number.isInteger(uid) || uid < 0) {
    throw new BootstrapError("SERVICE_SPEC_INVALID");
  }
  return [{
    actor: "user",
    description:
      "Stop the worker: it takes no new work and finishes what it has, for up to its drain time.",
    command: ["launchctl", "bootout", `gui/${uid}/${MACOS_LABEL}`],
  }];
}

export type Operation = Readonly<{
  name: "status" | "doctor" | "drain" | "plan";
  root: string;
  /** `plan` only: the account that runs the service (Linux: dedicated; macOS: the user). */
  account?: string;
  /** `plan` only: the system to plan for; defaults to the one this machine is. */
  system?: "linux" | "macos";
  /** `plan` only: extra non-secret settings, such as a coding agent's. */
  settings?: Readonly<Record<string, string>>;
}>;

const PLAN_FLAGS = new Set(["--account", "--system", "--setting"]);

/**
 * Reads `status`, `doctor`, `drain` or `plan` with an optional `--root`
 * (`plan` also takes `--account`, `--system` and repeatable `--setting
 * NAME=VALUE`). Nothing else is accepted: these commands take no server and no
 * setup code, so a code on the command line is refused by name here as well.
 */
export function parseOperation(
  argv: readonly string[],
  defaults: Readonly<{ root: string }>,
): Operation {
  const [name, ...rest] = argv;
  if (
    name !== "status" && name !== "doctor" && name !== "drain" &&
    name !== "plan"
  ) throw new BootstrapError("COMMAND_UNKNOWN");
  let root = defaults.root;
  let account: string | undefined;
  let system: "linux" | "macos" | undefined;
  const settings: Record<string, string> = {};
  for (let at = 0; at < rest.length; at += 2) {
    const word = rest[at]!;
    if (word === "--token" || word.startsWith("--token=")) {
      throw new BootstrapError("COMMAND_TOKEN_SHORTCUT");
    }
    const value = rest[at + 1];
    if (
      (word !== "--root" && !(name === "plan" && PLAN_FLAGS.has(word))) ||
      value === undefined || value.startsWith("--")
    ) throw new BootstrapError("COMMAND_UNKNOWN");
    if (word === "--root") root = value;
    else if (word === "--account") account = value;
    else if (word === "--system") {
      if (value !== "linux" && value !== "macos") {
        throw new BootstrapError("COMMAND_UNKNOWN");
      }
      system = value;
    } else {
      const equals = value.indexOf("=");
      if (equals < 1) throw new BootstrapError("COMMAND_UNKNOWN");
      settings[value.slice(0, equals)] = value.slice(equals + 1);
    }
  }
  return name === "plan"
    ? { name, root, account, system, settings }
    : { name, root };
}

export type OperationIo = Readonly<{
  write: (text: string) => void;
  probes: Probes;
  /** The system the service lives on; `drain` and `plan` name their commands for it. */
  target: "linux" | "macos";
  /** The user's home directory: only the macOS plan needs it (the LaunchAgent lives there). */
  home?: string;
}>;

/**
 * Runs a read-only operation and returns its exit code. `status` and `doctor`
 * look; `drain` prints the one command that stops the worker, for the operator
 * to run, and runs nothing.
 */
export async function runOperation(
  operation: Operation,
  io: OperationIo,
): Promise<number> {
  try {
    if (operation.name === "status") {
      io.write(
        describeStatus(await installationStatus(operation.root, io.probes)),
      );
      return 0;
    }
    if (operation.name === "doctor") {
      const checks = await doctor(operation.root, io.probes);
      io.write(describeChecks(checks));
      return doctorExitCode(checks);
    }
    if (operation.name === "plan") {
      io.write(await planText(operation, io));
      return 0;
    }
    const uid = io.probes.uid();
    io.write(
      `To drain this worker, run the command below. The worker takes no new work and finishes what it has.\n${
        describeChanges(planDrain(io.target, uid ?? -1))
      }`,
    );
    return 0;
  } catch (error) {
    io.write(
      `${
        error instanceof BootstrapError
          ? error.message
          : "The command could not complete. Nothing was changed."
      }\n`,
    );
    return 2;
  }
}

const DEFAULT_LINUX_ACCOUNT = "bakery-worker";

/**
 * The exact system changes setting up the service would make, and the text of
 * each definition, for the machine this root was paired for. It reads the
 * pairing record and prints; it writes nothing and runs nothing. The settings
 * come from what the confirmation showed (server, name, slots, capabilities);
 * the setup code is only ever named by its file.
 */
async function planText(
  operation: Operation,
  io: OperationIo,
): Promise<string> {
  const binding = await readPairingBinding(operation.root);
  if (binding === null) throw new BootstrapError("SETUP_NOT_PAIRED");
  // The record lives in a directory anyone with write access could have edited,
  // and what it holds is printed: it must be safe to show, like the rest.
  if (
    !shown(binding.serverOrigin, 300) || !shown(binding.name) ||
    !shown(binding.architecture, 100) ||
    !binding.capabilities.every((entry) => shown(entry))
  ) throw new BootstrapError("PAIRING_BINDING_CORRUPT");
  const system = operation.system ?? io.target;
  if (binding.os !== system) {
    throw new BootstrapError("SERVICE_SYSTEM_MISMATCH");
  }
  const account = operation.account ??
    (system === "linux" ? DEFAULT_LINUX_ACCOUNT : undefined);
  if (account === undefined) throw new BootstrapError("COMMAND_UNKNOWN");
  const spec: ServiceSpec = {
    root: operation.root,
    account,
    settings: {
      BAKERY_SERVER_URL: binding.serverOrigin,
      BAKERY_WORKER_STATE_DIR: join(operation.root, "state"),
      BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: join(operation.root, TOKEN_FILE),
      BAKERY_WORKER_NAME: binding.name,
      BAKERY_WORKER_SLOTS: String(binding.slots),
      BAKERY_WORKER_CAPABILITIES: binding.capabilities.join(","),
      ...operation.settings,
    },
  };
  let changes: readonly SystemChange[];
  let definition: string;
  let where: string;
  if (system === "linux") {
    changes = planLinuxService(spec);
    definition = renderSystemdUnit(spec);
    where = LINUX_UNIT_PATH;
  } else {
    const uid = io.probes.uid();
    if (io.home === undefined) throw new BootstrapError("SERVICE_SPEC_INVALID");
    // No user id is refused by the plan itself: -1 is not one.
    changes = planMacService(spec, io.home, uid ?? -1);
    definition = renderLaunchAgent(spec);
    where = `${io.home}/Library/LaunchAgents/${MACOS_LABEL}.plist`;
  }
  return [
    "These are the exact changes setting up the service makes, in order. Nothing has been changed yet; run each step yourself as the account named.",
    describeChanges(changes).trimEnd(),
    "",
    `Service definition (${where}):`,
    definition.trimEnd(),
    "",
    `Settings file (${
      environmentFilePath(operation.root)
    }); add a coding agent's settings with --setting NAME=VALUE:`,
    environmentFileText(spec).trimEnd(),
    "",
  ].join("\n");
}
