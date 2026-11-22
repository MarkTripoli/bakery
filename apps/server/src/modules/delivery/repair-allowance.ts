import { StandardError, unprocessable } from "@bakery/contracts/http";
import { REVIEW_LOOP_LIMITS } from "@bakery/contracts/review-evidence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { reviewLoopFromSnapshot } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import { planReviewRepeatKey } from "../review-loop/limits.ts";
import { reopenFailedRun } from "../work/run-reopen.ts";
import { planRuntimeFromSnapshot } from "../workflow-adapter/plan-state.ts";
import { PLAN_DELIVERY_STOPPED_CODE } from "./plan-host.ts";
import { isPlanRunSnapshot, loopSnapshotOf } from "./plan-run-view.ts";
import {
  loadRepairAllowances,
  recordRepairAllowance,
  type StoredFailedCheck,
  type StoredRepairAllowance,
  withAllowances,
} from "./review-store.ts";

/** Audit operation recorded once for every allowance of more repair tries. */
export const REPAIR_ALLOWANCE_OPERATION = "runRepairAllowances.create";

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

type StopRow = {
  id: string;
  ordinal: number;
  review_cycle_id: string | null;
  decision: string;
  reason: string;
  head_sha: string;
  base_sha: string | null;
  policy_digest: string | null;
  failed_checks: readonly StoredFailedCheck[];
  blocking_fingerprints: readonly string[];
};

/**
 * Allows a run whose review and repair loop ran out of tries to try more, and
 * puts it back to work (issue #62, chapter 25 one engine).
 *
 * What it does, in one transaction: records the allowance (insert-only; the
 * policy frozen at admission is never rewritten, the bound in force is that
 * policy plus the allowances), records the repair decision the allowance buys
 * so the loop's counts stay true, and reopens the run, which the engine ended
 * when the loop stopped. The engine then asks the pinned plan again with the
 * repeat's bound raised by the allowance; nothing else about the plan changes.
 *
 * What it refuses, and why:
 * - A run that is not a compiled plan, or has no repair loop: there is no bound
 *   to raise.
 * - A loop that did not stop for lack of tries (a repeated blocker, an
 *   unavailable reviewer, a failed review, stale evidence, time or budget): more
 *   tries would not change why it stopped. The reopen is for this one reason.
 * - A run that failed for any other reason, or is not failed: the run must be
 *   the one the loop halted (`delivery_loop_stopped`).
 * - More tries than the workflow can ever hold (the contract ceiling).
 * - A task that is a lane of a coordination plan (see `reopenFailedRun`).
 *
 * It is idempotent: the same stop is answered once. Asking again after it was
 * answered returns that allowance and reopens nothing.
 */
export async function allowMoreRepairTries(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly runId: string;
    readonly tries: number;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<StoredRepairAllowance> {
  const { organizationId, runId } = input;
  if (
    !Number.isInteger(input.tries) || input.tries < 1 ||
    input.tries > REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling
  ) throw unprocessable(["tries"], "repair_tries_out_of_range");

  // The run row is the lock: two people allowing at once serialize here.
  const run = await transaction.query<{ snapshot: unknown; status: string }>(
    `select snapshot, status from bakery.workflow_runs
      where organization_id = $1 and id = $2 for update`,
    [organizationId, runId],
  );
  const row = run.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!isPlanRunSnapshot(row.snapshot)) conflict("not_a_plan_run");
  const frozen = reviewLoopFromSnapshot(
    await loopSnapshotOf(transaction, {
      organizationId,
      runId,
      snapshot: row.snapshot,
    }),
  );
  if (frozen === null) conflict("no_repair_loop");

  const allowances = await loadRepairAllowances(transaction, {
    organizationId,
    runId,
  });
  const latestRows = await transaction.query<StopRow>(
    `select id, ordinal, review_cycle_id, decision, reason, head_sha, base_sha,
            policy_digest, failed_checks, blocking_fingerprints
       from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2
      order by ordinal desc limit 1`,
    [organizationId, runId],
  );
  const latest = latestRows.rows[0];
  if (latest === undefined) conflict("repair_not_exhausted");
  // Asked again for a stop already answered: that allowance, nothing reopened.
  const answered = allowances.find(({ decisionOrdinal }) =>
    decisionOrdinal === latest.ordinal
  );
  if (answered !== undefined) return answered;

  if (
    latest.decision !== "stop" || latest.reason !== "repair_cycles_exhausted"
  ) {
    conflict("repair_not_exhausted");
  }
  const failure = await transaction.query<{ code: string | null }>(
    `select details ->> 'code' as code from bakery.audit_events
      where organization_id = $1 and operation = 'workflow.plan_failed'
        and resource_id = $2
      order by created_at desc, id desc limit 1`,
    [organizationId, runId],
  );
  if (
    row.status !== "failed" ||
    failure.rows[0]?.code !== PLAN_DELIVERY_STOPPED_CODE
  ) conflict("run_not_stopped_by_loop");

  const limits = withAllowances(frozen, allowances)!;
  if (
    limits.maxRepairCycles + input.tries >
      REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling
  ) conflict("allowance_exceeds_workflow_maximum");
  const runtime = await planRuntimeFromSnapshot(row.snapshot);
  const repeatKey = runtime === null
    ? null
    : planReviewRepeatKey(runtime.document);
  if (repeatKey === null) conflict("no_repair_loop");
  const maxRepairCycles = limits.maxRepairCycles + input.tries;

  const allowance = await recordRepairAllowance(transaction, {
    id: crypto.randomUUID(),
    organizationId,
    runId,
    answersDecisionOrdinal: latest.ordinal,
    repeatKey,
    addedTries: input.tries,
    maxRepairCycles,
    requestedBy: input.principalId,
    // The repair the allowance buys: the same candidate and findings the stop
    // judged, under the raised bound. Counting it keeps "repairs used" equal
    // to the repairs the run has actually run.
    decision: {
      id: crypto.randomUUID(),
      organizationId,
      runId,
      ordinal: latest.ordinal + 1,
      reviewCycleId: latest.review_cycle_id,
      decision: "repair",
      reason: "repair_selected",
      headSha: latest.head_sha,
      baseSha: latest.base_sha,
      policyDigest: latest.policy_digest,
      failedChecks: latest.failed_checks,
      blockingFingerprints: latest.blocking_fingerprints,
      limits: { ...limits, maxRepairCycles },
    },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: input.principalId,
    operation: REPAIR_ALLOWANCE_OPERATION,
    resourceType: "repair_allowance",
    resourceId: allowance.id,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      runId,
      answersDecisionOrdinal: latest.ordinal,
      addedTries: input.tries,
      maxRepairCycles,
    },
  });
  await reopenFailedRun(transaction, {
    organizationId,
    runId,
    principalId: input.principalId,
    requestId: input.requestId,
    traceId: input.traceId,
    reason: "repair_tries_allowed",
  });
  return allowance;
}
