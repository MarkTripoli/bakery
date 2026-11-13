import { effectiveApprovalPolicy } from "../work/stage-policy.ts";
import {
  type CheckReason,
  type CheckResult,
  isCheckReason,
  isCheckResult,
} from "@bakery/contracts/check-evidence";
import { StandardError } from "@bakery/contracts/http";
import { candidateHeadSha } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { DecisionCheckFact } from "./repair-loop.ts";
import type { CandidateIdentity } from "./identity.ts";
import { commandSubjects } from "./check-pins.ts";
import { deriveReviewPins, type ReviewPins } from "./review-pins.ts";
import {
  loadStepOutputs,
  readCycleJobInput,
  readLatestCycleAtHead,
  readLatestDecision,
  type StoredCycle,
  type StoredDecision,
} from "./review-store.ts";
import { evaluateDeliveryChecks } from "./service.ts";
import type {
  CandidateChecksVerdict,
  CheckRequirement,
  RequirementEvaluation,
} from "./verdict.ts";

/**
 * The delivery gate for a run's candidate (issue #94): whether the candidate
 * may merge, answered only from stored facts. A merge consumer (#97) calls
 * `assertDeliveryCandidateMergeable` right before it acts. Nothing here records,
 * edits or runs anything, and nothing is cached: every call reads the rows as
 * they are now.
 */

/** `STATE_CONFLICT` reason when the candidate may not merge. */
export const DELIVERY_CANDIDATE_BLOCKED_REASON = "delivery_candidate_blocked";

/** Why a candidate may not merge; `decision_stop` carries the stop reason. */
export const DELIVERY_BLOCKED_REASONS = Object.freeze(
  [
    "no_decision",
    "decision_stop",
    "decision_repair_pending",
    "candidate_moved",
    "checks_blocked",
    "review_missing",
  ] as const,
);
export type DeliveryBlockedReason = typeof DELIVERY_BLOCKED_REASONS[number];

export type DeliveryCandidateEvaluation = {
  /** True unless every condition below holds; the only field to branch on. */
  readonly mergeBlocked: boolean;
  /**
   * Each condition that blocks, in a stable order. A stopped loop reads
   * `decision_stop:<reason>`; every other entry is a bare reason code.
   */
  readonly reasons: readonly string[];
  /** The candidate as the run stands now; null while no harness step reported. */
  readonly candidate: { readonly headSha: string } | null;
  /** Required checks judged against that head now; null when not evaluated. */
  readonly checks: CandidateChecksVerdict | null;
  /** The newest review cycle of that head; null when none exists. */
  readonly review: StoredCycle | null;
  /** The decision that governs delivery: the run's latest. */
  readonly decision: StoredDecision | null;
};

type CheckFactRow = {
  id: string;
  check_id: string;
  result: string;
  reason: string;
  exit_code: number | null;
  output_digest: string | null;
  evidence_version_id: string | null;
  head_sha: string;
};

/** The requirements a pinned policy places on a candidate: its fixed commands. */
export function pinnedRequirements(
  pins: Pick<ReviewPins, "decisions">,
): CheckRequirement[] {
  return pins.decisions.map((decision) => ({
    kind: "command",
    checkId: decision.commandId,
    mode: decision.mode,
  }));
}

/**
 * The candidate's identity as the pins state it. A run has no pull request, so
 * the metadata digests are null: only the command checks are bound to them.
 */
export function pinnedIdentity(pins: ReviewPins): CandidateIdentity {
  return {
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    profileDigest: pins.profileDigest,
    checkerDigest: pins.checkerDigest,
    subjects: commandSubjects(pins),
    titleDigest: null,
    bodyDigest: null,
    mergeMessageDigest: null,
    commitSelectionDigest: null,
  };
}

/**
 * A row that did not pass keeps its own status in the #83 verdict whatever head
 * it judged, so a failed or unavailable row of an earlier head would read as a
 * failure of this candidate. It says nothing about this head: the check for it
 * has not been recorded. Such an evaluation is relabelled `stale` (the head
 * part changed), so the decision stops on stale evidence instead of repairing
 * what was a different commit.
 */
function relabelMovedRows(
  verdict: CandidateChecksVerdict,
  headByRow: ReadonlyMap<string, string>,
  headSha: string,
): CandidateChecksVerdict {
  const evaluations = verdict.evaluations.map(
    (evaluation): RequirementEvaluation => {
      const rowHead = evaluation.rowId === null
        ? undefined
        : headByRow.get(evaluation.rowId);
      if (
        rowHead === undefined || rowHead === headSha ||
        (evaluation.status !== "failed" && evaluation.status !== "unavailable")
      ) return evaluation;
      return {
        ...evaluation,
        status: "stale",
        reason: "stale",
        blocking: evaluation.requirement.mode === "require",
        changed: ["head"],
      };
    },
  );
  const blockedChecks = evaluations.filter(({ blocking }) => blocking);
  return {
    ...verdict,
    evaluations,
    blockedChecks,
    blocked: verdict.reason === "policy_missing" || blockedChecks.length > 0,
  };
}

/**
 * Judges the required checks of a pinned policy against the head the pins
 * name, with the facts of the rows behind the verdict. It calls
 * `evaluateDeliveryChecks`, the one #83 entry point, then reads the facts of
 * exactly the rows that verdict named, scoped to the run and organization. The
 * facts include each row's head, which is how an earlier head's row is told
 * from the candidate's own (see `relabelMovedRows`).
 */
export async function evaluateReviewedChecks(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly pins: ReviewPins;
  },
): Promise<
  {
    readonly verdict: CandidateChecksVerdict;
    readonly facts: DecisionCheckFact[];
  }
> {
  const { organizationId, runId, pins } = input;
  const read = await evaluateDeliveryChecks(transaction, {
    organizationId,
    runId,
    current: pinnedIdentity(pins),
    requirements: pinnedRequirements(pins),
  });
  const rowIds = read.evaluations.flatMap(({ rowId }) =>
    rowId === null ? [] : [rowId]
  );
  const rows = rowIds.length === 0
    ? []
    : (await transaction.query<CheckFactRow>(
      `select id, check_id, result, reason, exit_code, output_digest,
              evidence_version_id, head_sha
         from bakery.check_runs
        where organization_id = $1 and run_id = $2 and id = any($3::uuid[])`,
      [organizationId, runId, rowIds],
    )).rows;
  const verdict = relabelMovedRows(
    read,
    new Map(rows.map((row) => [row.id, row.head_sha])),
    pins.headSha,
  );
  const facts = rows.map((row): DecisionCheckFact => {
    if (!isCheckResult(row.result) || !isCheckReason(row.reason)) {
      throw new Error("DELIVERY_READ_CHECK_RUN_INVALID");
    }
    return {
      checkRunId: row.id,
      checkId: row.check_id,
      result: row.result as CheckResult,
      reason: row.reason as CheckReason,
      exitCode: row.exit_code,
      outputDigest: row.output_digest,
      evidenceVersionId: row.evidence_version_id,
    };
  });
  return { verdict, facts };
}

/**
 * The pins the decision's review job was admitted under, or null when its cycle
 * or job is gone or its input no longer yields a usable policy. The gate never
 * throws for a policy it cannot read: an unreadable policy is a block.
 */
async function pinsOfDecision(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly reviewCycleId: string | null;
  },
): Promise<ReviewPins | null> {
  if (input.reviewCycleId === null) return null;
  const stored = await readCycleJobInput(transaction, {
    organizationId: input.organizationId,
    cycleId: input.reviewCycleId,
  });
  if (stored === null) return null;
  try {
    return await deriveReviewPins(stored);
  } catch (error) {
    if (error instanceof StandardError) return null;
    throw error;
  }
}

/**
 * Why a person's approval still blocks this decision's candidate, or
 * undefined when the task's review stage is automatic or the person approved
 * it. Only an `answered` approval with decision `approve` on this exact
 * delivery decision counts; an approval for an older decision never carries
 * over to a repaired candidate.
 */
async function stageApprovalReason(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly deliveryDecisionId: string;
  },
): Promise<string | undefined> {
  const policy = await transaction.query<{ approval_policy: unknown }>(
    `select t.approval_policy
       from bakery.workflow_runs r
       join bakery.tasks t
         on t.organization_id = r.organization_id and t.id = r.task_id
      where r.organization_id = $1 and r.id = $2`,
    [input.organizationId, input.runId],
  );
  if (
    effectiveApprovalPolicy(policy.rows[0]?.approval_policy).review !==
      "human_approval"
  ) return undefined;
  const approval = await transaction.query<
    { status: string; decision: string | null }
  >(
    `select status, decision from bakery.questions
      where organization_id = $1 and kind = 'approval'
        and subject_type = 'run_stage' and subject_id = $2
      order by created_at desc
      limit 1`,
    [input.organizationId, input.deliveryDecisionId],
  );
  const row = approval.rows[0];
  if (row?.status === "answered" && row.decision === "approve") {
    return undefined;
  }
  if (row?.decision === "request_changes") return "approval_changes_requested";
  if (row?.decision === "reject") return "approval_rejected";
  return "approval_pending";
}

/**
 * Decides, from stored facts, whether the run's candidate may merge. The
 * candidate is the head of the last harness step that reported one. The
 * candidate may merge only when all of these hold, and each failure adds its
 * reason in this order:
 *
 * - `no_decision`: the loop has taken no decision yet;
 * - `decision_stop:<reason>`: the latest decision stopped the loop;
 * - `decision_repair_pending`: the latest decision selected a repair that has
 *   not been reviewed yet;
 * - `candidate_moved`: the latest `proceed` judged a different head;
 * - `checks_blocked`: a required check of the policy that decision was taken
 *   under is not a fresh pass for this head right now;
 * - `review_missing`: no approved review cycle exists for this head;
 * - `approval_pending`, `approval_changes_requested`, `approval_rejected`:
 *   the task's policy makes the review stage wait for a person, and that
 *   person has not approved this exact decision's run-stage approval (#37).
 *
 * A review never approves by itself: the checks are read again here, so a
 * newer failed row blocks a candidate an older decision let through.
 */
export async function evaluateDeliveryCandidate(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<DeliveryCandidateEvaluation> {
  const { organizationId, runId } = input;
  const run = await transaction.query<{ snapshot: unknown }>(
    `select snapshot from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  if (run.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const stepOutputs = await loadStepOutputs(transaction, input);
  let headSha: string | null;
  try {
    headSha = candidateHeadSha(run.rows[0]!.snapshot, stepOutputs);
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "WORKFLOW_INPUT_UNRESOLVED"
    ) {
      throw error;
    }
    headSha = null;
  }
  const decision = await readLatestDecision(transaction, input);
  const reasons: string[] = [];
  let checks: CandidateChecksVerdict | null = null;
  let review: StoredCycle | null = null;

  if (decision === null) reasons.push("no_decision");
  else if (decision.decision === "stop") {
    reasons.push(`decision_stop:${decision.reason}`);
  } else if (decision.decision === "repair") {
    reasons.push("decision_repair_pending");
  }
  if (decision?.decision === "proceed") {
    if (headSha === null || decision.headSha !== headSha) {
      // The decision judged another head; nothing recorded about that head
      // says anything about this one.
      reasons.push("candidate_moved");
    } else {
      review = await readLatestCycleAtHead(transaction, { ...input, headSha });
      const pins = await pinsOfDecision(transaction, {
        organizationId,
        reviewCycleId: decision.reviewCycleId,
      });
      if (pins === null || pins.headSha !== headSha) {
        // The policy the decision was taken under cannot be recovered, so no
        // check can be shown fresh for this head.
        reasons.push("checks_blocked");
      } else {
        checks = (await evaluateReviewedChecks(transaction, {
          organizationId,
          runId,
          pins,
        })).verdict;
        if (checks.blocked) reasons.push("checks_blocked");
      }
      if (review === null || review.status !== "approved") {
        reasons.push("review_missing");
      }
      const approval = await stageApprovalReason(transaction, {
        organizationId,
        runId,
        deliveryDecisionId: decision.id,
      });
      if (approval) reasons.push(approval);
    }
  }
  return {
    mergeBlocked: reasons.length > 0,
    reasons,
    candidate: headSha === null ? null : { headSha },
    checks,
    review,
    decision,
  };
}

/**
 * Throws `STATE_CONFLICT` with reason `delivery_candidate_blocked` and the
 * blocking reasons unless the run's candidate may merge; returns the evaluation
 * otherwise. A merge consumer calls this right before it acts.
 */
export async function assertDeliveryCandidateMergeable(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<DeliveryCandidateEvaluation> {
  const evaluation = await evaluateDeliveryCandidate(transaction, input);
  if (evaluation.mergeBlocked) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: DELIVERY_CANDIDATE_BLOCKED_REASON,
        blockedReasons: [...evaluation.reasons],
      },
    });
  }
  return evaluation;
}
