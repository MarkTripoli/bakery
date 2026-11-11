import { StandardError } from "@bakery/contracts/http";
import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "@bakery/contracts/repository-profile-config";
import {
  type EffectiveRepositoryRuleEntry,
  type OrganizationRepositoryRuleEntry,
  repositoryRuleStageRequirements,
  type RepositoryRuleStageViolation,
  repositoryRuleStageViolations,
  type RepositoryRuleWorkflowStage,
  RULE_GUARD_ALL_CHECKS,
} from "@bakery/contracts/repository-rules";
import { DELIVERY_REFERENCES } from "@bakery/contracts/workflow-presets";
import type { WorkflowActionName } from "@bakery/contracts/workflow-action-registry";
import type { PgTransactionClient } from "../../platform/database.ts";
import { lockOrganization } from "../auth/adapters/access-postgres.ts";
import { parseStoredOrganizationRules } from "../repository-rules/pinned.ts";
import { readLatestRuleVersionRow } from "../repository-rules/postgres.ts";
import {
  extractFixedWorkflowSteps,
  type FixedWorkflowStep,
  WorkflowNotExecutableError,
  WorkflowNotFixedError,
} from "../work/run-steps.ts";

/** The only action whose literal `checks` input runs fixed policy commands. */
const CHECK_ACTION = "quality.check" satisfies WorkflowActionName;

const ACTION_EFFECTS: Readonly<Record<string, string | undefined>> =
  REPOSITORY_FIXED_POLICY_ACTION_EFFECTS;

const VIOLATION_MESSAGES: Readonly<
  Record<RepositoryRuleStageViolation["reason"], string>
> = Object.freeze({
  stage_missing: "needs a stage that runs the check",
  stage_before_revision:
    "needs its check to run after the last stage that changes the revision",
});

/**
 * The commands a `quality.check` input runs, as far as the guard can tell at
 * admission: a literal array lists them, and the reference
 * `$delivery.checkIds` stands for every command of the pinned fixed policy, so
 * it is the all-checks marker. The marker is never accepted from a literal
 * array, where it is not a command id and would only forge coverage.
 */
function literalChecks(input: unknown): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const checks: unknown = Reflect.get(input, "checks");
  if (checks === DELIVERY_REFERENCES.checkIds) return [RULE_GUARD_ALL_CHECKS];
  return Array.isArray(checks) &&
      checks.every((check) => typeof check === "string")
    ? checks.filter((check) => check !== RULE_GUARD_ALL_CHECKS)
    : [];
}

/** Maps fixed workflow steps to what the rule guard needs, in execution order. */
export function repositoryRuleWorkflowStages(
  steps: readonly Pick<FixedWorkflowStep, "action" | "input" | "condition">[],
): readonly RepositoryRuleWorkflowStage[] {
  return steps.map((step) => ({
    // A conditional stage may be skipped, and skipped evidence never passes a
    // `require` rule, so it satisfies nothing.
    checks: step.action === CHECK_ACTION && step.condition === undefined
      ? literalChecks(step.input)
      : [],
    producesRevision: ACTION_EFFECTS[step.action] === "repository_revision",
  }));
}

/**
 * Throws the typed refusal naming every rule key whose required check the
 * steps lack or misplace. Pure: the caller supplies the rules (the latest
 * organization baseline at publication, the pinned effective set at admission).
 */
export function assertStepsSatisfyRules(
  rules: {
    readonly entries: readonly (
      | OrganizationRepositoryRuleEntry
      | EffectiveRepositoryRuleEntry
    )[];
  },
  steps: readonly Pick<FixedWorkflowStep, "action" | "input" | "condition">[],
): void {
  const requirements = repositoryRuleStageRequirements(rules);
  if (requirements.length === 0) return;
  const violations = repositoryRuleStageViolations(
    requirements,
    repositoryRuleWorkflowStages(steps),
  );
  if (violations.length === 0) return;
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: violations.map((violation) => ({
        path: ["steps"],
        code: `repository_rule_${violation.reason}`,
        message: `Rule ${violation.ruleKey} is required and ${
          VIOLATION_MESSAGES[violation.reason]
        } ${violation.commandId}.`,
      })),
    },
  });
}

/**
 * Refuses a workflow version that would drop a stage a `require` rule of the
 * latest organization baseline needs. Takes the shared organization lock, so
 * a rule publication cannot commit between this read and the caller's write,
 * and reads the baseline through the one org-bound reader. Stored rules that
 * fail their schema or digest fail closed. Nothing is written here.
 */
export async function assertWorkflowSatisfiesRepositoryRules(
  transaction: PgTransactionClient,
  organizationId: string,
  definition: unknown,
): Promise<void> {
  await lockOrganization(transaction, organizationId);
  const row = await readLatestRuleVersionRow(transaction, organizationId);
  if (!row) return;
  const rules = await parseStoredOrganizationRules(row);
  if (repositoryRuleStageRequirements(rules).length === 0) return;
  let steps: readonly FixedWorkflowStep[];
  try {
    steps = extractFixedWorkflowSteps(definition);
  } catch (cause) {
    // A definition the runtime cannot read proves nothing; never pass it.
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: cause instanceof WorkflowNotFixedError
          ? "workflow_not_fixed"
          : cause instanceof WorkflowNotExecutableError
          ? "workflow_not_executable"
          : "workflow_version_invalid",
      },
      cause,
    });
  }
  assertStepsSatisfyRules(rules, steps);
}
