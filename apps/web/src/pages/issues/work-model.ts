import type {
  QuestionResponse,
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
export type WorkNext = "openTask" | "none";

/** The one next step per progress value (the design's progress table). */
export function progressNext(progress: WorkProgress): WorkNext {
  switch (progress) {
    case "admitted":
    case "active":
    case "completed":
    case "failed":
      return "openTask";
    // Starting again is the status card's button, not the work row's.
    case "canceled":
    case "rejected":
    case "pending":
    case "waiting":
    case "suspended":
      return "none";
  }
}

/** Progress values after which nothing more happens to the request. */
const FINISHED: ReadonlySet<WorkProgress> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

/** True once the request has reached an end state. */
export function workFinished(progress: WorkProgress): boolean {
  return FINISHED.has(progress);
}

/** Progress values in which a run exists that a person may ask to stop. */
const STOPPABLE: ReadonlySet<WorkProgress> = new Set([
  "admitted",
  "active",
  "suspended",
]);

/**
 * The run a person could ask to stop: the request's own run while it is
 * starting, working or paused; null when there is none. Whether this person may
 * stop it is the run's own capability read, not a guess from here.
 */
export function stoppableRunId(
  request: Pick<TicketRequestViewResponse, "progress" | "workflowRunId">,
): string | null {
  return STOPPABLE.has(request.progress) ? request.workflowRunId : null;
}

/**
 * True when work began from a label and has no run yet: nothing here can stop it
 * until it starts, so the page says how to stop it on GitHub (design: Stop work).
 */
export function stopsBeforeStart(
  request: Pick<
    TicketRequestViewResponse,
    "progress" | "workflowRunId" | "origin"
  >,
): boolean {
  return request.workflowRunId === null &&
    (request.origin === "webhook" || request.origin === "poll") &&
    !workFinished(request.progress);
}

/** How often the page re-reads a request it asked to stop. */
export const STOP_POLL_MS = 5_000;

/** How long a paused request may stay unstopped before the page says it can take a while. */
export const STOP_SLOW_MS = 15_000;

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

/** The progress values a task can be in while it waits on a person's answer. */
const ANSWERABLE: ReadonlySet<WorkProgress> = new Set(["admitted", "active"]);

/**
 * Whether the progress badge should read "Needs an answer": the work is under
 * way and its task has an open question, so "Working" would contradict the row
 * above it. A paused, finished or stopped request keeps its own word.
 */
export function waitsOnAnswer(
  progress: WorkProgress,
  row: QuestionRowView | null,
): boolean {
  return row?.kind === "open" && ANSWERABLE.has(progress);
}

/** What the issue page says about its task's questions (design section D). */
export type QuestionRowView =
  | {
    kind: "open";
    /** Every question still waiting for an answer. */
    count: number;
    /** The first two lines of the oldest one. */
    lines: readonly string[];
    /** When the oldest was asked. */
    askedAt: string;
  }
  | { kind: "expired" };

/**
 * Reads a task's questions into the one row the issue page shows. Approvals are
 * decisions the task page asks for, not questions. A question that is open shows
 * the oldest, since that is the one that has waited longest; with none open, the
 * row stays only while the newest question is the one that expired, so an
 * old expiry does not outlive the answer that came after it.
 */
export function questionRow(
  questions: readonly Pick<
    QuestionResponse,
    "kind" | "status" | "prompt" | "createdAt"
  >[],
): QuestionRowView | null {
  const asked = questions.filter((question) => question.kind === "question");
  const open = asked.filter((question) => question.status === "open");
  if (open.length > 0) {
    const oldest = open.reduce((first, next) =>
      Date.parse(next.createdAt) < Date.parse(first.createdAt) ? next : first
    );
    return {
      kind: "open",
      count: open.length,
      lines: oldest.prompt.split(/\r?\n/).map((line) => line.trim()).filter(
        (line) => line !== "",
      ).slice(0, 2),
      askedAt: oldest.createdAt,
    };
  }
  const newest = asked.reduce<(typeof asked)[number] | null>(
    (latest, next) =>
      latest === null ||
        Date.parse(next.createdAt) > Date.parse(latest.createdAt)
        ? next
        : latest,
    null,
  );
  return newest?.status === "expired" ? { kind: "expired" } : null;
}
