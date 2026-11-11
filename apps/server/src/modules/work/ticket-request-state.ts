import {
  isNonterminalTicketDisposition,
  isTicketAutoResumableReason,
  isTicketExplicitResumeReason,
  type TicketReadinessReport,
  type TicketReasonCode,
  type TicketRequestDisposition,
  type TicketRequestIntent,
} from "@bakery/contracts/ticket-admission";

/**
 * The disposition machine of a ticket request: which moves are legal and what
 * a fresh readiness report means for a request that already exists. Pure: the
 * caller reads the request, its task and its run, and applies the decision.
 */

/** Dispositions a finished task or run maps a request to. */
export type TicketFinishedDisposition = "completed" | "failed" | "canceled";

/** Why a request ended: the state of the run (or, with none, the task). */
export type TicketTerminalReason = `${
  | "run"
  | "task"}_${TicketFinishedDisposition}`;

/** Where a resumed request returns to: before a run, queued, or running. */
export type TicketResumeTarget = "waiting" | "admitted" | "active";

/** What the stored request, its task and its run look like at a recheck. */
export type RecheckCurrent = {
  disposition: TicketRequestDisposition;
  /** Reason recorded with the disposition; null when none is recorded. */
  dispositionReason: string | null;
  intent: TicketRequestIntent;
  /** The request owns a workflow run. */
  hasRun: boolean;
  /** Status of that run; null when there is none. */
  runStatus: string | null;
  taskStatus: string;
  /** An approved, unconsumed, unrevoked, unexpired plan approval exists. */
  approvalAvailable: boolean;
  /** Requirements digest pinned on the request; null before one is pinned. */
  pinnedRequirementsDigest: string | null;
  /** When a pause was requested of the run, or null if none was. */
  pauseRequestedAt: string | null;
};

export type RecheckDecision =
  | { action: "none" }
  | { action: "suspend"; reason: TicketReasonCode }
  | { action: "pause" }
  | { action: "resume"; to: TicketResumeTarget }
  | { action: "advance" }
  | {
    action: "terminal";
    disposition: TicketFinishedDisposition;
    reason: TicketTerminalReason;
  };

const NONE: RecheckDecision = { action: "none" };

/** Legal disposition moves. A disposition never moves to itself or back to pending. */
const TRANSITIONS: Readonly<
  Record<TicketRequestDisposition, readonly TicketRequestDisposition[]>
> = Object.freeze({
  pending: ["waiting", "admitted", "rejected", "failed", "canceled"],
  waiting: [
    "admitted",
    "active",
    "suspended",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ],
  admitted: ["active", "suspended", "completed", "failed", "canceled"],
  active: ["suspended", "completed", "failed", "canceled"],
  suspended: [
    "waiting",
    "admitted",
    "active",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ],
  rejected: [],
  completed: [],
  failed: [],
  canceled: [],
});

export function canTransition(
  from: TicketRequestDisposition,
  to: TicketRequestDisposition,
): boolean {
  return TRANSITIONS[from].includes(to);
}

function finishedDisposition(
  status: string | null,
): TicketFinishedDisposition | null {
  return status === "completed" || status === "failed" || status === "canceled"
    ? status
    : null;
}

/** The run's end state wins; a request without a run follows its task. */
function terminalOutcome(current: RecheckCurrent): RecheckDecision | null {
  const run = current.hasRun ? finishedDisposition(current.runStatus) : null;
  if (run !== null) {
    return { action: "terminal", disposition: run, reason: `run_${run}` };
  }
  const task = finishedDisposition(current.taskStatus);
  if (task !== null) {
    return { action: "terminal", disposition: task, reason: `task_${task}` };
  }
  return null;
}

/**
 * Reason to suspend on, from the first check that did not pass. Reasons that
 * only exist before a request does (`active_request`, `adoption_required`)
 * never suspend. A request that lost its acceptance criteria records
 * `acceptance_changed`, whether `requirements_unchanged` or `acceptance_present`
 * reported it. Null when no check gives a suspending reason.
 */
export function suspensionReason(
  report: Pick<TicketReadinessReport, "checks">,
): TicketReasonCode | null {
  for (const check of report.checks) {
    if (check.status === "pass") continue;
    if (check.reason === "acceptance_missing") return "acceptance_changed";
    if (
      check.reason === "active_request" || check.reason === "adoption_required"
    ) {
      continue;
    }
    return check.reason;
  }
  return null;
}

/**
 * Where a resumed request returns to: before a run, queued, or running. Also
 * used by an explicit resume, which has no recheck decision to read it from.
 */
export function resumeTarget(
  current: Pick<RecheckCurrent, "hasRun" | "runStatus">,
): TicketResumeTarget {
  if (!current.hasRun) return "waiting";
  return current.runStatus === null || current.runStatus === "queued" ||
      current.runStatus === "waiting_capacity"
    ? "admitted"
    : "active";
}

/**
 * A stored reason is replaced by a newer one unless it is an explicit-resume
 * reason: those stay until a person re-evaluates the request, so a milder
 * reason found later (for example a returned hold label after the issue was
 * closed) never makes the request resumable.
 */
function replacesStoredReason(
  stored: string | null,
  next: TicketReasonCode,
): boolean {
  return stored !== next && !isTicketExplicitResumeReason(stored);
}

/**
 * Decides what a fresh readiness report means for the existing request.
 *
 * - A finished run (or task without a run) ends the request.
 * - Not ready and not suspended: suspend with the first suspending reason.
 * - Suspended: resume only when the report is ready and the stored reason is
 *   auto-resumable; explicit-resume reasons never resume here. Otherwise a
 *   newer or stronger reason is recorded, and a request that owns a run and
 *   has no pause requested yet is paused.
 * - Ready and `waiting` with an approved plan available: advance, which
 *   creates the run.
 *
 * A request with a pinned digest is resumed or advanced only on a report that
 * checked the pin (`requirements_unchanged`). One call returns one decision;
 * the caller re-decides after applying a `suspend` if it wants the pause in the
 * same pass.
 */
export function decideRecheck(
  current: RecheckCurrent,
  report: Pick<TicketReadinessReport, "verdict" | "checks">,
): RecheckDecision {
  if (!isNonterminalTicketDisposition(current.disposition)) return NONE;
  const terminal = terminalOutcome(current);
  if (terminal !== null) return terminal;

  const ready = report.verdict === "ready";
  const pinChecked = current.pinnedRequirementsDigest === null ||
    report.checks.some((check) => check.id === "requirements_unchanged");
  const reason = ready ? null : suspensionReason(report);

  if (current.disposition === "suspended") {
    if (
      ready && pinChecked &&
      isTicketAutoResumableReason(current.dispositionReason)
    ) {
      return { action: "resume", to: resumeTarget(current) };
    }
    if (
      reason !== null && replacesStoredReason(current.dispositionReason, reason)
    ) {
      return { action: "suspend", reason };
    }
    if (current.hasRun && current.pauseRequestedAt === null) {
      return { action: "pause" };
    }
    return NONE;
  }

  if (!ready) {
    return reason === null ? NONE : { action: "suspend", reason };
  }
  if (
    current.disposition === "waiting" && current.intent === "start" &&
    current.approvalAvailable && pinChecked
  ) {
    return { action: "advance" };
  }
  return NONE;
}
