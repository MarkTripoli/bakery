import type { ApprovedPlanForInstructions } from "@bakery/contracts/workflow-presets";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { consumeApprovalForAdmission } from "../conversation/approvals.ts";
import {
  approvalPolicyDigest,
  effectiveApprovalPolicy,
  PLAN_STAGE,
} from "./stage-policy.ts";

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/**
 * Applies the task's stage policy to a run admission. Planning-only tasks start
 * no run. When the plan stage waits for a human, the run needs an approval and
 * consumes it in the admission transaction; without one no run row exists.
 * Returns the consumed plan revision, or null under the automatic policy.
 * Tasks with no stored policy read as the legacy policy and start as before.
 */
export async function admitStagePolicy(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    principalId: string;
    task: { id: string; approval_policy: unknown; planning_only: boolean };
    approvalId: string | undefined;
    runId: string;
    requestId: string;
    traceId: string;
  },
): Promise<ApprovedPlanForInstructions | null> {
  if (facts.task.planning_only) conflict("planning_only");
  const policy = effectiveApprovalPolicy(facts.task.approval_policy);
  if (policy.plan !== "human_approval") return null;
  if (facts.approvalId === undefined) conflict("approval_required");
  return await consumeApprovalForAdmission(transaction, {
    organizationId: facts.organizationId,
    taskId: facts.task.id,
    approvalId: facts.approvalId,
    runId: facts.runId,
    stage: PLAN_STAGE,
    policyDigest: await approvalPolicyDigest(policy),
    principalId: facts.principalId,
    requestId: facts.requestId,
    traceId: facts.traceId,
  });
}
