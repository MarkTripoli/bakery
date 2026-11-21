/**
 * Whether the work behind a ticket counts as delivered, by the source's
 * completion policy (#32, docs/technical-design/10-tickets.md "Progress
 * visible in both places"). Pure: the caller reads the evidence.
 *
 * A finished run is not delivery. A closed issue is not delivery. A pull
 * request closed without a merge is not delivery. Each policy names what it
 * waits for, so the ticket's progress can say so in plain words.
 */

/** What a source requires before its ticket counts as delivered. */
export type TicketCompletionPolicy = "merged" | "deployed_healthy" | "manual";

/** The facts a verdict reads. */
export type TicketDeliveryEvidence = {
  /** The run (or, without one, the task) ended successfully. */
  workFinished: boolean;
  /** The pull requests registered for the task. */
  pullRequests: readonly { status: "open" | "closed" | "merged" }[];
  /** The latest release health recorded for the work, or null when none is. */
  deployment: { healthy: boolean } | null;
  /** A person confirmed delivery by hand. */
  manuallyConfirmed: boolean;
  /**
   * The provider issue is closed. It is carried so a closed issue is visibly
   * ignored: no policy reads it, because closing a ticket proves nothing was
   * delivered.
   */
  issueClosed: boolean;
};

/** What a delivered ticket's progress still waits for. */
export type TicketDeliveryWait =
  | "work"
  | "merge"
  | "deployment"
  | "confirmation";

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
  if (policy === "manual") {
    return evidence.manuallyConfirmed
      ? { delivered: true }
      : waiting("confirmation");
  }
  const merge = mergeState(evidence.pullRequests);
  if (!merge.merged) return waiting("merge", merge.closedUnmerged);
  if (policy === "merged") return { delivered: true };
  return evidence.deployment?.healthy === true
    ? { delivered: true }
    : waiting("deployment");
}
