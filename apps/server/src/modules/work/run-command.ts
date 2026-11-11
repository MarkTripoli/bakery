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
import { type RepositoryVersionedProfileConfig } from "@bakery/contracts/repository-inspection";
import {
  actionAndInputFromSnapshot,
  admitRepositoryProfile,
  executionJobInputFitsTransport,
} from "@bakery/persistence/repository-admission";
import { WORKFLOW_ACTION_METADATA } from "@bakery/contracts/workflow-action-registry";
import {
  type PinnedRepositoryRules,
  STEP_OUTPUT_ALLOWANCE_BYTES,
} from "@bakery/contracts/repository-rules";
import { workflowPresetById } from "@bakery/contracts/workflow-presets";
import {
  type FrozenActionBinding,
  workflowActionBinding,
} from "@bakery/persistence";
import type { ReviewLoopLimits } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  appendTaskProjectionEvent,
  loadTaskScope,
  lockApplication,
  toIso,
} from "./postgres.ts";
import {
  extractFixedWorkflowSteps,
  type FixedWorkflowStep,
  insertRunSteps,
  reviewLoopLimitsFor,
  stepReferencesEarlierOutput,
  WorkflowNotExecutableError,
  WorkflowNotFixedError,
  workflowRequiresRepository,
} from "./run-steps.ts";
import {
  isModelAction,
  parseMicroUsd,
  type RunBudgetSummary,
} from "./budget.ts";
import {
  evaluateLaneAdmission,
  type LaneCoordinationSnapshot,
} from "./coordination-admission.ts";
import {
  type FrozenStepAgents,
  resolveFrozenStepAgents,
} from "./agent-run-admission.ts";
import { admitStagePolicy } from "./stage-admission.ts";
import { ticketRequestBlocksRun } from "./ticket-run-guard.ts";
import { pinEffectiveRepositoryRules } from "../repository-rules/pinned.ts";
import { assertStepsSatisfyRules } from "../workflows/rule-guard.ts";
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
};

export function resolveDependencyReadiness(
  dependencies: readonly RunDependencySnapshot[],
): { status: RunStatus; reason: string | null } {
  const ready = dependencies.every((dependency) =>
    dependency.status === "completed"
  );
  return {
    status: ready ? "queued" : "blocked",
    reason: ready ? null : "dependency_incomplete",
  };
}

function buildRunSnapshot(options: {
  executionMode: RunSnapshot["executionMode"];
  inputs: unknown;
  workflow: RunSnapshot["workflow"];
  repositoryProfile: RunSnapshot["repositoryProfile"];
  stepAgents: FrozenStepAgents;
  stepActions: RunSnapshot["stepActions"];
  dependencies: readonly RunDependencySnapshot[];
  reviewLoop: ReviewLoopLimits | null;
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
  };
}

/**
 * Refuses a run whose budget cannot cover a model step's reservation. Engine
 * admission reserves that amount against the run budget and refuses the same
 * way, so a run created without this check could only fail later. Steps
 * without a model action reserve nothing and are not checked.
 */
function assertBudgetCoversReservations(
  steps: readonly FixedWorkflowStep[],
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

export function validateBudgetLimitUsd(value: unknown): string {
  if (value === undefined) return "0";
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(value) ||
    Number(value) > 200
  ) {
    throw unprocessable(["budgetLimitUsd"], "budget_limit_invalid");
  }
  return value;
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
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type, resource_id,
       outcome, request_id, trace_id, details
     ) values ($1, $2, 'runs.create', 'workflow_run', $3, 'succeeded', $4, $5, $6::jsonb)`,
    [
      options.organizationId,
      options.principalId,
      options.run.id,
      options.requestId,
      options.traceId,
      JSON.stringify({ status: options.status, reason: options.reason }),
    ],
  );
  const sequence = await nextOrganizationSequence(
    transaction,
    options.organizationId,
  );
  const eventType = options.status === "queued"
    ? "run.requested"
    : "run.blocked";
  const event = await transaction.query<{ id: string }>(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       application_id, repository_id, task_id, conversation_id, aggregate_id,
       aggregate_version, payload, trace_id
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     returning id`,
    [
      options.organizationId,
      sequence,
      eventType,
      options.task.application_id,
      options.task.repository_id,
      options.task.id,
      options.task.conversation_id,
      options.run.id,
      options.run.version,
      JSON.stringify(
        options.status === "queued" ? { runId: options.run.id } : {
          resourceId: options.run.id,
          resourceVersion: options.run.version,
          taskId: options.task.id,
          status: options.status,
          reason: options.reason,
        },
      ),
      options.traceId,
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("DOMAIN_EVENT_INSERT_FAILED");
  if (options.status === "queued") {
    await transaction.query(
      `insert into bakery.outbox (
         organization_id, event_id, destination, delivery_key, status
       ) values ($1, $2, 'inngest', $3, 'pending')`,
      [
        options.organizationId,
        eventId,
        `run:${options.run.id}:version:${options.run.version}`,
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
    `select workflow_version.id, workflow_version.revision,
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

async function loadActiveWorkflowVersionId(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<string> {
  const result = await transaction.query<{
    slug: string;
    enabled: boolean;
    active_version_id: string | null;
  }>(
    `select slug, enabled, active_version_id
       from bakery.workflow_definitions
      where organization_id = $1
        and id = $2
        for share`,
    [organizationId, workflowId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.slug.startsWith("preset:")) {
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
 * server-injected repository profile, so measure that exact resolved input
 * before any run exists. A step that reads earlier step outputs cannot be
 * resolved here and is measured from its literal input plus the 2,048-byte
 * `STEP_OUTPUT_ALLOWANCE_BYTES`, which covers identifiers such as artifact and
 * version ids but not the repair step: its input carries the failed checks and
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
  steps: readonly FixedWorkflowStep[],
  repositoryId: string | null,
  options: { strict: boolean },
): void {
  // A preset's oversized brief is reported on its description; a plain
  // workflow's input comes from the run inputs.
  const inputsPath = options.strict ? ["description"] : ["inputs"];
  const refuse = (base: Record<string, unknown>): void => {
    const withProfile = (profile: unknown) =>
      snapshot.repositoryProfile === null
        ? base
        : { ...base, repositoryProfile: profile };
    if (
      executionJobInputFitsTransport(withProfile(snapshot.repositoryProfile))
    ) {
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
  };
  for (const step of steps) {
    // A step whose input cannot be resolved here (it reads an earlier step's
    // output, or, for a plain workflow, a request key that is absent) is
    // measured from its literal input plus an allowance for those identifiers.
    // Presets keep the original rule: only an earlier-output reference may be
    // unresolved, anything else is an error.
    const estimate = () =>
      refuse({
        ...(isPlainRecord(step.input) ? step.input : {}),
        stepOutputAllowance: "x".repeat(STEP_OUTPUT_ALLOWANCE_BYTES),
      });
    let resolved: unknown;
    try {
      resolved = actionAndInputFromSnapshot({
        runSnapshot: snapshot,
        stepKey: step.key,
        stepOutputs: {},
        repositoryId,
      }).input;
    } catch (error) {
      if (
        options.strict && (!(error instanceof Error) ||
          error.message !== "WORKFLOW_INPUT_UNRESOLVED" ||
          !stepReferencesEarlierOutput(step))
      ) throw error;
      estimate();
      continue;
    }
    if (!isPlainRecord(resolved)) continue;
    refuse(resolved);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function createRunCommand(
  context: ActionContext,
  input: RunCreateInput,
): Promise<RunOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
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

  const budgetLimitUsd = validateBudgetLimitUsd(
    input.budgetLimitUsd ?? preset?.defaultBudgetLimitUsd,
  );
  const inputs = preset
    ? presetBriefInputs(task, approvedPlan)
    : input.inputs === undefined
    ? null
    : input.inputs;
  validateRunInputs(inputs);

  let profile: ProfileRow | null = null;
  if (input.executionMode === "repository") {
    profile = await loadProfile(
      transaction,
      organizationId,
      task,
      input.repositoryProfileId,
    );
  } else {
    if (task.task_type !== "maintenance") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "cloud_only_requires_maintenance" },
      });
    }
    if (input.repositoryProfileId !== undefined) {
      throw unprocessable(
        ["repositoryProfileId"],
        "repository_profile_not_allowed",
      );
    }
  }

  let repositoryRequired: boolean;
  try {
    repositoryRequired = workflowRequiresRepository(workflow.normalized_spec);
  } catch (error) {
    throw new Error("WORKFLOW_VERSION_INVALID", { cause: error });
  }
  if (input.executionMode === "cloud_only" && repositoryRequired) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_required" },
    });
  }
  let steps: readonly FixedWorkflowStep[];
  try {
    steps = extractFixedWorkflowSteps(
      workflow.normalized_spec,
      profile?.config.workflow.kind,
    );
  } catch (error) {
    if (error instanceof WorkflowNotFixedError) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_not_fixed" },
      });
    }
    if (error instanceof WorkflowNotExecutableError) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_not_executable" },
      });
    }
    throw new Error("WORKFLOW_VERSION_INVALID", { cause: error });
  }

  // A review and repair loop runs checks and a review after implement, so a
  // profile that cannot run them must fail here, not after implement spends.
  const reviewLoop = reviewLoopLimitsFor(workflow.normalized_spec);
  if (
    reviewLoop !== null && profile !== null &&
    fixedPolicyDeniesSteps(profile.config, steps)
  ) {
    throw unprocessable(["repositoryProfileId"], "profile_effect_denied");
  }

  const stepAgents = await resolveFrozenStepAgents(
    transaction,
    organizationId,
    steps,
    profile?.config.agentBindings,
  );
  assertBudgetCoversReservations(steps, stepAgents, budgetLimitUsd);

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
  const fixedPolicyPins = fixedPolicy === undefined ? {} : {
    fixedPolicyDigest: await sha256Hex(canonicalJson(fixedPolicy)),
    trustedCheckerConfigDigest: fixedPolicy.trustedChecker.configDigest,
  };
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
  if (pinnedRules !== null) assertStepsSatisfyRules(pinnedRules, steps);
  const builtSnapshot = buildRunSnapshot({
    executionMode: input.executionMode,
    inputs,
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
    stepAgents,
    stepActions: Object.fromEntries(steps.map((step) => [
      step.key,
      workflowActionBinding(step.action, step.requires),
    ])),
    dependencies: dependencySnapshot,
    reviewLoop,
  });
  const snapshot: RunSnapshot = lane === null ? builtSnapshot : {
    ...builtSnapshot,
    admission: { ...builtSnapshot.admission, status, reason },
    coordination: lane.snapshot,
  };

  if (preset || snapshot.repositoryProfile !== null) {
    assertJobInputsFit(snapshot, steps, task.repository_id, {
      strict: preset !== undefined,
    });
  }

  const inserted = await transaction.query<RunRow>(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id,
       repository_profile_id, requested_by, status, snapshot,
       budget_limit_usd, application_id, repository_id,
       repository_profile_revision, repository_profile_digest,
       observation_id, observation_digest, base_sha, version
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, 1
     )
     returning id, kind, task_id, workflow_version_id, skill_source_id,
       repository_profile_id, repository_profile_revision,
       repository_profile_digest, observation_id, observation_digest, base_sha,
       null::text as workspace_base_sha,
       requested_by, inngest_run_id, status, budget_limit_usd,
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
    ],
  );
  const run = inserted.rows[0];
  if (!run) throw new Error("RUN_INSERT_FAILED");
  await insertRunSteps(transaction, {
    organizationId,
    runId: run.id,
    steps,
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
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toRun(run);
}
