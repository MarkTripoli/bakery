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
