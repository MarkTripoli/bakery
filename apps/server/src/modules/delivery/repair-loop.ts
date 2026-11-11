import {
  CHECK_REASON_RESULTS,
  type CheckReason,
  type CheckResult,
} from "@bakery/contracts/check-evidence";
import { REPOSITORY_RULE_MODES } from "@bakery/contracts/repository-rules";
import {
  DELIVERY_REASON_DECISIONS,
  type DeliveryDecisionKind,
  type DeliveryDecisionReason,
  isBlockingSeverity,
  isDeliveryDecision,
  isReviewSeverity,
  REVIEW_LOOP_LIMITS,
  type ReviewSeverity,
} from "@bakery/contracts/review-evidence";
import {
  type CandidateChecksVerdict,
  REQUIREMENT_STATUSES,
  type RequirementEvaluation,
} from "./verdict.ts";

/**
 * The bounded delivery decision (issue #94): after a review, say whether the
 * candidate proceeds, goes back for repair, or stops the run. Pure and total:
 * the same facts always give the same answer, nothing here reads a database or
 * a clock, and an input that is not what the types promise throws a plain
 * error instead of guessing. No path approves a candidate that has a blocking
 * requirement or a blocking finding; `proceed` needs both to be clean.
 *
 * The caller (the review finalizer) supplies every fact, each from stored rows:
 * the check verdict, the facts of the check runs behind it, the review it just
 * recorded, the decisions already recorded for the run, the frozen limits, the
 * time since the first review on the database clock, and the run's budget.
 */

/** A check run's own facts, which the verdict does not carry. */
export type DecisionCheckFact = {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly result: CheckResult;
  readonly reason: CheckReason;
  readonly exitCode: number | null;
  /** Digest of the captured output; null when none was captured. */
  readonly outputDigest: string | null;
  /** Evidence artifact version of the row; null when none was published. */
  readonly evidenceVersionId: string | null;
};

/**
 * A required check that ran and did not pass, with the facts the repair step
 * and the next decision need. The first five fields are the repair input's
 * `FailedCheck`; the digest and evidence version are what a later decision
 * compares and what an auditor opens.
 */
export type DecisionFailedCheck = {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly result: "failed";
  readonly reason: Exclude<CheckReason, "verified">;
  readonly exitCode: number | null;
  readonly outputDigest: string | null;
  readonly evidenceVersionId: string | null;
};

/** The two review outcomes the server writes. */
export const DECISION_REVIEW_STATUSES = Object.freeze(
  ["approved", "changes_requested"] as const,
);
export type DecisionReviewStatus = typeof DECISION_REVIEW_STATUSES[number];

/** One finding of the review, reduced to what the decision reads. */
export type DecisionFinding = {
  /** 64 lowercase hex characters. */
  readonly fingerprint: string;
  readonly severity: ReviewSeverity;
};

/**
 * The review just recorded. `status` is `approved` exactly when no finding
 * blocks; the function refuses a review where the two disagree, so an
 * approval can never cover a blocker.
 */
export type DecisionReview = {
  readonly status: DecisionReviewStatus;
  readonly findings: readonly DecisionFinding[];
};

/** One decision already recorded for the run. */
export type PriorDecision = {
  /** Position of the decision in the run, from 0; unique per run. */
  readonly ordinal: number;
  readonly decision: DeliveryDecisionKind;
  /** Fingerprints of the blocking findings of that decision's review. */
  readonly blockingFingerprints: readonly string[];
  /** Required checks that failed on that decision's candidate. */
  readonly failedChecks: ReadonlyArray<{
    readonly checkId: string;
    readonly outputDigest: string | null;
  }>;
};

/** The frozen bounds the decision reads. */
export type DecisionLimits = {
  /** Repairs the run may use; 0 to the contract ceiling. */
  readonly maxRepairCycles: number;
  /** Milliseconds from the first review after which no repair starts. */
  readonly maxLoopDurationMs: number;
};

/**
 * What the run can still spend, as decimal USD strings (`"12.50"`, no
 * exponent, no float): `remainingUsd` is the unreserved headroom and
 * `nextCycleUsd` what one more repair and review would reserve.
 */
export type DecisionBudget = {
  readonly remainingUsd: string;
  readonly nextCycleUsd: string;
};

export type DeliveryDecisionInput = {
  /** #83 verdict for the candidate: current required checks against its rows. */
  readonly verdict: CandidateChecksVerdict;
  /**
   * Facts of the check runs the verdict named (`rowId`); extra rows are
   * ignored. The verdict keeps a row that did not pass as `failed` whether or
   * not the candidate has moved, so the caller must pass the rows it read for
   * the candidate under review.
   */
  readonly checkFacts: readonly DecisionCheckFact[];
  readonly review: DecisionReview;
  /** Decisions already recorded for this run, in any order. */
  readonly priorDecisions: readonly PriorDecision[];
  readonly limits: DecisionLimits;
  /** Milliseconds since the first review was recorded; database clock. */
  readonly elapsedMs: number;
  /** Null when the run has no budget to bound. */
  readonly budget: DecisionBudget | null;
};

export type DeliveryDecisionResult = {
  readonly decision: DeliveryDecisionKind;
  /** The reason; it always belongs to `decision` (see DELIVERY_REASON_DECISIONS). */
  readonly reason: DeliveryDecisionReason;
  /**
   * Blocking required checks that failed on this candidate, in requirement
   * order. These are the only checks a repair receives. Empty when the policy
   * is missing.
   */
  readonly failedChecks: readonly DecisionFailedCheck[];
  /** Fingerprints of the review's blocking findings, in review order. */
  readonly blockingFingerprints: readonly string[];
  /**
   * What repeated from the previous decision. Filled only for reason
   * `repeated_blocker`; empty otherwise.
   */
  readonly repeated: {
    readonly fingerprints: readonly string[];
    readonly checkIds: readonly string[];
  };
};

/** A fingerprint or an output digest: 64 lowercase hex characters. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(-?)(\d{1,30})(?:\.(\d{1,30}))?$/;

function invalid(what: string): never {
  throw new Error(`DELIVERY_DECISION_INPUT_INVALID:${what}`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

type Decimal = {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
};

function parseDecimal(value: unknown, name: string): Decimal {
  const match = typeof value === "string" ? DECIMAL_PATTERN.exec(value) : null;
  if (match === null) invalid(`${name}_not_decimal`);
  return {
    negative: match[1] === "-",
    whole: match[2],
    fraction: match[3] ?? "",
  };
}

/**
 * Compares two decimal USD amounts exactly. Both are scaled to the same number
 * of fractional digits and compared as integers, so no value is ever rounded:
 * `"0.10"` equals `"0.1"`, and two amounts a float cannot tell apart differ.
 */
function compareDecimals(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.fraction.length, b.fraction.length);
  const scaled = (value: Decimal): bigint => {
    const magnitude = BigInt(value.whole + value.fraction.padEnd(scale, "0"));
    return value.negative ? -magnitude : magnitude;
  };
  const left = scaled(a);
  const right = scaled(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFailureReason(
  reason: CheckReason,
): reason is Exclude<CheckReason, "verified"> {
  return CHECK_REASON_RESULTS[reason] === "failed";
}

function lowercaseFingerprint(fingerprint: unknown, name: string): string {
  if (typeof fingerprint !== "string" || !HEX64_PATTERN.test(fingerprint)) {
    invalid(`${name}_fingerprint`);
  }
  return fingerprint;
}

function validateLimits(limits: DecisionLimits): void {
  if (
    !isNonNegativeInteger(limits.maxRepairCycles) ||
    limits.maxRepairCycles > REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling
  ) invalid("max_repair_cycles");
  if (!isNonNegativeInteger(limits.maxLoopDurationMs)) {
    invalid("max_loop_duration");
  }
}

/** Blocking fingerprints of the review, after proving the review coherent. */
function blockingFingerprintsOf(review: DecisionReview): string[] {
  if (
    !(DECISION_REVIEW_STATUSES as readonly string[]).includes(review.status)
  ) {
    invalid("review_status");
  }
  const seen = new Set<string>();
  const blocking: string[] = [];
  for (const finding of review.findings) {
    const fingerprint = lowercaseFingerprint(finding.fingerprint, "finding");
    if (!isReviewSeverity(finding.severity)) invalid("finding_severity");
    if (seen.has(fingerprint)) invalid("finding_fingerprint_duplicate");
    seen.add(fingerprint);
    if (isBlockingSeverity(finding.severity)) blocking.push(fingerprint);
  }
  if ((review.status === "approved") !== (blocking.length === 0)) {
    invalid("review_status_disagrees_with_findings");
  }
  return blocking;
}

/**
 * Copies the verdict's evaluations once, by index, into plain data the rest of
 * the decision reads. `forEach`, `filter` and `map` skip the holes of a sparse
 * array, and a getter can answer differently each time it is read, so a
 * hand-built verdict could otherwise validate one thing and decide on another.
 * A hole, a non-object entry or an entry without a requirement object is
 * refused. `Array.from` visits every index from 0 to `length - 1` and reads each
 * one exactly once.
 */
function snapshotEvaluations(list: unknown): RequirementEvaluation[] {
  if (!Array.isArray(list)) invalid("evaluations");
  return Array.from(list as readonly unknown[], (entry) => {
    if (entry === null || typeof entry !== "object") {
      invalid("evaluation_entry");
    }
    const evaluation = entry as RequirementEvaluation;
    const requirement: unknown = evaluation.requirement;
    if (requirement === null || typeof requirement !== "object") {
      invalid("evaluation_requirement");
    }
    return {
      requirement: { ...(requirement as RequirementEvaluation["requirement"]) },
      status: evaluation.status,
      reason: evaluation.reason,
      blocking: evaluation.blocking,
      rowId: evaluation.rowId,
      changed: evaluation.changed,
    };
  });
}

/**
 * The supplied `blocking` flag is a claim, not a fact: it is recomputed the way
 * the #83 verdict defines it (`evaluateCandidateChecks`), blocking when the
 * requirement's mode is `require` and its status is not `passed`, and any
 * disagreement is refused. A hand-built verdict that marks a failed, missing,
 * stale or unavailable required check as non-blocking therefore cannot reach
 * the `clean` row.
 */
function validateEvaluation(evaluation: RequirementEvaluation): void {
  // Closed sets first: the blocking recomputation below reads both values, and
  // an unknown mode or status would otherwise read as non-blocking by default.
  if (
    !(REPOSITORY_RULE_MODES as readonly unknown[]).includes(
      evaluation.requirement.mode,
    )
  ) invalid("evaluation_mode");
  if (
    !(REQUIREMENT_STATUSES as readonly unknown[]).includes(evaluation.status)
  ) invalid("evaluation_status");
  if (
    evaluation.blocking &&
    (evaluation.status === "passed" || evaluation.status === "not_blocking")
  ) invalid("evaluation_blocking_status");
  const blocking = evaluation.requirement.mode === "require" &&
    evaluation.status !== "passed";
  if (evaluation.blocking !== blocking) invalid("evaluation_blocking_mismatch");
}

function failedCheckOf(
  evaluation: RequirementEvaluation,
  facts: ReadonlyMap<string, DecisionCheckFact>,
): DecisionFailedCheck {
  const fact = evaluation.rowId === null
    ? undefined
    : facts.get(evaluation.rowId);
  if (fact === undefined) invalid("failed_check_fact_missing");
  if (
    fact.checkId !== evaluation.requirement.checkId ||
    fact.result !== "failed" ||
    !isFailureReason(fact.reason)
  ) invalid("failed_check_fact_disagrees");
  if (
    fact.exitCode !== null &&
    !(Number.isSafeInteger(fact.exitCode) && fact.exitCode >= 0 &&
      fact.exitCode <= 255)
  ) invalid("failed_check_exit_code");
  if (fact.outputDigest !== null && !HEX64_PATTERN.test(fact.outputDigest)) {
    invalid("failed_check_output_digest");
  }
  return {
    checkRunId: fact.checkRunId,
    checkId: fact.checkId,
    result: "failed",
    reason: fact.reason,
    exitCode: fact.exitCode,
    outputDigest: fact.outputDigest,
    evidenceVersionId: fact.evidenceVersionId,
  };
}

/** The decision recorded last, or null when there is none. */
function previousDecision(
  priors: readonly PriorDecision[],
): PriorDecision | null {
  const ordinals = new Set<number>();
  let previous: PriorDecision | null = null;
  for (const prior of priors) {
    if (!isNonNegativeInteger(prior.ordinal) || ordinals.has(prior.ordinal)) {
      invalid("prior_ordinal");
    }
    ordinals.add(prior.ordinal);
    if (!isDeliveryDecision(prior.decision)) invalid("prior_decision");
    for (const fingerprint of prior.blockingFingerprints) {
      lowercaseFingerprint(fingerprint, "prior");
    }
    for (const check of prior.failedChecks) {
      if (typeof check.checkId !== "string" || check.checkId === "") {
        invalid("prior_check_id");
      }
      if (
        check.outputDigest !== null && !HEX64_PATTERN.test(check.outputDigest)
      ) {
        invalid("prior_output_digest");
      }
    }
    if (previous === null || prior.ordinal > previous.ordinal) previous = prior;
  }
  return previous;
}

const NO_REPEAT = Object.freeze({
  fingerprints: Object.freeze([]) as readonly string[],
  checkIds: Object.freeze([]) as readonly string[],
});

/**
 * Decides what happens to a reviewed candidate. The nine rows below are
 * evaluated in order and the first match wins, so an earlier row always
 * outranks a later one:
 *
 * 1. no check requirement at all -> stop, `policy_missing`;
 * 2. a blocking requirement is `stale` or `missing` (a pending row is missing)
 *    -> stop, `stale_evidence`;
 * 3. a blocking requirement is `unavailable` (a canceled row is unavailable)
 *    -> stop, `checks_unavailable`;
 * 4. no blocking requirement and no blocking finding -> proceed, `clean`;
 * 5. a blocking fingerprint also blocked the immediately preceding decision, or
 *    a failed check has the same check id and the same output digest as in it
 *    -> stop, `repeated_blocker`;
 * 6. repairs already used >= `maxRepairCycles` -> stop,
 *    `repair_cycles_exhausted`;
 * 7. `elapsedMs` >= `maxLoopDurationMs` -> stop, `repair_time_exhausted`;
 * 8. a budget is set and `remainingUsd` < `nextCycleUsd` -> stop,
 *    `repair_budget_exhausted`;
 * 9. otherwise -> repair, `repair_selected`.
 *
 * Only a `failed` result is repairable: unavailable, canceled, pending,
 * missing and stale evidence never repairs, because a repair cannot supply a
 * missing tool or a missing run. A `warn` or `guide` requirement never blocks,
 * and findings below `major` never block. A failed check whose output digest
 * is null cannot be shown to repeat, so it never trips row 5; the cycle, time
 * and budget rows still bound the loop.
 *
 * Throws a plain error for an input the types do not allow: an incoherent
 * review or verdict (including an evaluation whose mode is not guide, warn or
 * require, whose status is not a known verdict status, or whose `blocking` flag
 * differs from its mode and status), an evaluation list with a hole, a
 * non-object entry or a non-array value, a missing or disagreeing check fact, a malformed
 * fingerprint, digest or decimal, a negative elapsed time or a repeated
 * ordinal. It never returns a guess.
 */
export function decideDelivery(
  input: DeliveryDecisionInput,
): DeliveryDecisionResult {
  validateLimits(input.limits);
  if (
    typeof input.elapsedMs !== "number" || !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0
  ) invalid("elapsed_ms");
  const budget = input.budget === null ? null : {
    remaining: parseDecimal(input.budget.remainingUsd, "remaining_usd"),
    next: parseDecimal(input.budget.nextCycleUsd, "next_cycle_usd"),
  };
  if (budget !== null && budget.next.negative) {
    invalid("next_cycle_usd_negative");
  }
  const blockingFingerprints = blockingFingerprintsOf(input.review);
  const previous = previousDecision(input.priorDecisions);
  const result = (
    reason: DeliveryDecisionReason,
    failedChecks: readonly DecisionFailedCheck[],
    repeated = NO_REPEAT,
  ): DeliveryDecisionResult => ({
    decision: DELIVERY_REASON_DECISIONS[reason],
    reason,
    failedChecks,
    blockingFingerprints,
    repeated,
  });

  const { verdict } = input;
  // Each verdict field is read once; the evaluations are copied once, by index.
  const verdictReason = verdict.reason;
  const verdictBlocked = verdict.blocked;
  const evaluations = snapshotEvaluations(verdict.evaluations);
  // Row 1. An empty requirement list is a missing policy, never "all clear";
  // a verdict that says nothing was required fails closed the same way.
  if (verdictReason === "policy_missing" || evaluations.length === 0) {
    return result("policy_missing", []);
  }
  for (let index = 0; index < evaluations.length; index++) {
    validateEvaluation(evaluations[index]);
  }
  const blocking = evaluations.filter(({ blocking: isBlocking }) => isBlocking);
  if (verdictBlocked !== (blocking.length > 0)) {
    invalid("verdict_blocked_disagrees");
  }
  const facts = new Map<string, DecisionCheckFact>();
  for (const fact of input.checkFacts) {
    if (facts.has(fact.checkRunId)) invalid("check_fact_duplicate");
    facts.set(fact.checkRunId, fact);
  }
  const failedChecks = blocking.filter(({ status }) => status === "failed")
    .map((evaluation) => failedCheckOf(evaluation, facts));

  // Rows 2 and 3.
  if (
    blocking.some(({ status }) => status === "stale" || status === "missing")
  ) {
    return result("stale_evidence", failedChecks);
  }
  if (blocking.some(({ status }) => status === "unavailable")) {
    return result("checks_unavailable", failedChecks);
  }
  // Row 4. Every blocking requirement left is a failed one.
  if (blocking.length === 0 && blockingFingerprints.length === 0) {
    return result("clean", failedChecks);
  }
  // Row 5.
  if (previous !== null) {
    const earlier = new Set(previous.blockingFingerprints);
    const fingerprints = blockingFingerprints.filter((fingerprint) =>
      earlier.has(fingerprint)
    );
    const checkIds = failedChecks.filter((check) =>
      check.outputDigest !== null &&
      previous.failedChecks.some((prior) =>
        prior.checkId === check.checkId &&
        prior.outputDigest === check.outputDigest
      )
    ).map(({ checkId }) => checkId);
    if (fingerprints.length > 0 || checkIds.length > 0) {
      return result("repeated_blocker", failedChecks, {
        fingerprints,
        checkIds,
      });
    }
  }
  // Row 6.
  const repairsUsed =
    input.priorDecisions.filter(({ decision }) => decision === "repair").length;
  if (repairsUsed >= input.limits.maxRepairCycles) {
    return result("repair_cycles_exhausted", failedChecks);
  }
  // Row 7.
  if (input.elapsedMs >= input.limits.maxLoopDurationMs) {
    return result("repair_time_exhausted", failedChecks);
  }
  // Row 8.
  if (budget !== null && compareDecimals(budget.remaining, budget.next) < 0) {
    return result("repair_budget_exhausted", failedChecks);
  }
  // Row 9.
  return result("repair_selected", failedChecks);
}
