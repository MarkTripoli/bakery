import { FAULTS, StandardError } from "@bakery/contracts/http";
import {
  type DeliveryDecisionKind,
  type DeliveryDecisionReason,
  REVIEW_LOOP_LIMITS,
} from "@bakery/contracts/review-evidence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { candidateHeadSha } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  AttemptRow,
  RequestMetadata,
  WorkerIdentity,
} from "../execution/shared.ts";
import { appendIteration, appendStopGate } from "./append-iteration.ts";
import { requestRunStageApproval } from "../conversation/approvals.ts";
import { evaluateReviewedChecks } from "./candidate.ts";
import {
  assertIndependentReviewer,
  REVIEW_NOT_INDEPENDENT_REASON,
} from "./independence.ts";
import { decideDelivery, type DeliveryDecisionResult } from "./repair-loop.ts";
import { deriveReviewPins, type ReviewPins } from "./review-pins.ts";
import { parseReviewReport, verifyReviewReport } from "./review-report.ts";
import {
  candidateImplementer,
  insertDeliveryDecision,
  insertReviewCycle,
  insertReviewFindings,
  loadRunLoopFacts,
  loopElapsedMs,
  readRunBudgetHeadroom,
  type RunLoopFacts,
  type StoredFailedCheck,
} from "./review-store.ts";

/** Audit operation recorded once for every accepted `review.independent` report. */
export const REVIEW_RECORD_OPERATION = "delivery.review.record";

/** Audit operation recorded when a review job failed for good and stopped the run. */
export const REVIEW_STOP_OPERATION = "delivery.review.stop";

/** `VALIDATION_FAILED` reason: the job's revision is no longer the candidate. */
export const REVIEW_CANDIDATE_MOVED_REASON = "review_candidate_moved";

/** `VALIDATION_FAILED` reason: the run has no candidate to have been reviewed. */
export const REVIEW_CANDIDATE_UNRESOLVED_REASON = "review_candidate_unresolved";

/** The worker fault code that names an unavailable reviewer. */
export const REVIEWER_UNAVAILABLE_FAULT = "REVIEWER_UNAVAILABLE";

type FinalizeInput = {
  readonly attempt: AttemptRow;
  readonly identity: WorkerIdentity;
  readonly jobId: string;
  readonly resultPayload: unknown;
  readonly metadata: RequestMetadata;
};

/** What an accepted report left behind. */
export type ReviewRecord = {
  readonly cycleId: string;
  readonly ordinal: number;
  readonly decisionId: string;
  readonly decision: DeliveryDecisionKind;
  readonly reason: DeliveryDecisionReason;
};

/** What a terminal review failure left behind: a decision with no cycle. */
export type ReviewStopRecord = {
  readonly ordinal: number;
  readonly decisionId: string;
  readonly reason: DeliveryDecisionReason;
};

type ReviewJob = {
  readonly input: unknown;
  readonly runId: string;
  readonly runStepId: string;
  readonly checkpoints: number;
};

type JobRow = {
  action: string;
  input: unknown;
  run_id: string;
  run_step_id: string;
  checkpoints: number;
};

type SessionRow = {
  run_step_id: string | null;
  parent_session_id: string | null;
  resume_ref: unknown;
};

/**
 * Reads the job the attempt belongs to, with the run and step that own it,
 * under an explicit organization predicate. The job input is the one admission
 * wrote and the claim re-verified; nothing here trusts the report. A job whose
 * checkpoints are not a list counts as having one, which the independence rule
 * refuses.
 */
async function loadReviewJob(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<ReviewJob> {
  const result = await transaction.query<JobRow>(
    `select job.action, job.input, step.id as run_step_id, run.id as run_id,
            case when jsonb_typeof(job.current_checkpoints) = 'array'
                 then jsonb_array_length(job.current_checkpoints)
                 else 1 end as checkpoints
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
      where job.organization_id = $1 and job.id = $2`,
    [organizationId, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.action !== "review.independent") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return {
    input: row.input,
    runId: row.run_id,
    runStepId: row.run_step_id,
    checkpoints: Number(row.checkpoints),
  };
}

function refuse(reason: string, subReason?: string): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: subReason === undefined ? { reason } : { reason, subReason },
  });
}

/**
 * The commit the run's candidate is now: the head the last harness step
 * reported. A review is evidence for exactly that commit, so the job's
 * revision has to be it.
 */
function requireCandidate(facts: RunLoopFacts, pins: ReviewPins): void {
  let candidate: string;
  try {
    candidate = candidateHeadSha(facts.snapshot, facts.stepOutputs);
  } catch (error) {
    if (
      error instanceof Error && error.message === "WORKFLOW_INPUT_UNRESOLVED"
    ) refuse(REVIEW_CANDIDATE_UNRESOLVED_REASON);
    throw error;
  }
  if (candidate !== pins.headSha) refuse(REVIEW_CANDIDATE_MOVED_REASON);
}

/**
 * Verifies a worker's `review.independent` report inside the result
 * transaction, records it as an insert-only cycle with its findings, takes the
 * delivery decision and applies it. The report is a claim: the head, base and
 * policy come from the job's own pins, the independence of the reviewer from
 * the stored session rows, and whether the candidate may proceed from the #83
 * check rows, never from the report's say-so.
 *
 * Every refusal throws `StandardError` and the caller rolls the writes back:
 *
 * - `review_policy_missing`: the job carries no usable fixed policy;
 * - `review_report_invalid`: the report differs from what the pins derive, or
 *   breaks a bound (the sub-reason names the rule);
 * - `review_not_independent`: the reviewer is not a fresh session of the review
 *   step, or the implementer cannot be named (the sub-reason names the rule);
 * - `review_candidate_moved` and `review_candidate_unresolved`: the job's
 *   revision is not the run's candidate.
 *
 * Returns null for a run that froze no review loop: there is nothing to record,
 * and the generic result path stores the report as the step output as before.
 * A replayed result returns before this hook, so rows are written once.
 */
export async function finalizeReview(
  transaction: PgTransactionClient,
  input: FinalizeInput,
): Promise<ReviewRecord | null> {
  const { attempt, identity, jobId, metadata } = input;
  const organizationId = attempt.organization_id;
  const job = await loadReviewJob(transaction, organizationId, jobId);
  const facts = await loadRunLoopFacts(transaction, {
    organizationId,
    runId: job.runId,
  });
  const limits = facts.reviewLoop;
  if (limits === null) return null;

  const pins = await deriveReviewPins(job.input);
  const report = parseReviewReport(input.resultPayload);
  verifyReviewReport(report, pins, {
    maxFindings: limits.maxFindings,
    resultByteBudget: REVIEW_LOOP_LIMITS.resultByteBudget,
  });

  // The reviewer is whatever session the report names, looked up as stored.
  const session = await transaction.query<SessionRow>(
    `select run_step_id, parent_session_id, resume_ref
       from bakery.agent_sessions
      where organization_id = $1 and id = $2`,
    [organizationId, report.sessionId],
  );
  const reviewer = session.rows[0];
  assertIndependentReviewer({
    reviewer: {
      sessionId: report.sessionId,
      runStepId: reviewer?.run_step_id ?? null,
      parentSessionId: reviewer?.parent_session_id ?? null,
      resumeRef: reviewer === undefined || reviewer.resume_ref === null
        ? null
        : JSON.stringify(reviewer.resume_ref),
    },
    implementingSessions: facts.implementing.map(({ sessionId }) => sessionId),
    reviewStepId: job.runStepId,
    jobCheckpoints: job.checkpoints,
  });
  requireCandidate(facts, pins);
  const implementer = candidateImplementer(facts);
  if (implementer === null || implementer.workerPrincipalId === null) {
    refuse(REVIEW_NOT_INDEPENDENT_REASON, "implementer_unknown");
  }

  const ordinal = facts.cycleCount;
  const blockingCount = report.findings.filter(({ blocking }) => blocking)
    .length;
  const status = blockingCount === 0 ? "approved" : "changes_requested";
  await insertReviewCycle(transaction, {
    id: report.reviewId,
    organizationId,
    runId: job.runId,
    runStepId: job.runStepId,
    jobId,
    attemptId: attempt.id,
    fence: String(attempt.fence),
    ordinal,
    reviewerSessionId: report.sessionId,
    reviewerPrincipalId: identity.host.principal_id,
    implementerSessionId: implementer.sessionId,
    implementerPrincipalId: implementer.workerPrincipalId,
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    policyDigest: pins.policyDigest,
    status,
    findingCount: report.findings.length,
    blockingCount,
  });
  await insertReviewFindings(transaction, {
    organizationId,
    reviewCycleId: report.reviewId,
    findings: report.findings.map((finding) => ({
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      body: finding.detail,
    })),
  });

  const { verdict, facts: checkFacts } = await evaluateReviewedChecks(
    transaction,
    { organizationId, runId: job.runId, pins },
  );
  const outcome = decideDelivery({
    verdict,
    checkFacts,
    review: {
      status,
      findings: report.findings.map(({ fingerprint, severity }) => ({
        fingerprint,
        severity,
      })),
    },
    priorDecisions: facts.priorDecisions,
    limits: {
      maxRepairCycles: limits.maxRepairCycles,
      maxLoopDurationMs: limits.maxLoopDurationMs,
    },
    elapsedMs: await loopElapsedMs(transaction, {
      organizationId,
      runId: job.runId,
    }) ?? 0,
    budget: await readRunBudgetHeadroom(transaction, {
      organizationId,
      runId: job.runId,
      snapshot: facts.snapshot,
    }),
  });
  const decisionId = crypto.randomUUID();
  const decisionOrdinal = facts.decisionCount;
  await insertDeliveryDecision(transaction, {
    id: decisionId,
    organizationId,
    runId: job.runId,
    ordinal: decisionOrdinal,
    reviewCycleId: report.reviewId,
    decision: outcome.decision,
    reason: outcome.reason,
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    policyDigest: pins.policyDigest,
    failedChecks: storedFailedChecks(outcome),
    blockingFingerprints: outcome.blockingFingerprints,
    limits,
  });
  await applyDecision(transaction, {
    organizationId,
    runId: job.runId,
    snapshot: facts.snapshot,
    ordinal: decisionOrdinal,
    decisionId,
    outcome,
  });

  const audited = await appendAudit(transaction, {
    organizationId,
    principalId: identity.host.principal_id,
    operation: REVIEW_RECORD_OPERATION,
    resourceType: "job_attempt",
    resourceId: attempt.id,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: {
      jobId,
      runId: job.runId,
      runStepId: job.runStepId,
      fence: String(attempt.fence),
      reviewCycleId: report.reviewId,
      ordinal,
      reviewerSessionId: report.sessionId,
      implementerSessionId: implementer.sessionId,
      headSha: pins.headSha,
      baseSha: pins.baseSha,
      policyDigest: pins.policyDigest,
      findingCount: report.findings.length,
      blockingCount,
      decisionId,
      decision: outcome.decision,
      reason: outcome.reason,
    },
  });
  if (audited !== 1) throw new Error("REVIEW_RECORD_AUDIT_INSERT_FAILED");
  return {
    cycleId: report.reviewId,
    ordinal,
    decisionId,
    decision: outcome.decision,
    reason: outcome.reason,
  };
}

/** The `FailedCheck` shape a decision stores: ids and outcome, no digest. */
function storedFailedChecks(
  outcome: DeliveryDecisionResult,
): StoredFailedCheck[] {
  return outcome.failedChecks.map((check) => ({
    checkRunId: check.checkRunId,
    checkId: check.checkId,
    result: check.result,
    reason: check.reason,
    exitCode: check.exitCode,
  }));
}

/**
 * Applies a decision to the run: `repair` appends the next iteration, `stop`
 * appends the pre-failed gate step, `proceed` appends nothing, which is how a
 * clean seed candidate keeps its original check rows and review as the only
 * evidence. When the task's policy makes the review stage wait for a person,
 * `proceed` also opens a run-stage approval for that exact candidate; merge
 * eligibility then requires it approved (#37).
 */
async function applyDecision(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly snapshot: unknown;
    readonly ordinal: number;
    readonly decisionId: string;
    readonly outcome: Pick<DeliveryDecisionResult, "decision" | "reason">;
  },
): Promise<void> {
  const { outcome } = input;
  if (outcome.decision === "repair") {
    await appendIteration(transaction, input);
  } else if (outcome.decision === "stop") {
    await appendStopGate(transaction, {
      organizationId: input.organizationId,
      runId: input.runId,
      ordinal: input.ordinal,
      reason: outcome.reason,
      decisionId: input.decisionId,
    });
  } else if (outcome.decision === "proceed") {
    await requestRunStageApproval(transaction, {
      organizationId: input.organizationId,
      runId: input.runId,
      deliveryDecisionId: input.decisionId,
    });
  }
}

const REVIEW_RESULT_SAVEPOINT = "review_independent_result";

/**
 * Runs `finalizeReview` so a refused report stays visible to an operator. The
 * finalizer runs inside a savepoint. When it refuses with a `StandardError`,
 * everything it wrote rolls back to the savepoint (no cycle, no finding, no
 * decision, no appended step) and one `delivery.review.record` audit entry with
 * outcome `denied` is appended. Its details are the problem code, the refusal
 * reason and the sub-reason, fixed strings of this module and of the pure
 * verifiers and never anything the worker sent.
 *
 * The refusal is returned, not thrown, so the caller can return it and let the
 * transaction commit that entry. The job, attempt and step stay as they were:
 * the lease expires and the attempt cap bounds retries, as for a refused check
 * report. Any other error is rethrown and rolls the whole transaction back.
 */
export async function finalizeOrDenyReview(
  transaction: PgTransactionClient,
  input: FinalizeInput,
): Promise<StandardError | null> {
  await transaction.query(`savepoint ${REVIEW_RESULT_SAVEPOINT}`);
  try {
    await finalizeReview(transaction, input);
    await transaction.query(`release savepoint ${REVIEW_RESULT_SAVEPOINT}`);
    return null;
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    await transaction.query(`rollback to savepoint ${REVIEW_RESULT_SAVEPOINT}`);
    const reason = error.params?.reason;
    const subReason = error.params?.subReason;
    const inserted = await appendAudit(transaction, {
      organizationId: input.attempt.organization_id,
      principalId: input.identity.host.principal_id,
      operation: REVIEW_RECORD_OPERATION,
      resourceType: "job_attempt",
      resourceId: input.attempt.id,
      requestId: input.metadata.requestId,
      traceId: input.metadata.traceId,
      outcome: "denied",
      details: {
        code: error.code,
        reason: typeof reason === "string" ? reason : null,
        subReason: typeof subReason === "string" ? subReason : null,
      },
    });
    if (inserted !== 1) throw new Error("REVIEW_DENIAL_AUDIT_INSERT_FAILED");
    return error;
  }
}

type StopInput = {
  readonly attempt: AttemptRow;
  readonly identity: WorkerIdentity;
  readonly jobId: string;
  /** The `Problem.code` of the fault the worker reported. */
  readonly faultCode: string;
  readonly metadata: RequestMetadata;
};

const REVIEW_STOP_SAVEPOINT = "review_independent_stop";

/** A reviewer that could not run stops the loop; any other fault fails it. */
function stopReasonFor(faultCode: string): DeliveryDecisionReason {
  return faultCode === REVIEWER_UNAVAILABLE_FAULT
    ? "reviewer_unavailable"
    : "review_failed";
}

/**
 * The fault code for an audit entry: a registered problem code or null. The
 * code is the worker's own string, so it is recorded only when it names a
 * fault the server knows, never as free text.
 */
function auditedFaultCode(faultCode: string): string | null {
  return Object.hasOwn(FAULTS, faultCode) ? faultCode : null;
}

/**
 * Records the stop that a terminal `review.independent` failure means. It runs
 * only once the result route has decided the failure is final (the job was not
 * requeued), so a retryable fault that gets another attempt records nothing.
 * The decision has no cycle, because a review that did not complete leaves
 * none; its head is the run's candidate, and its base and policy come from the
 * job's pins when those are readable. The `delivery_gate` step is appended
 * beside the failed review step so the run reads the same on every stop path.
 *
 * Returns null for a run with no review loop. A refusal here must not keep a
 * failed result from being recorded, so a `StandardError` rolls back to a
 * savepoint, leaves one `delivery.review.stop` audit entry of outcome `failed`
 * and lets the failure complete; the run still fails because its review step
 * did. Any other error is rethrown.
 */
export async function recordReviewJobFailure(
  transaction: PgTransactionClient,
  input: StopInput,
): Promise<ReviewStopRecord | null> {
  const { attempt, identity, jobId, metadata } = input;
  const organizationId = attempt.organization_id;
  await transaction.query(`savepoint ${REVIEW_STOP_SAVEPOINT}`);
  try {
    const job = await loadReviewJob(transaction, organizationId, jobId);
    const facts = await loadRunLoopFacts(transaction, {
      organizationId,
      runId: job.runId,
    });
    const limits = facts.reviewLoop;
    if (limits === null) {
      await transaction.query(`release savepoint ${REVIEW_STOP_SAVEPOINT}`);
      return null;
    }
    let headSha: string;
    try {
      headSha = candidateHeadSha(facts.snapshot, facts.stepOutputs);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "WORKFLOW_INPUT_UNRESOLVED"
      ) throw error;
      refuse(REVIEW_CANDIDATE_UNRESOLVED_REASON);
    }
    // The pins are best effort: a failed job may be exactly one whose policy
    // could not be read, and the stop must still be recorded.
    let pins: ReviewPins | null = null;
    try {
      pins = await deriveReviewPins(job.input);
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
    }
    const reason = stopReasonFor(input.faultCode);
    const decisionId = crypto.randomUUID();
    const ordinal = facts.decisionCount;
    await insertDeliveryDecision(transaction, {
      id: decisionId,
      organizationId,
      runId: job.runId,
      ordinal,
      reviewCycleId: null,
      decision: "stop",
      reason,
      headSha,
      baseSha: pins?.baseSha ?? null,
      policyDigest: pins?.policyDigest ?? null,
      failedChecks: [],
      blockingFingerprints: [],
      limits,
    });
    await appendStopGate(transaction, {
      organizationId,
      runId: job.runId,
      ordinal,
      reason,
      decisionId,
    });
    const audited = await appendAudit(transaction, {
      organizationId,
      principalId: identity.host.principal_id,
      operation: REVIEW_STOP_OPERATION,
      resourceType: "job_attempt",
      resourceId: attempt.id,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      details: {
        jobId,
        runId: job.runId,
        runStepId: job.runStepId,
        fence: String(attempt.fence),
        headSha,
        decisionId,
        decision: "stop",
        reason,
        faultCode: auditedFaultCode(input.faultCode),
      },
    });
    if (audited !== 1) throw new Error("REVIEW_STOP_AUDIT_INSERT_FAILED");
    await transaction.query(`release savepoint ${REVIEW_STOP_SAVEPOINT}`);
    return { ordinal, decisionId, reason };
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    await transaction.query(`rollback to savepoint ${REVIEW_STOP_SAVEPOINT}`);
    const code = error.params?.reason;
    const inserted = await appendAudit(transaction, {
      organizationId,
      principalId: identity.host.principal_id,
      operation: REVIEW_STOP_OPERATION,
      resourceType: "job_attempt",
      resourceId: attempt.id,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      outcome: "failed",
      details: {
        code: error.code,
        reason: typeof code === "string" ? code : null,
        faultCode: auditedFaultCode(input.faultCode),
      },
    });
    if (inserted !== 1) throw new Error("REVIEW_STOP_AUDIT_INSERT_FAILED");
    return null;
  }
}
