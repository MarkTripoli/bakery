import { toRunEnvironment } from "./run-environment.ts";
import { z } from "zod";
import { type ActionContext } from "@bakery/contracts/action-registry";
import {
  contractSchemas,
  serializedJsonByteLength,
} from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  type RepositoryVersionedProfileConfig,
  type RunPlacement,
  RunPlacementSchema,
} from "@bakery/contracts/repository-inspection";
import {
  admitRepositoryProfile,
  executionJobInputFitsTransport,
} from "@bakery/persistence/repository-admission";
import { WORKFLOW_ACTION_METADATA } from "@bakery/contracts/workflow-action-registry";
import {
  type PinnedRepositoryRules,
  STEP_OUTPUT_ALLOWANCE_BYTES,
} from "@bakery/contracts/repository-rules";
import { workflowPresetById } from "@bakery/contracts/workflow-presets";
import type { FrozenActionBinding } from "@bakery/persistence";
import type { ReviewLoopLimits } from "@bakery/persistence/repository-admission";
import { planReviewLoopLimits } from "../review-loop/limits.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { assertStepSkillsAllowed } from "../catalog/skill-use-grants.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import { auditAgentSessionId } from "../auth/application/agent-power-grants.ts";
import { authorize } from "../auth/application/authorize.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import {
  pinDeclaredRunInputs,
  recordInputPaths,
  resolveInputPaths,
} from "./run-input-pins.ts";
import { requestRunStart } from "./run-start.ts";
import { resolveDependencyReadiness } from "./dependency-readiness.ts";
import {
  appendTaskProjectionEvent,
  loadTaskScope,
  lockApplication,
  type TaskRow,
  toIso,
  toTask,
} from "./postgres.ts";
import {
  deriveRunWorkspaceRequirement,
  type FixedWorkflowStep,
} from "./run-steps.ts";
import {
  resolveScopeProfileDefaults,
  type ScopeProfileDefaults,
  type WorkspaceRequirement,
} from "@bakery/contracts/scope-profiles";
import { readProjectScopeProfile } from "../projects/scope-profiles.ts";
import {
  formatMicroUsd,
  isModelAction,
  parseMicroUsd,
  type RunBudgetSummary,
} from "./budget.ts";
import {
  evaluateLaneAdmission,
  type LaneCoordinationSnapshot,
} from "./coordination-admission.ts";
import type { FrozenStepAgents } from "./agent-run-admission.ts";
import { admitStagePolicy } from "./stage-admission.ts";
import { ticketRequestBlocksRun } from "./ticket-run-guard.ts";
import { pinEffectiveRepositoryRules } from "../repository-rules/pinned.ts";
import { fixedPolicyPins as fixedPolicyPinsOf } from "../repository-rules/policy-digest.ts";
import { assertPlanSatisfiesRules } from "../workflows/rule-guard.ts";
import { writePlanRun } from "../workflow-adapter/plan-admission.ts";
import { assertNotQuiesced } from "../../platform/maintenance.ts";
import {
  type PlanAdmission,
  resolvePlanAdmission,
} from "./plan-run-admission.ts";
import {
  assertConnectionsBindable,
  ingestConnectionInput,
  type StorageConnectionDeps,
} from "../knowledge/storage-connections.ts";
import {
  boundStepConnections,
  buildWorkflowPlan,
} from "@bakery/contracts/workflow-compiler";
import {
  ensurePresetWorkflowVersion,
  fixedPolicyDeniesSteps,
  presetBriefInputs,
} from "./workflow-presets.ts";

type RunCreateInput = z.output<typeof contractSchemas.RunCreate>;
type RunOutput = z.output<typeof contractSchemas.Run>;

type TaskAdmissionRow = {
  id: string;
  application_id: string;
  repository_id: string | null;
  conversation_id: string;
  parent_task_id: string | null;
  priority: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  title: string;
  description: string;
  task_type: string;
  status: string;
  archived_at: Date | string | null;
  current_run_id: string | null;
  version: number;
  repository_profile_id: string | null;
  repository_profile_revision: number | null;
  repository_profile_digest: string | null;
  observation_id: string | null;
  observation_digest: string | null;
  base_sha: string | null;
  approval_policy: unknown;
  planning_only: boolean;
};

type WorkflowVersionRow = {
  id: string;
  workflow_id: string;
  revision: number;
  normalized_spec: unknown;
  digest: string;
  status: string;
  enabled: boolean;
};

type ProfileRow = {
  repository_id: string;
  application_id: string;
  id: string;
  revision: number;
  digest: string;
  config: RepositoryVersionedProfileConfig;
  archived_at: Date | string | null;
  observationId: string | null;
  observationDigest: string | null;
  baseSha: string | null;
};
type PersistedProfileRow =
  & Omit<
    ProfileRow,
    "config" | "observationId" | "observationDigest" | "baseSha"
  >
  & { config: unknown; active_profile_id: string | null };
const MAX_RUN_JSON_BYTES = 100_000;

type DependencyRow = {
  depends_on_task_id: string;
  status: string;
  application_id: string;
};

/** Actions whose output is `HarnessOutput`, the only report of a workspace base. */
const HARNESS_ACTIONS: readonly string[] = Object.freeze(
  Object.entries(WORKFLOW_ACTION_METADATA)
    .filter(([, metadata]) => metadata.output === "HarnessOutput")
    .map(([name]) => {
      // Inlined into SQL below, so refuse anything but a plain action name.
      if (!/^[a-z][a-z0-9_.-]*$/.test(name)) {
        throw new Error("WORK_HARNESS_ACTION_NAME_INVALID");
      }
      return name;
    }),
);

/**
 * SQL column `workspace_base_sha` for the run row `runRef` (a table alias or
 * name already in scope, such as `run` or `workflow_runs`): the commit the
 * run's first completed harness step started from, as its worker reported it
 * in the step output. The first completed harness step decides; a base that is
 * not a git SHA yields null rather than a later step's base. `base_sha` stays
 * the admission pin of the inspected observation, so this is read, never
 * written to `workflow_runs`.
 */
export function runWorkspaceBaseShaColumn(runRef: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(runRef)) {
    throw new Error("WORK_RUN_REFERENCE_INVALID");
  }
  const actions = HARNESS_ACTIONS.map((name) => `'${name}'`).join(", ");
  return `(select case
              when first_harness.base ~ '^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$'
              then first_harness.base
            end
       from (select step.output->>'baseSha' as base
               from bakery.run_steps step
               join bakery.jobs job
                 on job.organization_id = step.organization_id
                and job.run_step_id = step.id
              where step.organization_id = ${runRef}.organization_id
                and step.run_id = ${runRef}.id
                and step.status = 'completed'
                and job.action in (${actions})
              order by step.position, step.iteration, step.id
              limit 1) first_harness) as workspace_base_sha`;
}

type RunBaseRow = {
  id: string;
  repository_profile_id: string | null;
  repository_profile_revision: number | null;
  repository_profile_digest: string | null;
  observation_id: string | null;
  observation_digest: string | null;
  base_sha: string | null;
  workspace_base_sha: string | null;
  requested_by: string;
  inngest_run_id: string | null;
  status: string;
  budget_limit_usd: string | number;
  environment: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type WorkflowRunRow = RunBaseRow & {
  kind?: "workflow" | null;
  task_id: string;
  workflow_version_id: string;
  skill_source_id?: null;
};

type SkillImportRunRow = RunBaseRow & {
  kind: "skill_import";
  task_id: null;
  workflow_version_id: null;
  skill_source_id: string;
};

export type RunRow = WorkflowRunRow | SkillImportRunRow;
const runStatuses: Record<RunOutput["status"], true> = {
  queued: true,
  running: true,
  waiting_input: true,
  waiting_capacity: true,
  paused: true,
  canceling: true,
  canceled: true,
  completed: true,
  failed: true,
  blocked: true,
};

function isRunStatus(value: string): value is RunOutput["status"] {
  return Object.hasOwn(runStatuses, value);
}

type RunStatus = "queued" | "blocked";

type RunDependencySnapshot = {
  taskId: string;
  status: string;
};

type RunSnapshot = {
  schemaVersion: 1;
  executionMode: "repository" | "cloud_only";
  inputs: unknown;
  workflow: {
    id: string;
    revision: number;
    digest: string;
    normalizedSpec: unknown;
  };
  repositoryProfile: {
    organizationId: string;
    applicationId: string;
    repositoryId: string;
    id: string;
    revision: number;
    digest: string;
    config: unknown;
    observationId: string | null;
    observationDigest: string | null;
    baseSha: string | null;
    fixedPolicyDigest?: string;
    trustedCheckerConfigDigest?: string;
    /** Effective repository rules frozen at admission; never re-read. */
    repositoryRules: PinnedRepositoryRules;
  } | null;
  stepAgents: FrozenStepAgents;
  stepActions: Readonly<Record<string, FrozenActionBinding>>;
  admission: {
    dependencies: readonly RunDependencySnapshot[];
    status: RunStatus;
    reason: string | null;
  };
  /**
   * Review and repair loop bounds frozen at admission. Present only when the
   * workflow has the loop shape (`isReviewLoopSpec`); read back through
   * `reviewLoopFromSnapshot`, never re-derived from constants.
   */
  reviewLoop?: ReviewLoopLimits;
  /** Present only for a coordination lane child: plan identity and typed handoffs. */
  coordination?: LaneCoordinationSnapshot;
  /**
   * The workspaces the run's steps declare, derived once at admission (O23).
   * `required: false` is a run that mounts no repository.
   */
  workspaceRequirement?: WorkspaceRequirement;
  /**
   * The project's scope profile defaults the run inherits, pinned by revision
   * and digest at admission; revision 0 is the empty baseline.
   */
  scopeProfile?: ScopeProfileDefaults & { applicationId: string };
  /**
   * Present only for a compiled-plan run: the frozen document and its pin, the
   * `$task` the plan reads, the agents its steps run as and each action's
   * fallback agent. Written by `writePlanRun`, which reads it back as the
   * engine will before this snapshot is inserted.
   */
  runtime?: unknown;
  task?: unknown;
  planAgents?: unknown;
  planActionAgents?: unknown;
};

export { resolveDependencyReadiness };

function buildRunSnapshot(options: {
  executionMode: RunSnapshot["executionMode"];
  inputs: unknown;
  workflow: RunSnapshot["workflow"];
  repositoryProfile: RunSnapshot["repositoryProfile"];
  stepAgents: FrozenStepAgents;
  stepActions: RunSnapshot["stepActions"];
  dependencies: readonly RunDependencySnapshot[];
  reviewLoop: ReviewLoopLimits | null;
  workspaceRequirement: WorkspaceRequirement;
  scopeProfile: NonNullable<RunSnapshot["scopeProfile"]>;
}): RunSnapshot {
  const admission = resolveDependencyReadiness(options.dependencies);
  return {
    schemaVersion: 1,
    executionMode: options.executionMode,
    inputs: options.inputs,
    workflow: options.workflow,
    repositoryProfile: options.repositoryProfile,
    stepAgents: options.stepAgents,
    stepActions: options.stepActions,
    admission: {
      dependencies: options.dependencies.map((dependency) => ({
        taskId: dependency.taskId,
        status: dependency.status,
      })),
      status: admission.status,
      reason: admission.reason,
    },
    ...(options.reviewLoop === null ? {} : { reviewLoop: options.reviewLoop }),
    workspaceRequirement: options.workspaceRequirement,
    scopeProfile: options.scopeProfile,
  };
}

/**
 * Refuses a run whose budget cannot cover a model step's reservation. Engine
 * admission reserves that amount against the run budget and refuses the same
 * way, so a run created without this check could only fail later. Steps
 * without a model action reserve nothing and are not checked.
 */
function assertBudgetCoversReservations(
  steps: readonly Pick<FixedWorkflowStep, "key" | "action">[],
  stepAgents: FrozenStepAgents,
  budgetLimitUsd: string,
): void {
  const limit = parseMicroUsd(budgetLimitUsd, "budget_limit");
  for (const step of steps) {
    const billing = stepAgents[step.key]?.config.billing;
    if (billing === undefined || !isModelAction(step.action)) continue;
    if (
      limit < parseMicroUsd(billing.maxUsdReservation, "max_usd_reservation")
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "budget_below_reservation" },
      });
    }
  }
}

const MAX_RUN_BUDGET_USD = "200";

function workflowCeilingUsd(workflow: WorkflowVersionRow): number | undefined {
  const spec = workflow.normalized_spec as
    | { limits?: { maxCostUsd?: number } }
    | null;
  const ceiling = spec?.limits?.maxCostUsd;
  return typeof ceiling === "number" ? ceiling : undefined;
}

export function capBudgetAtWorkflowCeiling(
  requested: string | undefined,
  ceilingUsd: number | undefined,
): string {
  if (requested === undefined && ceilingUsd === undefined) return "0";
  const candidates = [
    requested,
    ceilingUsd === undefined
      ? undefined
      : formatMicroUsd(parseMicroUsd(String(ceilingUsd), "max_cost")),
  ].filter((value): value is string => value !== undefined);
  const lowest = candidates.reduce((left, right) =>
    parseMicroUsd(left, "budget_limit") <= parseMicroUsd(right, "max_cost")
      ? left
      : right
  );
  return parseMicroUsd(lowest, "budget_limit") >
      parseMicroUsd(MAX_RUN_BUDGET_USD, "budget_limit")
    ? MAX_RUN_BUDGET_USD
    : lowest;
}

export function validateBudgetLimitUsd(value: unknown): string {
  if (value === undefined) return "0";
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(value) ||
    Number(value) > Number(MAX_RUN_BUDGET_USD)
  ) {
    throw unprocessable(["budgetLimitUsd"], "budget_limit_invalid");
  }
  return value;
}

/**
 * The repositories a run is bound to: the task's own repository, plus every
 * repository linked to it. Coordination inserts a `task_repositories` row per
 * (task, repository) so a multi-repository plan's lanes each bind their own;
 * an ordinary task has no rows and is bound to its own repository alone.
 */
async function boundRepositoryIds(
  transaction: PgTransactionClient,
  organizationId: string,
  task: { id: string; repository_id: string | null },
): Promise<Set<string>> {
  const bound = new Set<string>();
  if (task.repository_id !== null) bound.add(task.repository_id);
  const links = await transaction.query<{ repository_id: string }>(
    `select repository_id from bakery.task_repositories
      where organization_id = $1 and task_id = $2`,
    [organizationId, task.id],
  );
  for (const row of links.rows) bound.add(row.repository_id);
  return bound;
}

/**
 * A plan may name a repository in its inputs. Refuse one the run is not bound
 * to, so a supplied `repositoryId` cannot redirect a step away from the task's
 * own repositories. Membership, not equality with the profile: a lane binds its
 * own repository, which is deliberately not the profile's.
 */
async function assertSuppliedRepositoryIsBound(
  transaction: PgTransactionClient,
  organizationId: string,
  task: { id: string; repository_id: string | null },
  inputs: unknown,
): Promise<void> {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    return;
  }
  const supplied = (inputs as Record<string, unknown>).repositoryId;
  if (typeof supplied !== "string") return;
  const bound = await boundRepositoryIds(transaction, organizationId, task);
  if (!bound.has(supplied)) {
    throw unprocessable(
      ["inputs", "repositoryId"],
      "repository_not_bound_to_task",
    );
  }
}

export function validateRunInputs(value: unknown): unknown {
  if (jsonBytes(value, ["inputs"]) > MAX_RUN_JSON_BYTES) {
    throw unprocessable(["inputs"], "inputs_too_large");
  }
  return value;
}

function jsonBytes(value: unknown, path: (string | number)[]): number {
  try {
    return serializedJsonByteLength(value);
  } catch (error) {
    throw unprocessable(path, "json_invalid", error);
  }
}
async function assertWorkflowVersionValid(
  workflow: WorkflowVersionRow,
): Promise<void> {
  let byteLength: number;
  let digest: string;
  try {
    byteLength = serializedJsonByteLength(workflow.normalized_spec);
    digest = await sha256Hex(canonicalJson(workflow.normalized_spec));
  } catch (error) {
    throw new Error("WORKFLOW_VERSION_INVALID", { cause: error });
  }
  if (
    byteLength > MAX_RUN_JSON_BYTES ||
    !Number.isInteger(workflow.revision) ||
    workflow.revision < 1 ||
    !/^[a-f0-9]{64}$/i.test(workflow.digest) ||
    digest !== workflow.digest.toLowerCase()
  ) {
    throw new Error("WORKFLOW_VERSION_INVALID");
  }
}

/**
 * Legacy projection for runs without a persisted budget account. New model
 * admissions create the account and read paths replace this with ledger data.
 */
function runBudgetSummary(row: RunRow): RunOutput["budgetSummary"] {
  const budgetLimitUsd = String(row.budget_limit_usd);
  return {
    installation: null,
    run: {
      scope: "run",
      runId: row.id,
      periodStart: null,
      periodEnd: null,
      limitUsd: budgetLimitUsd,
      reservedUsd: "0",
      settledUsd: "0",
      availableUsd: budgetLimitUsd,
      unknownCount: 1,
    },
  };
}

export function toRun(
  row: RunRow,
  budgetSummary: RunOutput["budgetSummary"] | RunBudgetSummary =
    runBudgetSummary(row),
): RunOutput {
  const kind = row.kind ?? "workflow";
  const validOwner = kind === "workflow"
    ? row.task_id !== null && row.workflow_version_id !== null &&
      (row.skill_source_id === undefined || row.skill_source_id === null)
    : row.task_id === null && row.workflow_version_id === null &&
      typeof row.skill_source_id === "string";
  // A producer that forgot the projection must fail, not read as "unknown".
  if (
    !isRunStatus(row.status) || !validOwner ||
    row.workspace_base_sha === undefined
  ) {
    throw new Error("WORK_READ_RUN_INVALID");
  }
  return {
    id: row.id,
    kind,
    taskId: row.task_id,
    workflowVersionId: row.workflow_version_id,
    skillSourceId: row.skill_source_id ?? null,
    repositoryProfileId: row.repository_profile_id,
    repositoryProfileRevision: row.repository_profile_revision,
    repositoryProfileDigest: row.repository_profile_digest,
    observationId: row.observation_id,
    observationDigest: row.observation_digest,
    baseSha: row.base_sha,
    workspaceBaseSha: row.workspace_base_sha,
    requestedBy: row.requested_by,
    inngestRunId: row.inngest_run_id,
    status: row.status as RunOutput["status"],
    budgetLimitUsd: String(row.budget_limit_usd),
    environment: toRunEnvironment(row.environment),
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
    budgetSummary,
  };
}

async function appendRunFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    run: RunRow;
    task: TaskAdmissionRow;
    taskVersion: number;
    status: RunStatus;
    reason: string | null;
    /** The agent session that made the call (O50), or null. */
    agentSessionId: string | null;
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type, resource_id,
       outcome, request_id, trace_id, details, agent_session_id
     ) values ($1, $2, 'runs.create', 'workflow_run', $3, 'succeeded', $4, $5, $6::jsonb, $7)`,
    [
      options.organizationId,
      options.principalId,
      options.run.id,
      options.requestId,
      options.traceId,
      JSON.stringify({ status: options.status, reason: options.reason }),
      options.agentSessionId,
    ],
  );
  if (options.status === "queued") {
    await requestRunStart(transaction, {
      organizationId: options.organizationId,
      applicationId: options.task.application_id,
      repositoryId: options.task.repository_id,
      taskId: options.task.id,
      conversationId: options.task.conversation_id,
      runId: options.run.id,
      runVersion: options.run.version,
      traceId: options.traceId,
    });
  } else {
    const sequence = await nextOrganizationSequence(
      transaction,
      options.organizationId,
    );
    await transaction.query(
      `insert into bakery.domain_events (
         organization_id, organization_sequence, event_type, schema_version,
         application_id, repository_id, task_id, conversation_id, aggregate_id,
         aggregate_version, payload, trace_id
       ) values ($1, $2, 'run.blocked', 1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        options.organizationId,
        sequence,
        options.task.application_id,
        options.task.repository_id,
        options.task.id,
        options.task.conversation_id,
        options.run.id,
        options.run.version,
        JSON.stringify({
          resourceId: options.run.id,
          resourceVersion: options.run.version,
          taskId: options.task.id,
          status: options.status,
          reason: options.reason,
        }),
        options.traceId,
      ],
    );
  }
  await appendTaskProjectionEvent(transaction, {
    organizationId: options.organizationId,
    eventType: "tasks.updated",
    taskId: options.task.id,
    version: options.taskVersion,
    applicationId: options.task.application_id,
    repositoryId: options.task.repository_id,
    conversationId: options.task.conversation_id,
    traceId: options.traceId,
  });
}

async function loadTaskForAdmission(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<TaskAdmissionRow> {
  const result = await transaction.query<TaskAdmissionRow>(
    `select id, application_id, repository_id, conversation_id, title,
            parent_task_id, priority, created_by, created_at, updated_at,
            description, task_type, status, archived_at, current_run_id, version,
            repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha,
            approval_policy, planning_only
       from bakery.tasks
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

// Run admission locks the task's application before the workflow definition.
// The shared definition lock blocks a concurrent disable/update while allowing
// concurrent admissions to read the immutable published version. Deactivation
// may lock the definition only when it takes no application or task locks later.
async function loadWorkflowVersion(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowVersionId: string,
): Promise<WorkflowVersionRow> {
  const result = await transaction.query<WorkflowVersionRow>(
    `select workflow_version.id, workflow_version.workflow_id,
            workflow_version.revision,
            workflow_version.normalized_spec, workflow_version.digest,
            workflow_version.status, workflow_definition.enabled
       from bakery.workflow_versions workflow_version
       join bakery.workflow_definitions workflow_definition
         on workflow_definition.organization_id = workflow_version.organization_id
        and workflow_definition.id = workflow_version.workflow_id
      where workflow_version.organization_id = $1
        and workflow_version.id = $2
      for share of workflow_definition`,
    [organizationId, workflowVersionId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!row.enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_disabled" },
    });
  }
  if (row.status !== "published") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_not_published" },
    });
  }
  return row;
}

/**
 * The version a run starts from: the definition's active one. A catalog
 * definition is system managed and is run through ticket admission, which pins
 * its revision, never started directly by id. The refusal reads the
 * definition's immutable origin, like the authoring lock, and never the slug: a
 * person's own definition whose slug merely starts with "preset:" is theirs to
 * run, and a catalog definition under an ordinary slug is not.
 */
export async function loadActiveWorkflowVersionId(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<string> {
  const result = await transaction.query<{
    origin_kind: string;
    enabled: boolean;
    active_version_id: string | null;
  }>(
    `select origin_kind, enabled, active_version_id
       from bakery.workflow_definitions
      where organization_id = $1
        and id = $2
        for share`,
    [organizationId, workflowId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.origin_kind === "catalog") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_locked" },
    });
  }
  if (!row.enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_disabled" },
    });
  }
  if (row.active_version_id === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_not_active" },
    });
  }
  return row.active_version_id;
}

async function loadProfile(
  transaction: PgTransactionClient,
  organizationId: string,
  task: TaskAdmissionRow,
  requestedProfileId: string | undefined,
): Promise<ProfileRow> {
  if (task.repository_id === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_required" },
    });
  }
  if (requestedProfileId === undefined) {
    throw unprocessable(["repositoryProfileId"], "repository_profile_required");
  }
  const profileId = requestedProfileId.toLowerCase();
  if (
    task.repository_profile_id === null ||
    profileId !== task.repository_profile_id
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_profile_mismatch" },
    });
  }
  const result = await transaction.query<PersistedProfileRow>(
    `select p.id, p.repository_id, r.application_id, p.revision, p.digest,
            p.config, r.archived_at, r.active_profile_id
       from bakery.repository_profiles p
       join bakery.repositories r
         on r.organization_id = p.organization_id and r.id = p.repository_id
      where p.organization_id = $1 and p.id = $2
        and p.repository_id = $3 and r.application_id = $4
      for share of r`,
    [
      organizationId,
      profileId,
      task.repository_id,
      task.application_id,
    ],
  );
  const profile = result.rows[0];
  if (!profile) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (profile.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_archived" },
    });
  }
  if (profile.active_profile_id !== profile.id) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_profile_not_current" },
    });
  }
  if (
    task.repository_profile_revision === null ||
    task.repository_profile_digest === null
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_profile_pin_mismatch" },
    });
  }
  const admitted = await admitRepositoryProfile(
    transaction,
    {
      organizationId,
      applicationId: task.application_id,
      repositoryId: task.repository_id,
    },
    profile,
    {
      repositoryProfileId: task.repository_profile_id,
      repositoryProfileRevision: task.repository_profile_revision,
      repositoryProfileDigest: task.repository_profile_digest,
      observationId: task.observation_id,
      observationDigest: task.observation_digest,
      baseSha: task.base_sha,
    },
  );
  return {
    ...profile,
    config: admitted.config,
    observationId: admitted.observationId,
    observationDigest: admitted.observationDigest,
    baseSha: admitted.baseSha,
  };
}

async function loadDependencies(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<readonly DependencyRow[]> {
  const result = await transaction.query<DependencyRow>(
    `select d.depends_on_task_id, prerequisite.status,
            prerequisite.application_id
       from bakery.task_dependencies d
       join bakery.tasks prerequisite
         on prerequisite.organization_id = d.organization_id
        and prerequisite.id = d.depends_on_task_id
      where d.organization_id = $1 and d.task_id = $2
      order by d.created_at asc, d.id asc
      for share of prerequisite`,
    [organizationId, taskId],
  );
  return result.rows;
}

/**
 * The worker transport bounds the complete job input, including the
 * server-injected repository profile, so measure what admission can before any
 * run exists: the run's inputs, the profile and rules every job carries, and the
 * 2,048-byte `STEP_OUTPUT_ALLOWANCE_BYTES`, which covers identifiers such as
 * artifact and version ids but not the repair step: its input carries the failed checks and
 * the blocking findings, up to about 23.9 kB in the worst case. That step fits
 * only because the pinned profile and rules always leave at least 30,000 bytes
 * of the job input bound (`ORGANIZATION_RULES_MAX_BYTES`) and the
 * `$delivery.blockingFindings` resolver never passes more than the
 * 20,000-byte findings budget (`REVIEW_LOOP_LIMITS.resultByteBudget`). A unit
 * case (the worst-case repair input stays inside the job input step margin)
 * recomputes that margin; this estimate does not.
 */
function assertJobInputsFit(
  snapshot: RunSnapshot,
  options: { strict: boolean },
): void {
  // A preset's oversized brief is reported on its description; a plain
  // workflow's input comes from the run inputs.
  const inputsPath = options.strict ? ["description"] : ["inputs"];
  // A compiled plan has no steps to resolve here: each action's input is built
  // by the engine from earlier results. What admission can bound is the run's
  // own inputs plus the profile and rules every job carries.
  const base: Record<string, unknown> = {
    inputs: snapshot.inputs,
    stepOutputAllowance: "x".repeat(STEP_OUTPUT_ALLOWANCE_BYTES),
  };
  const withProfile = (profile: unknown) =>
    snapshot.repositoryProfile === null
      ? base
      : { ...base, repositoryProfile: profile };
  if (executionJobInputFitsTransport(withProfile(snapshot.repositoryProfile))) {
    return;
  }
  // Name the pinned rules when they alone push the input over the bound.
  const { repositoryRules: _pin, ...bareProfile } =
    snapshot.repositoryProfile ?? {};
  if (
    snapshot.repositoryProfile !== null &&
    executionJobInputFitsTransport(withProfile(bareProfile))
  ) {
    throw unprocessable(["repositoryRules"], "repository_rules_too_large");
  }
  throw unprocessable(inputsPath, "inputs_too_large");
}

export async function createRunCommand(
  context: ActionContext,
  input: RunCreateInput,
  /**
   * Server-side only: where the run's work may execute (chapter 25 section 8).
   * No public field carries it yet, so a caller that knows a constraint passes
   * it here and every other run records the empty one.
   */
  options: {
    placement?: RunPlacement;
    storageConnections?: StorageConnectionDeps;
  } = {},
): Promise<RunOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  // A backup holds the installation: no run is admitted until it lets go.
  await assertNotQuiesced(transaction, "intake");
  requireCommandMetadata(context);
  const taskId = context.params.id;
  if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const taskScope = await loadTaskScope(
    transaction,
    organizationId,
    taskId,
    undefined,
    false,
  );
  await lockApplication(transaction, organizationId, taskScope.application_id);
  const task = await loadTaskForAdmission(
    transaction,
    organizationId,
    taskId,
  );
  // Stage policy: planning-only tasks start nothing, and a plan stage that waits
  // for a human consumes its approval here, in this transaction, before any
  // other check. Every later failure rolls the consumption back with the rest.
  const runId = crypto.randomUUID();
  const approvedPlan = await admitStagePolicy(transaction, {
    organizationId,
    principalId,
    task,
    approvalId: input.approvalId,
    runId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  if (task.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "task_archived" },
    });
  }
  if (task.status !== "draft" || task.current_run_id !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "task_not_startable" },
    });
  }
  // A suspended ticket request owns the decision: no run starts for its task.
  const ticketBlock = await ticketRequestBlocksRun(
    transaction,
    organizationId,
    task.id,
  );
  if (ticketBlock !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: ticketBlock },
    });
  }

  const preset = input.presetId === undefined
    ? undefined
    : workflowPresetById(input.presetId);
  if (input.presetId !== undefined && !preset) {
    throw unprocessable(["presetId"], "preset_unknown");
  }
  if (preset && input.inputs !== undefined) {
    throw unprocessable(["inputs"], "inputs_not_allowed_with_preset");
  }
  const workflowVersionId = preset
    ? await ensurePresetWorkflowVersion(
      transaction,
      organizationId,
      principalId,
      preset,
    )
    : input.workflowId !== undefined
    ? await loadActiveWorkflowVersionId(
      transaction,
      organizationId,
      input.workflowId,
    )
    : input.workflowVersionId;
  if (workflowVersionId === undefined) {
    throw unprocessable(["workflowVersionId"], "workflow_version_required");
  }
  const workflow = await loadWorkflowVersion(
    transaction,
    organizationId,
    workflowVersionId,
  );
  await assertWorkflowVersionValid(workflow);
  await assertStepSkillsAllowed(transaction, {
    organizationId,
    workflowId: workflow.workflow_id,
    definition: workflow.normalized_spec,
  });

  const namedBudgetUsd = input.budgetLimitUsd ?? preset?.defaultBudgetLimitUsd;
  const budgetLimitUsd = capBudgetAtWorkflowCeiling(
    namedBudgetUsd === undefined
      ? undefined
      : validateBudgetLimitUsd(namedBudgetUsd),
    workflowCeilingUsd(workflow),
  );
  const suppliedInputs = preset
    ? presetBriefInputs(task, approvedPlan)
    : input.inputs === undefined
    ? null
    : input.inputs;
  validateRunInputs(suppliedInputs);
  // A storage path an input names is resolved now, to the version it points at,
  // and the run keeps that pin; the path stays only as a label.
  if (preset && input.inputPaths !== undefined) {
    throw unprocessable(["inputPaths"], "input_paths_not_allowed_with_preset");
  }
  const storageConnections = options.storageConnections;
  const { inputs, resolved: resolvedInputPaths } = await resolveInputPaths(
    transaction,
    {
      organizationId,
      inputs: suppliedInputs,
      inputPaths: input.inputPaths,
      ...(storageConnections === undefined ? {} : {
        connections: (path: string) => {
          authorizeConnectionReads(context);
          return ingestConnectionInput(
            context,
            transaction,
            { isAdmin: false },
            storageConnections,
            { organizationId, principalId, taskId: task.id, path },
          );
        },
      }),
    },
  );
  validateRunInputs(inputs);

  let profile: ProfileRow | null = null;
  if (input.executionMode === "repository") {
    profile = await loadProfile(
      transaction,
      organizationId,
      task,
      input.repositoryProfileId,
    );
  } else if (input.repositoryProfileId !== undefined) {
    // A repository profile is the code form of a scope profile, so it has no
    // meaning on a run that mounts no repository. The maintenance-only rule is
    // gone (O23): any work type may run without a repository, because work type
    // is an organization label the kernel never branches on.
    throw unprocessable(
      ["repositoryProfileId"],
      "repository_profile_not_allowed",
    );
  }

  // One derivation of what the run needs (O23): the steps decide, not the
  // work type. A run whose steps need no repository runs without one.
  let workspaceRequirement: WorkspaceRequirement;
  try {
    workspaceRequirement = deriveRunWorkspaceRequirement(
      workflow.normalized_spec,
    );
  } catch (error) {
    throw new Error("WORKFLOW_VERSION_INVALID", { cause: error });
  }
  if (input.executionMode === "cloud_only" && workspaceRequirement.required) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_required" },
    });
  }
  // Step defaults come from the project's scope profile, not the repository
  // profile (O23): every run of the project pins the published revision, and a
  // project that has published none runs on the empty baseline.
  const storedScopeProfile = await readProjectScopeProfile(
    transaction,
    organizationId,
    task.application_id,
  );
  const scopeProfile = {
    applicationId: task.application_id,
    ...resolveScopeProfileDefaults({
      organizationId,
      applicationId: task.application_id,
      profile: storedScopeProfile === null ? null : {
        applicationId: storedScopeProfile.applicationId,
        revision: storedScopeProfile.revision,
        digest: storedScopeProfile.digest,
        checkCommands: storedScopeProfile.checkCommands,
        rules: storedScopeProfile.rules,
      },
    }),
  };
  // Every run is a compiled plan (#400): the engine decides each step as the
  // run goes. A document the plan compiler refuses, the retired flat grammar
  // (a bare step list with no compiler fields) included, is refused here as
  // `workflow_plan_not_compilable`, before anything is written.
  const planAdmission: PlanAdmission = await resolvePlanAdmission(
    transaction,
    {
      organizationId,
      definition: workflow.normalized_spec,
      profileAgentBindings: profile?.config.agentBindings,
    },
  );

  const boundConnectionIds = [
    ...new Set(
      buildWorkflowPlan(planAdmission.document).steps.flatMap((step) =>
        boundStepConnections(step.files)
      ),
    ),
  ];
  if (boundConnectionIds.length > 0) authorizeConnectionReads(context);
  await assertConnectionsBindable(context, transaction, { isAdmin: false }, {
    organizationId,
    principalId,
    connectionIds: boundConnectionIds,
  });

  // A plan binds a repository through its inputs, and that binding is only
  // meaningful if the run is actually bound to that repository. Without this
  // a caller could point a step at a repository the task never had, and
  // nothing downstream would notice: `$task.repositoryId` is the task's own
  // (nullable) repository while `$input.repositoryId` is whatever was sent.
  await assertSuppliedRepositoryIsBound(
    transaction,
    organizationId,
    task,
    inputs,
  );

  // A plan that reviews freezes its loop bounds from the plan itself (its
  // `repeat` bound); a plan without a review freezes none.
  const reviewLoop: ReviewLoopLimits | null = planReviewLoopLimits(
    planAdmission.document,
  );
  // A plan that reviews and repairs runs checks and a review after implement, so
  // a profile whose fixed policy denies one of those effects must fail here, not
  // after implement spends.
  if (
    reviewLoop !== null && profile !== null &&
    fixedPolicyDeniesSteps(profile.config, planAdmission.sites)
  ) {
    throw unprocessable(["repositoryProfileId"], "profile_effect_denied");
  }
  assertBudgetCoversReservations(
    planAdmission.sites.map((site) => ({
      key: site.qualifiedId,
      action: site.action,
    })),
    planAdmission.stepAgents,
    budgetLimitUsd,
  );

  const dependencies = await loadDependencies(
    transaction,
    organizationId,
    task.id,
  );
  if (
    dependencies.some((dependency) =>
      dependency.application_id !== task.application_id
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "dependency_application_mismatch" },
    });
  }
  const dependencySnapshot = dependencies.map((dependency) => ({
    taskId: dependency.depends_on_task_id,
    status: dependency.status,
  }));
  const readiness = resolveDependencyReadiness(dependencySnapshot);
  // A lane child also waits for its prerequisite lanes' committed typed outputs.
  const lane = await evaluateLaneAdmission(
    transaction,
    organizationId,
    task.id,
  );
  // An early lane start is refused before anything is written: no run, task
  // stays draft, and the same start succeeds once prerequisite outputs commit.
  if (lane?.reason) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: lane.reason },
    });
  }
  const status: RunStatus = readiness.status;
  const reason = readiness.reason;
  const fixedPolicy = profile?.config.schemaVersion === 2
    ? profile.config.fixedPolicy
    : undefined;
  const fixedPolicyPins = fixedPolicy === undefined
    ? {}
    : await fixedPolicyPinsOf(fixedPolicy);
  // The one rules read of this admission (organization baseline and pinned
  // profile together). The snapshot freezes it; nothing reads rules again.
  const pinnedRules = profile === null
    ? null
    : await pinEffectiveRepositoryRules(
      transaction,
      organizationId,
      {
        repositoryId: profile.repository_id,
        id: profile.id,
        revision: profile.revision,
        digest: profile.digest,
        repositoryRules: profile.config.repositoryRules,
      },
    );
  // The run's own steps must carry every check the pinned rules require; this
  // evaluates only the run being admitted, never a run already admitted.
  if (pinnedRules !== null) {
    // A plan is read through its shape: a check counts only when it runs
    // after the last revision on every path through the plan.
    assertPlanSatisfiesRules(pinnedRules, planAdmission.document);
  }
  // What a plan run freezes beside the sections every run has, read back the
  // way the engine reads it before anything is inserted. The `$task` is the
  // task as it is at admission.
  const planSections = await writePlanRun({
    document: planAdmission.document,
    task: toTask(
      {
        ...task,
        archived_at: task.archived_at === null
          ? null
          : new Date(task.archived_at),
        created_at: new Date(task.created_at),
        updated_at: new Date(task.updated_at),
      } as TaskRow,
    ),
    inputs,
    agents: planAdmission.agents,
    actionAgents: planAdmission.actionAgents,
  });
  const builtSnapshot = buildRunSnapshot({
    executionMode: input.executionMode,
    inputs: planSections.inputs,
    workflow: {
      id: workflow.id,
      revision: workflow.revision,
      digest: workflow.digest,
      normalizedSpec: workflow.normalized_spec,
    },
    repositoryProfile: profile === null || pinnedRules === null ? null : {
      organizationId,
      applicationId: profile.application_id,
      repositoryId: profile.repository_id,
      id: profile.id,
      revision: profile.revision,
      digest: profile.digest,
      config: profile.config,
      observationId: profile.observationId,
      observationDigest: profile.observationDigest,
      baseSha: profile.baseSha,
      ...fixedPolicyPins,
      repositoryRules: pinnedRules,
    },
    // A plan freezes no per-step agent or action binding (its agents are in
    // `planAgents`); the keys stay for readers that still look at both.
    stepAgents: {},
    stepActions: {},
    dependencies: dependencySnapshot,
    reviewLoop,
    workspaceRequirement,
    scopeProfile,
  });
  const laneSnapshot: RunSnapshot = lane === null ? builtSnapshot : {
    ...builtSnapshot,
    admission: { ...builtSnapshot.admission, status, reason },
    coordination: lane.snapshot,
  };
  const snapshot: RunSnapshot = {
    ...laneSnapshot,
    runtime: planSections.runtime,
    task: planSections.task,
    planAgents: planSections.planAgents,
    planActionAgents: planSections.planActionAgents,
  };

  if (preset || snapshot.repositoryProfile !== null) {
    assertJobInputsFit(snapshot, { strict: preset !== undefined });
  }

  const inserted = await transaction.query<RunRow>(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id,
       repository_profile_id, requested_by, status, snapshot,
       budget_limit_usd, application_id, repository_id,
       repository_profile_revision, repository_profile_digest,
       observation_id, observation_digest, base_sha, environment, placement,
       version
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18::jsonb, 1
     )
     returning id, kind, task_id, workflow_version_id, skill_source_id,
       repository_profile_id, repository_profile_revision,
       repository_profile_digest, observation_id, observation_digest, base_sha,
       null::text as workspace_base_sha,
       requested_by, inngest_run_id, status, budget_limit_usd, environment,
       started_at, finished_at, created_at, updated_at, version`,
    [
      runId,
      organizationId,
      task.id,
      workflow.id,
      profile?.id ?? null,
      principalId,
      status,
      JSON.stringify(snapshot),
      budgetLimitUsd,
      profile?.application_id ?? null,
      profile?.repository_id ?? null,
      profile?.revision ?? null,
      profile?.digest ?? null,
      profile?.observationId ?? null,
      profile?.observationDigest ?? null,
      profile?.baseSha ?? null,
      input.environment ?? "live",
      // An ordinary run records the empty placement, `{}`: no constraint.
      JSON.stringify(
        options.placement === undefined
          ? {}
          : RunPlacementSchema.parse(options.placement),
      ),
    ],
  );
  const run = inserted.rows[0];
  if (!run) throw new Error("RUN_INSERT_FAILED");
  // A plan run has no steps here: the engine appends each one as the plan
  // decides it.
  // Pin the exact version each declared input resolved to, now, so a later
  // publication of the same path cannot change what this run reads.
  await pinDeclaredRunInputs(transaction, {
    organizationId,
    runId: run.id,
    inputs,
  });
  await recordInputPaths(transaction, {
    organizationId,
    runId: run.id,
    resolved: resolvedInputPaths,
  });
  const taskUpdate = await transaction.query<{ id: string; version: number }>(
    `update bakery.tasks
        set status = $3, current_run_id = $4,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'draft'
        and current_run_id is null
      returning id, version`,
    [organizationId, task.id, status, run.id],
  );
  if (taskUpdate.rows.length !== 1) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  await appendRunFacts(transaction, {
    organizationId,
    principalId,
    run,
    task,
    taskVersion: taskUpdate.rows[0].version,
    status,
    reason,
    agentSessionId: await auditAgentSessionId(
      transaction,
      context,
      organizationId,
    ),
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toRun(run);
}

export function authorizeConnectionReads(context: ActionContext): void {
  const authority = (context as Partial<AuthorizedActionContext>).authority;
  if (
    authority === undefined || !("subject" in authority) ||
    !("organizationId" in authority)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  authorize(authority as OrganizationActor, "integrationConnection:read");
}
