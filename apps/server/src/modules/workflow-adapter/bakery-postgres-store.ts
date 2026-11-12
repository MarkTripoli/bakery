import { RepositoryExecutionContextSchema } from "@bakery/contracts/repository-inspection";
import {
  actionAndInputFromSnapshot,
  admitRepositoryExecutionJob,
  type AdmittedRepositoryProfile,
  assertSecretIdentityRepositoryAdmission,
  executionJobInputFitsTransport,
  loadExecutableRepositoryProfile,
  repositoryExecutionRequirements,
} from "@bakery/persistence/repository-admission";
import { StandardError } from "@bakery/contracts/http";
import { workerActionOutputCarriesSession } from "@bakery/contracts/contracts";
import {
  appendAudit,
  appendDomainEvent,
  assertActionAgentPolicy,
  assertActionInput,
  carriesPlanRuntime,
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
  workflowActionCapabilities,
} from "@bakery/persistence";
import { type Inngest, NonRetriableError } from "inngest";
import { WorkflowInterpreterError } from "@bakery/contracts/workflow-interpreter";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { reconcileCoordinationForTerminalTask } from "../work/coordination-projection.ts";
import {
  budgetContentDigest,
  type BudgetPolicy,
  reserveWorkflowAction,
} from "../work/budget.ts";
import {
  type AdmissionRecord,
  assertLogicalKey,
  type LogicalInvocationKey,
} from "./invocation-contract.ts";
import type { AuthoritativeState } from "./resume-decision.ts";
import { runFixedWorkflow } from "./fixed-workflow.ts";
import {
  nextPlanStep,
  planInputsFromSnapshot,
  planRuntimeFromSnapshot,
  PlanStateError,
  planTaskFromSnapshot,
} from "./plan-state.ts";
const terminalStatuses: Record<string, true> = {
  completed: true,
  failed: true,
  canceled: true,
  blocked: true,
  skipped: true,
};
const eligibleRunStatuses: Record<string, true> = {
  queued: true,
  running: true,
};
const eligibleStepStatuses: Record<string, true> = {
  pending: true,
  running: true,
  waiting: true,
};
const MAX_WORKFLOW_STEPS = 32;
const MAX_RECONCILIATION_WAITS = 8;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_PERSISTED_ATTEMPTS = 2_147_483_647;
const MIN_ENGINE_OWNER_LEASE_MS = 3_000;
const MAX_JOB_COMPLETION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
type JsonRecord = Record<string, unknown>;
const deterministicWorkflowErrors: Record<string, true> = {
  WORKFLOW_EVENT_ID_MISSING: true,
  WORKFLOW_RUN_ID_MISSING: true,
  WORKFLOW_JOB_ID_MISSING: true,
  WORKFLOW_INPUT_UNRESOLVED: true,
  WORKFLOW_STEP_ACTION_MISSING: true,
  WORKFLOW_MAX_ATTEMPTS_INVALID: true,
  WORKFLOW_ENGINE_RETRIES_INVALID: true,
  WORKFLOW_RETRY_WAIT_INVALID: true,
  WORKFLOW_COMPLETION_TIMEOUT_INVALID: true,
  WORKFLOW_STATE_CONFLICT: true,
  WORKFLOW_RECONCILIATION_UNEXPECTED: true,
};
function jsonRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function eventPayload(data: unknown): JsonRecord {
  const record = jsonRecord(data);
  if (!record) return {};
  return jsonRecord(record.payload) ?? record;
}

function isDeterministicWorkflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":", 1)[0] ?? message;
  return deterministicWorkflowErrors[code] === true;
}
type LogicalRow = {
  organizationId: string;
  runId: string;
  workflowVersionId: string;
  runStatus: string;
  runSnapshot: unknown;
  requestedBy: string | null;
  runApplicationId: string | null;
  runRepositoryId: string | null;
  runRepositoryProfileId: string | null;
  runRepositoryProfileRevision: number | null;
  runRepositoryProfileDigest: string | null;
  runObservationId: string | null;
  runObservationDigest: string | null;
  runBaseSha: string | null;
  taskId: string;
  applicationId: string;
  repositoryId: string | null;
  taskType: string;
  taskRepositoryProfileId: string | null;
  taskRepositoryProfileRevision: number | null;
  taskRepositoryProfileDigest: string | null;
  taskObservationId: string | null;
  taskObservationDigest: string | null;
  taskBaseSha: string | null;
  conversationId: string;
  originalTraceId: string | null;
  runStepId: string;
  stepKey: string;
  iteration: number;
  stepStatus: string;
  stepOutput: unknown;
  stepError: unknown;
  jobId: string | null;
  action: string | null;
  jobStatus: string | null;
  cancelRequestedAt: Date | string | null;
  availableAt: Date | string | null;
  maxAttempts: string | number | null;
  terminalAttemptCount: string | number;
  liveAttemptCount: string | number;
  lastAttemptId: string | null;
  lastAttemptStatus: string | null;
  lastAttemptResult: unknown;
  stepOutputs: unknown;
};

type AdmissionStepRow = Pick<
  LogicalRow,
  | "organizationId"
  | "runId"
  | "workflowVersionId"
  | "runStatus"
  | "runSnapshot"
  | "requestedBy"
  | "runApplicationId"
  | "runRepositoryId"
  | "runRepositoryProfileId"
  | "runRepositoryProfileRevision"
  | "runRepositoryProfileDigest"
  | "runObservationId"
  | "runObservationDigest"
  | "runBaseSha"
  | "taskId"
  | "taskType"
  | "applicationId"
  | "repositoryId"
  | "taskRepositoryProfileId"
  | "taskRepositoryProfileRevision"
  | "taskRepositoryProfileDigest"
  | "taskObservationId"
  | "taskObservationDigest"
  | "taskBaseSha"
  | "conversationId"
  | "originalTraceId"
  | "runStepId"
  | "stepKey"
  | "iteration"
  | "stepStatus"
  | "stepOutput"
  | "stepError"
  | "jobId"
  | "jobStatus"
  | "cancelRequestedAt"
  | "maxAttempts"
  | "terminalAttemptCount"
  | "liveAttemptCount"
  | "lastAttemptId"
  | "lastAttemptStatus"
  | "lastAttemptResult"
  | "stepOutputs"
>;

export type EngineOwner = Readonly<{
  runId: string;
  token: string;
  generation: string;
  leaseMs: number;
}>;

class EngineOwnerLostError extends Error {
  constructor() {
    super("WORKFLOW_ENGINE_OWNER_LOST");
  }
}

export type EngineOwnerCandidate = Readonly<{
  runId: string;
  generation: string;
}>;

export type BakeryPostgresWorkflowRepository = Readonly<{
  acquireEngineOwner(
    runId: string,
    token: string,
    leaseMs: number,
  ): Promise<EngineOwner | undefined>;
  renewEngineOwner(owner: EngineOwner): Promise<boolean>;
  releaseEngineOwner(owner: EngineOwner): Promise<boolean>;
  handoffEngineOwner(owner: EngineOwner): Promise<boolean>;
  rearmExpiredEngineOwners(
    limit: number,
  ): Promise<readonly EngineOwnerCandidate[]>;
  findNext(
    runId: string,
    owner?: EngineOwner,
  ): Promise<LogicalInvocationKey | undefined>;
  readRunStatus(
    runId: string,
    owner?: EngineOwner,
  ): Promise<string | undefined>;
  read(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<AuthoritativeState | undefined>;
  admit(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<AdmissionRecord>;
  markStalled(
    key: LogicalInvocationKey,
    reason: string,
    owner?: EngineOwner,
  ): Promise<void>;
  markEngineFailure(
    runId: string,
    reason: string,
    owner?: string | EngineOwner,
  ): Promise<void>;
  /**
   * Ends a compiled-plan run the interpreter has finished or halted: the run,
   * its task, their events and the coordination projection, in one
   * transaction fenced by the engine owner. Refuses a run that was not
   * admitted under a plan, whose end the worker result path decides from its
   * rows.
   */
  finishPlanRun(
    runId: string,
    outcome: PlanRunOutcome,
    owner: EngineOwner,
  ): Promise<void>;
}>;

export type PlanRunOutcome = "completed" | "failed" | "canceled";

function isTerminal(
  row: Pick<
    LogicalRow,
    "runStatus" | "stepStatus" | "jobStatus" | "lastAttemptStatus"
  >,
): boolean {
  return terminalStatuses[row.runStatus] === true ||
    terminalStatuses[row.stepStatus] === true ||
    (row.jobStatus !== null && terminalStatuses[row.jobStatus] === true) ||
    // A queued job with a failed last attempt is a retry, not a terminal step.
    (row.lastAttemptStatus !== null && row.jobStatus !== "queued" &&
      terminalStatuses[row.lastAttemptStatus] === true);
}

function terminalResult(row: LogicalRow): unknown {
  if (row.stepOutput !== null && row.stepOutput !== undefined) {
    return row.stepOutput;
  }
  if (row.lastAttemptResult && typeof row.lastAttemptResult === "object") {
    const result = (row.lastAttemptResult as JsonRecord).result;
    if (result !== undefined) return result;
  }
  return undefined;
}

function persistedMaxAttempts(
  row: LogicalRow,
  configuredMaxAttempts: number,
): number {
  const value = row.maxAttempts === null
    ? configuredMaxAttempts
    : Number(row.maxAttempts);
  if (
    !Number.isSafeInteger(value) || value < 1 ||
    value > MAX_PERSISTED_ATTEMPTS
  ) {
    throw new Error("WORKFLOW_MAX_ATTEMPTS_INVALID");
  }
  return value;
}

function stateFromRow(
  key: LogicalInvocationKey,
  row: LogicalRow,
  configuredMaxAttempts: number,
): AuthoritativeState {
  if (key.actionVersion !== row.workflowVersionId) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        expectedActionVersion: key.actionVersion,
        persistedActionVersion: row.workflowVersionId,
      },
    });
  }
  const terminal = isTerminal(row);
  const admission = row.jobId === null ? undefined : {
    key,
    terminal,
    ...(row.jobId ? { jobId: row.jobId } : {}),
  };
  const result = terminalResult(row);
  const attempts = Number(row.terminalAttemptCount);
  const liveAttempts = Number(row.liveAttemptCount);
  const state: AuthoritativeState = {
    key,
    ...(admission ? { admission } : {}),
    ...(result === undefined ? {} : { result }),
    attempts,
    liveAttempts,
    maxAttempts: persistedMaxAttempts(row, configuredMaxAttempts),
    ...(row.availableAt && new Date(row.availableAt).getTime() > Date.now()
      ? { nextRetryAt: new Date(row.availableAt) }
      : {}),
  };
  const terminalFailure = row.cancelRequestedAt !== null
    ? "cancel_requested_at"
    : terminal && result === undefined
    ? row.stepError
      ? "workflow_step_failed"
      : row.lastAttemptStatus ?? row.jobStatus ?? row.stepStatus
    : undefined;
  return terminalFailure ? { ...state, terminalFailure } : state;
}

async function loadLogical(
  transaction: PgTransactionClient,
  key: LogicalInvocationKey,
  lock = false,
): Promise<LogicalRow> {
  const lockClause = lock ? "for update of step, run, task" : "";
  const result = await transaction.query<LogicalRow>(
    `select run.organization_id as "organizationId",
            run.id as "runId", run.workflow_version_id as "workflowVersionId",
            run.status as "runStatus", run.snapshot as "runSnapshot",
            run.requested_by as "requestedBy",
            run.application_id as "runApplicationId",
            run.repository_id as "runRepositoryId",
            run.repository_profile_id as "runRepositoryProfileId",
            run.repository_profile_revision as
              "runRepositoryProfileRevision",
            run.repository_profile_digest as "runRepositoryProfileDigest",
            run.observation_id as "runObservationId",
            run.observation_digest as "runObservationDigest",
            run.base_sha as "runBaseSha",
            task.id as "taskId", task.application_id as "applicationId",
            task.repository_id as "repositoryId",
            task.task_type as "taskType",
            task.conversation_id as "conversationId",
            task.repository_profile_id as "taskRepositoryProfileId",
            task.repository_profile_revision as
              "taskRepositoryProfileRevision",
            task.repository_profile_digest as "taskRepositoryProfileDigest",
            task.observation_id as "taskObservationId",
            task.observation_digest as "taskObservationDigest",
            task.base_sha as "taskBaseSha",
            original_request.trace_id as "originalTraceId",
            step.id as "runStepId", step.step_key as "stepKey",
            step.iteration, step.status as "stepStatus",
            step.output as "stepOutput", step.error as "stepError",
            job.id as "jobId", job.action,
            job.status as "jobStatus",
            job.cancel_requested_at as "cancelRequestedAt",
            job.available_at as "availableAt",
            job.max_attempts as "maxAttempts",
            coalesce(attempts.terminal_attempt_count, 0) as
              "terminalAttemptCount",
            coalesce(attempts.live_attempt_count, 0) as
              "liveAttemptCount",
            attempts.last_id as "lastAttemptId",
            attempts.last_status as "lastAttemptStatus",
            attempts.last_result as "lastAttemptResult",
            coalesce(outputs.step_outputs, '{}'::jsonb) as "stepOutputs"
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
       join bakery.run_steps step
         on step.organization_id = run.organization_id and step.run_id = run.id
       left join lateral (
         select event.trace_id
           from bakery.domain_events event
          where event.organization_id = run.organization_id
            and event.aggregate_id = run.id
            and event.event_type = 'run.requested'
          order by event.organization_sequence asc
          limit 1
       ) original_request on true
       left join bakery.jobs job
         on job.organization_id = step.organization_id and
            job.run_step_id = step.id
       left join lateral (
         select count(*) filter (
                  where attempt.status not in ('leased', 'running', 'canceling')
                )::integer as terminal_attempt_count,
                count(*) filter (
                  where attempt.status in ('leased', 'running', 'canceling')
                )::integer as live_attempt_count,
                (array_agg(attempt.id order by attempt.attempt_no desc))[1]
                  as last_id,
                (array_agg(attempt.status order by attempt.attempt_no desc))[1]
                  as last_status,
                (array_agg(attempt.result order by attempt.attempt_no desc))[1]
                  as last_result
           from bakery.job_attempts attempt
          where attempt.organization_id = step.organization_id
            and attempt.job_id = job.id
       ) attempts on true
       left join lateral (
         select jsonb_object_agg(previous.step_key, previous.output) as
                  step_outputs
           from (
             select distinct on (previous.step_key)
                    previous.step_key, previous.output
               from bakery.run_steps previous
              where previous.organization_id = step.organization_id
                and previous.run_id = run.id
                and previous.output is not null
              order by previous.step_key, previous.iteration desc,
                       previous.position desc, previous.id desc
           ) previous
       ) outputs on true
      where run.id = $1 and step.step_key = $2 and step.iteration = $3
      order by job.created_at desc nulls last, job.id desc nulls last
      limit 1
      ${lockClause}`,
    [key.runId, key.stepKey, key.iteration],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function lockExistingJob(
  transaction: PgTransactionClient,
  key: LogicalInvocationKey,
): Promise<void> {
  await transaction.query(
    `select job.id
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
      where step.run_id = $1 and step.step_key = $2 and step.iteration = $3
      for update of job`,
    [key.runId, key.stepKey, key.iteration],
  );
}

async function loadNext(
  transaction: PgTransactionClient,
  runId: string,
): Promise<LogicalInvocationKey | undefined> {
  const result = await transaction.query<{
    runId: string;
    stepKey: string;
    iteration: number;
    workflowVersionId: string;
  }>(
    `select run.id as "runId", step.step_key as "stepKey",
            step.iteration, run.workflow_version_id as "workflowVersionId"
       from bakery.workflow_runs run
       join bakery.run_steps step
         on step.organization_id = run.organization_id and step.run_id = run.id
      where run.id = $1
        and run.status in ('queued', 'running')
        and step.status in ('pending', 'running', 'waiting')
      order by step.position asc, step.iteration asc, step.id asc
      limit 1`,
    [runId],
  );
  const row = result.rows[0];
  return row
    ? {
      runId: row.runId,
      stepKey: row.stepKey,
      iteration: row.iteration,
      actionVersion: row.workflowVersionId,
    }
    : undefined;
}
async function loadRunStatus(
  transaction: PgTransactionClient,
  runId: string,
): Promise<string | undefined> {
  const result = await transaction.query<{ status: string }>(
    `select status
       from bakery.workflow_runs
      where id = $1`,
    [runId],
  );
  return result.rows[0]?.status;
}

function originalTraceId(row: Pick<LogicalRow, "originalTraceId">): string {
  if (!row.originalTraceId) throw new Error("WORKFLOW_ORIGINAL_TRACE_MISSING");
  return row.originalTraceId;
}

/** What ending a run needs to know about it: its scope, task and original trace. */
type RunEndContext = Pick<
  LogicalRow,
  | "organizationId"
  | "runId"
  | "taskId"
  | "applicationId"
  | "repositoryId"
  | "conversationId"
  | "originalTraceId"
>;

function appendRunUpdated(
  transaction: PgTransactionClient,
  row: RunEndContext,
  version: number,
): Promise<string> {
  return appendDomainEvent(transaction, {
    organizationId: row.organizationId,
    applicationId: row.applicationId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    conversationId: row.conversationId,
    eventType: "run.updated",
    aggregateId: row.runId,
    aggregateVersion: version,
    payload: { runId: row.runId, version },
    traceId: originalTraceId(row),
  });
}
type FailureProjection = Readonly<{ code: string; message: string }>;

/**
 * Deterministic budget refusals at admission. Retrying the same admission
 * hits the same refusal forever, so the engine fails the run with the stable
 * code instead. Replay and integrity conflicts (`budget_replay_*`) are not
 * listed: they stay thrown.
 */
const BUDGET_ADMISSION_REFUSALS: Readonly<Record<string, FailureProjection>> = {
  budget_cap_exceeded: {
    code: "BUDGET_CAP_EXCEEDED",
    message: "The run budget cannot cover this step's model reservation.",
  },
  plan_budget_cap_exceeded: {
    code: "PLAN_BUDGET_CAP_EXCEEDED",
    message: "The plan budget cannot cover this step's model reservation.",
  },
  budget_policy_unavailable: {
    code: "BUDGET_POLICY_UNAVAILABLE",
    message: "The budget policy is not configured.",
  },
  budget_policy_invalid: {
    code: "BUDGET_POLICY_INVALID",
    message: "The budget policy is invalid.",
  },
  budget_pricing_unavailable: {
    code: "BUDGET_PRICING_UNAVAILABLE",
    message: "No trusted pricing exists for this step's model.",
  },
  billing_configuration_missing: {
    code: "BILLING_CONFIGURATION_MISSING",
    message: "The coding agent has no valid billing configuration.",
  },
};

function budgetAdmissionRefusal(error: unknown): FailureProjection | undefined {
  if (!(error instanceof StandardError) || error.code !== "STATE_CONFLICT") {
    return undefined;
  }
  const reason = (error.params as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" &&
      Object.hasOwn(BUDGET_ADMISSION_REFUSALS, reason)
    ? BUDGET_ADMISSION_REFUSALS[reason]
    : undefined;
}

function failureProjection(reason: string): FailureProjection {
  if (reason === "attempt_budget_exhausted") {
    return {
      code: "ATTEMPT_BUDGET_EXHAUSTED",
      message: "The attempt budget is exhausted.",
    };
  }
  if (reason === "workflow_step_bound_exhausted") {
    return {
      code: "WORKFLOW_STEP_BOUND_EXHAUSTED",
      message: "Workflow execution reached its step bound.",
    };
  }
  const [code, ...messageParts] = reason.split(":");
  if (/^[A-Z][A-Z0-9_]+$/.test(code ?? "")) {
    return {
      code,
      message: messageParts.join(":") || code,
    };
  }
  return {
    code: "WORKFLOW_ENGINE_FAILURE",
    message: reason,
  };
}

async function assertEngineOwner(
  transaction: PgTransactionClient,
  runId: string,
  owner?: EngineOwner,
): Promise<boolean> {
  if (!owner) return true;
  const result = await transaction.query(
    `select 1
       from bakery.workflow_runs
      where id = $1
        and engine_owner_token = $2
        and engine_owner_generation = $3
        and engine_owner_lease_expires_at > clock_timestamp()
        and status not in ('completed', 'failed', 'canceled', 'blocked')`,
    [runId, owner.token, owner.generation],
  );
  return result.rows.length > 0;
}

async function requireEngineOwner(
  transaction: PgTransactionClient,
  runId: string,
  owner?: EngineOwner,
): Promise<void> {
  if (!await assertEngineOwner(transaction, runId, owner)) {
    throw new EngineOwnerLostError();
  }
}
function requireOwnerValue(owner: EngineOwner | undefined): EngineOwner {
  if (!owner) throw new EngineOwnerLostError();
  return owner;
}

type RunEndRow = RunEndContext & {
  runSnapshot: unknown;
  runStatus: string;
  requestedBy: string;
  workflowVersionId: string;
};

/** The run, its task and its original trace, locked, with the snapshot to classify it. */
async function loadRunEndContext(
  transaction: PgTransactionClient,
  runId: string,
): Promise<RunEndRow | undefined> {
  const result = await transaction.query<RunEndRow>(
    `select run.organization_id as "organizationId", run.id as "runId",
            run.snapshot as "runSnapshot", run.status as "runStatus",
            run.requested_by as "requestedBy",
            run.workflow_version_id as "workflowVersionId",
            task.id as "taskId", task.application_id as "applicationId",
            task.repository_id as "repositoryId",
            task.conversation_id as "conversationId",
            original_request.trace_id as "originalTraceId"
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
       left join lateral (
         select event.trace_id
           from bakery.domain_events event
          where event.organization_id = run.organization_id
            and event.aggregate_id = run.id
            and event.event_type = 'run.requested'
          order by event.organization_sequence asc
          limit 1
       ) original_request on true
      where run.id = $1
        for update of run, task`,
    [runId],
  );
  return result.rows[0];
}

/**
 * Ends a plan run as failed for a reason that belongs to no step (the plan
 * cannot be read, or asks for something this engine does not run yet). The run
 * has no reason column, so the stable code goes to the audit log, which an
 * operator can read, next to the run it names.
 */
async function endPlanRunFailed(
  transaction: PgTransactionClient,
  context: RunEndRow,
  owner: EngineOwner | undefined,
  code: string,
): Promise<void> {
  await projectRunEnd(
    transaction,
    context,
    "failed",
    owner,
    "WORKFLOW_PLAN_PROJECTION_CONFLICT",
  );
  await appendAudit(transaction, {
    organizationId: context.organizationId,
    principalId: context.requestedBy,
    operation: "workflow.plan_failed",
    resourceType: "workflow_run",
    resourceId: context.runId,
    requestId: `plan-run:${context.runId}`,
    traceId: originalTraceId(context),
    outcome: "failed",
    details: { code },
  });
}

/**
 * What the engine does next for a compiled-plan run, or `null` for a flat run,
 * which keeps the row-order loop. The run's own interpreter revision answers
 * from the frozen document and the stored rows: a dispatch gets its step row
 * appended on demand (idempotent, so a replay finds the same row) and the key
 * goes to the engine; finished or halted ends the run; anything else the plan
 * asks for, or a plan that cannot be read, ends it failed with a stable code.
 */
async function findNextPlanKey(
  transaction: PgTransactionClient,
  runId: string,
  owner: EngineOwner | undefined,
): Promise<LogicalInvocationKey | undefined | null> {
  const context = await loadRunEndContext(transaction, runId);
  if (!context || !carriesPlanRuntime(context.runSnapshot)) return null;
  if (context.runStatus !== "queued" && context.runStatus !== "running") {
    return undefined;
  }
  const activeOwner = requireOwnerValue(owner);
  let answer;
  try {
    const runtime = await planRuntimeFromSnapshot(context.runSnapshot);
    if (runtime === null) throw new PlanStateError("plan_snapshot_invalid");
    const rows = await transaction.query<
      { stepKey: string; iteration: number; status: string; output: unknown }
    >(
      `select step_key as "stepKey", iteration, status, output
         from bakery.run_steps
        where organization_id = $1 and run_id = $2
        order by position, id`,
      [context.organizationId, context.runId],
    );
    answer = nextPlanStep(runtime, {
      inputs: planInputsFromSnapshot(context.runSnapshot),
      task: planTaskFromSnapshot(context.runSnapshot),
      rows: rows.rows,
    });
  } catch (error) {
    if (
      error instanceof PlanStateError ||
      error instanceof WorkflowInterpreterError
    ) {
      await endPlanRunFailed(transaction, context, activeOwner, error.code);
      return undefined;
    }
    throw error;
  }
  if (answer.kind === "finished") {
    await projectRunEnd(
      transaction,
      context,
      "completed",
      activeOwner,
      "WORKFLOW_PLAN_PROJECTION_CONFLICT",
    );
    return undefined;
  }
  if (answer.kind === "halted") {
    await projectRunEnd(
      transaction,
      context,
      answer.outcome === "canceled" ? "canceled" : "failed",
      activeOwner,
      "WORKFLOW_PLAN_PROJECTION_CONFLICT",
    );
    return undefined;
  }
  if (answer.step.kind === "wait") {
    await endPlanRunFailed(
      transaction,
      context,
      activeOwner,
      "plan_wait_unsupported",
    );
    return undefined;
  }
  await transaction.query(
    `insert into bakery.run_steps (
       organization_id, run_id, step_key, position, iteration, status, input
     )
     select $1, $2, $3, coalesce(max(position), 0) + 1, 0, 'pending', $4::jsonb
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
     on conflict (run_id, step_key, iteration) do nothing`,
    [
      context.organizationId,
      context.runId,
      answer.step.key,
      JSON.stringify(answer.step.input),
    ],
  );
  return {
    runId: context.runId,
    stepKey: answer.step.key,
    iteration: 0,
    actionVersion: context.workflowVersionId,
  };
}

async function projectFailure(
  transaction: PgTransactionClient,
  row: AdmissionStepRow,
  reason: string,
  owner?: EngineOwner,
): Promise<void> {
  await requireEngineOwner(transaction, row.runId, owner);
  const failure = failureProjection(reason);
  const ownerPredicate = owner
    ? `and exists (
         select 1
           from bakery.workflow_runs owner_run
          where owner_run.id = $3
            and owner_run.engine_owner_token = $4
            and owner_run.engine_owner_generation = $5
            and owner_run.engine_owner_lease_expires_at > clock_timestamp()
            and owner_run.status not in ('completed', 'failed', 'canceled', 'blocked')
       )`
    : "";
  if (row.jobId !== null) {
    const jobUpdate = await transaction.query<{ version: number }>(
      `update bakery.jobs
          set status = 'failed', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
          and status not in ('completed', 'failed', 'canceled')
          ${ownerPredicate}
        returning version`,
      owner
        ? [
          row.organizationId,
          row.jobId,
          row.runId,
          owner.token,
          owner.generation,
        ]
        : [row.organizationId, row.jobId],
    );
    if (jobUpdate.rows[0] && row.lastAttemptId) {
      await appendDomainEvent(transaction, {
        organizationId: row.organizationId,
        applicationId: row.applicationId,
        repositoryId: row.repositoryId,
        taskId: row.taskId,
        conversationId: row.conversationId,
        eventType: "job.updated",
        aggregateId: row.jobId,
        aggregateVersion: jobUpdate.rows[0].version,
        payload: {
          jobId: row.jobId,
          attemptId: row.lastAttemptId,
          version: jobUpdate.rows[0].version,
        },
        traceId: originalTraceId(row),
      });
    }
  }
  await transaction.query(
    `update bakery.run_steps
        set status = 'failed', error = ${owner ? "$6" : "$3"}::jsonb,
            started_at = coalesce(started_at, now()),
            finished_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled', 'skipped')
        ${ownerPredicate}`,
    owner
      ? [
        row.organizationId,
        row.runStepId,
        row.runId,
        owner.token,
        owner.generation,
        JSON.stringify({ code: failure.code, message: failure.message }),
      ]
      : [
        row.organizationId,
        row.runStepId,
        JSON.stringify({ code: failure.code, message: failure.message }),
      ],
  );
  await projectRunEnd(
    transaction,
    row,
    "failed",
    owner,
    "WORKFLOW_FAILURE_PROJECTION_CONFLICT",
  );
}

/**
 * The statements every run end shares: the run row (status, `finished_at`, the
 * engine owner cleared, fenced by the owner when there is one), its
 * `run.updated` event, the task row and its `tasks.updated` event, and the
 * coordination plan/lane projection. A failed step reaches it through
 * `projectFailure`; a compiled plan reaches it when the interpreter says the
 * plan is finished or halted. `conflict` names the error when the run or the
 * task is no longer open.
 */
const RUN_END_STATUS: Readonly<
  Record<"completed" | "failed" | "canceled", string>
> = { completed: "completed", failed: "failed", canceled: "canceled" };

async function projectRunEnd(
  transaction: PgTransactionClient,
  row: RunEndContext,
  status: "completed" | "failed" | "canceled",
  owner: EngineOwner | undefined,
  conflict: string,
): Promise<void> {
  // A closed set of literals: the status is never taken from outside.
  const literal = RUN_END_STATUS[status];
  if (literal === undefined) throw new Error(conflict);
  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = '${literal}', finished_at = now(), updated_at = now(),
            engine_owner_token = null, engine_owner_lease_expires_at = null,
            version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled', 'blocked')
        ${
      owner
        ? "and engine_owner_token = $3 and engine_owner_generation = $4 " +
          "and engine_owner_lease_expires_at > clock_timestamp()"
        : ""
    }
      returning version`,
    owner
      ? [row.organizationId, row.runId, owner.token, owner.generation]
      : [row.organizationId, row.runId],
  );
  if (!runUpdate.rows[0]) {
    throw new Error(conflict);
  }
  await appendRunUpdated(transaction, row, runUpdate.rows[0].version);
  const taskUpdate = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = '${literal}', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
        and current_run_id = $3
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [row.organizationId, row.taskId, row.runId],
  );
  if (!taskUpdate.rows[0]) {
    throw new Error(conflict);
  }
  await appendDomainEvent(transaction, {
    organizationId: row.organizationId,
    applicationId: row.applicationId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    conversationId: row.conversationId,
    eventType: "tasks.updated",
    aggregateId: row.taskId,
    aggregateVersion: taskUpdate.rows[0].version,
    payload: {
      resourceId: row.taskId,
      resourceVersion: taskUpdate.rows[0].version,
    },
    traceId: originalTraceId(row),
  });
  // Keep the persisted coordination plan/lane projection in step with the child.
  await reconcileCoordinationForTerminalTask(transaction, {
    organizationId: row.organizationId,
    taskId: row.taskId,
    traceId: originalTraceId(row),
  });
}

export function createBakeryPostgresWorkflowRepository(options: {
  database: PgDatabase;
  maxAttempts: number;
  budgetPolicy?: BudgetPolicy;
}): BakeryPostgresWorkflowRepository {
  if (
    !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
    options.maxAttempts > MAX_PERSISTED_ATTEMPTS
  ) {
    throw new Error("WORKFLOW_MAX_ATTEMPTS_INVALID");
  }
  return {
    async acquireEngineOwner(runId, token, leaseMs) {
      if (
        !runId.trim() || !token.trim() || !Number.isSafeInteger(leaseMs) ||
        leaseMs < 1
      ) throw new Error("WORKFLOW_ENGINE_OWNER_INVALID");
      return await withPgTransaction(options.database, async (transaction) => {
        const result = await transaction.query<{ generation: string }>(
          `update bakery.workflow_runs
              set engine_owner_token = $2,
                  engine_owner_generation = engine_owner_generation + 1,
                  engine_owner_lease_expires_at =
                    clock_timestamp() + ($3::integer * interval '1 millisecond'),
                  updated_at = clock_timestamp(), version = version + 1
            where id = $1
              and status not in ('completed', 'failed', 'canceled', 'blocked')
              and (
                engine_owner_token is null or
                engine_owner_lease_expires_at <= clock_timestamp()
              )
            returning engine_owner_generation as generation`,
          [runId, token, leaseMs],
        );
        const row = result.rows[0];
        return row
          ? { runId, token, generation: row.generation, leaseMs }
          : undefined;
      });
    },
    async renewEngineOwner(owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        const result = await transaction.query(
          `update bakery.workflow_runs
              set engine_owner_lease_expires_at =
                    clock_timestamp() + ($4::integer * interval '1 millisecond'),
                  updated_at = clock_timestamp(), version = version + 1
            where id = $1 and engine_owner_token = $2
              and engine_owner_generation = $3
              and engine_owner_lease_expires_at > clock_timestamp()
              and status not in ('completed', 'failed', 'canceled', 'blocked')
            returning id`,
          [owner.runId, owner.token, owner.generation, owner.leaseMs],
        );
        return result.rows.length > 0;
      });
    },
    async releaseEngineOwner(owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        const result = await transaction.query(
          `update bakery.workflow_runs
              set engine_owner_token = null,
                  engine_owner_lease_expires_at = null,
                  updated_at = clock_timestamp(), version = version + 1
            where id = $1 and engine_owner_token = $2
              and engine_owner_generation = $3
              and engine_owner_lease_expires_at > clock_timestamp()
              and status not in ('completed', 'failed', 'canceled', 'blocked')
            returning id`,
          [owner.runId, owner.token, owner.generation],
        );
        return result.rows.length > 0;
      });
    },
    async handoffEngineOwner(owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        const locked = await transaction.query<{
          organizationId: string;
          taskId: string;
          applicationId: string;
          repositoryId: string | null;
          conversationId: string;
          traceId: string | null;
          version: number;
        }>(
          `select run.organization_id as "organizationId",
                  run.task_id as "taskId",
                  task.application_id as "applicationId",
                  task.repository_id as "repositoryId",
                  task.conversation_id as "conversationId",
                  run.version,
                  original_request.trace_id as "traceId"
             from bakery.workflow_runs run
             join bakery.tasks task
               on task.organization_id = run.organization_id
              and task.id = run.task_id
             left join lateral (
               select event.trace_id
                 from bakery.domain_events event
                where event.organization_id = run.organization_id
                  and event.aggregate_id = run.id
                  and event.event_type = 'run.requested'
                order by event.organization_sequence asc
                limit 1
             ) original_request on true
            where run.id = $1
              and run.engine_owner_token = $2
              and run.engine_owner_generation = $3
              and run.engine_owner_lease_expires_at > clock_timestamp()
              and run.status not in ('completed', 'failed', 'canceled', 'blocked')
            for update of run`,
          [owner.runId, owner.token, owner.generation],
        );
        const row = locked.rows[0];
        if (!row) return false;
        if (!row.traceId) throw new Error("WORKFLOW_ORIGINAL_TRACE_MISSING");
        const nextVersion = row.version + 1;
        await appendDomainEvent(transaction, {
          organizationId: row.organizationId,
          applicationId: row.applicationId,
          repositoryId: row.repositoryId,
          taskId: row.taskId,
          conversationId: row.conversationId,
          eventType: "run.requested",
          aggregateId: owner.runId,
          aggregateVersion: nextVersion,
          payload: { runId: owner.runId },
          traceId: row.traceId,
          outboxDeliveryKey: `run:${owner.runId}:version:${nextVersion}`,
        });
        const released = await transaction.query<{ version: number }>(
          `update bakery.workflow_runs
              set engine_owner_token = null,
                  engine_owner_lease_expires_at = null,
                  updated_at = clock_timestamp(), version = version + 1
            where id = $1
              and engine_owner_token = $2
              and engine_owner_generation = $3
              and engine_owner_lease_expires_at > clock_timestamp()
            returning version`,
          [owner.runId, owner.token, owner.generation],
        );
        const version = released.rows[0]?.version;
        if (version === undefined || version !== nextVersion) {
          throw new Error("WORKFLOW_OWNER_HANDOFF_CONFLICT");
        }
        return true;
      });
    },
    async rearmExpiredEngineOwners(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("WORKFLOW_RECONCILIATION_LIMIT_INVALID");
      }
      return await withPgTransaction(options.database, async (transaction) => {
        const result = await transaction.query<EngineOwnerCandidate>(
          `with candidates as (
             select run.id
               from bakery.workflow_runs run
              where run.kind = 'workflow'
                and run.status in ('queued', 'running')
                and run.updated_at <= clock_timestamp() - interval '1 second'
                and (
                  (
                    run.engine_owner_token is null
                    and not exists (
                      select 1
                        from bakery.outbox delivery
                        join bakery.domain_events event
                          on event.organization_id = delivery.organization_id
                         and event.id = delivery.event_id
                       where delivery.organization_id = run.organization_id
                         and event.aggregate_id = run.id
                         and event.event_type = 'run.requested'
                         and delivery.destination = 'inngest'
                         and (
                           delivery.status in ('pending', 'sending')
                           or (
                             delivery.status = 'delivered'
                             and delivery.delivered_at >
                               clock_timestamp() -
                                 ($2::integer * interval '1 millisecond')
                           )
                         )
                    )
                  ) or (
                    run.engine_owner_token is not null
                    and run.engine_owner_lease_expires_at <= clock_timestamp()
                  )
                )
              order by run.updated_at asc, run.id asc
              limit $1
              for update of run skip locked
           )
           update bakery.workflow_runs run
              set engine_owner_token = null,
                  engine_owner_lease_expires_at = null,
                  updated_at = clock_timestamp(), version = version + 1
             from candidates
            where run.id = candidates.id
           returning run.id as "runId",
                     run.engine_owner_generation as generation`,
          [limit, MIN_ENGINE_OWNER_LEASE_MS],
        );
        return result.rows;
      });
    },
    async findNext(runId, owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, runId, owner);
        const planKey = await findNextPlanKey(transaction, runId, owner);
        if (planKey !== null) return planKey;
        return await loadNext(transaction, runId);
      });
    },
    async readRunStatus(runId, owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, runId, owner);
        return await loadRunStatus(transaction, runId);
      });
    },
    async read(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, key.runId, owner);
        return stateFromRow(
          key,
          await loadLogical(transaction, key),
          options.maxAttempts,
        );
      });
    },
    async admit(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await lockExistingJob(transaction, key);
        const row = await loadLogical(
          transaction,
          key,
          true,
        ) as AdmissionStepRow;
        await requireEngineOwner(transaction, key.runId, owner);
        if (key.actionVersion !== row.workflowVersionId) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        const snapshot = jsonRecord(row.runSnapshot);
        const profileContext = RepositoryExecutionContextSchema.safeParse(
          snapshot?.repositoryProfile,
        );
        let profile: AdmittedRepositoryProfile | null = null;
        if (snapshot?.executionMode === "repository") {
          if (
            !profileContext.success ||
            profileContext.data.organizationId !== row.organizationId ||
            profileContext.data.applicationId !== row.applicationId ||
            profileContext.data.repositoryId !== row.repositoryId ||
            profileContext.data.applicationId !== row.runApplicationId ||
            profileContext.data.repositoryId !== row.runRepositoryId ||
            profileContext.data.id !== row.runRepositoryProfileId ||
            profileContext.data.revision !== row.runRepositoryProfileRevision ||
            profileContext.data.digest !== row.runRepositoryProfileDigest ||
            row.runRepositoryProfileId !== row.taskRepositoryProfileId ||
            row.runRepositoryProfileRevision !==
              row.taskRepositoryProfileRevision ||
            row.runRepositoryProfileDigest !==
              row.taskRepositoryProfileDigest ||
            profileContext.data.observationId !== row.runObservationId ||
            profileContext.data.observationDigest !==
              row.runObservationDigest ||
            profileContext.data.baseSha !== row.runBaseSha ||
            row.runObservationId !== row.taskObservationId ||
            row.runObservationDigest !== row.taskObservationDigest ||
            row.runBaseSha !== row.taskBaseSha
          ) {
            throw new StandardError({ code: "STATE_CONFLICT" });
          }
          profile = await loadExecutableRepositoryProfile(
            transaction,
            profileContext.data,
            {
              repositoryProfileId: profileContext.data.id,
              repositoryProfileRevision: profileContext.data.revision,
              repositoryProfileDigest: profileContext.data.digest,
              observationId: profileContext.data.observationId,
              observationDigest: profileContext.data.observationDigest,
              baseSha: profileContext.data.baseSha,
            },
          );
          if (
            canonicalJson(profile.config) !==
              canonicalJson(profileContext.data.config)
          ) {
            throw new StandardError({ code: "STATE_CONFLICT" });
          }
        } else if (
          snapshot?.executionMode !== "cloud_only" ||
          row.taskType !== "maintenance" ||
          snapshot.repositoryProfile !== null ||
          row.runApplicationId !== null ||
          row.runRepositoryId !== null || row.runRepositoryProfileId !== null ||
          row.runRepositoryProfileRevision !== null ||
          row.runRepositoryProfileDigest !== null ||
          row.runObservationId !== null || row.runObservationDigest !== null ||
          row.runBaseSha !== null
        ) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        if (row.jobId !== null) {
          await admitRepositoryExecutionJob(
            transaction,
            row.organizationId,
            row.jobId,
            { enqueue: true },
          );
          if (isTerminal(row)) return { key, terminal: true };
          const stepUpdate = await transaction.query(
            `update bakery.run_steps
                set status = 'running', started_at = coalesce(started_at, now()),
                    updated_at = now(), version = version + 1
              where organization_id = $1 and id = $2 and status = 'pending'
              returning version`,
            [row.organizationId, row.runStepId],
          );
          if (stepUpdate.rows[0]) {
            const runUpdate = await transaction.query<{ version: number }>(
              `update bakery.workflow_runs
                  set status = 'running',
                      started_at = coalesce(started_at, now()),
                      updated_at = now(), version = version + 1
                where organization_id = $1 and id = $2
                  and status in ('queued', 'running')
                  ${
                owner
                  ? "and engine_owner_token = $3 " +
                    "and engine_owner_generation = $4 " +
                    "and engine_owner_lease_expires_at > clock_timestamp()"
                  : ""
              }
                returning version`,
              owner
                ? [
                  row.organizationId,
                  row.runId,
                  owner.token,
                  owner.generation,
                ]
                : [row.organizationId, row.runId],
            );
            if (owner && !runUpdate.rows[0]) {
              throw new EngineOwnerLostError();
            }
            if (runUpdate.rows[0]) {
              await appendRunUpdated(
                transaction,
                row,
                runUpdate.rows[0].version,
              );
            }
          }
          const admitted = await loadLogical(transaction, key);
          return {
            key,
            terminal: isTerminal(admitted),
            ...(admitted.jobId ? { jobId: admitted.jobId } : {}),
          };
        }
        if (
          !eligibleRunStatuses[row.runStatus] ||
          !eligibleStepStatuses[row.stepStatus] ||
          row.cancelRequestedAt !== null
        ) {
          return { key, terminal: true };
        }
        const {
          action,
          input: resolvedInput,
          agent,
          requiredCapabilities,
        } = actionAndInputFromSnapshot(row);
        workflowActionCapabilities(action, requiredCapabilities);
        assertActionAgentPolicy(requiredCapabilities, agent?.config ?? null);
        const value = jsonRecord(resolvedInput);
        if (
          !value || Object.hasOwn(value, "repositoryProfile") ||
          (Object.hasOwn(value, "repositoryId") &&
            value.repositoryId !== row.runRepositoryId)
        ) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        assertActionInput(action, value);
        const input = profileContext.success
          ? { ...value, repositoryProfile: profileContext.data }
          : value;
        if (!executionJobInputFitsTransport(input)) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        await assertSecretIdentityRepositoryAdmission(transaction, {
          organizationId: row.organizationId,
          action,
          executionMode: snapshot?.executionMode,
          applicationId: row.runApplicationId,
          repositoryId: row.runRepositoryId,
          repositoryProfile: profileContext.success
            ? profileContext.data
            : null,
          requestedBy: row.requestedBy,
          runId: row.runId,
          secretRef: typeof value.secretRef === "string"
            ? value.secretRef
            : null,
        });
        const requirements = repositoryExecutionRequirements(
          profile,
          action,
          requiredCapabilities,
        );
        const contentDigest = await budgetContentDigest({
          action,
          actionVersion: key.actionVersion,
          input,
          agent,
        });
        // A deterministic refusal rolls back the partial reservation and fails
        // the run; other errors keep rolling back the whole admission.
        await transaction.query("savepoint workflow_budget_reservation");
        let budgetReservation;
        try {
          budgetReservation = await reserveWorkflowAction(transaction, {
            organizationId: row.organizationId,
            runId: row.runId,
            runStepId: row.runStepId,
            action,
            actionVersion: key.actionVersion,
            contentDigest,
            agentVersionId: agent?.agentVersionId ?? null,
            billing: agent?.config.billing ?? null,
            policy: options.budgetPolicy,
          });
        } catch (error) {
          await transaction.query(
            "rollback to savepoint workflow_budget_reservation",
          );
          const refusal = budgetAdmissionRefusal(error);
          if (!refusal) throw error;
          await transaction.query(
            "release savepoint workflow_budget_reservation",
          );
          await projectFailure(
            transaction,
            row,
            `${refusal.code}:${refusal.message}`,
            owner,
          );
          return { key, terminal: true };
        }
        await transaction.query(
          "release savepoint workflow_budget_reservation",
        );
        await transaction.query(
          `insert into bakery.jobs (
             organization_id, run_step_id, action, input, status,
             available_at, priority, max_attempts,
             application_id, repository_id, repository_profile_id,
             repository_profile_revision, repository_profile_digest,
             observation_id, observation_digest, base_sha, requirements,
             agent_version_id, agent_config, skill_refs, billing,
             installation_reservation_id
           ) values ($1, $2, $3, $4::jsonb, 'queued', now(), 0, $5,
                     $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                     $15, $16::jsonb, $17::jsonb, $18::jsonb, $19)
           on conflict (run_step_id, action) do nothing`,
          [
            row.organizationId,
            row.runStepId,
            action,
            JSON.stringify(input ?? {}),
            action === "secret.identity.read" ? 1 : options.maxAttempts,
            row.runApplicationId,
            row.runRepositoryId,
            row.runRepositoryProfileId,
            row.runRepositoryProfileRevision,
            row.runRepositoryProfileDigest,
            row.runObservationId,
            row.runObservationDigest,
            row.runBaseSha,
            canonicalJson(requirements),
            agent?.agentVersionId ?? null,
            canonicalJson(agent?.config ?? {}),
            canonicalJson(agent?.skillRefs ?? []),
            JSON.stringify(agent?.config.billing ?? null),
            budgetReservation?.installationReservationId ?? null,
          ],
        );
        if (agent && workerActionOutputCarriesSession(action)) {
          // Worker results must name a server-created session of this step.
          await transaction.query(
            "select pg_advisory_xact_lock(hashtext('agent_session:' || $1::text))",
            [row.runStepId],
          );
          await transaction.query(
            `insert into bakery.agent_sessions (
               organization_id, run_step_id, conversation_id,
               agent_version_id, harness, status
             )
             select $1, $2, $3, $4, $5, 'starting'
              where not exists (
                select 1 from bakery.agent_sessions existing
                 where existing.organization_id = $1
                   and existing.run_step_id = $2
              )`,
            [
              row.organizationId,
              row.runStepId,
              row.conversationId,
              agent.agentVersionId,
              agent.config.harness,
            ],
          );
        }
        const stepUpdate = await transaction.query(
          `update bakery.run_steps
              set status = 'running', started_at = coalesce(started_at, now()),
                  updated_at = now(), version = version + 1
            where organization_id = $1 and id = $2 and status = 'pending'
            returning version`,
          [row.organizationId, row.runStepId],
        );
        if (stepUpdate.rows[0]) {
          const runUpdate = await transaction.query<{ version: number }>(
            `update bakery.workflow_runs
                set status = 'running', started_at = coalesce(started_at, now()),
                    updated_at = now(), version = version + 1
              where organization_id = $1 and id = $2
                and status in ('queued', 'running')
                ${
              owner
                ? "and engine_owner_token = $3 " +
                  "and engine_owner_generation = $4 " +
                  "and engine_owner_lease_expires_at > clock_timestamp()"
                : ""
            }
              returning version`,
            owner
              ? [
                row.organizationId,
                row.runId,
                owner.token,
                owner.generation,
              ]
              : [row.organizationId, row.runId],
          );
          if (owner && !runUpdate.rows[0]) {
            throw new EngineOwnerLostError();
          }
          if (runUpdate.rows[0]) {
            await appendRunUpdated(transaction, row, runUpdate.rows[0].version);
          }
        }
        const admitted = await loadLogical(transaction, key);
        if (admitted.jobId) {
          await admitRepositoryExecutionJob(
            transaction,
            admitted.organizationId,
            admitted.jobId,
            { enqueue: true },
          );
        }
        return {
          key,
          terminal: isTerminal(admitted),
          ...(admitted.jobId ? { jobId: admitted.jobId } : {}),
        };
      });
    },
    async markStalled(key, reason, owner) {
      assertLogicalKey(key);
      await withPgTransaction(options.database, async (transaction) => {
        await lockExistingJob(transaction, key);
        const row = await loadLogical(
          transaction,
          key,
          true,
        ) as AdmissionStepRow;
        if (
          !["attempt_budget_exhausted", "workflow_step_bound_exhausted"]
            .includes(reason) ||
          isTerminal(row) ||
          (reason === "attempt_budget_exhausted" && row.jobId === null)
        ) return;
        if (reason === "attempt_budget_exhausted") {
          const budget = await transaction.query<{
            maxAttempts: number;
            terminalAttempts: string;
            liveAttempts: string;
          }>(
            `select job.max_attempts as "maxAttempts",
                    count(*) filter (
                      where attempt.status not in ('leased', 'running', 'canceling')
                    )::text as "terminalAttempts",
                    count(*) filter (
                      where attempt.status in ('leased', 'running', 'canceling')
                    )::text as "liveAttempts"
               from bakery.jobs job
               left join bakery.job_attempts attempt
                 on attempt.organization_id = job.organization_id
                and attempt.job_id = job.id
              where job.organization_id = $1 and job.id = $2
              group by job.id`,
            [row.organizationId, row.jobId],
          );
          const budgetRow = budget.rows[0];
          if (
            !budgetRow ||
            Number(budgetRow.terminalAttempts) < budgetRow.maxAttempts ||
            Number(budgetRow.liveAttempts) !== 0
          ) return;
        }
        await projectFailure(transaction, row, reason, owner);
      });
    },
    async finishPlanRun(runId, outcome, owner) {
      if (!Object.hasOwn(RUN_END_STATUS, outcome)) {
        throw new Error("WORKFLOW_PLAN_OUTCOME_INVALID");
      }
      await withPgTransaction(options.database, async (transaction) => {
        const context = await loadRunEndContext(transaction, runId);
        if (!context) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        await requireEngineOwner(transaction, runId, requireOwnerValue(owner));
        if (!carriesPlanRuntime(context.runSnapshot)) {
          throw new Error("WORKFLOW_PLAN_RUN_REQUIRED");
        }
        await projectRunEnd(
          transaction,
          context,
          outcome,
          owner,
          "WORKFLOW_PLAN_PROJECTION_CONFLICT",
        );
      });
    },
    async markEngineFailure(runId, reason, ownerReference) {
      if (!runId.trim() || !reason.trim()) {
        throw new Error("WORKFLOW_ENGINE_FAILURE_INVALID");
      }
      await withPgTransaction(options.database, async (transaction) => {
        let owner: EngineOwner | undefined;
        let ownerToken: string | undefined;
        if (typeof ownerReference === "object" && ownerReference !== null) {
          if (ownerReference.runId !== runId) return;
          owner = ownerReference;
        } else if (ownerReference) {
          ownerToken = ownerReference;
        }
        const ownerFromToken = async (): Promise<EngineOwner | undefined> => {
          if (!ownerToken) return owner;
          const result = await transaction.query<{ generation: string }>(
            `select engine_owner_generation as generation
               from bakery.workflow_runs
              where id = $1
                and engine_owner_token = $2
                and engine_owner_lease_expires_at > clock_timestamp()
                and status not in ('completed', 'failed', 'canceled', 'blocked')`,
            [runId, ownerToken],
          );
          if (!result.rows[0]) return undefined;
          return {
            runId,
            token: ownerToken,
            generation: result.rows[0].generation,
            leaseMs: MIN_ENGINE_OWNER_LEASE_MS,
          };
        };
        const key = await loadNext(transaction, runId);
        if (!key) {
          // A compiled-plan run has no open row between steps, and an engine
          // failure there still has to end the run, not leave it running.
          const context = await loadRunEndContext(transaction, runId);
          if (
            !context || !carriesPlanRuntime(context.runSnapshot) ||
            (context.runStatus !== "queued" && context.runStatus !== "running")
          ) return;
          const planOwner = await ownerFromToken();
          if (ownerToken && !planOwner) return;
          await endPlanRunFailed(
            transaction,
            context,
            planOwner,
            failureProjection(reason).code,
          );
          return;
        }
        await lockExistingJob(transaction, key);
        const row = await loadLogical(
          transaction,
          key,
          true,
        ) as AdmissionStepRow;
        if (ownerToken) {
          owner = await ownerFromToken();
          if (!owner) return;
        }
        await projectFailure(transaction, row, reason, owner);
      });
    },
  };
}

export function createBakeryFixedWorkflow(options: {
  client: Inngest;
  database: PgDatabase;
  maxAttempts: number;
  waitMs: number;
  jobCompletionTimeout: string;
  engineRetries: number;
  budgetPolicy?: BudgetPolicy;
}) {
  const repository = createBakeryPostgresWorkflowRepository({
    database: options.database,
    maxAttempts: options.maxAttempts,
    budgetPolicy: options.budgetPolicy,
  });
  const engineRetries = options.engineRetries as
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10;
  if (
    !Number.isSafeInteger(options.engineRetries) ||
    options.engineRetries < 1 ||
    options.engineRetries > 10
  ) {
    throw new Error("WORKFLOW_ENGINE_RETRIES_INVALID");
  }
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 1) {
    throw new Error("WORKFLOW_RETRY_WAIT_INVALID");
  }
  const timeoutMatch = /^(?<amount>\d+)(?<unit>ms|s|m|h)$/.exec(
    options.jobCompletionTimeout.trim(),
  );
  if (!timeoutMatch?.groups) {
    throw new Error("WORKFLOW_COMPLETION_TIMEOUT_INVALID");
  }
  const timeoutMultiplier = timeoutMatch.groups.unit === "ms"
    ? 1
    : timeoutMatch.groups.unit === "s"
    ? 1_000
    : timeoutMatch.groups.unit === "m"
    ? 60_000
    : 3_600_000;
  const timeoutMs = Number(timeoutMatch.groups.amount) * timeoutMultiplier;
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    timeoutMs > MAX_JOB_COMPLETION_TIMEOUT_MS
  ) {
    throw new Error("WORKFLOW_COMPLETION_TIMEOUT_INVALID");
  }
  const ownerLeaseMs = Math.max(MIN_ENGINE_OWNER_LEASE_MS, timeoutMs * 2);
  return options.client.createFunction(
    {
      id: "bakery-fixed-workflow",
      retries: engineRetries,
      concurrency: [{
        key: "event.data.payload.runId",
        limit: 1,
      }],
      onFailure: async ({ event, error, step }) => {
        if (!isDeterministicWorkflowError(error)) return;
        const original = jsonRecord(event.data.event);
        if (!original) return;
        const ownerToken = typeof original.id === "string"
          ? original.id
          : undefined;
        const payload = eventPayload(original.data);
        const runId = payload.runId;
        if (
          typeof runId !== "string" || runId.trim() === "" || !ownerToken
        ) return;
        const code = (error instanceof Error ? error.message : String(error))
          .split(":", 1)[0] ?? "WORKFLOW_ENGINE_FAILURE";
        // Catch-time projection is authoritative while the owner fence is live.
        // onFailure below remains a retry-safe fallback for exhausted retries.
        await step.run(
          `fallback-project-engine-failure-${runId}`,
          () => repository.markEngineFailure(runId, code, ownerToken),
        );
      },
      triggers: [{ event: "bakery/run.requested.v1" }],
    },
    async ({ event, step }) => {
      const payload = eventPayload(event.data);
      const runId = payload.runId;
      const ownerToken = typeof event.id === "string" ? event.id : undefined;
      let owner: EngineOwner | undefined;
      let released = false;
      const releaseOwner = async (): Promise<void> => {
        if (!owner || released) return;
        const activeOwner = requireOwnerValue(owner);
        try {
          await step.run(
            `release-engine-owner-${activeOwner.generation}`,
            () => repository.releaseEngineOwner(activeOwner),
          );
        } catch {
          // Recovery reclaims an expired lease when the database is unavailable.
        }
        released = true;
      };
      const handoff = async (): Promise<{ status: string }> => {
        if (!owner || released) return { status: "superseded" };
        const activeOwner = requireOwnerValue(owner);
        const didHandoff = await step.run(
          `handoff-engine-owner-${activeOwner.generation}`,
          () => repository.handoffEngineOwner(activeOwner),
        );
        released = true;
        return didHandoff ? { status: "handoff" } : { status: "superseded" };
      };
      try {
        if (typeof runId !== "string" || runId.trim() === "") {
          throw new Error("WORKFLOW_RUN_ID_MISSING");
        }
        if (typeof ownerToken !== "string" || ownerToken.trim() === "") {
          throw new Error("WORKFLOW_EVENT_ID_MISSING");
        }
        const acquiredOwner = await step.run(
          "acquire-engine-owner",
          () =>
            repository.acquireEngineOwner(
              runId,
              ownerToken,
              ownerLeaseMs,
            ),
        );
        if (!acquiredOwner) return { status: "superseded" };
        owner = acquiredOwner;
        let checkpoint = 0;
        while (checkpoint < MAX_WORKFLOW_STEPS) {
          const key = await step.run(
            `load-next-workflow-step-${checkpoint}`,
            () => repository.findNext(runId, owner),
          );
          if (!key) {
            const status = await step.run(
              `read-run-status-${checkpoint}`,
              () => repository.readRunStatus(runId, owner),
            );
            if (
              status === "paused" || status === "waiting_input" ||
              status === "waiting_capacity"
            ) {
              await releaseOwner();
              return { status: "waiting" as const };
            }
            await releaseOwner();
            return { status: status ?? "completed" };
          }

          let waitAttempt = 0;
          let retryAttempt = 0;
          while (
            waitAttempt < MAX_RECONCILIATION_WAITS &&
            retryAttempt < MAX_RETRY_ATTEMPTS
          ) {
            const renewed = await step.run(
              `renew-engine-owner-before-${checkpoint}-${waitAttempt}`,
              () => repository.renewEngineOwner(requireOwnerValue(owner)),
            );
            if (!renewed) throw new EngineOwnerLostError();
            const outcome = await runFixedWorkflow(
              { logical: key },
              {
                store: {
                  read: (logical) => repository.read(logical, owner),
                  admit: (logical) => repository.admit(logical, owner),
                },
                checkpoint,
                wait: async (admission, waitCheckpoint) => {
                  if (!admission.jobId) {
                    throw new Error("WORKFLOW_JOB_ID_MISSING");
                  }
                  const waitNumber = waitAttempt++;
                  await step.waitForEvent(
                    `wait-for-job-${checkpoint}-${key.stepKey}-${key.iteration}-${waitCheckpoint}-${waitNumber}`,
                    {
                      event: "bakery/job.completed.v1",
                      timeout: options.jobCompletionTimeout,
                      if: `async.data.payload.runId == '${runId}' && ` +
                        `async.data.payload.jobId == '${admission.jobId}'`,
                    },
                  );
                },
              },
            );
            const afterWaitRenewed = await step.run(
              `renew-engine-owner-after-${checkpoint}-${waitAttempt}`,
              () => repository.renewEngineOwner(requireOwnerValue(owner)),
            );
            if (!afterWaitRenewed) throw new EngineOwnerLostError();
            if (outcome.decision.kind === "terminal-result") break;
            if (outcome.decision.kind === "retryable") {
              if (retryAttempt >= MAX_RETRY_ATTEMPTS - 1) {
                return await handoff();
              }
              const delayMs = Math.max(
                1,
                Math.min(
                  options.waitMs,
                  outcome.decision.nextRetryAt.getTime() - Date.now(),
                ),
              );
              const retryNumber = retryAttempt++;
              await step.sleep(
                `wait-for-retry-${checkpoint}-${key.stepKey}-${key.iteration}-${retryNumber}`,
                `${delayMs}ms`,
              );
              continue;
            }
            if (outcome.decision.kind === "stalled") {
              const reason = outcome.decision.reason;
              await step.run(
                `mark-stalled-${checkpoint}-${key.stepKey}-${key.iteration}`,
                () => repository.markStalled(key, reason, owner),
              );
              await releaseOwner();
              return { status: "stalled" as const, reason };
            }
            if (outcome.decision.kind === "waiting") continue;
            if (outcome.decision.kind === "failed") {
              await releaseOwner();
              return {
                status: "failed" as const,
                reason: outcome.decision.reason,
              };
            }
            if (outcome.decision.kind === "state-conflict") {
              throw new Error(
                `WORKFLOW_STATE_CONFLICT:${outcome.decision.reason}`,
              );
            }
            throw new Error("WORKFLOW_RECONCILIATION_UNEXPECTED");
          }
          if (
            waitAttempt >= MAX_RECONCILIATION_WAITS ||
            retryAttempt >= MAX_RETRY_ATTEMPTS
          ) return await handoff();
          checkpoint += 1;
        }
        return await handoff();
      } catch (error) {
        if (error instanceof EngineOwnerLostError) {
          if (typeof runId === "string" && runId.trim() !== "") {
            try {
              const status = await step.run(
                `read-terminal-run-status-${runId}`,
                () => repository.readRunStatus(runId),
              );
              if (status === "completed") {
                return { status: "completed" as const };
              }
            } catch {
              // A successor owns recovery when the authoritative read fails.
            }
          }
          return { status: "superseded" as const };
        }
        if (isDeterministicWorkflowError(error)) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          const code = message.split(":", 1)[0] ??
            "WORKFLOW_ENGINE_FAILURE";
          const activeOwner = owner;
          if (
            activeOwner && typeof runId === "string" && runId.trim() !== ""
          ) {
            try {
              await step.run(
                `project-engine-failure-${runId}-${activeOwner.generation}`,
                () => repository.markEngineFailure(runId, code, activeOwner),
              );
            } catch {
              // onFailure retries the fenced projection after this throw.
            }
          }
          throw new NonRetriableError(message, { cause: error });
        }
        throw error;
      } finally {
        await releaseOwner();
      }
    },
  );
}

export function createBakeryWorkflowRecovery(options: {
  client: Inngest;
  database: PgDatabase;
  limit?: number;
  budgetPolicy?: BudgetPolicy;
}) {
  const repository = createBakeryPostgresWorkflowRepository({
    database: options.database,
    maxAttempts: 1,
    budgetPolicy: options.budgetPolicy,
  });
  const limit = options.limit ?? 50;
  return options.client.createFunction(
    {
      id: "bakery-workflow-recovery",
      retries: 3,
      triggers: [
        { cron: "* * * * *" },
        { event: "bakery/workflow.reconcile.v1" },
      ],
    },
    async ({ step }) => {
      const candidates = await step.run(
        "rearm-expired-workflow-owners",
        () => repository.rearmExpiredEngineOwners(limit),
      );
      for (const candidate of candidates) {
        await step.sendEvent(
          `rearm-workflow-${candidate.runId}-${candidate.generation}`,
          {
            name: "bakery/run.requested.v1",
            data: { payload: { runId: candidate.runId } },
          },
        );
      }
      return { rearmed: candidates.length };
    },
  );
}
