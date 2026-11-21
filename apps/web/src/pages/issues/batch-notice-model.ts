import type { BatchResponse } from "../../api/client.ts";

/**
 * What the Issues page says about batches (#58, UX design 2b): a batch that is
 * running in a repository gets one line under the header, and the issues it has
 * taken or merged wear "In the batch". The page reads the batches the server
 * already serves; nothing here decides anything about a batch.
 */

/** The batches the Issues page speaks of: the ones that are at work (not paused, waiting to be told, stopping or ended). */
export function runningBatches(
  batches: readonly BatchResponse[],
): BatchResponse[] {
  return batches.filter((batch) => batch.state === "running");
}

/** How the notice describes the issue the batch is on. */
export type BatchNoticeState = "working" | "approval" | "question" | "choosing";

export type BatchNotice = {
  readonly batchId: string;
  readonly repositoryId: string;
  /** Issues merged so far, and the limit. */
  readonly done: number;
  readonly max: number;
  readonly state: BatchNoticeState;
  /** The issue's number in GitHub, when the batch has one started. */
  readonly number: string;
};

/**
 * The one line for a running batch: "{done} of {max} merged", then the issue it
 * is working on, or the one that waits for an approval or an answer, or that it
 * is choosing the next. A batch works on one issue at a time, so there is at most one.
 */
export function noticeOf(batch: BatchResponse): BatchNotice {
  const current = batch.issues.find((issue) => issue.state === "started");
  const number = current?.issueNumber ?? "";
  const state: BatchNoticeState = number === ""
    ? "choosing"
    : batch.waitingOn === null
    ? "working"
    : batch.waitingOn.kind;
  return {
    batchId: batch.id,
    repositoryId: batch.repositoryId,
    done: batch.issuesDone,
    max: batch.maxIssues,
    state,
    number,
  };
}

/** The notices to show: those of the running batches in the repositories in view (all of them when none is chosen). */
export function noticesFor(
  batches: readonly BatchResponse[],
  repositoryId: string | null,
): BatchNotice[] {
  return runningBatches(batches)
    .filter((batch) =>
      repositoryId === null || batch.repositoryId === repositoryId
    )
    .map(noticeOf);
}

/** The GitHub issues (by the id of Bakery's copy) that a running batch has taken: being worked on, or merged. */
export function issuesInBatch(
  batches: readonly BatchResponse[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const batch of runningBatches(batches)) {
    for (const issue of batch.issues) {
      if (issue.state === "started" || issue.state === "merged") {
        ids.add(issue.externalTicketId);
      }
    }
  }
  return ids;
}
