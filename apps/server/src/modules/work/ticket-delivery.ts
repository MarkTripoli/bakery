/**
 * Whether the work behind a ticket counts as delivered, by the source's
 * completion policy (#32, docs/technical-design/10-tickets.md "Progress
 * visible in both places"). Pure: the caller reads the evidence.
 *
 * A finished run is not delivery. A pull request closed without a merge is not
 * delivery. The state of the provider issue is not an input at all: closing a
 * ticket proves nothing was delivered. Each policy names what it waits for, so
 * the ticket's progress can say so in plain words.
 */

/** What a source requires before its ticket counts as delivered. */
export type TicketCompletionPolicy = "task" | "merged" | "deployed_healthy";

/** The facts a verdict reads. */
export type TicketDeliveryEvidence = {
  /** The run (or, without one, the task) ended successfully. */
  workFinished: boolean;
  /** The pull requests registered for the task. */
  pullRequests: readonly { status: "open" | "closed" | "merged" }[];
  /** The latest release health recorded for the work, or null when none is. */
  deployment: { healthy: boolean } | null;
  /**
   * Seconds since the latest run of the work finished; null when no run did
   * (a task closed by hand). A run can end before the step that registers its
   * pull request, so a run with no pull request yet is held for
   * `NO_PULL_REQUEST_GRACE_SECONDS` before it counts as having none.
   */
  finishedSecondsAgo: number | null;
};

/**
 * How long a finished run with no registered pull request waits before
 * `merged` treats it as work that opens none. A terminal request never
 * reopens, so delivering before a late registration would be final; the
 * recheck that follows reads the pull request once it exists. Ten minutes is
 * two recheck passes.
 */
export const NO_PULL_REQUEST_GRACE_SECONDS = 600;

/** What a delivered ticket's progress still waits for. */
export type TicketDeliveryWait =
  | "work"
  | "pull_request"
  | "merge"
  | "deployment";

export type TicketDeliveryVerdict =
  | { delivered: true }
  | {
    delivered: false;
    waitingFor: TicketDeliveryWait;
    /** A pull request was closed without merging and none merged since. */
    closedUnmerged: boolean;
  };

/**
 * A merge counts once at least one pull request merged and none is still
 * open: a replacement may follow a pull request closed unmerged, but a
 * merged one beside an open one leaves part of the work unmerged.
 */
function mergeState(
  pullRequests: TicketDeliveryEvidence["pullRequests"],
): { merged: boolean; closedUnmerged: boolean } {
  const merged = pullRequests.some((pr) => pr.status === "merged");
  const open = pullRequests.some((pr) => pr.status === "open");
  const closed = pullRequests.some((pr) => pr.status === "closed");
  return {
    merged: merged && !open,
    closedUnmerged: closed && !merged,
  };
}

export function ticketDeliveryVerdict(
  policy: TicketCompletionPolicy,
  evidence: TicketDeliveryEvidence,
): TicketDeliveryVerdict {
  const waiting = (
    waitingFor: TicketDeliveryWait,
    closedUnmerged = false,
  ): TicketDeliveryVerdict => ({
    delivered: false,
    waitingFor,
    closedUnmerged,
  });
  if (!evidence.workFinished) return waiting("work");
  // Work that opens no pull request (a plan, an analysis) is delivered when it
  // is finished.
  if (policy === "task") return { delivered: true };
  // Under `merged`, a run that registered no pull request at all had no code
  // to merge (a docs or ops task, or a run that found nothing to change), so
  // finished is delivered, once the run has been over long enough that its
  // pull request would have registered. An open pull request, or one closed
  // unmerged, still holds it: that is code that was proposed and not taken.
  if (policy === "merged" && evidence.pullRequests.length === 0) {
    return evidence.finishedSecondsAgo !== null &&
        evidence.finishedSecondsAgo < NO_PULL_REQUEST_GRACE_SECONDS
      ? waiting("pull_request")
      : { delivered: true };
  }
  const merge = mergeState(evidence.pullRequests);
  if (!merge.merged) return waiting("merge", merge.closedUnmerged);
  if (policy === "merged") return { delivered: true };
  return evidence.deployment?.healthy === true
    ? { delivered: true }
    : waiting("deployment");
}
