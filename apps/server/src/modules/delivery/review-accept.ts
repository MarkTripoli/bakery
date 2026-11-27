import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { isStorableDecisionText } from "@bakery/contracts/human-approval";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { appendDecision } from "../work/human-approval-store.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  ACCEPTANCE_COLUMNS,
  ACCEPTANCE_JOIN,
  REVIEW_CYCLE_COLUMNS,
  type ReviewCycleRow,
  toReviewCycle,
} from "./postgres.ts";

/**
 * An owner overrules a reviewer by recording an accept-with-reason decision
 * (chapter 25 section 9, O18, #412 slice 5).
 *
 * The decision is recorded in the open: a ledger entry that names the review,
 * who decided, when and why, shown on the review itself. It is a separate
 * record, never an edit of the review, which stays what the reviewer found.
 *
 * Rules, and why:
 * - Only an organization administrator, or a member whose role holds
 *   `review:accept`, and never an agent: decisions that overrule a reviewer are a person's unless a workflow
 *   explicitly grants an agent that power, which this operation does not.
 * - Only a review that requested changes: an approved review has nothing to
 *   overrule, and accepting it would add a decision that means nothing.
 * - Once per review: a second decision would let the record disagree with itself.
 * - A reason is required; a blank one is refused before anything is written.
 */
export async function acceptReview(
  context: ActionContext,
  input: z.output<typeof contractSchemas.ReviewAccept>,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  if (context.agentSession !== undefined) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  if (input.reason.trim() === "") {
    throw unprocessable(["reason"], "review_accept_reason_required");
  }
  if (!isStorableDecisionText(input.reason)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const runId = context.params.id;
  const reviewId = context.params.reviewId;
  if (!runId || !reviewId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  // The run row is locked, not the review: reviews are insert-only, so the app
  // role may not lock one, and the run is what serializes two decisions.
  const found = await transaction.query<
    { task_id: string; status: string; ordinal: number; blocking: number }
  >(
    `select run.task_id, review.status, review.ordinal,
            review.blocking_count as blocking
       from bakery.review_cycles review
       join bakery.workflow_runs run
         on run.organization_id = review.organization_id
        and run.id = review.run_id
      where review.organization_id = $1 and review.run_id = $2
        and review.id = $3
        for update of run`,
    [organizationId, runId, reviewId],
  );
  const cycle = found.rows[0];
  if (!cycle) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (cycle.status !== "changes_requested") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "review_not_blocking" },
    });
  }
  const prior = await transaction.query(
    `select 1 from bakery.decisions_ledger
      where organization_id = $1 and kind = 'accept_with_reason'
        and subject_kind = 'review' and subject_id = $2
      limit 1`,
    [organizationId, reviewId],
  );
  if (prior.rows.length > 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "review_already_accepted" },
    });
  }

  await appendDecision(transaction, {
    organizationId,
    taskId: cycle.task_id,
    runId,
    kind: "accept_with_reason",
    subjectKind: "review",
    subjectId: reviewId,
    decidedBy: principalId,
    reason: input.reason,
    detail: { ordinal: cycle.ordinal, blockingCount: cycle.blocking },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runReviews.accept",
    resourceType: "review_cycle",
    resourceId: reviewId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { runId, ordinal: cycle.ordinal },
  });

  const row = await transaction.query<ReviewCycleRow>(
    `select ${REVIEW_CYCLE_COLUMNS},
            null::uuid as pull_request_id, ${ACCEPTANCE_COLUMNS}
       from bakery.review_cycles${ACCEPTANCE_JOIN}
      where review_cycles.organization_id = $1 and review_cycles.id = $2`,
    [organizationId, reviewId],
  );
  return toReviewCycle(row.rows[0]!);
}
