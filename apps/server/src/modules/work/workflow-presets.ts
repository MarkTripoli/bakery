import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type RepositoryVersionedProfileConfig,
  RepositoryVersionedProfileConfigSchema,
} from "@bakery/contracts/repository-inspection";
import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "@bakery/contracts/repository-profile-config";
import { isReviewLoopSpec } from "@bakery/contracts/review-evidence";
import {
  type ApprovedPlanForInstructions,
  renderImplementInstructions,
  WORKFLOW_PRESETS,
  type WorkflowPresetDefinition,
  type WorkflowPresetDocument,
  type WorkflowPresetSource,
} from "@bakery/contracts/workflow-presets";
import { compileWorkflowDocumentDetailed } from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import type { BudgetRuntimeConfig } from "@bakery/config";
import { selectStepAgentVersion } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  budgetPolicyUsable,
  findTrustedPricingSnapshot,
  formatMicroUsd,
  isModelAction,
  parseMicroUsd,
} from "./budget.ts";
import { resolveFrozenStepAgents } from "./agent-run-admission.ts";
import { pinEffectiveRepositoryRules } from "../repository-rules/pinned.ts";
import { assertStepsSatisfyRules } from "../workflows/rule-guard.ts";
import {
  extractFixedWorkflowSteps,
  type FixedWorkflowStep,
} from "./run-steps.ts";

type WorkflowPresetOutput = z.output<typeof contractSchemas.WorkflowPreset>;
type AvailabilityOutput = z.output<
  typeof contractSchemas.WorkflowPresetAvailability
>;
type AvailabilityReason = AvailabilityOutput["reasons"][number];
type PresetPage = z.output<typeof contractSchemas["Page<WorkflowPreset>"]>;

/** What can be wrong with the agent a model step runs, by the problem found. */
type AgentProblem =
  | "unbound"
  | "disabled"
  | "unbilled"
  | "capabilityDenied"
  | "unpriced";

type AgentReasons = Readonly<Record<AgentProblem, AvailabilityReason>>;

const CODING_AGENT_REASONS: AgentReasons = Object.freeze({
  unbound: "coding_agent_unbound",
  disabled: "coding_agent_disabled",
  unbilled: "coding_agent_unbilled",
  capabilityDenied: "coding_agent_capability_denied",
  unpriced: "coding_agent_unpriced",
});

/** Every problem with the review or repair agent reads as one setup reason. */
const uniformAgentReasons = (reason: AvailabilityReason): AgentReasons =>
  Object.freeze({
    unbound: reason,
    disabled: reason,
    unbilled: reason,
    capabilityDenied: reason,
    unpriced: reason,
  });

/**
 * The reasons each model action reports when its agent, billing or pricing
 * authority is missing. A preset step that runs a model action absent from
 * this map is a code error, never a silently ignored step.
 */
const AGENT_REASONS_BY_ACTION: Readonly<Record<string, AgentReasons>> = Object
  .freeze({
    "harness.implement": CODING_AGENT_REASONS,
    "agent.freeform": CODING_AGENT_REASONS,
    "harness.repair": uniformAgentReasons("repair_agent_unavailable"),
    "review.independent": uniformAgentReasons("review_agent_unavailable"),
  });

/** Maps each admission conflict reason to the agent problem it means. */
const AGENT_PROBLEM_BY_CONFLICT: Readonly<
  Record<string, AgentProblem | undefined>
> = Object.freeze({
  model_agent_required: "unbound",
  model_billing_required: "unbilled",
  agent_action_capability_denied: "capabilityDenied",
  agent_version_unavailable: "disabled",
  agent_version_invalid: "disabled",
});

/** Reasons are reported in this order so the verdict is stable. */
const REASON_ORDER: readonly AvailabilityReason[] = Object.freeze([
  "repository_archived",
  "application_archived",
  "no_active_profile",
  "coding_agent_unbound",
  "coding_agent_disabled",
  "coding_agent_unbilled",
  "coding_agent_capability_denied",
  "coding_agent_unpriced",
  "review_agent_unavailable",
  "repair_agent_unavailable",
  "profile_effect_denied",
  "required_check_missing",
  "budget_below_reservation",
  "budget_policy_unavailable",
]);

const EFFECT_OF_ACTION: Readonly<Record<string, string | undefined>> =
  REPOSITORY_FIXED_POLICY_ACTION_EFFECTS;

/** Actions that read the profile's fixed policy commands to run or to judge. */
const FIXED_POLICY_ACTIONS: readonly string[] = Object.freeze([
  "quality.check",
  "review.independent",
]);

/**
 * True when the profile's fixed policy cannot run `steps`: a step that checks
 * or reviews needs an observed (v2) fixed policy with at least one command, and
 * every effect the steps produce must be allowed. A profile with no fixed
 * policy at all permits the plain coding steps, as it always has. Preset
 * availability and run admission both call this, so the composer never offers
 * a start that admission refuses.
 */
export function fixedPolicyDeniesSteps(
  config: RepositoryVersionedProfileConfig,
  steps: readonly Pick<FixedWorkflowStep, "action">[],
): boolean {
  const policy = config.fixedPolicy;
  if (
    steps.some((step) => FIXED_POLICY_ACTIONS.includes(step.action)) &&
    (config.schemaVersion !== 2 || policy === undefined ||
      policy.commands.length === 0)
  ) return true;
  if (policy === undefined) return false;
  const allowed: readonly string[] = policy.allowedEffects;
  return steps.some((step) => {
    const effect = EFFECT_OF_ACTION[step.action];
    return effect !== undefined && !allowed.includes(effect);
  });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/** True when the preset is published in the compiler grammar (a document). */
function isPresetDocument(
  source: WorkflowPresetSource,
): source is WorkflowPresetDocument {
  return Object.hasOwn(source, "apiVersion");
}

/**
 * The authored node an action site points at, so a compiled site carries the
 * same literal input a flat step does. strict admission measures that input
 * (`stepReferencesEarlierOutput`) and the rule guard reads it, so neither may
 * lose it just because the engine resolves the input at dispatch time.
 */
function authoredNodeAt(
  document: WorkflowPresetDocument,
  path: readonly (string | number)[],
): Readonly<Record<string, unknown>> | undefined {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (typeof current !== "object" || current === null) return undefined;
  return current as Readonly<Record<string, unknown>>;
}

/**
 * The bounded repeat an action site sits in, read off its path through the
 * authored document: the nearest enclosing node that carries a `repeat`, with
 * that node's id and its `max`. Undefined for a site outside every repeat.
 */
export function repeatAround(
  document: WorkflowPresetDocument,
  path: readonly (string | number)[],
): { id: string; max: number } | undefined {
  let found: { id: string; max: number } | undefined;
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return found;
    const node = current as Record<string | number, unknown>;
    if (segment === "repeat") {
      const body = node.repeat;
      const max = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).max
        : undefined;
      if (
        typeof node.id === "string" && typeof max === "number" &&
        Number.isInteger(max) && max >= 1
      ) {
        found = { id: node.id, max };
      }
    }
    current = node[segment];
  }
  return found;
}

/**
 * The action steps a preset runs, in authored order, whatever grammar it is
 * published in. A flat spec lists them directly; a document compiles to a plan,
 * and the plan's action sites are the same actions with the containers' ids
 * prefixed onto their keys. Each site keeps the node's authored input and
 * condition, so strict admission and the rule guard read the same step shape
 * they read for a flat spec. A code-owned preset that no longer compiles is a
 * fault in the preset, not in the caller, so it fails as one.
 */
export async function presetActionSteps(
  source: WorkflowPresetSource,
): Promise<readonly FixedWorkflowStep[]> {
  if (!isPresetDocument(source)) return extractFixedWorkflowSteps(source);
  const { result, actionSites } = await compileWorkflowDocumentDetailed(
    source,
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  if (!result.ok) throw new Error("PRESET_DEFINITION_NOT_COMPILABLE");
  return actionSites.map((site, position) => {
    const node = authoredNodeAt(source, site.path) ?? {};
    const input = node.with ?? node.input ?? {};
    const repeat = repeatAround(source, site.path);
    return {
      key: site.qualifiedId,
      action: site.action,
      input,
      position,
      ...(node.if === undefined ? {} : { condition: node.if as string }),
      workflowAgentVersionId: null,
      stepAgentVersionId: null,
      ...(site.requires.length > 0 ? { requires: site.requires } : {}),
      ...(repeat === undefined ? {} : { repeat }),
    };
  });
}

/**
 * Materializes the organization's published workflow version for a preset.
 * Concurrent first runs serialize on an advisory lock, so every organization
 * shares exactly one version per preset revision; the stored digest is checked
 * against the code-owned digest on every call and fails closed on any drift.
 */
export async function ensurePresetWorkflowVersion(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  preset: WorkflowPresetDefinition,
): Promise<string> {
  await transaction.query(
    "select pg_advisory_xact_lock(hashtext('preset:' || $1::text || ':' || $2::text))",
    [organizationId, preset.id],
  );
  // The catalog origin is written once, at install, and only for a row this
  // insert creates. A row that already exists keeps whatever origin it has:
  // repairing a legacy row here would need a predicate that cannot tell a
  // pre-column preset row from a workflow a person authored under the same
  // `preset:` slug, which is precisely the provenance confusion this column
  // exists to prevent. The one-time repair lives in
  // migrations/data/0175_workflow_origin_provenance.ts instead.
  await transaction.query(
    `insert into bakery.workflow_definitions (
       organization_id, slug, name, description, enabled,
       origin_kind, origin_catalog_key, origin_catalog_version
     ) values ($1, $2, $3, $4, true, 'catalog', $5, $6)
     on conflict (organization_id, slug) do nothing`,
    [
      organizationId,
      preset.slug,
      preset.id,
      "Code-owned workflow preset materialized by the server.",
      preset.id,
      preset.revision,
    ],
  );
  const definition = await transaction.query<{ id: string }>(
    `select id from bakery.workflow_definitions
      where organization_id = $1 and slug = $2`,
    [organizationId, preset.slug],
  );
  const workflowId = definition.rows[0]?.id;
  if (!workflowId) throw new Error("PRESET_WORKFLOW_DEFINITION_MISSING");
  await transaction.query(
    `insert into bakery.workflow_versions (
       organization_id, workflow_id, revision, source_yaml, normalized_spec,
       digest, status, created_by
     ) values ($1, $2, $3, $4, $5::jsonb, $6, 'published', $7)
     on conflict (workflow_id, revision) do nothing`,
    [
      organizationId,
      workflowId,
      preset.revision,
      preset.sourceYaml,
      canonicalJson(preset.spec),
      preset.digest,
      principalId,
    ],
  );
  const stored = await transaction.query<{
    id: string;
    digest: string;
    status: string;
    normalized_spec: unknown;
  }>(
    `select id, digest, status, normalized_spec
       from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and revision = $3`,
    [organizationId, workflowId, preset.revision],
  );
  const version = stored.rows[0];
  if (!version) throw new Error("PRESET_WORKFLOW_VERSION_MISSING");
  if (
    version.digest !== preset.digest ||
    await sha256Hex(canonicalJson(version.normalized_spec)) !== preset.digest
  ) {
    conflict("preset_digest_mismatch");
  }
  if (version.status !== "published") conflict("workflow_not_published");
  await transaction.query(
    `update bakery.workflow_definitions
        set active_version_id = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and active_version_id is null`,
    [organizationId, workflowId, version.id],
  );
  return version.id;
}

type RepositoryRow = {
  archived_at: Date | string | null;
  active_profile_id: string | null;
  application_archived_at: Date | string | null;
};

/**
 * Evaluates the rules run admission enforces for the preset's steps. Agent
 * selection reuses the admission resolver and pricing and budget checks reuse
 * the budget predicates, so the verdict cannot drift from admission. Every
 * model step (implement, and for a review loop repair and review) is checked
 * with its own reasons, and the minimum budget is the reservation of one
 * mandatory path plus one repair cycle: implement, review, repair, review.
 */
export async function presetAvailability(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
  preset: WorkflowPresetDefinition,
  budgetLimitUsd: string,
  budgetPolicy: BudgetRuntimeConfig | undefined,
): Promise<AvailabilityOutput> {
  const repository = await transaction.query<RepositoryRow>(
    `select repository.archived_at, repository.active_profile_id,
            application.archived_at as application_archived_at
       from bakery.repositories repository
       join bakery.applications application
         on application.organization_id = repository.organization_id
        and application.id = repository.application_id
      where repository.organization_id = $1 and repository.id = $2`,
    [organizationId, repositoryId],
  );
  const row = repository.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const reasons = new Set<AvailabilityReason>();
  let minimumBudgetLimitUsd: string | null = null;
  if (row.archived_at !== null) reasons.add("repository_archived");
  if (row.application_archived_at !== null) reasons.add("application_archived");
  if (!budgetPolicyUsable(budgetPolicy)) {
    reasons.add("budget_policy_unavailable");
  }

  let config: z.output<typeof RepositoryVersionedProfileConfigSchema> | null =
    null;
  let activeProfile: { revision: number; digest: string } | null = null;
  if (row.active_profile_id !== null) {
    const profile = await transaction.query<
      { config: unknown; revision: number; digest: string }
    >(
      `select config, revision, digest from bakery.repository_profiles
        where organization_id = $1 and repository_id = $2 and id = $3`,
      [organizationId, repositoryId, row.active_profile_id],
    );
    const parsed = RepositoryVersionedProfileConfigSchema.safeParse(
      profile.rows[0]?.config,
    );
    if (parsed.success && profile.rows[0]) {
      config = parsed.data;
      activeProfile = {
        revision: profile.rows[0].revision,
        digest: profile.rows[0].digest,
      };
    }
  }
  if (config === null) {
    reasons.add("no_active_profile");
  } else {
    const steps = await presetActionSteps(preset.spec);
    if (fixedPolicyDeniesSteps(config, steps)) {
      reasons.add("profile_effect_denied");
    }

    // The same rule check run admission applies to the run's own steps, over
    // the same pin, so the composer never offers a start admission refuses.
    if (activeProfile !== null && row.active_profile_id !== null) {
      const pin = await pinEffectiveRepositoryRules(
        transaction,
        organizationId,
        {
          repositoryId,
          id: row.active_profile_id,
          revision: activeProfile.revision,
          digest: activeProfile.digest,
          repositoryRules: config.repositoryRules,
        },
      );
      try {
        assertStepsSatisfyRules(pin, steps);
      } catch (error) {
        if (
          !(error instanceof StandardError) || error.code !== "UNPROCESSABLE"
        ) {
          throw error;
        }
        reasons.add("required_check_missing");
      }
    }

    const modelSteps = steps.filter((step) => isModelAction(step.action));
    if (!modelSteps.some((step) => step.action === "harness.implement")) {
      throw new Error("PRESET_CODING_STEP_MISSING");
    }
    // Micro-USD reserved by each model step whose agent resolved with billing.
    const reservations = new Map<string, bigint>();
    for (const step of modelSteps) {
      const agentReasons = AGENT_REASONS_BY_ACTION[step.action];
      if (agentReasons === undefined) {
        throw new Error("PRESET_AGENT_STEP_UNSUPPORTED");
      }
      if (
        selectStepAgentVersion({
          action: step.action,
          stepAgentVersionId: step.stepAgentVersionId,
          workflowAgents: step.workflowAgentVersionId === null
            ? undefined
            : { [step.action]: step.workflowAgentVersionId },
          profileAgentBindings: config.agentBindings,
        }).source === "none"
      ) {
        reasons.add(agentReasons.unbound);
        continue;
      }
      try {
        const agents = await resolveFrozenStepAgents(
          transaction,
          organizationId,
          [step],
          config.agentBindings,
        );
        const billing = agents[step.key]?.config.billing;
        if (billing === undefined) continue;
        if (await findTrustedPricingSnapshot(transaction, billing) === null) {
          reasons.add(agentReasons.unpriced);
        }
        reservations.set(
          step.key,
          parseMicroUsd(billing.maxUsdReservation, "max_usd_reservation"),
        );
      } catch (error) {
        // A skill binding that no longer resolves makes the pinned agent
        // version unusable, which is the same verdict as a disabled agent.
        if (!(error instanceof StandardError)) throw error;
        if (error.code === "UNPROCESSABLE") {
          reasons.add(agentReasons.disabled);
        } else if (error.code === "STATE_CONFLICT") {
          const problem = AGENT_PROBLEM_BY_CONFLICT[
            String(error.params?.reason)
          ];
          // Unknown conflicts are real admission failures; never relabel them.
          if (problem === undefined) throw error;
          reasons.add(agentReasons[problem]);
        } else throw error;
      }
    }
    if (reservations.size === modelSteps.length) {
      let minimum = 0n;
      for (const reservation of reservations.values()) minimum += reservation;
      // A flat review loop reviews once on its mandatory path and again after
      // the repair step, which the flat spec does not list as its own review.
      // A compiled document lists every action once, its repeat body included,
      // so its model steps already are the path plus one repair cycle.
      if (isReviewLoopSpec(preset.spec)) {
        const review = modelSteps.find((step) =>
          step.action === "review.independent"
        );
        minimum += review === undefined ? 0n : reservations.get(review.key)!;
      }
      minimumBudgetLimitUsd = formatMicroUsd(minimum);
      if (parseMicroUsd(budgetLimitUsd, "budget_limit") < minimum) {
        reasons.add("budget_below_reservation");
      }
    }
  }
  const ordered = REASON_ORDER.filter((reason) => reasons.has(reason));
  return {
    status: ordered.length === 0 ? "ready" : "setup_required",
    reasons: ordered,
    minimumBudgetLimitUsd,
  };
}

/** One preset as the list read returns it; the repair loop's steps name their repeat. */
export function presetOutput(
  preset: WorkflowPresetDefinition,
  steps: readonly FixedWorkflowStep[],
  availability: AvailabilityOutput | null,
): WorkflowPresetOutput {
  return {
    definition: preset.spec as unknown as WorkflowPresetOutput["definition"],
    startableFromComposer: presetStartableFromComposer(preset),
    id: preset.id,
    revision: preset.revision,
    digest: preset.digest,
    nameKey: preset.nameKey,
    steps: steps.map((step) => ({
      id: step.key,
      uses: step.action,
      ...(step.repeat === undefined
        ? {}
        : { repeatId: step.repeat.id, repeatMax: step.repeat.max }),
    })),
    defaultBudgetLimitUsd: preset.defaultBudgetLimitUsd,
    availability,
  };
}

/** The inputs a preset's definition declares, by name; a flat preset declares none. */
function declaredInputs(
  preset: WorkflowPresetDefinition,
): Readonly<Record<string, Readonly<{ required: boolean }>>> {
  return isPresetDocument(preset.spec) ? preset.spec.inputs : {};
}

/** The inputs the server builds from the task, plus the one the run request may carry. */
const COMPOSER_INPUTS: readonly string[] = Object.freeze([
  "repositoryId",
  "brief",
  "instructions",
  "gates",
]);

/**
 * Whether a run of the preset can start from the new-task composer: every input
 * its definition requires is built from the task or carried by the run request.
 */
export function presetStartableFromComposer(
  preset: WorkflowPresetDefinition,
): boolean {
  return Object.entries(declaredInputs(preset)).every(([name, input]) =>
    !input.required || COMPOSER_INPUTS.includes(name)
  );
}

/** Whether the preset's definition declares a `gates` input, the plan sign-off switch. */
export function presetDeclaresGates(
  preset: WorkflowPresetDefinition,
): boolean {
  return Object.hasOwn(declaredInputs(preset), "gates");
}

/**
 * The run inputs of a preset run: the brief the server builds from the task,
 * and for a preset that declares `gates` the sign-off switch the run request
 * chose, which defaults to pausing for the plan's approval.
 */
export function presetRunInputs(
  preset: WorkflowPresetDefinition,
  task: Parameters<typeof presetBriefInputs>[0],
  approvedPlan: ApprovedPlanForInstructions | null | undefined,
  gates: "plan" | "none" | undefined,
): ReturnType<typeof presetBriefInputs> & { gates?: "plan" | "none" } {
  const inputs = presetBriefInputs(task, approvedPlan);
  const declared = declaredInputs(preset);
  const carried = Object.fromEntries(
    Object.entries(inputs).filter(([name]) => Object.hasOwn(declared, name)),
  ) as typeof inputs;
  return presetDeclaresGates(preset)
    ? { ...carried, gates: gates ?? "plan" }
    : carried;
}

/** Run inputs cap is 100000 bytes; the brief plan keeps this much headroom. */
const BRIEF_INPUT_BUDGET_BYTES = 90_000;
const DETAIL_TRUNCATION_MARKER = " [truncated]";
const textEncoder = new TextEncoder();

function byteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

function markShortened(detail: string, cap: number): boolean {
  return cap === 0 ? detail.length > 0 : detail.length > cap;
}

function truncateDetail(detail: string, maxChars: number): string {
  if (detail.length <= maxChars) return detail;
  let end = Math.max(0, maxChars - DETAIL_TRUNCATION_MARKER.length);
  const last = detail.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return detail.slice(0, end) + DETAIL_TRUNCATION_MARKER;
}

/**
 * Shrink the frozen plan so brief plus instructions stay inside the run-inputs
 * cap. Plan identity (revision id, digest, step ids and titles) is always kept;
 * only step detail is cut, longest budget first, then dropped.
 */
export function boundBriefPlan(
  plan: ApprovedPlanForInstructions,
  otherBytes: number,
): ApprovedPlanForInstructions {
  const budget = BRIEF_INPUT_BUDGET_BYTES - otherBytes;
  if (byteLength(plan) <= budget) return plan;
  for (const cap of [2000, 1000, 500, 200, 80, 0]) {
    const next: ApprovedPlanForInstructions = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        detail: cap === 0 ? "" : truncateDetail(step.detail, cap),
        ...(markShortened(step.detail, cap) ? { detailShortened: true } : {}),
      })),
    };
    if (byteLength(next) <= budget) return next;
  }
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      detail: "",
      ...(step.detail.length > 0 ? { detailShortened: true } : {}),
    })),
  };
}

/** Frozen brief the server builds from the task row; clients never supply it. */
export function presetBriefInputs(
  task: {
    title: string;
    description: string;
    task_type: string;
    repository_id?: string | null;
  },
  approvedPlan?: ApprovedPlanForInstructions | null,
): {
  repositoryId: string | null;
  brief: {
    title: string;
    description: string;
    taskType: string;
    approvedPlan?: ApprovedPlanForInstructions;
  };
  instructions: string;
} {
  const base = {
    title: task.title,
    description: task.description,
    taskType: task.task_type,
  };
  const instructions = renderImplementInstructions({
    title: task.title,
    description: task.description,
    approvedPlan,
  });
  const bounded = approvedPlan
    ? boundBriefPlan(
      approvedPlan,
      byteLength(base) + byteLength(instructions) + 64,
    )
    : null;
  return {
    repositoryId: task.repository_id ?? null,
    brief: { ...base, ...(bounded ? { approvedPlan: bounded } : {}) },
    instructions,
  };
}

export function createWorkflowPresetHandlers(
  options: {
    budget?: BudgetRuntimeConfig;
    presets?: readonly WorkflowPresetDefinition[];
  } = {},
) {
  return {
    async workflowPresetsList(
      context: ActionContext,
      input: unknown,
    ): Promise<PresetPage> {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const repositoryId = (input as { repositoryId?: string } | undefined)
        ?.repositoryId;
      const items: WorkflowPresetOutput[] = [];
      for (const preset of options.presets ?? WORKFLOW_PRESETS) {
        items.push(presetOutput(
          preset,
          await presetActionSteps(preset.spec),
          repositoryId === undefined ? null : await presetAvailability(
            transaction,
            organizationId,
            repositoryId,
            preset,
            preset.defaultBudgetLimitUsd,
            options.budget,
          ),
        ));
      }
      return { items, nextCursor: null };
    },
  };
}
