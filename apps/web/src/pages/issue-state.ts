import type { ExternalTicketResponse } from "../api/client.ts";

/** One GitHub issue as the Issues list reads it: the saved copy plus its latest check. */
export type IssueRow = ExternalTicketResponse;

/** What the person sees an issue as: one word per row. */
export type IssueStatus =
  | "canStart"
  | "waiting"
  | "cannotStart"
  | "inProgress"
  | "waitingToStart"
  | "paused"
  | "closed"
  | "unknown";

/** The list's filters: what can be started, everything open, what is being worked on, and closed. */
export const ISSUE_FILTERS = [
  "canStart",
  "open",
  "inProgress",
  "closed",
] as const;
export type IssueFilter = typeof ISSUE_FILTERS[number];

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The parts of the saved copy the list shows. */
export type IssueSnapshot = {
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly repository: string;
};

/** Reads the saved copy defensively: it is a JSON value, never trusted to have every field. */
export function issueSnapshot(row: IssueRow): IssueSnapshot {
  const snapshot = record(row.snapshot);
  return {
    title: text(snapshot.title),
    labels: Array.isArray(snapshot.labels)
      ? snapshot.labels.filter((label): label is string =>
        typeof label === "string"
      )
      : [],
    state: text(snapshot.state) || row.state,
    repository: text(snapshot.repositoryFullName),
  };
}

/** The issue's number on GitHub, or `null` when the server has none. */
export function issueNumber(row: IssueRow): number | null {
  const parsed = Number(row.number);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** One check of the readiness report, as stored. */
export type IssueCheck = {
  readonly id: string;
  readonly status: "pass" | "wait" | "reject";
  readonly reason: string;
  readonly evidence: readonly string[];
};

function checksOf(row: IssueRow): readonly IssueCheck[] {
  const readiness = record(row.latestReadiness);
  if (!Array.isArray(readiness.checks)) return [];
  return readiness.checks.flatMap((candidate): IssueCheck[] => {
    const check = record(candidate);
    const status = check.status;
    if (status !== "pass" && status !== "wait" && status !== "reject") {
      return [];
    }
    return [{
      id: text(check.id),
      status,
      reason: text(check.reason),
      evidence: Array.isArray(check.evidence)
        ? check.evidence.map((entry) => text(record(entry).ref)).filter(
          Boolean,
        )
        : [],
    }];
  });
}

/** The check that decides a waiting or rejected verdict: a rejection first, else the first wait. */
export function decidingCheck(row: IssueRow): IssueCheck | null {
  const checks = checksOf(row);
  return checks.find((check) => check.status === "reject") ??
    checks.find((check) => check.status === "wait") ?? null;
}

/**
 * The one status of an issue and the reason behind it, from, in this order:
 * the request already running for it, whether it is closed, and its latest
 * readiness verdict. An issue never read is "unknown", never "can start".
 */
export function issueStatus(
  row: IssueRow,
): { status: IssueStatus; reason: string | null } {
  const request = record(row.activeRequest);
  const disposition = text(request.disposition);
  if (disposition === "admitted" || disposition === "active") {
    return { status: "inProgress", reason: null };
  }
  if (disposition === "pending" || disposition === "waiting") {
    return {
      status: "waitingToStart",
      reason: text(request.dispositionReason) || null,
    };
  }
  if (disposition === "suspended") {
    return {
      status: "paused",
      reason: text(request.dispositionReason) || null,
    };
  }
  if (issueSnapshot(row).state === "closed") {
    return { status: "closed", reason: "ticket_closed" };
  }
  const readiness = record(row.latestReadiness);
  const verdict = text(readiness.verdict);
  if (verdict === "ready") return { status: "canStart", reason: null };
  if (verdict === "waiting" || verdict === "rejected") {
    return {
      status: verdict === "waiting" ? "waiting" : "cannotStart",
      reason: decidingCheck(row)?.reason ?? null,
    };
  }
  return { status: "unknown", reason: "not_checked" };
}

/** Whether a row belongs under a filter. */
export function issueMatchesFilter(
  row: IssueRow,
  filter: IssueFilter,
): boolean {
  const { status } = issueStatus(row);
  if (filter === "canStart") return status === "canStart";
  if (filter === "inProgress") {
    return status === "inProgress" || status === "waitingToStart" ||
      status === "paused";
  }
  if (filter === "closed") return status === "closed";
  return status !== "closed";
}

/** The number or label a check read, from its evidence: `blocker:owner/repo#12`, `label:ready for agent`. */
export function evidenceValue(
  check: IssueCheck | null,
  prefix: "blocker" | "label",
): string | null {
  const found = check?.evidence.find((entry) => entry.startsWith(`${prefix}:`));
  return found ? found.slice(prefix.length + 1) : null;
}

/** The number after `#` in an evidence reference such as `owner/repo#12`. */
export function referencedNumber(reference: string | null): string | null {
  const match = reference === null ? null : /#(\d+)$/.exec(reference);
  return match ? match[1] : null;
}

/** The reason codes that have a sentence of their own; any other reads as "cannot start yet". */
export const KNOWN_REASONS = [
  "predecessor_open",
  "closed_unmerged",
  "proof_unavailable",
  "inaccessible",
  "links_truncated",
  "label_missing",
  "label_withdrawn",
  "held",
  "acceptance_missing",
  "has_sub_issues",
  "pull_request_not_ticket",
  "ticket_closed",
  "ticket_gone",
  "ticket_moved",
  "acceptance_changed",
  "requirements_too_large",
  "active_request",
  "no_delegation",
  "actor_not_allowlisted",
  "actor_role_insufficient",
  "actor_unverifiable",
  "principal_inactive",
  "source_disabled",
  "resource_not_selected",
  "connection_not_enabled",
  "installation_not_enabled",
  "repository_archived",
  "no_active_profile",
  "preset_setup_required",
  "provider_unavailable",
  "repository_mismatch",
  "not_checked",
] as const;
export type KnownReason = typeof KNOWN_REASONS[number];

/** Maps a server reason to the key of its sentence, folding the provider reasons into one. */
export function reasonKey(code: string): KnownReason | "unknown" {
  const folded = code.startsWith("provider:") ? "provider_unavailable" : code;
  return (KNOWN_REASONS as readonly string[]).includes(folded)
    ? folded as KnownReason
    : "unknown";
}

/** What the person can do about a reason, in the design's words: where the fix lives. */
export type ReasonAction =
  | { kind: "none" }
  | { kind: "checkAgain" }
  | {
    kind: "github";
    label:
      | "fixLink"
      | "addLabel"
      | "removeLabel"
      | "addCriteria"
      | "shorten"
      | "openSubIssue";
  }
  | { kind: "integrations" }
  | { kind: "issueSettings" }
  | { kind: "projects" }
  | { kind: "askAdmin" }
  | { kind: "startAgain" };

/** The next step each reason code leads to (the design's reason table). */
export function reasonAction(code: string): ReasonAction {
  switch (reasonKey(code)) {
    case "closed_unmerged":
      return { kind: "github", label: "fixLink" };
    case "proof_unavailable":
    case "provider_unavailable":
    case "not_checked":
      return { kind: "checkAgain" };
    case "inaccessible":
    case "connection_not_enabled":
    case "installation_not_enabled":
      return { kind: "integrations" };
    case "label_missing":
    case "label_withdrawn":
      return { kind: "github", label: "addLabel" };
    case "held":
      return { kind: "github", label: "removeLabel" };
    case "acceptance_missing":
      return { kind: "github", label: "addCriteria" };
    case "requirements_too_large":
      return { kind: "github", label: "shorten" };
    case "has_sub_issues":
      return { kind: "github", label: "openSubIssue" };
    case "acceptance_changed":
      return { kind: "startAgain" };
    case "no_delegation":
    case "actor_not_allowlisted":
    case "actor_role_insufficient":
    case "actor_unverifiable":
    case "principal_inactive":
      return { kind: "askAdmin" };
    case "source_disabled":
    case "resource_not_selected":
      return { kind: "issueSettings" };
    case "no_active_profile":
    case "preset_setup_required":
      return { kind: "projects" };
    default:
      return { kind: "none" };
  }
}

/** Every check of the latest report, in the report's order. */
export function issueChecks(row: IssueRow): readonly IssueCheck[] {
  return checksOf(row);
}

/** What the "Can Bakery start this?" card offers as its one primary action. */
export type StartOffer = "start" | "startWhenReady" | "none";

/**
 * Start work is offered when the latest verdict is ready and nothing runs for
 * the issue; "Start when ready" when the only things in the way are
 * dependencies that clear by themselves; nothing otherwise.
 */
export function startOffer(row: IssueRow): StartOffer {
  const { status } = issueStatus(row);
  if (status === "canStart") return "start";
  if (status !== "waiting") return "none";
  const waits = issueChecks(row).filter((check) => check.status !== "pass");
  const onlyDependencies = waits.length > 0 &&
    waits.every((check) =>
      check.id === "dependencies_satisfied" &&
      check.status === "wait" && check.reason === "predecessor_open"
    );
  return onlyDependencies ? "startWhenReady" : "none";
}

/** One issue an issue depends on, as the saved copy lists it. */
export type IssueDependency = {
  readonly repository: string;
  readonly number: number;
  /** done: the check passed; open: still open; closedUnmerged; unreadable; unknown: not checked yet. */
  readonly state: "done" | "open" | "closedUnmerged" | "unreadable" | "unknown";
};

/** The native links of the saved copy, defensively read. */
export type IssueLinks = {
  readonly parent: { repository: string; number: number } | null;
  readonly subIssues: number;
  readonly dependencies: readonly IssueDependency[];
  /** The links could not be read in full: no list, or more than the saved copy keeps. */
  readonly incomplete: boolean;
};

const issueRef = (
  value: unknown,
): { repository: string; number: number } | null => {
  const ref = record(value);
  const number = Number(ref.number);
  const repository = text(ref.repositoryFullName);
  return Number.isInteger(number) && number > 0 && repository
    ? { repository, number }
    : null;
};

/** Reads the links, naming each dependency's state from the dependency check's evidence. */
export function issueLinks(row: IssueRow): IssueLinks {
  const links = record(record(row.snapshot).links);
  const dependencyCheck = issueChecks(row).find((check) =>
    check.id === "dependencies_satisfied"
  );
  const blocked = Array.isArray(links.blockedBy) ? links.blockedBy : [];
  const dependencies = blocked.flatMap((candidate): IssueDependency[] => {
    const ref = issueRef(candidate);
    if (ref === null) return [];
    const named = `${ref.repository}#${ref.number}`;
    const mentioned = dependencyCheck?.evidence.some((entry) =>
      entry === `blocker:${named}`
    ) ?? false;
    const state: IssueDependency["state"] = dependencyCheck === undefined
      ? "unknown"
      : dependencyCheck.status === "pass"
      ? "done"
      : !mentioned
      ? "done"
      : dependencyCheck.reason === "closed_unmerged"
      ? "closedUnmerged"
      : dependencyCheck.reason === "inaccessible" ||
          dependencyCheck.reason === "proof_unavailable"
      ? "unreadable"
      : "open";
    return [{ ...ref, state }];
  });
  const truncated = dependencyCheck?.reason === "links_truncated";
  return {
    parent: issueRef(links.parent),
    subIssues: Number(links.subIssuesTotal) > 0
      ? Number(links.subIssuesTotal)
      : 0,
    dependencies,
    incomplete: Object.keys(links).length === 0 || truncated,
  };
}

/** The saved description, and whether it is only the first part of a long one. */
export function issueBody(row: IssueRow): { body: string; truncated: boolean } {
  const snapshot = record(row.snapshot);
  return {
    body: text(snapshot.body),
    truncated: snapshot.bodyTruncated === true,
  };
}

/** How long ago a time was, as the whole unit that fits: minutes, hours or days. */
export function ageOf(
  then: string | null,
  now: number,
): { unit: "minute" | "hour" | "day"; count: number } | "now" | null {
  if (then === null) return null;
  const elapsed = now - Date.parse(then);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  return { unit: "day", count: Math.floor(hours / 24) };
}

/** The health of a repository's GitHub connection, as the sources report it. */
export type SourceHealth = "unknown" | "healthy" | "degraded" | "auth_required";

/** What the page tells about GitHub: the worst trouble among the repositories read. */
export type GitHubTrouble = "authRequired" | "degraded" | "unknown";

/**
 * Trouble to show for the sources in question. Unknown counts only when no
 * source is healthy (a newly added repository must not hide a working one).
 */
export function troubleOf(
  healths: readonly SourceHealth[],
): GitHubTrouble | null {
  if (healths.includes("auth_required")) return "authRequired";
  if (healths.includes("degraded")) return "degraded";
  if (healths.length > 0 && !healths.includes("healthy")) return "unknown";
  return null;
}
