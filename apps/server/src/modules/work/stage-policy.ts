import { z } from "zod";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { FIXED_CODING_PRESET } from "@bakery/contracts/workflow-presets";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

/**
 * Task stage policy. Only the plan stage can wait for a human; the preset
 * marks which stages a task may choose for (`policySelectable`). A task with no
 * stored policy reads as the legacy policy, and so does a new task that sets
 * none: the plan stage is automatic and `runs.create` behaves as before.
 */
export const TaskApprovalPolicySchema = z.object({
  plan: z.enum(["automatic", "human_approval"]).describe(
    "How the plan stage proceeds: `automatic` starts runs directly, `human_approval` requires an approved plan revision consumed at run admission.",
  ),
}).strict().describe(
  "Stage policy snapshot stored on a task at creation; its digest binds every approval to the policy in force.",
);
export type TaskApprovalPolicy = z.infer<typeof TaskApprovalPolicySchema>;

/** The policy in force when a task stores none. */
export const LEGACY_APPROVAL_POLICY: TaskApprovalPolicy = Object.freeze({
  plan: "automatic",
});

/** Stage id the plan approval is scoped to. */
export const PLAN_STAGE = "plan";

export function parseApprovalPolicy(value: unknown): TaskApprovalPolicy {
  const parsed = TaskApprovalPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(["approvalPolicy"], "approval_policy_invalid");
  }
  const plan = FIXED_CODING_PRESET.stages.find((stage) =>
    stage.id === PLAN_STAGE
  );
  if (!plan?.policySelectable) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "approval_policy_unsupported" },
    });
  }
  return parsed.data;
}

/** Effective policy for a stored (possibly null) policy snapshot. */
export function effectiveApprovalPolicy(stored: unknown): TaskApprovalPolicy {
  if (stored === null || stored === undefined) return LEGACY_APPROVAL_POLICY;
  const parsed = TaskApprovalPolicySchema.safeParse(stored);
  if (!parsed.success) throw new Error("TASK_APPROVAL_POLICY_INVALID");
  return parsed.data;
}

export async function approvalPolicyDigest(
  policy: TaskApprovalPolicy,
): Promise<string> {
  return await sha256Hex(canonicalJson(policy));
}
