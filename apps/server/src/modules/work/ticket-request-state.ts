import {
  isNonterminalTicketDisposition,
  isTicketAutoResumableReason,
  isTicketExplicitResumeReason,
  isTicketNonSuspendingReason,
  TICKET_AUTO_RESUMABLE_REASONS,
  TICKET_EXPLICIT_RESUME_REASONS,
  type TicketReadinessReport,
  type TicketReasonCode,
  type TicketRequestDisposition,
  type TicketRequestIntent,
} from "@bakery/contracts/ticket-admission";
import type { TicketDeliveryVerdict } from "./ticket-delivery.ts";

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
  /**
   * Status of the ticket-origin coordination plan the request's routed
   * targets run in (#31), or null/omitted when it runs on its own task. When
   * set, the plan's projection of its child tasks decides the outcome.
   */
  planStatus?: string | null;
  /**
   * Whether the source's completion policy is met by the evidence found now
   * (see `ticketDeliveryVerdict`). A finished run ends the request as
   * completed only when it is: until then the request stays open, and a run
   * that failed or was canceled still ends it.
   */
  delivery: TicketDeliveryVerdict;
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
/**
 * The request's end state from its plan, in the task vocabulary of its child
 * tasks: done only when every child is, failed when any failed or stopped.
 */
function planOutcome(status: string): RecheckDecision | null {
  if (status === "completed") {
    return {
      action: "terminal",
      disposition: "completed",
      reason: "task_completed",
    };
  }
  if (status === "failed" || status === "partially_delivered") {
    return { action: "terminal", disposition: "failed", reason: "task_failed" };
  }
  if (status === "canceled") {
    return {
      action: "terminal",
      disposition: "canceled",
      reason: "task_canceled",
    };
  }
  return null;
}

/** Whether the work behind the request ended successfully, as the recheck reads it. */
export function requestWorkFinished(
  current: Pick<
    RecheckCurrent,
    "hasRun" | "runStatus" | "taskStatus" | "planStatus"
  >,
): boolean {
  if (current.planStatus != null) return current.planStatus === "completed";
  if (current.hasRun && finishedDisposition(current.runStatus) !== null) {
    return current.runStatus === "completed";
  }
  return current.taskStatus === "completed";
}

function terminalOutcome(current: RecheckCurrent): RecheckDecision | null {
  const outcome = endedOutcome(current);
  // A finished run is not delivery: the request stays open until the source's
  // completion policy is met, so nothing reads "done" before it is true.
  if (
    outcome?.action === "terminal" && outcome.disposition === "completed" &&
    !current.delivery.delivered
  ) return null;
  return outcome;
}

function endedOutcome(current: RecheckCurrent): RecheckDecision | null {
  if (current.planStatus != null) return planOutcome(current.planStatus);
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
    // Reasons that exist only before a request does never suspend one,
    // including the label routing blocks (#31): an admitted request keeps the
    // targets it was admitted with.
    if (isTicketNonSuspendingReason(check.reason)) continue;
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
    current.approvalAvailable && pinChecked && current.planStatus == null
  ) {
    return { action: "advance" };
  }
  return NONE;
}

/**
 * Every reason a disposition stores: the suspension reasons (auto-resumable
 * and explicit-resume) and the run or task end a request finished with. The
 * non-suspending reasons never reach a disposition. `ticketRequests.list`
 * and `.get` (#69) answer this closed set as `dispositionReasonCode`.
 */
export const TICKET_DISPOSITION_REASON_CODES = Object.freeze(
  [
    ...TICKET_AUTO_RESUMABLE_REASONS,
    ...TICKET_EXPLICIT_RESUME_REASONS,
    "run_completed",
    "run_failed",
    "run_canceled",
    "task_completed",
    "task_failed",
    "task_canceled",
  ] as const satisfies readonly (TicketReasonCode | TicketTerminalReason)[],
);
export type TicketDispositionReasonCode =
  typeof TICKET_DISPOSITION_REASON_CODES[number];

/** The stored reason as a closed code; a value outside the set reads as none. */
export function dispositionReasonCode(
  stored: string | null,
): TicketDispositionReasonCode | null {
  return (TICKET_DISPOSITION_REASON_CODES as readonly string[]).includes(
      stored ?? "",
    )
    ? stored as TicketDispositionReasonCode
    : null;
}

/** Why a request's run was paused, in the words the ticket page uses. */
export type TicketPausedReason =
  | "edited_after_setup"
  | "label_removed"
  | "hold_label_added"
  | "dependency_unreadable";

const PAUSED_REASONS: Readonly<Partial<Record<string, TicketPausedReason>>> =
  Object.freeze({
    acceptance_changed: "edited_after_setup",
    label_withdrawn: "label_removed",
    label_missing: "label_removed",
    held: "hold_label_added",
    proof_unavailable: "dependency_unreadable",
    inaccessible: "dependency_unreadable",
    links_truncated: "dependency_unreadable",
  });

/**
 * Why the run was paused. A pause is only ever requested of a suspended
 * request (`decideRecheck`), so its cause is the suspension reason stored with
 * it; null when no pause was requested, or when the reason is none of the four
 * the page names (`dispositionReasonCode` still carries it).
 */
export function pausedReason(
  pauseRequestedAt: unknown,
  stored: string | null,
): TicketPausedReason | null {
  if (pauseRequestedAt === null || stored === null) return null;
  return PAUSED_REASONS[stored] ?? null;
}

/** One progress value for display, from the disposition and the run. */
export type TicketRequestProgress =
  | "pending"
  | "waiting"
  | "admitted"
  | "active"
  | "suspended"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

/**
 * The progress the ticket page shows. A terminal disposition, `pending` and
 * `suspended` are shown as stored. Otherwise the run decides, because the
 * recheck that moves the disposition runs on its own schedule: a run that
 * failed or was canceled shows its end, a completed one shows completed only
 * once the source's completion policy is met (`delivered`), and active until
 * then, a queued run `admitted`, a paused run `suspended`, a run
 * waiting for input, capacity or a block `waiting`, and a running or stopping
 * run `active`. With no run the disposition stands. Unknown run statuses
 * leave the disposition as stored.
 */
export function ticketRequestProgress(
  disposition: TicketRequestDisposition,
  runStatus: string | null,
  delivered: boolean,
): TicketRequestProgress {
  if (
    !isNonterminalTicketDisposition(disposition) ||
    disposition === "suspended" || runStatus === null
  ) return disposition;
  switch (runStatus) {
    // A finished run whose delivery is not proven yet is still open work.
    case "completed":
      return delivered ? "completed" : "active";
    case "failed":
    case "canceled":
      return runStatus;
    case "queued":
      return "admitted";
    case "paused":
      return "suspended";
    case "waiting_input":
    case "waiting_capacity":
    case "blocked":
      return "waiting";
    case "running":
    case "canceling":
      return "active";
    default:
      return disposition;
  }
}
