import type { HumanApprovalDecision } from "@bakery/contracts/human-approval";

/**
 * The rules a `human.approval` step applies, kept pure so the decisions they
 * encode can be read, tested and changed without a database in the way.
 *
 * Three rules live here, and each one exists because the obvious alternative
 * quietly changes who is in charge:
 *
 * 1. The approver is the workflow's owner. `workflow_versions.created_by` is an
 *    editor, so resolving the approver from it would make whoever last saved the
 *    workflow the person who must approve its runs. When there is no owner the
 *    answer is a named refusal - never "any organization admin", which is a
 *    widening nobody asked for and which nobody would notice.
 * 2. Every ending has a name. A rejection, a stop and an expiry are three
 *    different things, and a single "stopped" or a bare "failed" collapses the
 *    reason a person reading the run needs.
 * 3. A wait is not work. The active clock is wall time minus the time a run
 *    spent waiting for a person, so a seven-day approval does not consume the
 *    loop's budget and stop it as if it had worked for seven days.
 */

/**
 * Refusal raised when a human.approval step has no one to ask. The name is the
 * contract: it says which check failed, so an operator reads the cause instead
 * of guessing at a generic permission error.
 */
export const NO_RESOLVABLE_APPROVER = "no-resolvable-approver";

/** What resolves as the approver of one approval step. */
export type ApprovalResolution =
  | Readonly<{ resolved: true; approverPrincipalIds: readonly string[] }>
  | Readonly<{ resolved: false; refusal: typeof NO_RESOLVABLE_APPROVER }>;

/**
 * Decide who may answer one approval step.
 *
 * `audience` is the step's explicit list, which wins because an author who named
 * people meant those people. With no audience the workflow's owner is the
 * default approver, which is the design's stated default. With neither, the step
 * cannot be answered by anybody and waiting on it would only end in an expiry
 * seven days later - so it is refused now, by name.
 *
 * Deliberately absent: any fallback to an organization administrator, and any
 * use of a version's author. Both would answer "who approves this?" with someone
 * the workflow never named.
 */
export function resolveApprover(input: {
  readonly audience: readonly string[] | undefined;
  readonly ownerPrincipalId: string | null;
  /**
   * Audience entries that are real principals in this organization.
   *
   * An audience is text the caller supplied, so an entry may name a group, a
   * role or a typo. Only an entry that resolves to an actual principal can
   * answer, and the check happens against the database rather than by trusting
   * the shape of the string.
   */
  readonly principals?: ReadonlySet<string>;
}): ApprovalResolution {
  const audience = input.audience ?? [];
  if (audience.length > 0) {
    // Every audience entry that names a real principal may answer. Keeping the
    // whole list matters: naming only the first would silently drop everyone
    // else the workflow asked, and those people would find they cannot answer
    // an approval that was addressed to them.
    const resolvable = audience.filter((entry) =>
      input.principals === undefined || input.principals.has(entry)
    );
    if (resolvable.length === 0) {
      // A named audience nobody belongs to is not an approval waiting to be
      // answered; it is one that can only expire. Refuse it now and say so.
      return { resolved: false, refusal: NO_RESOLVABLE_APPROVER };
    }
    return { resolved: true, approverPrincipalIds: resolvable };
  }
  if (input.ownerPrincipalId !== null) {
    return {
      resolved: true,
      approverPrincipalIds: [input.ownerPrincipalId],
    };
  }
  return { resolved: false, refusal: NO_RESOLVABLE_APPROVER };
}

/**
 * Named outcomes a run can end with. These are stored in
 * `workflow_runs.outcome` and are what a caller or a later step branches on, so
 * they are values rather than sentences.
 */
export const APPROVED_OUTCOME = "approved";
export const CHANGES_REQUESTED_OUTCOME = "changes_requested";
export const REJECTED_OUTCOME = "rejected";
export const APPROVAL_EXPIRED_OUTCOME = "approval_expired";

/**
 * The outcome a decision produces.
 *
 * Approving continues the run rather than ending it, so it has no terminal
 * outcome and reports null: the caller keeps going. The other two end the run
 * with different names, because "the reviewer wants changes" and "the reviewer
 * said no" call for different next steps and a single name would lose that.
 */
export function outcomeForDecision(
  decision: HumanApprovalDecision,
): string | null {
  switch (decision) {
    case "approve":
      return null;
    case "request_changes":
      return CHANGES_REQUESTED_OUTCOME;
    case "reject":
      return REJECTED_OUTCOME;
  }
}

/**
 * One interval a run spent waiting for a person. `endedAt` null means the wait
 * is still open, which is the state that must be excluded while it is happening
 * rather than only once it is over.
 */
export type RunWait = Readonly<{
  startedAt: Date;
  endedAt: Date | null;
}>;

/**
 * Active elapsed time: the wall-clock span minus every wait inside it.
 *
 * An open wait counts up to `now`, so a run that is waiting right now is not
 * charged for the wait it is currently in the middle of. Waits that fall outside
 * the measured span are ignored, and the result never goes below zero, so
 * overlapping or misordered rows cannot make a run appear to have spent negative
 * time.
 */
export function activeElapsedMs(input: {
  readonly wallElapsedMs: number;
  readonly waits: readonly RunWait[];
  readonly now: Date;
}): number {
  let waitedMs = 0;
  for (const wait of input.waits) {
    const end = wait.endedAt ?? input.now;
    const duration = end.getTime() - wait.startedAt.getTime();
    if (duration > 0) waitedMs += duration;
  }
  const active = input.wallElapsedMs - waitedMs;
  return active > 0 ? active : 0;
}

/**
 * Whether a wait has run past the seven-day limit and must end as an expiry.
 *
 * Expiry is its own named ending, not a failure: nothing went wrong, the person
 * simply did not answer in the time the workflow allowed, and a reader of the
 * run needs to be able to tell those two apart.
 */
export function approvalExpired(input: {
  readonly startedAt: Date;
  readonly now: Date;
  readonly limitMs: number;
}): boolean {
  return input.now.getTime() - input.startedAt.getTime() >= input.limitMs;
}
