import type { GitHubMergeMethod } from "../integrations/github-app.ts";

/**
 * Decides whether Bakery may send a merge for one pull request, from the live
 * provider read the caller took immediately before dispatching (#40, B10.04).
 * Only the candidate the caller names may merge: a head that moved, a base that
 * moved, a pull request that is no longer open, or a check that has not passed
 * refuses the merge. Nothing here talks to GitHub or writes anything.
 */

/** What the caller named when it asked for the merge. */
export type MergeRequest = {
  /** The head the caller verified; a pull request whose head moved is refused. */
  expectedHeadSha: string;
  /**
   * The base the caller verified, when it verified one. A base that moved since
   * refuses the merge: the checks it read belong to the old base.
   */
  expectedBaseSha: string | null;
  mergeMethod: GitHubMergeMethod;
};

/** The pull request as GitHub answers it right now. */
export type MergeObservation = {
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergedSha: string | null;
  /** Whether every check the request requires passed on the observed head. */
  checksPassed: boolean;
};

/** Why a merge was not sent. Each one is safe: nothing was dispatched. */
export type MergeRefusalReason =
  | "already_merged"
  | "not_open"
  | "head_moved"
  | "base_moved"
  | "checks_not_passed";

export type MergeDecision =
  /** Send exactly this merge; the observed facts are the candidate's. */
  | { kind: "dispatch"; headSha: string; baseSha: string }
  /**
   * Answer from the provider read alone: it already merged (with the commit
   * GitHub reports, when it reports one), so nothing is sent and the recorded
   * outcome is that merge.
   */
  | { kind: "already_merged"; mergedSha: string | null }
  | { kind: "refused"; reason: MergeRefusalReason };

/**
 * The order the checks run in is the order a person reads them: a finished
 * merge answers before anything else (a retried request is not a conflict), then
 * the pull request must still be open, then its head, then its base, then its
 * checks.
 */
export function decideMerge(
  request: MergeRequest,
  observed: MergeObservation,
): MergeDecision {
  if (observed.merged) {
    return { kind: "already_merged", mergedSha: observed.mergedSha };
  }
  if (observed.state !== "open") return { kind: "refused", reason: "not_open" };
  if (observed.headSha !== request.expectedHeadSha) {
    return { kind: "refused", reason: "head_moved" };
  }
  if (
    request.expectedBaseSha !== null &&
    observed.baseSha !== request.expectedBaseSha
  ) return { kind: "refused", reason: "base_moved" };
  if (!observed.checksPassed) {
    return { kind: "refused", reason: "checks_not_passed" };
  }
  return {
    kind: "dispatch",
    headSha: observed.headSha,
    baseSha: observed.baseSha,
  };
}

/**
 * The conclusions GitHub treats as a satisfied merge check: a passing run, and
 * the two "no objection" answers. Deliberately an allowlist: `startup_failure`,
 * `stale`, `timed_out`, `action_required` and any conclusion this build has
 * never seen all refuse the merge, because a merge box that cannot read a check
 * must not merge over it. `skipped` counts as satisfied, as GitHub's own merge
 * box treats it.
 */
const PASSING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "neutral",
  "skipped",
]);

/**
 * The GitHub check-run state a merge needs: at least one run, every run
 * completed, and every conclusion in the allowlist. A commit with no checks at
 * all is not proven and is not ready.
 */
export function checksPassed(
  runs: readonly { status: string; conclusion: string | null }[],
): boolean {
  if (runs.length === 0) return false;
  return runs.every((run) =>
    run.status === "completed" &&
    run.conclusion !== null &&
    PASSING_CHECK_CONCLUSIONS.has(run.conclusion)
  );
}
