import { isAbsolute, join } from "node:path";
import { BootstrapError } from "./errors.ts";

/**
 * The native service definitions (#18, slice 3): the dedicated unprivileged
 * Linux systemd unit and the macOS LaunchAgent, rendered as text, and the exact
 * list of system changes installing them would make. Nothing here touches the
 * machine: it returns text and data, so the operator sees every change before
 * any is made, and this code never runs `sudo` (the privilege steps are the
 * operator's, named one by one). A coding agent's harness is never started
 * with elevated rights by anything in this file.
 */

export const LINUX_UNIT_PATH = "/etc/systemd/system/bakery-worker.service";
export const LINUX_SERVICE = "bakery-worker";
export const MACOS_LABEL = "io.bakery.worker";

export type ServiceSpec = Readonly<{
  /** Absolute install root (the one slice 1 installs into); the service runs `current/bakery-worker` from it. */
  root: string;
  /** Linux: the dedicated account that runs the service. macOS: the user whose session runs it. */
  account: string;
  /** The non-secret settings the worker starts with. The setup code is a file, never a setting. */
  settings: Readonly<Record<string, string>>;
}>;

const PATH_CHARACTERS = /^[A-Za-z0-9_./-]+$/;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const SETTING_NAME = /^BAKERY_[A-Z0-9_]{1,100}$/;
/** The worker takes its code from a protected file or descriptor; these names would be the shortcut. */
const TOKEN_SETTINGS = new Set([
  "BAKERY_WORKER_ENROLLMENT_TOKEN",
  "BAKERY_ENROLLMENT_TOKEN",
  "BAKERY_WORKER_ENROLLMENT_TOKEN_FD",
]);

/** A control character other than a tab or a line break, which the files below turn into a space. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function checked(spec: ServiceSpec): void {
  if (
    !isAbsolute(spec.root) || !PATH_CHARACTERS.test(spec.root) ||
    spec.root.includes("..") || spec.root.length > 200 ||
    !ACCOUNT.test(spec.account)
  ) throw new BootstrapError("SERVICE_SPEC_INVALID");
  for (const [name, value] of Object.entries(spec.settings)) {
    if (!SETTING_NAME.test(name) || TOKEN_SETTINGS.has(name)) {
      throw new BootstrapError("SERVICE_SETTING_REFUSED");
    }
    if (
      value.length > 4096 || hasControlCharacter(value)
    ) {
      throw new BootstrapError("SERVICE_SETTING_REFUSED");
    }
  }
}

/** Where the service's non-secret settings live: inside the root, owner-only. */
export function environmentFilePath(root: string): string {
  return join(root, "worker.env");
}

/** The binary the service runs, by absolute path (never a `PATH` lookup). */
export function workerPath(root: string): string {
  return join(root, "current", "bakery-worker");
}

function environmentValue(value: string): string {
  const single = value.replace(/[\r\n]+/g, " ");
  if (/^[A-Za-z0-9_.:/@,=+-]+$/.test(single)) return single;
  return `"${single.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The settings as a systemd `EnvironmentFile`: sorted, one per line, values quoted when they need it. */
export function environmentFileText(spec: ServiceSpec): string {
  checked(spec);
  return Object.keys(spec.settings).sort().map((name) =>
    `${name}=${environmentValue(spec.settings[name]!)}`
  ).join("\n") + "\n";
}

/**
 * The Linux unit: a dedicated unprivileged account, the settings from an
 * owner-only file, no new privileges, a private umask, and the process tree
 * (supervisor and workers) kept in the service's own control group so a stop
 * or a crash cleans up everything. It mirrors `infra/production`'s unit for the
 * installed native worker.
 */
export function renderSystemdUnit(spec: ServiceSpec): string {
  checked(spec);
  return [
    "[Unit]",
    "Description=Bakery native worker",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `User=${spec.account}`,
    `Group=${spec.account}`,
    `EnvironmentFile=${environmentFilePath(spec.root)}`,
    `ExecStart=${workerPath(spec.root)}`,
    `WorkingDirectory=${spec.root}`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=45",
    "KillMode=control-group",
    "Delegate=memory pids",
    "DelegateSubgroup=supervisor",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/[\r\n]+/g, " ");
}

/**
 * The macOS LaunchAgent: it runs in the logged-in user's session (a worker that
 * builds with Xcode and the keychain needs one), restarts only after a failure,
 * and logs inside the install root. A launch agent has no environment file, so
 * the non-secret settings are written in; the setup code never is.
 */
export function renderLaunchAgent(spec: ServiceSpec): string {
  checked(spec);
  const environment = Object.keys(spec.settings).sort().map((name) =>
    `      <key>${xml(name)}</key>\n      <string>${
      xml(spec.settings[name]!)
    }</string>`
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${MACOS_LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    `      <string>${xml(workerPath(spec.root))}</string>`,
    "    </array>",
    "    <key>WorkingDirectory</key>",
    `    <string>${xml(spec.root)}</string>`,
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    environment,
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <dict>",
    "      <key>SuccessfulExit</key>",
    "      <false/>",
    "    </dict>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>Umask</key>",
    "    <integer>63</integer>",
    "    <key>StandardOutPath</key>",
    `    <string>${xml(join(spec.root, "worker.log"))}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xml(join(spec.root, "worker.log"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Who performs a change. Nothing here is performed by this code. */
export type ChangeActor = "administrator" | "service-account" | "user";

export type SystemChange = Readonly<{
  actor: ChangeActor;
  description: string;
  /** The exact command, as separate arguments, when the change is a command. */
  command?: readonly string[];
  /** The file written, with its mode, when the change is a file. */
  file?: Readonly<{ path: string; mode: string; owner: string }>;
}>;

/**
 * Every change installing the Linux service would make, in order, and who makes
 * it. The narrow privilege step is the account, the unit and the service; the
 * root and the settings belong to the service account, so the verified worker
 * and its secrets are never owned by the administrator or world-readable. The
 * setup code is typed or read by the service account (pairing), never by
 * a command line here.
 */
export function planLinuxService(spec: ServiceSpec): readonly SystemChange[] {
  checked(spec);
  return [
    {
      actor: "administrator",
      description:
        `Create the dedicated account ${spec.account} (no login shell).`,
      command: [
        "useradd",
        "--system",
        "--user-group",
        "--home-dir",
        spec.root,
        "--shell",
        "/usr/sbin/nologin",
        spec.account,
      ],
    },
    {
      actor: "administrator",
      description:
        `Create the install root, owned by ${spec.account} and private to it.`,
      command: [
        "install",
        "--directory",
        "--owner",
        spec.account,
        "--group",
        spec.account,
        "--mode",
        "0700",
        spec.root,
      ],
    },
    {
      actor: "service-account",
      description:
        `Run the same setup command that started this, as ${spec.account} (never as root): it installs the signed worker release, checks its digest, and pairs it with your organization.`,
      command: [
        "bakery-worker",
        "setup",
        "--server",
        "<your Bakery address>",
        "--root",
        spec.root,
      ],
    },
    {
      actor: "service-account",
      description:
        "Write the worker's non-secret settings, readable by its owner only.",
      file: {
        path: environmentFilePath(spec.root),
        mode: "0600",
        owner: spec.account,
      },
    },
    {
      actor: "administrator",
      description: "Install the service definition.",
      file: { path: LINUX_UNIT_PATH, mode: "0644", owner: "root" },
    },
    {
      actor: "administrator",
      description: "Make systemd read the new definition.",
      command: ["systemctl", "daemon-reload"],
    },
    {
      actor: "administrator",
      description: "Start the worker now and at every boot.",
      command: ["systemctl", "enable", "--now", LINUX_SERVICE],
    },
  ];
}

/** The macOS equivalent: the user's own LaunchAgent, nothing that needs an administrator. */
export function planMacService(
  spec: ServiceSpec,
  home: string,
  uid: number,
): readonly SystemChange[] {
  checked(spec);
  if (
    !isAbsolute(home) || !PATH_CHARACTERS.test(home) ||
    !Number.isInteger(uid) || uid < 0
  ) {
    throw new BootstrapError("SERVICE_SPEC_INVALID");
  }
  const plist = join(home, "Library", "LaunchAgents", `${MACOS_LABEL}.plist`);
  return [
    {
      actor: "user",
      description: "Write the LaunchAgent for this user's login session.",
      file: { path: plist, mode: "0644", owner: spec.account },
    },
    {
      actor: "user",
      description:
        "Load it into this user's session; it runs while the user is logged in.",
      command: ["launchctl", "bootstrap", `gui/${uid}`, plist],
    },
  ];
}

/** The plan as text a person reads and confirms before anything is changed. */
export function describeChanges(changes: readonly SystemChange[]): string {
  const lines: string[] = [];
  changes.forEach((change, index) => {
    lines.push(`${index + 1}. [${change.actor}] ${change.description}`);
    if (change.command) lines.push(`     $ ${change.command.join(" ")}`);
    if (change.file) {
      lines.push(
        `     file ${change.file.path} (mode ${change.file.mode}, owner ${change.file.owner})`,
      );
    }
  });
  return `${lines.join("\n")}\n`;
}
