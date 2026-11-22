import { commandFailure } from "../task-conversation/model.ts";

/**
 * Where a request to merge, or to check an unknown merge again, stands:
 * - `working`: sent, not answered yet;
 * - `conflict`: the pull request, review or checks changed (409/412), so the
 *   latest is shown;
 * - `inProgress`: another change is merging into the same branch;
 * - `baseMoved`: the branch it merges into changed;
 * - `notOpen`: the pull request is no longer open;
 * - `findingsBlocking`: the review has findings that block the merge;
 * - `checksNotPassed`: a required check has not passed (or has no result);
 * - `forbidden`: this person may not merge here;
 * - `error`: refused for another reason, nothing was started;
 * - `unreachable`: Bakery could not reach GitHub to check, so the outcome is
 *   still unknown;
 * - `notMerged`: a check settled the attempt as not merged, so a merge can be
 *   asked for again;
 * - `noAnswer`: the answer never arrived (a lost connection or a server error),
 *   so the merge may or may not have started. The page says so and reads back
 *   what Bakery recorded; it never says "nothing changed".
 */
export type MergePhase =
  | "idle"
  | "working"
  | "conflict"
  | "inProgress"
  | "baseMoved"
  | "notOpen"
  | "findingsBlocking"
  | "checksNotPassed"
  | "forbidden"
  | "error"
  | "unreachable"
  | "notMerged"
  | "noAnswer";

/** The rule slugs a refused merge request names (`problem.reason`). */
const REFUSAL_BY_REASON: Readonly<Record<string, MergePhase>> = {
  target_merge_in_progress: "inProgress",
  head_moved: "conflict",
  review_evidence_stale: "conflict",
  check_evidence_stale: "conflict",
  base_moved: "baseMoved",
  pull_request_not_open: "notOpen",
  review_findings_blocking: "findingsBlocking",
  checks_not_passed: "checksNotPassed",
  check_runs_missing: "checksNotPassed",
};

/**
 * How a refused or failed request to queue a merge reads. An answer that never
 * arrived is `noAnswer`; a conflict or failed precondition is told by its
 * reason, and one the page has no words for is the generic `error`.
 */
export function queueFailure(failure: {
  kind: string;
  problem?: {
    status: number;
    retryable: boolean;
    code?: string;
    reason?: string;
  };
}): MergePhase {
  const ended = commandFailure(failure);
  if (ended === "unknown") return "noAnswer";
  if (ended !== "conflict") return ended;
  const reason = failure.problem?.reason;
  return reason === undefined
    ? "error"
    : Object.hasOwn(REFUSAL_BY_REASON, reason)
    ? REFUSAL_BY_REASON[reason] ?? "error"
    : "error";
}
