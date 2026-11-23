import type { CodingAgent } from "./machine-state.ts";

/**
 * The systems a machine can be added on (#70 slice 3): the one list the wizard's
 * first table, its coding-agent step and its install step all read, and the
 * machine page reads for a machine that needs its setup again.
 *
 * A row is `supported` only when the native support matrix
 * (`docs/backend-delivery/native-support-matrix.json`) records its worker-target
 * as verified on a real host. Today that is Linux on x86_64 and arm64; the macOS
 * rows are named in one line and can never be chosen for a new machine.
 *
 * Having `steps` is a separate fact: a Linux machine on any processor is set up
 * the same way, so a machine that is already enrolled keeps its set-up-again
 * steps even where the row is not yet supported.
 */

export type MachineSystem = "linux" | "macos";

export const CODING_AGENTS: readonly CodingAgent[] = ["claude", "codex", "pi"];

export type SystemRow = Readonly<{
  /** A stable name for the row, used for its form value and test hooks. */
  id: string;
  os: MachineSystem;
  /** The value the server stores and compares: `arm64` or `x64` (see `normalizeArchitecture`). */
  architecture: string;
  /** The processor as a person reads it: `arm64`, or `x86_64` for the stored `x64`. */
  processor: string;
  /** The words after the processor on screen, when the table says more than the value does. */
  processorNote: "appleSilicon" | "intel" | null;
  /** How Bakery runs on it; null while there is no installer. */
  installedAs: "systemd" | null;
  /** The steps an enrolled machine follows to be set up again; null where there are none. */
  steps: "systemd" | null;
  /** The coding agents it can run; none while there is no installer. */
  agents: readonly CodingAgent[];
  supported: boolean;
}>;

export const SYSTEM_ROWS: readonly SystemRow[] = [
  {
    id: "linux-arm64",
    os: "linux",
    architecture: "arm64",
    processor: "arm64",
    processorNote: null,
    installedAs: "systemd",
    steps: "systemd",
    agents: CODING_AGENTS,
    supported: true,
  },
  {
    id: "linux-x86_64",
    os: "linux",
    architecture: "x64",
    processor: "x86_64",
    processorNote: null,
    installedAs: "systemd",
    steps: "systemd",
    agents: CODING_AGENTS,
    supported: true,
  },
  {
    id: "macos-arm64",
    os: "macos",
    architecture: "arm64",
    processor: "arm64",
    processorNote: "appleSilicon",
    installedAs: null,
    steps: null,
    agents: [],
    supported: false,
  },
  {
    id: "macos-x86_64",
    os: "macos",
    architecture: "x64",
    processor: "x86_64",
    processorNote: "intel",
    installedAs: null,
    steps: null,
    agents: [],
    supported: false,
  },
];

/**
 * The processor as the server stores it. It mirrors the server's own
 * normalisation (`apps/server/src/modules/execution/shared.ts`): `x86_64`,
 * `amd64` and `x64` are one processor, stored as `x64`; `aarch64` is `arm64`.
 * Anything else is kept as it is, lower-cased.
 */
export function normalizeArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "x64":
    case "x86_64":
    case "amd64":
    case "x8664":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return normalized;
  }
}

/** The system as the table names it: trimmed and lower-case, as `systemRow` and `hasSetupSteps` both read it. */
function normalizeOs(os: string): string {
  return os.trim().toLowerCase();
}

/** The row for a system and processor, or null for one the table does not list. */
export function systemRow(
  os: string,
  architecture: string,
): SystemRow | null {
  const processor = normalizeArchitecture(architecture);
  return SYSTEM_ROWS.find((row) =>
    row.os === normalizeOs(os) && row.architecture === processor
  ) ?? null;
}

/** Whether Bakery can set a machine up on this system and processor. */
export function isSupportedSystem(os: string, architecture: string): boolean {
  return systemRow(os, architecture)?.supported === true;
}

/** The processor as a person reads it: the row's label (`x86_64` for a stored `x64`), or the stored value when the table does not list it. */
export function processorLabel(os: string, architecture: string): string {
  return systemRow(os, architecture)?.processor ?? architecture;
}

/** Whether a machine on this system has set-up steps to follow, on any processor. */
export function hasSetupSteps(os: string): boolean {
  const name = normalizeOs(os);
  return SYSTEM_ROWS.some((row) => row.os === name && row.steps !== null);
}

/** The supported rows, in table order. */
export function supportedRows(): SystemRow[] {
  return SYSTEM_ROWS.filter((row) => row.supported);
}

/** The row chosen when the page opens: the only supported one, else none. */
export function defaultSystemRow(): SystemRow | null {
  const rows = supportedRows();
  return rows.length === 1 ? rows[0]! : null;
}
