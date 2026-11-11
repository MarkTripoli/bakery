import { StandardError } from "@bakery/contracts/http";

/**
 * The independence rule for a review: the reviewer is a fresh session that the
 * server created for the review step, never one of the sessions that wrote the
 * candidate. The server cannot see what a model remembers, so the rule is about
 * identity and lineage it can check: the reported session is the review step's
 * own, it is not an implementing session of the run, it was not forked or
 * resumed from another session, and the review job carries no checkpoint a
 * worker could have resumed from. Same host and same agent definition are
 * allowed; the cycle records both principals so an auditor can see them.
 */

/** `VALIDATION_FAILED` reason when the reviewer is not independent. */
export const REVIEW_NOT_INDEPENDENT_REASON = "review_not_independent";

/** Which rule a refused reviewer broke; carried as `params.subReason`. */
export const REVIEW_INDEPENDENCE_VIOLATIONS = Object.freeze(
  [
    "session_unknown",
    "implementer_unknown",
    "session_is_implementer",
    "session_not_review_step",
    "session_has_parent",
    "session_resumed",
    "job_checkpoints",
  ] as const,
);
export type ReviewIndependenceViolation =
  typeof REVIEW_INDEPENDENCE_VIOLATIONS[number];

/**
 * The reviewer as the server stored it, looked up by the session id the report
 * named. Every field but `sessionId` comes from the `agent_sessions` row, not
 * from the report.
 */
export type ReviewerSession = {
  /** Session id the report named. */
  readonly sessionId: string;
  /** Run step that owns the session row, or null when no row has that id. */
  readonly runStepId: string | null;
  /** Session this one was forked from; null for a fresh session. */
  readonly parentSessionId: string | null;
  /** Handle this session was resumed from; null for a fresh session. */
  readonly resumeRef: string | null;
};

export type IndependenceInput = {
  readonly reviewer: ReviewerSession;
  /**
   * Session ids of every implementing (harness) step of the run. Never empty
   * for a real candidate: a review follows a completed implementing step, and
   * the cycle records the implementing session, so an empty list is refused.
   */
  readonly implementingSessions: readonly string[];
  /** The review step the job belongs to. */
  readonly reviewStepId: string;
  /** Checkpoints recorded for the review job; a fresh review has none. */
  readonly jobCheckpoints: number;
};

function refuse(subReason: ReviewIndependenceViolation): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason: REVIEW_NOT_INDEPENDENT_REASON, subReason },
  });
}

/** Ids compare case-insensitively, so letter case cannot hide a session. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Throws `VALIDATION_FAILED` with reason `review_not_independent` and a
 * sub-reason when the reviewer breaks a rule, and returns otherwise. The rules
 * run in this order, so a session that is both an implementer and not the
 * review step's own is reported as the implementer:
 *
 * 1. the id names a stored session (`session_unknown`);
 * 2. the run has at least one implementing session on record, and every entry
 *    of the list is a non-empty string (`implementer_unknown`): with none, or
 *    with an entry that is not a usable id, rule 3 could not fire for it, so the
 *    rule refuses rather than pass a reviewer it cannot compare. The list is read
 *    by index, so a sparse hole is an entry that is not a string;
 * 3. it is not an implementing session of the run (`session_is_implementer`);
 * 4. it belongs to the review step (`session_not_review_step`);
 * 5. it has no parent (`session_has_parent`);
 * 6. it was not resumed (`session_resumed`);
 * 7. the job has no checkpoints (`job_checkpoints`).
 *
 * Anything the input cannot prove fails closed: a value that is not what the
 * type promises is a violation, never a pass.
 */
export function assertIndependentReviewer(input: IndependenceInput): void {
  const { reviewer } = input;
  if (typeof reviewer.sessionId !== "string" || reviewer.sessionId === "") {
    refuse("session_unknown");
  }
  if (typeof reviewer.runStepId !== "string" || reviewer.runStepId === "") {
    refuse("session_unknown");
  }
  const { implementingSessions } = input;
  if (
    !Array.isArray(implementingSessions) || implementingSessions.length === 0
  ) {
    refuse("implementer_unknown");
  }
  // By index, not `some`/`every`: those skip the holes of a sparse array.
  for (let index = 0; index < implementingSessions.length; index++) {
    const id: unknown = implementingSessions[index];
    if (typeof id !== "string" || id === "") refuse("implementer_unknown");
  }
  if (implementingSessions.some((id) => sameId(id, reviewer.sessionId))) {
    refuse("session_is_implementer");
  }
  if (!sameId(reviewer.runStepId, input.reviewStepId)) {
    refuse("session_not_review_step");
  }
  if (reviewer.parentSessionId !== null) refuse("session_has_parent");
  if (reviewer.resumeRef !== null) refuse("session_resumed");
  if (input.jobCheckpoints !== 0) refuse("job_checkpoints");
}
