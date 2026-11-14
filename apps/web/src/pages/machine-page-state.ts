import type { WorkerUpdate } from "../api/client.ts";
import type { MachineReason } from "./machine-state.ts";

/**
 * What the machine page says and offers about one machine (#70 part C1): the
 * mode an administrator asks of it, the one fix its problem banner offers, and
 * how each readiness check is grouped, named and explained.
 */

/** The three modes the control offers; retiring is a separate, confirmed action. */
export type MachineMode = "accepting" | "paused" | "draining";

export const MACHINE_MODES: readonly MachineMode[] = [
  "accepting",
  "paused",
  "draining",
];

/** The `status` an update writes for a mode: Taking work, Paused, Finish and stop. */
export function modeStatus(mode: MachineMode): WorkerUpdate["status"] {
  switch (mode) {
    case "accepting":
      return "online";
    case "paused":
      return "offline";
    case "draining":
      return "draining";
  }
}

/** The control's value for what the server reports; a retired machine has none. */
export function controlMode(
  requested: "accepting" | "paused" | "draining" | "revoked",
): MachineMode | null {
  return requested === "revoked" ? null : requested;
}

/** The one fix a problem banner offers, or none. */
export type BannerFix = "takeWork" | "seeChecks" | "addMachine";

export function bannerFix(reason: MachineReason): BannerFix | null {
  switch (reason.kind) {
    case "paused":
    case "finishing":
      return "takeWork";
    case "checkFailed":
      return "seeChecks";
    case "retired":
      return "addMachine";
    // Offline and not responding mend themselves; "needs attention" with no
    // check named has nothing to scroll to.
    default:
      return null;
  }
}

/** The check groups, in the order the page shows them. */
export type CheckGroup = "machine" | "capability" | "other";

export const CHECK_GROUPS: readonly CheckGroup[] = [
  "machine",
  "capability",
  "other",
];

/** The checks that are about the whole machine: when one fails it takes no work. */
const MACHINE_CHECKS = [
  "protocol_compatible",
  "supervisor_health",
  "spool_access",
  "disk_threshold",
  "credential_isolation",
] as const;

const CAPABILITY_KINDS = ["model", "git", "reviewer"] as const;

export type CheckInfo = Readonly<{
  group: CheckGroup;
  /** Catalog key of the check's name, or null: show the id itself. */
  nameKey: string | null;
  /** Catalog key of the fix sentence for a failed check, or null: only the machine's reason. */
  fixKey: string | null;
  /** The coding agent a `capability:model:<agent>` check names, if it does. */
  agent: "claude" | "codex" | "pi" | null;
}>;

/**
 * A check id to what the page shows. Ids are open strings the machine and the
 * server emit: one that is not recognised is shown as it is, with no invented
 * advice, under "other".
 */
export function checkInfo(id: string): CheckInfo {
  if ((MACHINE_CHECKS as readonly string[]).includes(id)) {
    return {
      group: "machine",
      nameKey: `machines.check.name.${id}`,
      fixKey: `machines.check.fix.${id}`,
      agent: null,
    };
  }
  const parts = id.split(":");
  if (
    parts[0] === "capability" &&
    (CAPABILITY_KINDS as readonly string[]).includes(parts[1] ?? "")
  ) {
    const kind = parts[1]!;
    const named = parts[2];
    const agent = named === "claude" || named === "codex" || named === "pi"
      ? named
      : null;
    return {
      group: "capability",
      nameKey: `machines.check.name.capability.${kind}`,
      fixKey: `machines.check.fix.capability.${kind}`,
      agent,
    };
  }
  return { group: "other", nameKey: null, fixKey: null, agent: null };
}

/** Whether a failed check stops the whole machine (true) or only the work that needs it. */
export function stopsWholeMachine(id: string): boolean {
  return checkInfo(id).group === "machine";
}

/** Failed check ids by group, each group in the order the page lists them, empty groups left out. */
export function groupChecks(
  ids: readonly string[],
): { group: CheckGroup; ids: string[] }[] {
  return CHECK_GROUPS.flatMap((group) => {
    const inGroup = ids.filter((id) => checkInfo(id).group === group);
    return inGroup.length > 0 ? [{ group, ids: inGroup }] : [];
  });
}
