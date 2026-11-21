import type { TicketRequestProgress } from "./ticket-request-state.ts";
import type { TicketDeliveryVerdict } from "./ticket-delivery.ts";

/**
 * What Bakery's status note on a ticket says, and when it is written again
 * (#32, docs/technical-design/10-tickets.md "Progress visible in both places").
 * Pure: the caller reads the request, its run and its delivery evidence.
 *
 * The note changes on a meaningful phase change only, so a code names each
 * phase; a poll that sees the same phase writes nothing. A phase can come
 * back (a paused request resumes), so the stored code is compared for
 * equality, never for order.
 */

/** One phase of a ticket request, as the ticket's reader sees it. */
export type TicketProgressPhase = Readonly<{
  /** Stored on the link as `last_synced_run_revision`. */
  code: number;
  /** The first line of the note, in plain words. */
  headline: string;
}>;

const PHASES = {
  queued: { code: 1, headline: "Queued: Bakery will start on this soon." },
  working: { code: 2, headline: "Working on this issue." },
  waitingForPullRequest: {
    code: 3,
    headline: "The work is finished; waiting for its pull request.",
  },
  waitingForMerge: {
    code: 4,
    headline: "The work is finished; waiting for its pull request to merge.",
  },
  pullRequestClosed: {
    code: 5,
    headline:
      "The pull request was closed without merging, so this is not delivered.",
  },
  waitingForDeployment: {
    code: 6,
    headline: "Merged; waiting for a healthy release.",
  },
  paused: { code: 7, headline: "Paused." },
  delivered: { code: 8, headline: "Delivered." },
  failed: { code: 9, headline: "Stopped: the run did not succeed." },
  canceled: { code: 10, headline: "Canceled." },
} as const satisfies Record<string, TicketProgressPhase>;

/**
 * The phase for a request's progress and delivery verdict, or null when the
 * request has nothing to say yet (not yet admitted, or rejected).
 */
export function ticketProgressPhase(
  progress: TicketRequestProgress,
  verdict: TicketDeliveryVerdict,
): TicketProgressPhase | null {
  switch (progress) {
    case "admitted":
    case "waiting":
      return PHASES.queued;
    case "suspended":
      return PHASES.paused;
    case "completed":
      return PHASES.delivered;
    case "failed":
      return PHASES.failed;
    case "canceled":
      return PHASES.canceled;
    case "active":
      if (verdict.delivered || verdict.waitingFor === "work") {
        return PHASES.working;
      }
      if (verdict.waitingFor === "pull_request") {
        return PHASES.waitingForPullRequest;
      }
      if (verdict.waitingFor === "deployment") {
        return PHASES.waitingForDeployment;
      }
      return verdict.closedUnmerged
        ? PHASES.pullRequestClosed
        : PHASES.waitingForMerge;
    default:
      return null;
  }
}

/** Who may read the note: everyone for a public ticket, the repository's readers for a private one. */
export type TicketAudience = "public" | "private";

/** What a note shows beyond its headline. */
export type TicketProgressNote = Readonly<{
  phase: TicketProgressPhase;
  audience: TicketAudience;
  taskTitle: string;
  pullRequests: readonly Readonly<{
    number: number;
    status: "open" | "closed" | "merged";
  }>[];
}>;

/**
 * The note's text. A public ticket gets the phase and its pull requests and
 * nothing else: the task's own title, plans, traces and artifacts stay in
 * Bakery, and a link would not grant access to them anyway. A private ticket
 * also names the task. Pull request numbers are provider facts of the same
 * repository.
 */
export function ticketProgressBody(note: TicketProgressNote): string {
  const lines = [`Bakery: ${note.phase.headline}`];
  if (note.audience === "private") {
    // Shown as inline code so an @mention does not notify, a #ref does not
    // link and HTML (an effect marker among it) is not parsed.
    const title = note.taskTitle.replace(/\s+/g, " ").trim().slice(0, 200)
      .replaceAll("`", "'").replaceAll("<!--", "<!- -");
    lines.push("", `Task: \`${title}\``);
  }
  if (note.pullRequests.length > 0) {
    lines.push(
      "",
      ...note.pullRequests.slice(0, 10).map((pr) =>
        `Pull request #${pr.number}: ${pr.status}`
      ),
    );
  }
  return lines.join("\n");
}
