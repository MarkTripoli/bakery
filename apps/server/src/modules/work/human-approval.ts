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
 * The step key a `human.approval` step uses when its definition names none.
 *
 * Kept here rather than inline at each call site so the writer that opens the
 * wait and any reader that must resolve it agree on one value.
 */
export const HUMAN_APPROVAL_STEP_KEY = "human.approval";

/**
 * Refusal raised when a human.approval step has no one to ask. The name is the
 * contract: it says which check failed, so an operator reads the cause instead
 * of guessing at a generic permission error.
 */
export const NO_RESOLVABLE_APPROVER = "no-resolvable-approver";

/** What resolves as the approver of one approval step. */
export type ApprovalResolution =
  | Readonly<{
    resolved: true;
    approverPrincipalIds: readonly string[];
    fallback?: true;
  }>
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
    if (resolvable.length > 0) {
      return { resolved: true, approverPrincipalIds: resolvable };
    }
    const owner = resolveApprover({
      audience: undefined,
      ownerPrincipalId: input.ownerPrincipalId,
      ...(input.principals === undefined
        ? {}
        : { principals: input.principals }),
    });
    return owner.resolved ? { ...owner, fallback: true } : owner;
  }
  if (input.ownerPrincipalId !== null) {
    // The owner is a candidate like any other, so the same membership check
    // applies. Accepting the id because it was supplied would let a run that
    // has an owner who cannot answer here sit until its wait expired, and a
    // reader could not tell that apart from one waiting on a real person.
    const ownerResolvable = input.principals === undefined ||
      input.principals.has(input.ownerPrincipalId);
    if (!ownerResolvable) {
      return { resolved: false, refusal: NO_RESOLVABLE_APPROVER };
    }
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
  /**
   * When the measured span began. Waits that started before it are clipped to
   * it rather than counted whole, so a wait from an earlier span cannot be
   * charged against this one.
   */
  readonly spanStartedAt?: Date;
}): number {
  // The span the wall clock measures: [spanStart, now]. Anything outside it is
  // not time this run spent, either waiting or working.
  const spanEndMs = input.now.getTime();
  const spanStartMs = input.spanStartedAt?.getTime() ??
    (spanEndMs - input.wallElapsedMs);

  // Clip each wait to the span and drop the empty ones, then merge the result
  // so overlapping waits are subtracted once. Summing raw intervals would
  // double-subtract two waits that overlapped, making the run look shorter than
  // the time it actually worked.
  const clipped: { start: number; end: number }[] = [];
  for (const wait of input.waits) {
    const start = Math.max(wait.startedAt.getTime(), spanStartMs);
    const end = Math.min((wait.endedAt ?? input.now).getTime(), spanEndMs);
    if (end > start) clipped.push({ start, end });
  }
  clipped.sort((a, b) => a.start - b.start);

  let waitedMs = 0;
  let current: { start: number; end: number } | null = null;
  for (const interval of clipped) {
    if (current === null) {
      current = { ...interval };
      continue;
    }
    if (interval.start <= current.end) {
      // Overlapping or touching: extend rather than add a second time.
      current.end = Math.max(current.end, interval.end);
      continue;
    }
    waitedMs += current.end - current.start;
    current = { ...interval };
  }
  if (current !== null) waitedMs += current.end - current.start;

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
