import { join } from "node:path";
import { PAIRING_FILE, type PairingBinding, TOKEN_FILE } from "./pairing.ts";
import {
  environmentFilePath,
  environmentFileText,
  LINUX_SERVICE,
  LINUX_UNIT_PATH,
  MACOS_LABEL,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceSpec,
} from "./service.ts";

export const LINK_LINUX_ACCOUNT = "bakery-worker";
export const LINK_LINUX_ROOT = "/var/lib/bakery-worker";

const HARNESSES: Readonly<Record<string, { prefix: string; program: string }>> =
  {
    claude: { prefix: "CLAUDE", program: "claude" },
    "claude-code": { prefix: "CLAUDE", program: "claude" },
    codex: { prefix: "CODEX", program: "codex" },
    pi: { prefix: "PI", program: "pi" },
  };

export function bindingSettings(
  binding: PairingBinding,
  root: string,
): Record<string, string> {
  return {
    BAKERY_SERVER_URL: binding.serverOrigin,
    BAKERY_WORKER_STATE_DIR: join(root, "state"),
    BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: join(root, TOKEN_FILE),
    BAKERY_WORKER_NAME: binding.name,
    BAKERY_WORKER_SLOTS: String(binding.slots),
    BAKERY_WORKER_CAPABILITIES: binding.capabilities.join(","),
  };
}

export function harnessWorkspace(root: string): string {
  return join(root, "workspace");
}

function harnessSettings(
  binding: PairingBinding,
  root: string,
): Record<string, string> {
  const agent = binding.capabilities.map((capability) =>
    HARNESSES[capability.toLowerCase()]
  ).find((harness) => harness !== undefined);
  if (agent === undefined) return {};
  return {
    [`BAKERY_${agent.prefix}_HARNESS`]: "1",
    [`BAKERY_${agent.prefix}_HARNESS_REPOSITORY`]: harnessWorkspace(root),
    [`BAKERY_${agent.prefix}_HARNESS_TIME_LIMIT_MS`]: "120000",
    [`BAKERY_${agent.prefix}_HARNESS_EXECUTABLE`]: agent.program,
  };
}

export function linkServiceSpec(
  binding: PairingBinding,
  root: string,
  account: string,
): ServiceSpec {
  return {
    root,
    account,
    settings: {
      ...bindingSettings(binding, root),
      ...harnessSettings(binding, root),
    },
  };
}

function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fileFrom(text: string, path: string, mode: string, owner: string) {
  const marker = "BAKERY_WORKER_FILE_END";
  if (text.split("\n").includes(marker)) {
    throw new Error("SERVICE_FILE_MARKER_IN_TEXT");
  }
  return [
    `install -m ${mode} -o ${owner} -g ${owner} /dev/stdin ${
      quoted(path)
    } <<'${marker}'`,
    text.endsWith("\n") ? text.slice(0, -1) : text,
    marker,
  ].join("\n");
}

export function linuxLinkScript(
  binding: PairingBinding,
  sourceRoot: string,
): string {
  const root = LINK_LINUX_ROOT;
  const account = LINK_LINUX_ACCOUNT;
  const spec = linkServiceSpec(binding, root, account);
  const source = quoted(sourceRoot);
  const target = quoted(root);
  return [
    "set -eu",
    `id -u ${account} >/dev/null 2>&1 || useradd --system --user-group --home-dir ${target} --shell /usr/sbin/nologin ${account}`,
    `install --directory --owner ${account} --group ${account} --mode 0700 ${target} ${
      quoted(harnessWorkspace(root))
    } ${quoted(join(root, "state"))}`,
    `cp -a ${source}/releases ${source}/current ${
      quoted(join(sourceRoot, PAIRING_FILE))
    } ${quoted(join(sourceRoot, TOKEN_FILE))} ${target}/`,
    `chown -R ${account}:${account} ${target}`,
    fileFrom(
      environmentFileText(spec),
      environmentFilePath(root),
      "0600",
      account,
    ),
    fileFrom(renderSystemdUnit(spec), LINUX_UNIT_PATH, "0644", "root"),
    "systemctl daemon-reload",
    `systemctl enable ${LINUX_SERVICE}`,
    `systemctl restart ${LINUX_SERVICE}`,
    "",
  ].join("\n");
}

export type MacLinkService = Readonly<{
  plistPath: string;
  plist: string;
  commands: readonly (readonly string[])[];
}>;

export function macLinkService(
  binding: PairingBinding,
  root: string,
  account: string,
  home: string,
  uid: number,
): MacLinkService {
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    `${MACOS_LABEL}.plist`,
  );
  return {
    plistPath,
    plist: renderLaunchAgent(linkServiceSpec(binding, root, account)),
    commands: [
      ["launchctl", "bootout", `gui/${uid}/${MACOS_LABEL}`],
      ["launchctl", "bootstrap", `gui/${uid}`, plistPath],
    ],
  };
}
