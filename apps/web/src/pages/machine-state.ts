import type { WorkerResponse } from "../api/client.ts";

/**
 * What one machine's row says and does (#70). The server reports a machine
 * along several dimensions at once (how it is reached, whether it is ready,
 * what an administrator asked of it); a row shows ONE of them, the most
 * important, so that nobody has to reconcile three badges. The order is the
 * design's, and it is the order in which a problem blocks work.
 */

export type MachineBadge =
  | "retired"
  | "offline"
  | "notResponding"
  | "needsAttention"
  | "paused"
  | "finishing"
  | "checking"
  | "ready";

export type MachineBadgeTone = "neutral" | "success" | "warning" | "danger";

type MachineFacts = Pick<
  WorkerResponse,
  | "connectivity"
  | "desiredMode"
  | "failedCheckIds"
  | "readiness"
  | "readinessReason"
  | "status"
>;

/**
 * What an administrator asked of the machine. `desiredMode` is the intent
 * the server keeps; `status` carries the same choice as `online`, `offline`,
 * `draining` or `revoked`, which is what an update writes, so it is the
 * fallback for a response that leaves `desiredMode` out.
 */
export function requestedMode(
  machine: MachineFacts,
): "accepting" | "paused" | "draining" | "revoked" {
  if (machine.desiredMode !== undefined) return machine.desiredMode;
  switch (machine.status) {
    case "revoked":
      return "revoked";
    case "draining":
      return "draining";
    case "offline":
      return "paused";
    default:
      return "accepting";
  }
}

/** The one badge a machine shows: Retired, Offline, Not responding, Needs attention, Paused, Finishing up, Checking, Ready. */
export function machineBadge(machine: MachineFacts): MachineBadge {
  const mode = requestedMode(machine);
  if (mode === "revoked" || machine.status === "revoked") return "retired";
  if (machine.connectivity === "offline") return "offline";
  if (machine.connectivity === "stale") return "notResponding";
  if (machine.readiness === "needs_attention") return "needsAttention";
  if (mode === "paused") return "paused";
  if (mode === "draining") return "finishing";
  if (machine.readiness === "ready") return "ready";
  return "checking";
}

export function machineBadgeTone(badge: MachineBadge): MachineBadgeTone {
  switch (badge) {
    case "ready":
      return "success";
    case "needsAttention":
    case "offline":
      return "danger";
    case "notResponding":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * Why a machine cannot take some or all work, for the sentence that replaces a
 * row's summary line. Null for a machine that is ready or still being checked.
 * A failed check carries how many failed; the count is the only number a row
 * can promise, since the reason a check gives is free text from the machine.
 */
export type MachineReason =
  | Readonly<{ kind: "retired" | "offline" | "stale" | "paused" | "finishing" }>
  | Readonly<{ kind: "checkFailed"; count: number }>
  | Readonly<{ kind: "needsAttention" }>;

export function machineReason(machine: MachineFacts): MachineReason | null {
  switch (machineBadge(machine)) {
    case "retired":
      return { kind: "retired" };
    case "offline":
      return { kind: "offline" };
    case "notResponding":
      return { kind: "stale" };
    case "needsAttention": {
      const count = Array.isArray(machine.failedCheckIds)
        ? machine.failedCheckIds.length
        : 0;
      return count > 0
        ? { kind: "checkFailed", count }
        : { kind: "needsAttention" };
    }
    case "paused":
      return { kind: "paused" };
    case "finishing":
      return { kind: "finishing" };
    default:
      return null;
  }
}

/**
 * The row's one button. "Fix" only where something is broken (a machine that
 * needs attention); a machine someone paused or is finishing up is working as
 * asked, and one that is offline, not responding or retired mends itself or is
 * gone, so each of those gets "Open", the neutral button.
 */
export function machineRowAction(machine: MachineFacts): "fix" | "open" {
  return machineBadge(machine) === "needsAttention" ? "fix" : "open";
}

/** The coding agents a machine advertises, in the order it lists them. */
export type CodingAgent = "claude" | "codex" | "pi";

const AGENT_BY_KEY: Readonly<Record<string, CodingAgent>> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
};

export function codingAgents(
  capabilities: WorkerResponse["capabilities"],
): CodingAgent[] {
  if (!Array.isArray(capabilities)) return [];
  const agents: CodingAgent[] = [];
  for (const entry of capabilities) {
    if (typeof entry !== "string") continue;
    const key = entry.trim().toLowerCase();
    const agent = Object.hasOwn(AGENT_BY_KEY, key)
      ? AGENT_BY_KEY[key]
      : undefined;
    if (agent !== undefined && !agents.includes(agent)) agents.push(agent);
  }
  return agents;
}

/** Which rows a filter keeps; "needsAttention" also keeps a machine that has stopped answering. */
export type MachineFilter = "all" | "needsAttention" | "offline";

export function machineMatchesFilter(
  machine: MachineFacts,
  filter: MachineFilter,
): boolean {
  if (filter === "all") return true;
  const badge = machineBadge(machine);
  return filter === "offline"
    ? badge === "offline"
    : badge === "needsAttention" || badge === "notResponding";
}
