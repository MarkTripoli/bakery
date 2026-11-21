import type { CodingAgent } from "./machine-state.ts";

/**
 * The systems a machine can be added on (#70 slice 3): the one list the wizard's
 * first table, its coding-agent step and its install step all read, and the
 * machine page reads for a machine that needs its setup again.
 *
 * A row is `supported` only with a recorded real run of the installer on that
 * system. Today that is Linux on arm64 alone (`scripts/deploy/bootstrap-host.sh`,
 * `scripts/deploy/release.mjs`); there is no installer for the rest, so they are
 * listed, muted, and can never be chosen.
 */

export type MachineSystem = "linux" | "macos";

export const CODING_AGENTS: readonly CodingAgent[] = ["claude", "codex", "pi"];

export type SystemRow = Readonly<{
  /** A stable name for the row, used for its form value and test hooks. */
  id: string;
  os: MachineSystem;
  /** The value Bakery stores and compares: `arm64` or `x86_64`. */
  architecture: string;
  /** The words after the processor on screen, when the table says more than the value does. */
  processorNote: "appleSilicon" | "intel" | null;
  /** How Bakery runs on it; null while there is no installer. */
  installedAs: "systemd" | null;
  /** The coding agents it can run; none while there is no installer. */
  agents: readonly CodingAgent[];
  supported: boolean;
}>;

export const SYSTEM_ROWS: readonly SystemRow[] = [
  {
    id: "linux-arm64",
    os: "linux",
    architecture: "arm64",
    processorNote: null,
    installedAs: "systemd",
    agents: CODING_AGENTS,
    supported: true,
  },
  {
    id: "linux-x86_64",
    os: "linux",
    architecture: "x86_64",
    processorNote: null,
    installedAs: null,
    agents: [],
    supported: false,
  },
  {
    id: "macos-arm64",
    os: "macos",
    architecture: "arm64",
    processorNote: "appleSilicon",
    installedAs: null,
    agents: [],
    supported: false,
  },
  {
    id: "macos-x86_64",
    os: "macos",
    architecture: "x86_64",
    processorNote: "intel",
    installedAs: null,
    agents: [],
    supported: false,
  },
];

/** The row for a system and processor, or null for one the table does not list. */
export function systemRow(
  os: string,
  architecture: string,
): SystemRow | null {
  return SYSTEM_ROWS.find((row) =>
    row.os === os && row.architecture === architecture
  ) ?? null;
}

/** Whether Bakery can set a machine up on this system and processor. */
export function isSupportedSystem(os: string, architecture: string): boolean {
  return systemRow(os, architecture)?.supported === true;
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
