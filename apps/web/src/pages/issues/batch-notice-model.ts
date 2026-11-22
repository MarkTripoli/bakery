import type { BatchResponse } from "../../api/client.ts";

/**
 * What the Issues page says about batches (#58, UX design 2b and its rulings):
 * a batch that is still live in a repository gets one line under the header,
 * and the issues it has taken or merged wear "In the batch". The page reads the
 * batches the server already serves; nothing here decides anything about one.
 */

/** A batch is live until it has finished or been stopped. */
export const LIVE_STATES = [
  "running",
  "waiting",
  "paused",
  "finishing",
  "stopping",
] as const;
export type LiveState = (typeof LIVE_STATES)[number];

function isLive(state: BatchResponse["state"]): state is LiveState {
  return (LIVE_STATES as readonly string[]).includes(state);
}

/** The batches the Issues page speaks of: every live one. A paused batch can still be working on an issue, and a live batch blocks a new one in its repository. */
export function liveBatches(
  batches: readonly BatchResponse[],
): BatchResponse[] {
  return batches.filter((batch) => isLive(batch.state));
}

/** How the notice describes the issue the batch is on, after "{done} of {max} merged". */
export type BatchNoticeTail =
  | "working"
  | "approval"
  | "question"
  | "choosing"
  | "none";

export type BatchNotice = {
  readonly batchId: string;
  readonly repositoryId: string;
  /** The batch's own state, which words the notice. */
  readonly state: LiveState;
  /** Issues merged so far, and the limit. */
  readonly done: number;
  readonly max: number;
  readonly tail: BatchNoticeTail;
  /** The issue's number in GitHub, when the batch has one started. */
  readonly number: string;
  /** Warning when a person is needed (a yes or an answer, or the next issue to start), information otherwise. */
  readonly tone: "information" | "warning";
};

/**
 * The one line for a live batch: "{done} of {max} merged", then the issue it is
 * working on, or the one that waits for an approval or an answer. A batch that
 * has no issue started says nothing more, except a running one, which is
 * choosing the next. A batch that asks before each next issue says so instead.
 */
export function noticeOf(
  batch: BatchResponse & { state: LiveState },
): BatchNotice {
  // A batch works on one issue at a time, so there is at most one started.
  const current = batch.issues.find((issue) => issue.state === "started");
  const number = current?.issueNumber ?? "";
  const tail: BatchNoticeTail = number === ""
    ? batch.state === "running" ? "choosing" : "none"
    : batch.waitingOn === null
    ? "working"
    : batch.waitingOn.kind;
  const personNeeded = batch.state === "waiting" ||
    (batch.state === "running" && batch.waitingOn !== null);
  return {
    batchId: batch.id,
    repositoryId: batch.repositoryId,
    state: batch.state,
    done: batch.issuesDone,
    max: batch.maxIssues,
    tail,
    number,
    tone: personNeeded ? "warning" : "information",
  };
}

/** The notices to show: those of the live batches in the repositories in view (all of them when none is chosen). */
export function noticesFor(
  batches: readonly BatchResponse[],
  repositoryId: string | null,
): BatchNotice[] {
  return liveBatches(batches)
    .filter((batch) =>
      repositoryId === null || batch.repositoryId === repositoryId
    )
    .map((batch) => noticeOf(batch as BatchResponse & { state: LiveState }));
}

/** The GitHub issues (by the id of Bakery's copy) that a live batch has taken: being worked on, or merged. */
export function issuesInBatch(
  batches: readonly BatchResponse[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const batch of liveBatches(batches)) {
    for (const issue of batch.issues) {
      if (issue.state === "started" || issue.state === "merged") {
        ids.add(issue.externalTicketId);
      }
    }
  }
  return ids;
}
