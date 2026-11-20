import type {
  TicketRequestViewResponse,
  TicketTaskLinkResponse,
} from "../../api/client.ts";

/** The server's one progress value for a start request. */
export type WorkProgress = TicketRequestViewResponse["progress"];

/** The tone of the badge each progress value wears. */
export const PROGRESS_TONE = {
  pending: "neutral",
  waiting: "warning",
  admitted: "information",
  active: "information",
  suspended: "warning",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
  rejected: "neutral",
} as const satisfies Record<
  WorkProgress,
  "neutral" | "success" | "warning" | "danger" | "information"
>;

/** Progress values whose sentence carries the reason the server recorded. */
const REASONED: ReadonlySet<WorkProgress> = new Set([
  "waiting",
  "suspended",
  "rejected",
]);

/** The reason code a progress line quotes, or null when its state carries none. */
export function progressReason(
  request: Pick<
    TicketRequestViewResponse,
    "progress" | "dispositionReasonCode"
  >,
): string | null {
  return REASONED.has(request.progress) ? request.dispositionReasonCode : null;
}

/** What the person can do next from a progress line. */
export type WorkNext = "openTask" | "startWork" | "none";

/** The one next step per progress value (the design's progress table). */
export function progressNext(progress: WorkProgress): WorkNext {
  switch (progress) {
    case "admitted":
    case "active":
    case "completed":
    case "failed":
      return "openTask";
    case "canceled":
    case "rejected":
      return "startWork";
    case "pending":
    case "waiting":
    case "suspended":
      return "none";
  }
}

/** Who or what began the work, as the line under the state reads it. */
export type WorkStartedBy =
  | { kind: "you" }
  | { kind: "member"; name: string | null }
  | { kind: "youAdopted" }
  | { kind: "memberAdopted"; name: string | null }
  | { kind: "label"; label: string | null };

/**
 * Names the origin of a request. The viewer is "you"; another person is named
 * by `nameOf` (the memberships read), or is "a teammate" while no name is known.
 */
export function startedBy(
  request: Pick<
    TicketRequestViewResponse,
    "origin" | "requestedByPrincipalId" | "triggerLabelName"
  >,
  viewerPrincipalId: string | null,
  nameOf: (principalId: string) => string | null = () => null,
): WorkStartedBy {
  const mine = viewerPrincipalId !== null &&
    request.requestedByPrincipalId === viewerPrincipalId;
  const name = request.requestedByPrincipalId === null
    ? null
    : nameOf(request.requestedByPrincipalId);
  switch (request.origin) {
    case "manual":
      return mine ? { kind: "you" } : { kind: "member", name };
    case "adoption":
      return mine ? { kind: "youAdopted" } : { kind: "memberAdopted", name };
    case "webhook":
    case "poll":
      return { kind: "label", label: request.triggerLabelName };
  }
}

/** The state of Bakery's note on the issue. */
export type NoteView =
  | { state: "unknown" | "pending" | "healthy" | "recreated" }
  | { state: "failed"; reason: "permission" | "unavailable" | "refused" };

/** Reads a link's note health into the design's note table. */
export function noteView(
  link: Pick<TicketTaskLinkResponse, "syncHealth" | "lastProblemCode">,
): NoteView {
  switch (link.syncHealth) {
    case "unknown":
    case "pending":
      return { state: link.syncHealth };
    case "healthy":
      return {
        state: link.lastProblemCode === "note_recreated"
          ? "recreated"
          : "healthy",
      };
    case "failed": {
      const code = link.lastProblemCode ?? "";
      if (/forbidden|permission|denied|not_allowed/.test(code)) {
        return { state: "failed", reason: "permission" };
      }
      if (/unavailable|dependency|timeout|rate_limit/.test(code)) {
        return { state: "failed", reason: "unavailable" };
      }
      return { state: "failed", reason: "refused" };
    }
  }
}

/** The request the issue page speaks about: the newest, since the server lists newest first. */
export function currentRequest(
  requests: readonly TicketRequestViewResponse[],
): TicketRequestViewResponse | null {
  return requests[0] ?? null;
}

/** The banner a paused request earns on the issue page (design section 3). */
export type PausedBanner =
  | "editedAfterSetup"
  | "labelRemoved"
  | "onHold"
  | "dependencyUnreadable";

/** Maps the server's pause cause to its banner; null when nothing is paused. */
export function pausedBanner(
  request: Pick<TicketRequestViewResponse, "progress" | "pausedReason">,
): PausedBanner | null {
  if (request.progress !== "suspended") return null;
  switch (request.pausedReason) {
    case "edited_after_setup":
      return "editedAfterSetup";
    case "label_removed":
      return "labelRemoved";
    case "hold_label_added":
      return "onHold";
    case "dependency_unreadable":
      return "dependencyUnreadable";
    case null:
      return null;
  }
}
