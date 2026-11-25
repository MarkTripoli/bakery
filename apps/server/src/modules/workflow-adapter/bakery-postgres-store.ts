import {
  RepositoryExecutionContextSchema,
  RunPlacementSchema,
} from "@bakery/contracts/repository-inspection";
import {
  actionAndInputFromSnapshot,
  admitRepositoryExecutionJob,
  type AdmittedRepositoryProfile,
  assertSecretIdentityRepositoryAdmission,
  executionJobInputFitsTransport,
  loadExecutableRepositoryProfile,
  planDispatchFromRow,
  repositoryExecutionRequirements,
  withRunPlacement,
} from "@bakery/persistence/repository-admission";
import {
  HUMAN_APPROVAL_EVENT,
  HUMAN_APPROVAL_WAIT_LIMIT_MS,
  HumanApprovalInputSchema,
  normalizeWorkflowStop,
  WorkflowStopInputSchema,
} from "@bakery/contracts/human-approval";
import { isEngineProjectionAction } from "@bakery/contracts/workflow-action-registry";
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
  projectionOutputOf,
  withPgTransaction,
  workflowActionCapabilities,
} from "@bakery/persistence";
import { type Inngest, NonRetriableError } from "inngest";
import {
  type ActionDispatch,
  type JsonValue,
  type WaitDispatch,
  WorkflowInterpreterError,
} from "@bakery/contracts/workflow-interpreter";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { reconcileCoordinationForTerminalTask } from "../work/coordination-projection.ts";
import { requestHumanApproval, stopRun } from "../work/human-approval-store.ts";
import {
  budgetContentDigest,
  type BudgetPolicy,
  reserveToolCallCost,
  reserveWorkflowAction,
  settleExistingToolCallCost,
  settleRunToolCallCosts,
  settleToolCallCost,
  type ToolCallCostReservation,
} from "../work/budget.ts";
import { pinStepContextInputs } from "./step-context-inputs.ts";
import {
  type AdmissionRecord,
  assertLogicalKey,
  type LogicalInvocationKey,
} from "./invocation-contract.ts";
import { chooseStepFacts } from "../knowledge/step-facts.ts";
import { type AuthoritativeState, decideResume } from "./resume-decision.ts";
import {
  recordNotesDelivered,
  undeliveredStepNotes,
} from "../execution/step-notes.ts";
import { runFixedWorkflow } from "./fixed-workflow.ts";
import { isEngineSettledStepAction } from "@bakery/contracts/implemented-actions";
import type { EngineStepRunner } from "./engine-steps.ts";
import {
  nextPlanStep,
  planActionAgentsFromSnapshot,
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
/**
 * Inngest operations (steps) one engine function run may use before it hands
 * the run to a fresh one: the design's 1,000 less room for the longest pass
 * (a full-width set reads and completes its waits, about 40) and the hand-off.
 */
const STEP_OPERATION_BUDGET = 900;
/** The reason `stateFromRow` gives for a job a cancel was requested on. */
const CANCEL_REQUESTED = "cancel_requested_at";
const MAX_RECONCILIATION_WAITS = 8;
/**
 * How often the engine re-reads a human.approval wait for a decision. A decision
 * arrives from a person, so a short poll costs one indexed read and keeps the
 * step responsive; it is not a busy wait because the engine sleeps between reads.
 */
const APPROVAL_POLL_MS = 15_000;

/**
 * Stable code an approval wait settles with when its window closes with no
 * answer. Written as a failure code so the step is recognisably NOT approved,
 * and worded so a reader understands that silence was not consent.
 */
const APPROVAL_EXPIRED_CODE =
  "APPROVAL_EXPIRED:The approval window closed with no decision.";
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
  runPlacement: unknown;
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
  /** What the engine decided for a compiled-plan step; null for a flat run's. */
  stepDispatch: unknown;
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
  | "runPlacement"
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
  | "stepDispatch"
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

/**
 * What the engine needs to wait on a step: how long it may last, how much is
 * left, and whether it ends on elapsed time or on a person's decision.
 */
export type WaitBoundary = Readonly<{
  durationMs: number;
  remainingMs: number;
  /**
   * When the wait started, by the database clock. Kept so an approval wait can
   * report how long it has stood; the expiry decision itself uses `expired`,
   * which the database computes, so an app clock that disagrees with the
   * database cannot expire a wait early or late.
   */
  startedAt?: string;
  /**
   * Whether the wait's window has closed, decided by the database clock the row
   * was written with. This is what makes a seven-day window actually fire
   * instead of living only in a predicate nothing calls.
   */
  expired?: boolean;
  /**
   * "duration" ends when the clock passes the boundary. "approval" ends when a
   * person decides, and its remainingMs is how long until the decision expires;
   * reaching it ends the run with an expired outcome, never an approval.
   */
  kind?: "duration" | "approval";
}>;

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
  /** Whether the run is a compiled plan (its end is decided by its interpreter). */
  isPlanRun(runId: string, owner?: EngineOwner): Promise<boolean>;
  /**
   * The steps that may run now: for a compiled-plan run under interpreter
   * revision 2 inside a parallel group, one next step for each running lane
   * (their rows are appended on demand, idempotently); otherwise the single
   * step `findNext` answers, or none when the run is over.
   */
  findNextSet(
    runId: string,
    owner?: EngineOwner,
  ): Promise<readonly LogicalInvocationKey[]>;
  /**
   * Admits the jobs of every action step of a set (waits have no job), each
   * idempotently, so that all of them are queued for workers before any is
   * waited for.
   */
  admitSet(
    keys: readonly LogicalInvocationKey[],
    owner?: EngineOwner,
  ): Promise<void>;
  /**
   * What is left of a plan run's duration wait, by the database clock, or
   * null when the step is not a duration wait (an action step). The engine
   * sleeps this long, so a restart or a second engine run sleeps only the
   * remainder, never the full duration again.
   */
  readWait(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<WaitBoundary | null>;
  /**
   * Records a duration wait as elapsed, once its time has passed by the
   * database clock. True when the step is now completed (also when it already
   * was); false when the run no longer waits on it (canceled or ended).
   * Throws `WORKFLOW_WAIT_NOT_DUE`, which the engine retries, when called early.
   */
  completeWait(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<boolean>;
  /**
   * Completes a human.approval wait from the stored answer. The decision is made
   * out of band (a person answers), so this settles the step from the answer
   * rather than from elapsed time. True when the step is now completed (also
   * when it already was); false when the answer has not arrived yet, which is a
   * normal state the caller polls on rather than an error.
   */
  completeApprovalWait(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<boolean>;
  /**
   * Settles an approval wait whose window has closed with no answer, and ends
   * the plan run failed with `approval_expired`. Never approves: §19.3, nothing
   * is ever approved by silence. True when this call settled it (also when it
   * already was settled); false when the step was already decided, in which case
   * the decision stands and there is nothing to expire.
   */
  expireApprovalWait(
    key: LogicalInvocationKey,
    owner?: EngineOwner,
  ): Promise<boolean>;
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
  // An engine-settled step has no job. While its next look is not due it reads as
  // admitted and retryable, so the engine sleeps; once due it reads as not
  // admitted, so the engine admits it again and the step reads its effect back.
  const stepRetryAt = row.jobId === null && !terminal
    ? stepRetryAtOf(row.stepDispatch)
    : null;
  const stepWaiting = stepRetryAt !== null &&
    stepRetryAt.getTime() > Date.now();
  const admission = row.jobId === null
    ? (stepWaiting ? { key, terminal } : undefined)
    : {
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
    ...(stepWaiting && stepRetryAt !== null
      ? { nextRetryAt: stepRetryAt }
      : row.availableAt && new Date(row.availableAt).getTime() > Date.now()
      ? { nextRetryAt: new Date(row.availableAt) }
      : {}),
  };
  const terminalFailure = row.cancelRequestedAt !== null
    ? CANCEL_REQUESTED
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
            run.placement as "runPlacement",
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
            step.dispatch as "stepDispatch",
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

export const PLAN_LIMIT_REACHED_CODE = "limit_reached";

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
  details?: Readonly<Record<string, string | number>>,
): Promise<void> {
  await finishPlanRunIn(transaction, context, "failed", owner, code, details);
}

/**
 * The one place a compiled-plan run ends, inside a caller's transaction:
 * `finishPlanRun`, the engine's finished and halted answers, an unreadable
 * plan and an engine failure all come through here, so the closed outcome
 * set, the plan-run requirement and the shared run-end statements are
 * enforced once. A failure that belongs to no step passes its stable `code`,
 * which goes to the audit log because the run has no reason column.
 */
async function finishPlanRunIn(
  transaction: PgTransactionClient,
  context: RunEndRow,
  outcome: PlanRunOutcome,
  owner: EngineOwner | undefined,
  code?: string,
  details?: Readonly<Record<string, string | number>>,
): Promise<void> {
  if (typeof outcome !== "string" || !Object.hasOwn(RUN_END_STATUS, outcome)) {
    throw new Error("WORKFLOW_PLAN_OUTCOME_INVALID");
  }
  if (!carriesPlanRuntime(context.runSnapshot)) {
    throw new Error("WORKFLOW_PLAN_RUN_REQUIRED");
  }
  await settleRunToolCallCosts(transaction, {
    organizationId: context.organizationId,
    runId: context.runId,
  });
  await projectRunEnd(
    transaction,
    context,
    outcome,
    owner,
    "WORKFLOW_PLAN_PROJECTION_CONFLICT",
  );
  if (code === undefined) return;
  await appendAudit(transaction, {
    organizationId: context.organizationId,
    principalId: context.requestedBy,
    operation: "workflow.plan_failed",
    resourceType: "workflow_run",
    resourceId: context.runId,
    requestId: `plan-run:${context.runId}`,
    traceId: originalTraceId(context),
    outcome: "failed",
    details: { code, ...details },
  });
}

/**
 * What the host knows about a plan run beyond its rows, read once per engine
 * pass. `delivery` is `$delivery` as the host resolves it (absent until it can);
 * `halt` is a stable code that ends the run failed instead of asking the plan
 * anything. The engine names no template and no module behind either: the host
 * injects the reader where it builds the engine.
 */
export type PlanHostFacts = Readonly<{
  delivery?: JsonValue;
  halt?: string;
  /** Tries allowed beyond a repeat's `max`, by its step key; see `RunState.repeatExtra`. */
  repeatExtra?: Readonly<Record<string, number>>;
}>;

/** Reads {@link PlanHostFacts} for one run, inside the engine's transaction. */
export type PlanHostReader = (
  transaction: PgTransactionClient,
  run: Readonly<{
    organizationId: string;
    runId: string;
    runSnapshot: unknown;
  }>,
) => Promise<PlanHostFacts>;

/**
 * Asks a plan run's own interpreter revision what to do next, from the frozen
 * document, inputs and task and the stored step rows. Throws the adapter's or
 * the interpreter's stable error when the plan cannot be read.
 */
async function askPlan(
  transaction: PgTransactionClient,
  run: Pick<RunEndRow, "organizationId" | "runId" | "runSnapshot">,
  delivery?: JsonValue,
  repeatExtra?: Readonly<Record<string, number>>,
) {
  const runtime = await planRuntimeFromSnapshot(run.runSnapshot);
  if (runtime === null) throw new PlanStateError("plan_snapshot_invalid");
  const rows = await transaction.query<
    { stepKey: string; iteration: number; status: string; output: unknown }
  >(
    `select step_key as "stepKey", iteration, status, output
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
      order by position, id`,
    [run.organizationId, run.runId],
  );
  return nextPlanStep(runtime, {
    inputs: planInputsFromSnapshot(run.runSnapshot),
    task: planTaskFromSnapshot(run.runSnapshot),
    ...(delivery === undefined ? {} : { delivery }),
    ...(repeatExtra === undefined ? {} : { repeatExtra }),
    rows: rows.rows,
  });
}

/**
 * What the engine does next for a compiled-plan run, or `null` for a flat run,
 * which keeps the row-order loop. The run's own interpreter revision answers
 * from the frozen document and the stored rows: a dispatch gets its step row
 * appended on demand (idempotent, so a replay finds the same row) and the key
 * goes to the engine; inside a parallel group the answer is a set of steps,
 * each appended the same way; finished or halted ends the run; anything else
 * the plan asks for, or a plan that cannot be read, ends it failed with a
 * stable code. `undefined` means there is nothing more to run.
 */
async function findNextPlanKeys(
  transaction: PgTransactionClient,
  runId: string,
  owner: EngineOwner | undefined,
  planHost?: PlanHostReader,
): Promise<readonly LogicalInvocationKey[] | undefined | null> {
  // A flat run is served by the row-order loop and must not queue behind a lock
  // on its run or task row, which only deciding a plan run needs. A run's
  // snapshot never changes after admission, so a plain read says which kind it
  // is; only a plan run is then read again, locked.
  const kind = await transaction.query<{ runtime: boolean }>(
    `select snapshot ? 'runtime' as runtime
       from bakery.workflow_runs where id = $1`,
    [runId],
  );
  if (kind.rows[0]?.runtime !== true) return null;
  const context = await loadRunEndContext(transaction, runId);
  if (!context || !carriesPlanRuntime(context.runSnapshot)) return null;
  if (context.runStatus !== "queued" && context.runStatus !== "running") {
    return undefined;
  }
  const activeOwner = requireOwnerValue(owner);
  // The host may end the run (a recorded stop) or hand over `$delivery`; the
  // engine acts on either without knowing what produced it.
  const host: PlanHostFacts = planHost === undefined
    ? {}
    : await planHost(transaction, context);
  if (host.halt !== undefined) {
    await endPlanRunFailed(transaction, context, activeOwner, host.halt);
    return undefined;
  }
  let answer;
  try {
    answer = await askPlan(
      transaction,
      context,
      host.delivery,
      host.repeatExtra,
    );
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
    await finishPlanRunIn(transaction, context, "completed", activeOwner);
    return undefined;
  }
  if (answer.kind === "paused") {
    await endPlanRunFailed(
      transaction,
      context,
      activeOwner,
      PLAN_LIMIT_REACHED_CODE,
      {
        repeatKey: answer.key,
        iterations: answer.iterations,
        allowed: answer.allowed,
        max: answer.max,
      },
    );
    return undefined;
  }
  if (answer.kind === "halted") {
    await finishPlanRunIn(
      transaction,
      context,
      answer.outcome === "canceled" ? "canceled" : "failed",
      activeOwner,
    );
    return undefined;
  }
  const steps = answer.kind === "dispatch" ? [answer.step] : answer.steps;
  const keys: LogicalInvocationKey[] = [];
  for (const planned of steps) {
    const key = await appendPlanStep(
      transaction,
      context,
      activeOwner,
      planned,
    );
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
}

/**
 * Appends the row of one step the plan asked for, idempotently, and returns
 * its key; or ends the run failed with a stable code and returns undefined.
 */
async function appendPlanStep(
  transaction: PgTransactionClient,
  context: RunEndRow,
  activeOwner: EngineOwner,
  planned: ActionDispatch | WaitDispatch,
): Promise<LogicalInvocationKey | undefined> {
  const keyOf = (stepKey: string): LogicalInvocationKey => ({
    runId: context.runId,
    stepKey,
    iteration: 0,
    actionVersion: context.workflowVersionId,
  });
  if (planned.kind === "action" && planned.action === "human.approval") {
    return await appendApprovalWait(transaction, context, activeOwner, planned);
  }
  if (planned.kind === "wait") {
    if (planned.wait.kind !== "duration") {
      await endPlanRunFailed(
        transaction,
        context,
        activeOwner,
        "plan_wait_unsupported",
      );
      return undefined;
    }
    // A duration wait is a row without a job. Its start is the database clock
    // at the first insert and never moves: a replay, a restart or a second
    // engine run finds the same row (the insert is a no-op) and sleeps only
    // what is left.
    await transaction.query(
      `insert into bakery.run_steps (
         organization_id, run_id, step_key, position, iteration, status, input,
         dispatch, started_at
       )
       select $1, $2, $3, coalesce(max(position), 0) + 1, 0, 'waiting',
              '{}'::jsonb, $4::jsonb, clock_timestamp()
         from bakery.run_steps
        where organization_id = $1 and run_id = $2
       on conflict (run_id, step_key, iteration) do nothing`,
      [
        context.organizationId,
        context.runId,
        planned.key,
        JSON.stringify(planned),
      ],
    );
    return keyOf(planned.key);
  }
  // The agent a step runs as is its own, else the one its action falls back
  // to, frozen at admission beside the plan; the dispatch records the answer so
  // the job is built from exactly what was decided here.
  let dispatch = planned;
  try {
    const fallbacks = planActionAgentsFromSnapshot(context.runSnapshot);
    const fallback = fallbacks[dispatch.action];
    if (dispatch.agentVersionId === undefined && fallback !== undefined) {
      dispatch = { ...dispatch, agentVersionId: fallback };
    }
  } catch (error) {
    if (error instanceof PlanStateError) {
      await endPlanRunFailed(transaction, context, activeOwner, error.code);
      return undefined;
    }
    throw error;
  }
  await transaction.query(
    `insert into bakery.run_steps (
       organization_id, run_id, step_key, position, iteration, status, input,
       dispatch
     )
     select $1, $2, $3, coalesce(max(position), 0) + 1, 0, 'pending', $4::jsonb,
            $5::jsonb
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
     on conflict (run_id, step_key, iteration) do nothing`,
    [
      context.organizationId,
      context.runId,
      planned.key,
      JSON.stringify(dispatch.input),
      JSON.stringify(dispatch),
    ],
  );
  return keyOf(planned.key);
}

async function appendApprovalWait(
  transaction: PgTransactionClient,
  context: RunEndRow,
  activeOwner: EngineOwner,
  planned: ActionDispatch,
): Promise<LogicalInvocationKey | undefined> {
  const key: LogicalInvocationKey = {
    runId: context.runId,
    stepKey: planned.key,
    iteration: 0,
    actionVersion: context.workflowVersionId,
  };
  const existing = await transaction.query(
    `select 1 from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
        and iteration = 0`,
    [context.organizationId, context.runId, planned.key],
  );
  if (existing.rows.length > 0) return key;
  const input = HumanApprovalInputSchema.safeParse(planned.input);
  if (!input.success) {
    await endPlanRunFailed(
      transaction,
      context,
      activeOwner,
      "APPROVAL_INPUT_INVALID",
    );
    return undefined;
  }
  const owner = await transaction.query<{ owner: string | null }>(
    `select definition.owner_principal_id as owner
       from bakery.workflow_versions version
       join bakery.workflow_definitions definition
         on definition.organization_id = version.organization_id
        and definition.id = version.workflow_id
      where version.organization_id = $1 and version.id = $2`,
    [context.organizationId, context.workflowVersionId],
  );
  let asked;
  try {
    asked = await requestHumanApproval(transaction, {
      organizationId: context.organizationId,
      runId: context.runId,
      taskId: context.taskId,
      conversationId: context.conversationId,
      stepKey: planned.key,
      prompt: input.data.prompt,
      ...(input.data.audience === undefined
        ? {}
        : { audience: input.data.audience }),
      ownerPrincipalId: owner.rows[0]?.owner ?? context.requestedBy,
      traceId: context.originalTraceId ?? crypto.randomUUID(),
      applicationId: context.applicationId,
      repositoryId: context.repositoryId,
      stepIteration: key.iteration,
    });
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    await endPlanRunFailed(
      transaction,
      context,
      activeOwner,
      String(error.params?.reason ?? "APPROVAL_UNRESOLVABLE"),
    );
    return undefined;
  }
  const wait: WaitDispatch = {
    kind: "wait",
    key: planned.key,
    id: planned.id,
    wait: {
      kind: "event",
      event: HUMAN_APPROVAL_EVENT,
      timeoutMs: HUMAN_APPROVAL_WAIT_LIMIT_MS,
      approvalId: asked.approvalId,
    },
    iterationPath: planned.iterationPath,
  };
  await transaction.query(
    `insert into bakery.run_steps (
       organization_id, run_id, step_key, position, iteration, status, input,
       dispatch, started_at
     )
     select $1, $2, $3, coalesce(max(position), 0) + 1, 0, 'waiting',
            '{}'::jsonb, $4::jsonb, clock_timestamp()
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
     on conflict (run_id, step_key, iteration) do nothing`,
    [context.organizationId, context.runId, planned.key, JSON.stringify(wait)],
  );
  return key;
}

/** Audit operation recorded when the engine completes a projection step itself. */
export const WORKFLOW_PROJECTION_OPERATION = "workflow.projection.complete";

/**
 * Completes a plan step whose action is a projection (no worker runs it): its
 * output is its validated input, written in the engine's own transaction with
 * no job, so a replay finds the finished row and does nothing more. An input
 * that is not the action's shape ends the run failed with a stable code and
 * writes no output. Like any finished step it moves a queued run to running,
 * emits `run.updated`, and leaves one audit entry.
 */
async function completeProjectionStep(
  transaction: PgTransactionClient,
  row: AdmissionStepRow,
  key: LogicalInvocationKey,
  action: string,
  input: unknown,
  owner: EngineOwner | undefined,
): Promise<AdmissionRecord> {
  let output: unknown;
  try {
    output = projectionOutputOf(action, input);
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    await projectFailure(
      transaction,
      row,
      "PROJECTION_INPUT_INVALID:The projection input is not the shape of its action.",
      owner,
    );
    return { key, terminal: true };
  }
  return await finishEngineStep(
    transaction,
    row,
    key,
    action,
    output,
    WORKFLOW_PROJECTION_OPERATION,
  );
}

/**
 * Completes a step the engine settled itself, in the caller's transaction:
 * output written, a queued run moved to running with `run.updated`, one audit
 * entry. A step that is no longer pending is left as it is.
 */
async function finishEngineStep(
  transaction: PgTransactionClient,
  row: AdmissionStepRow,
  key: LogicalInvocationKey,
  action: string,
  output: unknown,
  operation: string,
): Promise<AdmissionRecord> {
  const completed = await transaction.query<{ version: number }>(
    `update bakery.run_steps
        set status = 'completed', output = $3::jsonb,
            started_at = coalesce(started_at, clock_timestamp()),
            finished_at = clock_timestamp(), updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'pending'
      returning version`,
    [row.organizationId, row.runStepId, JSON.stringify(output)],
  );
  if (completed.rows[0] === undefined) return { key, terminal: true };
  const runUpdate = await transaction.query<{ version: number }>(
    `update bakery.workflow_runs
        set status = 'running', started_at = coalesce(started_at, now()),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'queued'
      returning version`,
    [row.organizationId, row.runId],
  );
  if (runUpdate.rows[0]) {
    await appendRunUpdated(transaction, row, runUpdate.rows[0].version);
  }
  const audited = await appendAudit(transaction, {
    organizationId: row.organizationId,
    principalId: row.requestedBy,
    operation,
    resourceType: "run_step",
    resourceId: row.runStepId,
    requestId: `projection:${row.runStepId}`,
    traceId: originalTraceId(row),
    details: { runId: row.runId, stepKey: key.stepKey, action },
  });
  if (audited !== 1) {
    throw new Error("WORKFLOW_ENGINE_STEP_AUDIT_INSERT_FAILED");
  }
  return { key, terminal: true };
}

/** The one action this adapter settles by ending the run. */
const WORKFLOW_STOP_ACTION = "workflow.stop";

/** Audit operation recorded when the engine settles a `workflow.stop` step. */
export const WORKFLOW_STOP_OPERATION = "workflow.stop.complete";

/**
 * Settles a `workflow.stop` step: it ends the run on purpose with a named
 * outcome.
 *
 * A stop does not need a worker, like a projection, but it is not one: a
 * projection's output is its input, while a stop changes the run. It is
 * therefore settled here with the run's ending written in the same transaction,
 * under the engine owner's fence, in this order:
 *
 * 1. take the step row (`for update`) so only one engine settles it,
 * 2. refuse a run that has already ended, which is what stops a stop from
 *    relabelling a canceled run as succeeded -- the defect that kept `stopRun`
 *    without a producer,
 * 3. write the ledger entry, the run's named outcome and the event, through the
 *    one writer that already does exactly that,
 * 4. complete the step with the normalized outcome, so the step row and the run
 *    carry the same name.
 *
 * The step completes last on purpose: if any of the writes above fail, the
 * transaction rolls back and the step is still pending, so a retry re-runs the
 * whole ending rather than finding a completed step over a run that never ended.
 */
async function completeStopStep(
  transaction: PgTransactionClient,
  row: AdmissionStepRow,
  key: LogicalInvocationKey,
  input: unknown,
  owner: EngineOwner | undefined,
): Promise<AdmissionRecord> {
  await requireEngineOwner(transaction, row.runId, owner);
  const locked = await transaction.query<{ status: string; version: number }>(
    `select step.status, step.version
       from bakery.run_steps step
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id and run.id = step.run_id
      where step.organization_id = $1 and step.id = $2
        and run.status in ('queued', 'running')
        and step.status not in ('completed', 'failed', 'canceled', 'skipped')
      for update of step`,
    [row.organizationId, row.runStepId],
  );
  if (locked.rows[0] === undefined) return { key, terminal: true };

  // The input is validated here, not by the worker that would have run it, so a
  // malformed stop fails the run with the same projection-invalid code any other
  // unvalidatable engine-side action uses. Nothing is written before this point.
  let stop;
  try {
    stop = normalizeWorkflowStop(WorkflowStopInputSchema.parse(input ?? {}));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await projectFailure(
      transaction,
      row,
      "WORKFLOW_STOP_INPUT_INVALID:The workflow.stop input is not the shape of its action.",
      owner,
    );
    return { key, terminal: true };
  }

  await stopRun(transaction, {
    organizationId: row.organizationId,
    runId: row.runId,
    taskId: row.taskId,
    outcome: stop.outcome,
    reason: stop.reason ??
      "The workflow ended the run from a workflow.stop step.",
    // A stop the engine reached on its own has no requesting person; the ledger
    // already allows that for a system ending, and the audit row above names the
    // step instead.
    decidedBy: row.requestedBy ?? "system:workflow_stop",
    traceId: originalTraceId(row),
    applicationId: row.applicationId,
    repositoryId: row.repositoryId,
    conversationId: row.conversationId,
  });

  // The run is now ended by the writer above; the step records the same outcome
  // so a reader of either row agrees about what this run ended as.
  const completed = await transaction.query(
    `update bakery.run_steps
        set status = 'completed',
            output = jsonb_build_object(
              'outcome', $3::text,
              'reason', $4::text
            ),
            started_at = coalesce(started_at, clock_timestamp()),
            finished_at = clock_timestamp(), updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled', 'skipped')`,
    [row.organizationId, row.runStepId, stop.outcome, stop.reason ?? null],
  );
  if (completed.rowCount !== 1) {
    throw new Error("WORKFLOW_STOP_STEP_UPDATE_FAILED");
  }
  const audited = await appendAudit(transaction, {
    organizationId: row.organizationId,
    principalId: row.requestedBy,
    operation: WORKFLOW_STOP_OPERATION,
    resourceType: "run_step",
    resourceId: row.runStepId,
    requestId: `stop:${row.runStepId}`,
    traceId: originalTraceId(row),
    details: { runId: row.runId, stepKey: key.stepKey, outcome: stop.outcome },
  });
  if (audited !== 1) throw new Error("WORKFLOW_STOP_AUDIT_INSERT_FAILED");
  return { key, terminal: true };
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

/** Audit operation recorded when the engine settles a step a pack runner owns. */
export const WORKFLOW_ENGINE_STEP_OPERATION = "workflow.step.complete";

/** How long an engine-settled step that is not done waits before the engine looks at it again. */
const ENGINE_STEP_RETRY_MS = 10_000;

/**
 * How long an engine-settled step may keep answering "not done" before the
 * engine fails it. It has no job, so no attempt budget ends the wait.
 */
const ENGINE_STEP_WAIT_LIMIT_MS = 30 * 60_000;

/** When an engine-settled step first answered "not done", as recorded on the step row. */
function stepWaitingSinceOf(dispatch: unknown): Date | null {
  const at = jsonRecord(dispatch)?.stepWaitingSince;
  if (typeof at !== "string") return null;
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : new Date(time);
}

/** When the engine looks at a waiting engine-settled step again, as it recorded on the step row. */
function stepRetryAtOf(dispatch: unknown): Date | null {
  const at = jsonRecord(dispatch)?.stepRetryAt;
  if (typeof at !== "string") return null;
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : new Date(time);
}

async function admitEngineStep(
  database: PgDatabase,
  runner: EngineStepRunner | undefined,
  budgetPolicy: BudgetPolicy | undefined,
  key: LogicalInvocationKey,
  owner: EngineOwner | undefined,
): Promise<AdmissionRecord | null> {
  const due = await withPgTransaction(database, async (transaction) => {
    await requireEngineOwner(transaction, key.runId, owner);
    const row = await loadLogical(transaction, key, true) as AdmissionStepRow;
    if (key.actionVersion !== row.workflowVersionId) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    if (!carriesPlanRuntime(row.runSnapshot)) return null;
    const dispatch = planDispatchFromRow(row.stepDispatch);
    if (dispatch === null) return null;
    const { action, input } = actionAndInputFromSnapshot(row);
    if (!isEngineSettledStepAction(action)) return null;
    const eligible = eligibleRunStatuses[row.runStatus] &&
      eligibleStepStatuses[row.stepStatus] && row.cancelRequestedAt === null;
    if (eligible !== true && action === "tool.call") {
      await settleExistingToolCallCost(transaction, {
        organizationId: row.organizationId,
        runStepId: row.runStepId,
        action,
      });
    }
    return {
      row,
      action,
      input,
      limits: dispatch.limits,
      eligible: eligible === true,
    };
  });
  if (due === null) return null;
  if (!due.eligible) return { key, terminal: true };
  if (runner === undefined || !runner.handles(due.action)) {
    return await withPgTransaction(database, async (transaction) => {
      if (due.action === "tool.call") {
        await settleExistingToolCallCost(transaction, {
          organizationId: due.row.organizationId,
          runStepId: due.row.runStepId,
          action: due.action,
        });
      }
      await projectFailure(
        transaction,
        due.row,
        "ENGINE_STEP_UNAVAILABLE:No runner is configured for this step on this server.",
        owner,
      );
      return { key, terminal: true };
    });
  }
  const requestedBy = due.row.requestedBy;
  if (requestedBy === null) {
    return await withPgTransaction(database, async (transaction) => {
      if (due.action === "tool.call") {
        await settleExistingToolCallCost(transaction, {
          organizationId: due.row.organizationId,
          runStepId: due.row.runStepId,
          action: due.action,
        });
      }
      await projectFailure(
        transaction,
        due.row,
        "ENGINE_STEP_REQUESTER_MISSING:The run has no requesting person to record the step under.",
        owner,
      );
      return { key, terminal: true };
    });
  }
  const costReservation = await withPgTransaction<
    ToolCallCostReservation | null | false
  >(database, async (transaction) => {
    await requireEngineOwner(transaction, key.runId, owner);
    const row = await loadLogical(transaction, key, true) as AdmissionStepRow;
    const eligible = eligibleRunStatuses[row.runStatus] &&
      eligibleStepStatuses[row.stepStatus] && row.cancelRequestedAt === null;
    if (eligible !== true) {
      if (due.action === "tool.call") {
        await settleExistingToolCallCost(transaction, {
          organizationId: row.organizationId,
          runStepId: row.runStepId,
          action: due.action,
        });
      }
      return false;
    }
    const maxCostUsd = due.limits?.maxCostUsd;
    if (due.action !== "tool.call" || maxCostUsd === undefined) return null;
    const contentDigest = await budgetContentDigest({
      action: due.action,
      actionVersion: key.actionVersion,
      input: due.input,
      maxCostUsd,
    });
    await transaction.query("savepoint tool_call_cost_reservation");
    try {
      const reservation = await reserveToolCallCost(transaction, {
        organizationId: row.organizationId,
        runId: row.runId,
        runStepId: row.runStepId,
        action: due.action,
        maxCostUsd,
        contentDigest,
        policy: budgetPolicy,
      });
      await transaction.query("release savepoint tool_call_cost_reservation");
      return reservation;
    } catch (error) {
      await transaction.query(
        "rollback to savepoint tool_call_cost_reservation",
      );
      const refusal = budgetAdmissionRefusal(error);
      if (!refusal) throw error;
      await transaction.query("release savepoint tool_call_cost_reservation");
      await projectFailure(
        transaction,
        row,
        `${refusal.code}:${refusal.message}`,
        owner,
      );
      return false;
    }
  });
  if (costReservation === false) return { key, terminal: true };
  const result = await runner.run({
    organizationId: due.row.organizationId,
    runId: due.row.runId,
    taskId: due.row.taskId,
    repositoryId: due.row.runRepositoryId,
    requestedBy,
    traceId: originalTraceId(due.row),
    stepKey: due.row.stepKey,
    iteration: due.row.iteration,
    action: due.action,
    input: due.input,
  });
  return await withPgTransaction(database, async (transaction) => {
    await requireEngineOwner(transaction, key.runId, owner);
    const row = await loadLogical(transaction, key, true) as AdmissionStepRow;
    if (
      !eligibleRunStatuses[row.runStatus] ||
      !eligibleStepStatuses[row.stepStatus] || row.cancelRequestedAt !== null
    ) {
      if (costReservation) {
        await settleToolCallCost(transaction, {
          organizationId: row.organizationId,
          intentId: costReservation.intentId,
        });
      }
      return { key, terminal: true };
    }
    if (result.kind === "completed") {
      if (costReservation) {
        await settleToolCallCost(transaction, {
          organizationId: row.organizationId,
          intentId: costReservation.intentId,
        });
      }
      return await finishEngineStep(
        transaction,
        row,
        key,
        due.action,
        result.output,
        WORKFLOW_ENGINE_STEP_OPERATION,
      );
    }
    if (result.kind === "failed") {
      if (costReservation) {
        await settleToolCallCost(transaction, {
          organizationId: row.organizationId,
          intentId: costReservation.intentId,
        });
      }
      await projectFailure(
        transaction,
        row,
        `${result.code}:${result.message}`,
        owner,
      );
      return { key, terminal: true };
    }
    const waitingSince = stepWaitingSinceOf(row.stepDispatch);
    if (
      waitingSince !== null &&
      Date.now() - waitingSince.getTime() >=
        (runner.pacing?.(due.action)?.waitLimitMs ?? ENGINE_STEP_WAIT_LIMIT_MS)
    ) {
      if (costReservation) {
        await settleToolCallCost(transaction, {
          organizationId: row.organizationId,
          intentId: costReservation.intentId,
        });
      }
      await projectFailure(
        transaction,
        row,
        "ENGINE_STEP_TIMED_OUT:The step did not settle within its wait limit.",
        owner,
      );
      return { key, terminal: true };
    }
    await transaction.query(
      `update bakery.run_steps
          set dispatch = dispatch || jsonb_build_object(
                'stepRetryAt',
                to_char(
                  (clock_timestamp() + ($3::integer * interval '1 millisecond'))
                    at time zone 'UTC',
                  'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'
                ),
                'stepWaitingSince',
                coalesce(
                  dispatch -> 'stepWaitingSince',
                  to_jsonb(
                    to_char(
                      clock_timestamp() at time zone 'UTC',
                      'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'
                    )
                  )
                )
              ),
              started_at = coalesce(started_at, clock_timestamp()),
              updated_at = clock_timestamp(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'pending'`,
      [
        row.organizationId,
        row.runStepId,
        runner.pacing?.(due.action)?.retryMs ?? ENGINE_STEP_RETRY_MS,
      ],
    );
    const runUpdate = await transaction.query<{ version: number }>(
      `update bakery.workflow_runs
          set status = 'running', started_at = coalesce(started_at, now()),
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'queued'
        returning version`,
      [row.organizationId, row.runId],
    );
    if (runUpdate.rows[0]) {
      await appendRunUpdated(transaction, row, runUpdate.rows[0].version);
    }
    return { key, terminal: false };
  });
}

export function createBakeryPostgresWorkflowRepository(options: {
  database: PgDatabase;
  maxAttempts: number;
  budgetPolicy?: BudgetPolicy;
  /** Settles the steps a pack owns (delivery prepare, deploy, health); none fails them with a stable code. */
  engineSteps?: EngineStepRunner;
  /** The host's view of a plan run (`$delivery`, a halt); none leaves both unresolved. */
  planHost?: PlanHostReader;
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
        const planKeys = await findNextPlanKeys(
          transaction,
          runId,
          owner,
          options.planHost,
        );
        if (planKeys !== null) return planKeys?.[0];
        return await loadNext(transaction, runId);
      });
    },
    async isPlanRun(runId, owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, runId, owner);
        const kind = await transaction.query<{ runtime: boolean }>(
          `select snapshot ? 'runtime' as runtime
             from bakery.workflow_runs where id = $1`,
          [runId],
        );
        return kind.rows[0]?.runtime === true;
      });
    },
    async findNextSet(runId, owner) {
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, runId, owner);
        const planKeys = await findNextPlanKeys(
          transaction,
          runId,
          owner,
          options.planHost,
        );
        if (planKeys !== null) return planKeys ?? [];
        const key = await loadNext(transaction, runId);
        return key === undefined ? [] : [key];
      });
    },
    async admitSet(keys, owner) {
      for (const key of keys) {
        assertLogicalKey(key);
        // A wait has no job. Anything else is admitted only if no job exists
        // for it yet: a step that is queued, running or done is left as it is,
        // exactly as the per-step path decides.
        const wait = await this.readWait(key, owner);
        if (wait !== null) continue;
        const decision = decideResume(
          key,
          await this.read(key, owner),
          new Date(),
        );
        if (decision.kind === "newly-admit") {
          await this.admit(decision.key, owner);
        }
      }
    },
    async readWait(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, key.runId, owner);
        // A duration wait counts down from durationMs; a human.approval wait
        // counts down from timeoutMs and ends on a decision, so the two lengths
        // are read through the same coalesce and the kind travels with them.
        const result = await transaction.query<WaitBoundary>(
          `select coalesce(
                    (step.dispatch #>> '{wait,durationMs}')::integer,
                    (step.dispatch #>> '{wait,timeoutMs}')::integer
                  ) as "durationMs",
                  greatest(0, ceil(extract(epoch from (
                    step.started_at +
                      coalesce(
                        (step.dispatch #>> '{wait,durationMs}')::bigint,
                        (step.dispatch #>> '{wait,timeoutMs}')::bigint
                      ) * interval '1 millisecond' -
                      clock_timestamp()
                  )) * 1000))::integer as "remainingMs",
                  case when step.dispatch #>> '{wait,event}'
                          = ${"'" + "human.approval.decided" + "'"}
                       then 'approval' else 'duration' end as "kind",
                  step.started_at as "startedAt",
                  step.started_at +
                    coalesce(
                      (step.dispatch #>> '{wait,durationMs}')::bigint,
                      (step.dispatch #>> '{wait,timeoutMs}')::bigint
                    ) * interval '1 millisecond' <= clock_timestamp()
                    as "expired"
             from bakery.run_steps step
             join bakery.workflow_runs run
               on run.organization_id = step.organization_id
              and run.id = step.run_id
            where run.id = $1 and step.step_key = $2 and step.iteration = $3
              and step.dispatch ->> 'kind' = 'wait'
              and step.started_at is not null`,
          [key.runId, key.stepKey, key.iteration],
        );
        return result.rows[0] ?? null;
      });
    },
    async completeWait(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, key.runId, owner);
        const done = await transaction.query(
          `update bakery.run_steps step
              set status = 'completed',
                  output = '{"outcome": "elapsed"}'::jsonb,
                  finished_at = clock_timestamp(),
                  updated_at = clock_timestamp(), version = step.version + 1
             from bakery.workflow_runs run
            where run.id = $1 and run.organization_id = step.organization_id
              and run.id = step.run_id and run.status in ('queued', 'running')
              and step.step_key = $2 and step.iteration = $3
              and step.status = 'waiting'
              and step.dispatch ->> 'kind' = 'wait'
              and step.started_at +
                    (step.dispatch #>> '{wait,durationMs}')::bigint *
                      interval '1 millisecond' <= clock_timestamp()
           returning step.id`,
          [key.runId, key.stepKey, key.iteration],
        );
        if (done.rows.length > 0) return true;
        const current = await transaction.query<{ status: string }>(
          `select step.status
             from bakery.run_steps step
            where step.run_id = $1 and step.step_key = $2
              and step.iteration = $3 and step.dispatch ->> 'kind' = 'wait'`,
          [key.runId, key.stepKey, key.iteration],
        );
        const status = current.rows[0]?.status;
        if (status === "completed") return true;
        if (status === "waiting") {
          const run = await transaction.query<{ status: string }>(
            `select status from bakery.workflow_runs where id = $1`,
            [key.runId],
          );
          if (["queued", "running"].includes(run.rows[0]?.status ?? "")) {
            throw new Error("WORKFLOW_WAIT_NOT_DUE");
          }
        }
        return false;
      });
    },
    async completeApprovalWait(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, key.runId, owner);
        // The wait's dispatch pins the approval it is waiting on, so the step
        // and the answer can never be paired by position or by timing. A row
        // that is still waiting keeps its status and reports not-decided; the
        // engine retries rather than inventing a decision (§19.3: nothing is
        // ever approved by silence).
        const decided = await transaction.query<
          { decision: string; note: string | null }
        >(
          `update bakery.run_steps step
              set status = 'completed',
                  output = jsonb_build_object(
                    'decision', answer.decision,
                    'note', answer.decision_comment,
                    'decidedBy', answer.decided_by,
                    'decidedAt', answer.decided_at,
                    'approvalId', answer.id
                  ),
                  finished_at = clock_timestamp(),
                  updated_at = clock_timestamp(), version = step.version + 1
             from bakery.workflow_runs run, bakery.questions answer
            where run.id = $1 and run.organization_id = step.organization_id
              and run.id = step.run_id and run.status in ('queued', 'running')
              and step.step_key = $2 and step.iteration = $3
              and step.status = 'waiting'
              and step.dispatch ->> 'kind' = 'wait'
              and answer.id = (step.dispatch #>> '{wait,approvalId}')::uuid
              and answer.organization_id = step.organization_id
              and answer.kind = 'approval'
              and answer.decided_at is not null
           returning answer.decision, answer.decision_comment`,
          [key.runId, key.stepKey, key.iteration],
        );
        if (decided.rows.length > 0) return true;
        const current = await transaction.query<{ status: string }>(
          `select status from bakery.run_steps step
            where step.run_id = $1 and step.step_key = $2
              and step.iteration = $3 and step.dispatch ->> 'kind' = 'wait'`,
          [key.runId, key.stepKey, key.iteration],
        );
        const status = current.rows[0]?.status;
        if (status === "completed") return true;
        // Still waiting while the run is live is the ordinary case: the person
        // has not answered yet. Reporting false lets the caller poll, and keeps
        // the expiry decision reachable instead of behind a throw.
        return false;
      });
    },
    async expireApprovalWait(key, owner) {
      assertLogicalKey(key);
      return await withPgTransaction(options.database, async (transaction) => {
        await requireEngineOwner(transaction, key.runId, owner);
        const row = await loadLogical(
          transaction,
          key,
          true,
        ) as AdmissionStepRow;
        // A decision that arrived first wins: expiring it would throw away a
        // person's answer, so an already-completed step is left alone.
        if (isTerminal(row)) return false;
        // Settle the step through the same failure projection every other
        // settled step uses, so the row ends in a real status with a stable
        // code rather than sitting in 'waiting' forever.
        // projectFailure settles the step AND ends the run failed with the
        // step's code, which is the same path every other failed step takes.
        // Expiring is not a special end: it is a failure with a name that says
        // silence was not consent.
        await projectFailure(transaction, row, APPROVAL_EXPIRED_CODE, owner);
        return true;
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
      const delivery = await admitEngineStep(
        options.database,
        options.engineSteps,
        options.budgetPolicy,
        key,
        owner,
      );
      if (delivery !== null) return delivery;
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
        // A compiled-plan step carries the dispatch the engine recorded with
        // its row; actionAndInputFromSnapshot reads it, and the step's own
        // declared attempts become the job's.
        const planDispatch = carriesPlanRuntime(row.runSnapshot)
          ? planDispatchFromRow(row.stepDispatch)
          : null;
        const {
          action,
          input: resolvedInput,
          agent,
          requiredCapabilities,
        } = actionAndInputFromSnapshot(row);
        // A projection has no worker: the engine completes it here, in this
        // transaction, and never builds a job or reserves budget for it.
        if (planDispatch !== null && isEngineProjectionAction(action)) {
          return await completeProjectionStep(
            transaction,
            row,
            key,
            action,
            resolvedInput,
            owner,
          );
        }
        // A stop ends the run instead of running a worker, so it is settled here
        // the same way a projection is: no job, no budget reservation.
        if (planDispatch !== null && action === WORKFLOW_STOP_ACTION) {
          return await completeStopStep(
            transaction,
            row,
            key,
            resolvedInput,
            owner,
          );
        }
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
        // Notes left for this step before it started (#412) travel with the
        // job's input; they are marked delivered below, only once the job
        // exists. The budget digest is taken over `input`, without the notes.
        const stepNotes = await undeliveredStepNotes(transaction, {
          organizationId: row.organizationId,
          runId: row.runId,
          stepKey: row.stepKey,
        });
        const jobInput = stepNotes.length === 0
          ? input
          : { ...input, stepNotes: stepNotes.map((note) => note.body) };
        if (!executionJobInputFitsTransport(jobInput)) {
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
          identityRef: typeof value.identityRef === "string"
            ? value.identityRef
            : null,
        });
        // Each declared input slot is pinned before anything is reserved: a
        // slot that cannot be pinned fails the step here, and the job carries
        // the pins the worker will verify (never a re-fetch of the artifact).
        const stepInputs = await pinStepContextInputs(transaction, {
          organizationId: row.organizationId,
          runId: row.runId,
          slots: planDispatch?.inputs ?? [],
        });
        if (!stepInputs.ok) {
          await projectFailure(
            transaction,
            row,
            `${stepInputs.code}:${stepInputs.message}`,
            owner,
          );
          return { key, terminal: true };
        }
        if (planDispatch !== undefined && row.runRepositoryId !== null) {
          const stepFacts = await chooseStepFacts(transaction, {
            organizationId: row.organizationId,
            repositoryId: row.runRepositoryId,
          });
          if (stepFacts.facts.length > 0 || stepFacts.omitted > 0) {
            await transaction.query(
              `update bakery.run_steps
                  set dispatch = dispatch || jsonb_build_object('facts', $4::jsonb)
                where organization_id = $1 and run_id = $2 and id = $3`,
              [
                row.organizationId,
                row.runId,
                row.runStepId,
                JSON.stringify(stepFacts),
              ],
            );
          }
        }
        const ownRequirements = repositoryExecutionRequirements(
          profile,
          action,
          requiredCapabilities,
        );
        let requirements;
        try {
          requirements = withRunPlacement(
            ownRequirements,
            RunPlacementSchema.parse(row.runPlacement ?? {}),
          );
        } catch (error) {
          // A placement no host can satisfy fails this step with its reason,
          // for the person to see: leaving it thrown would roll admission back
          // and retry the same refusal on every tick.
          if (
            error instanceof StandardError && error.code === "STATE_CONFLICT"
          ) {
            await projectFailure(
              transaction,
              row,
              `placement_conflict:${String(error.params?.reason ?? "")}`,
              owner,
            );
            return { key, terminal: true };
          }
          throw error;
        }
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
        const createdJob = await transaction.query<{ id: string }>(
          `insert into bakery.jobs (
             organization_id, run_step_id, action, input, status,
             available_at, priority, max_attempts,
             application_id, repository_id, repository_profile_id,
             repository_profile_revision, repository_profile_digest,
             observation_id, observation_digest, base_sha, requirements,
             agent_version_id, agent_config, skill_refs, billing,
             installation_reservation_id, context_inputs
           ) values ($1, $2, $3, $4::jsonb, 'queued', now(), 0, $5,
                     $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                     $15, $16::jsonb, $17::jsonb, $18::jsonb, $19, $20::jsonb)
           on conflict (run_step_id, action) do nothing
           returning id`,
          [
            row.organizationId,
            row.runStepId,
            action,
            JSON.stringify(jobInput ?? {}),
            action === "secret.identity.read"
              ? 1
              : planDispatch?.retry.maxAttempts ?? options.maxAttempts,
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
            JSON.stringify(stepInputs.inputs),
          ],
        );
        const newJobId = createdJob.rows[0]?.id;
        if (newJobId !== undefined && stepNotes.length > 0) {
          await recordNotesDelivered(transaction, {
            organizationId: row.organizationId,
            jobId: newJobId,
            noteIds: stepNotes.map((note) => note.id),
          });
        }
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
      if (
        typeof outcome !== "string" || !Object.hasOwn(RUN_END_STATUS, outcome)
      ) {
        throw new Error("WORKFLOW_PLAN_OUTCOME_INVALID");
      }
      await withPgTransaction(options.database, async (transaction) => {
        const context = await loadRunEndContext(transaction, runId);
        if (!context) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        await requireEngineOwner(transaction, runId, requireOwnerValue(owner));
        await finishPlanRunIn(transaction, context, outcome, owner);
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
  planHost?: PlanHostReader;
  /** Settles the steps a pack owns; none fails them with a stable code. */
  engineSteps?: EngineStepRunner;
  /** Durable operations one function run may use; a test sets it small. */
  stepOperationBudget?: number;
}) {
  const stepOperationBudget = options.stepOperationBudget ??
    STEP_OPERATION_BUDGET;
  const repository = createBakeryPostgresWorkflowRepository({
    database: options.database,
    maxAttempts: options.maxAttempts,
    budgetPolicy: options.budgetPolicy,
    planHost: options.planHost,
    engineSteps: options.engineSteps,
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
    async ({ event, step: durableStep }) => {
      // Every durable operation is counted: a function run may use only so
      // many (STEP_OPERATION_BUDGET) before it hands the run on.
      let operations = 0;
      const counted = <T extends (...args: never[]) => unknown>(call: T): T =>
        ((...args: never[]) => {
          operations += 1;
          return call(...args);
        }) as T;
      const step = {
        run: counted(durableStep.run.bind(durableStep)),
        sleep: counted(durableStep.sleep.bind(durableStep)),
        waitForEvent: counted(durableStep.waitForEvent.bind(durableStep)),
        sendEvent: counted(durableStep.sendEvent.bind(durableStep)),
      } as typeof durableStep;
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
        // A plan run's end is decided by its interpreter from the rows, so a
        // failed step does not end the function run: the next answer projects
        // the halt (and the other lanes go on). A flat run ends at the failure.
        const planRun = await step.run(
          "read-run-kind",
          () => repository.isPlanRun(runId, owner),
        );
        let checkpoint = 0;
        /**
         * Drives one step of the answer to its end. A returned value ends the
         * function run with it; `undefined` goes on to the next step.
         */
        const driveKey = async (
          key: LogicalInvocationKey,
        ): Promise<
          { result: { status: string; reason?: string } } | undefined
        > => {
          // A duration wait has no job to wait for: sleep what is left of it by
          // the database clock, with the owner lease stretched over the sleep,
          // then record it elapsed. A restart or a second engine run reads the
          // same start and sleeps only the remainder.
          const durationWait = await step.run(
            `read-wait-${checkpoint}`,
            () => repository.readWait(key, owner),
          );
          if (durationWait !== null && durationWait.kind === "approval") {
            // A human.approval wait ends on a decision or on its window closing,
            // never on a bare sleep. The window is checked first, by the database
            // clock, so expiry is reachable: an unanswered approval settles and
            // the run ends failed rather than waiting forever.
            if (durationWait.expired === true) {
              const expired = await step.run(
                `expire-approval-${checkpoint}-${key.stepKey}-${key.iteration}`,
                () => repository.expireApprovalWait(key, owner),
              );
              if (!expired) {
                // A decision arrived first: it stands, and this step is done.
                return undefined;
              }
              return {
                result: {
                  status: "stalled" as const,
                  reason: "approval_expired",
                },
              };
            }
            await step.sleep(
              `wait-for-approval-${checkpoint}-${key.stepKey}-${key.iteration}`,
              `${
                Math.max(
                  1,
                  Math.min(APPROVAL_POLL_MS, durationWait.remainingMs),
                )
              }ms`,
            );
            const decided = await step.run(
              `complete-approval-${checkpoint}-${key.stepKey}-${key.iteration}`,
              () => repository.completeApprovalWait(key, owner),
            );
            if (decided) return undefined;
            // Not answered and still inside the window: the engine comes back.
            return { result: { status: "waiting" as const } };
          }
          if (durationWait !== null) {
            if (durationWait.remainingMs > 0) {
              const stretched = await step.run(
                `extend-engine-owner-for-wait-${checkpoint}`,
                () =>
                  repository.renewEngineOwner({
                    ...requireOwnerValue(owner),
                    leaseMs: durationWait.remainingMs + ownerLeaseMs,
                  }),
              );
              if (!stretched) throw new EngineOwnerLostError();
              await step.sleep(
                `wait-for-duration-${checkpoint}-${key.stepKey}-${key.iteration}`,
                `${durationWait.remainingMs}ms`,
              );
              const restored = await step.run(
                `renew-engine-owner-after-wait-${checkpoint}`,
                () => repository.renewEngineOwner(requireOwnerValue(owner)),
              );
              if (!restored) throw new EngineOwnerLostError();
            }
            const elapsed = await step.run(
              `complete-wait-${checkpoint}-${key.stepKey}-${key.iteration}`,
              () => repository.completeWait(key, owner),
            );
            if (!elapsed) throw new EngineOwnerLostError();
            return undefined;
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
                return { result: await handoff() };
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
              return { result: { status: "stalled" as const, reason } };
            }
            if (outcome.decision.kind === "waiting") continue;
            if (outcome.decision.kind === "failed") {
              // A plan run goes on: the rows say the step failed and the next
              // answer projects the halt. Not for a cancel the worker has not
              // acted on yet: the row is not over, the same step would be
              // found again at once, so the run is left to the cancel as before.
              if (planRun && outcome.decision.reason !== CANCEL_REQUESTED) {
                return undefined;
              }
              await releaseOwner();
              return {
                result: {
                  status: "failed" as const,
                  reason: outcome.decision.reason,
                },
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
          ) return { result: await handoff() };
          return undefined;
        };
        /**
         * One pass over a set of several steps (lanes of a parallel group):
         * look at every step once, without waiting for any one of them, and
         * if none of them moved, wait once for the first of them to: a job of
         * the set completing, a retry coming due or a duration wait ending.
         * The lanes therefore advance independently: the next answer is asked
         * for as soon as anything moved.
         */
        const driveSet = async (
          keys: readonly LogicalInvocationKey[],
        ): Promise<
          { result: { status: string; reason?: string } } | undefined
        > => {
          let moved = false;
          const jobIds: string[] = [];
          let timerMs: number | undefined;
          const soonest = (ms: number) => {
            timerMs = timerMs === undefined ? ms : Math.min(timerMs, ms);
          };
          for (const key of keys) {
            const durationWait = await step.run(
              `read-wait-${checkpoint}-${key.stepKey}`,
              () => repository.readWait(key, owner),
            );
            if (durationWait !== null) {
              if (durationWait.remainingMs > 0) {
                soonest(durationWait.remainingMs);
                continue;
              }
              const elapsed = await step.run(
                `complete-wait-${checkpoint}-${key.stepKey}-${key.iteration}`,
                () => repository.completeWait(key, owner),
              );
              if (!elapsed) throw new EngineOwnerLostError();
              moved = true;
              continue;
            }
            const outcome = await runFixedWorkflow(
              { logical: key },
              {
                store: {
                  read: (logical) => repository.read(logical, owner),
                  admit: (logical) => repository.admit(logical, owner),
                },
                checkpoint,
                // The one wait of the pass is below, for the set as a whole.
                wait: () => Promise.resolve(),
              },
            );
            const decision = outcome.decision;
            switch (decision.kind) {
              case "terminal-result":
                moved = true;
                break;
              case "failed":
                // The rows say so; the next answer projects it, except for a
                // cancel the worker has not acted on yet (see `driveKey`).
                if (decision.reason === CANCEL_REQUESTED) {
                  await releaseOwner();
                  return {
                    result: {
                      status: "failed" as const,
                      reason: decision.reason,
                    },
                  };
                }
                moved = true;
                break;
              case "retryable":
                soonest(
                  Math.max(
                    1,
                    Math.min(
                      options.waitMs,
                      decision.nextRetryAt.getTime() - Date.now(),
                    ),
                  ),
                );
                break;
              case "waiting":
                if (!decision.admission.jobId) {
                  throw new Error("WORKFLOW_JOB_ID_MISSING");
                }
                jobIds.push(decision.admission.jobId);
                break;
              case "stalled": {
                const reason = decision.reason;
                await step.run(
                  `mark-stalled-${checkpoint}-${key.stepKey}-${key.iteration}`,
                  () => repository.markStalled(key, reason, owner),
                );
                await releaseOwner();
                return { result: { status: "stalled" as const, reason } };
              }
              case "state-conflict":
                throw new Error(`WORKFLOW_STATE_CONFLICT:${decision.reason}`);
              default:
                throw new Error("WORKFLOW_RECONCILIATION_UNEXPECTED");
            }
          }
          if (moved || (jobIds.length === 0 && timerMs === undefined)) {
            return undefined;
          }
          const waitMs = Math.min(timeoutMs, timerMs ?? timeoutMs);
          const stretched = await step.run(
            `extend-engine-owner-for-set-${checkpoint}`,
            () =>
              repository.renewEngineOwner({
                ...requireOwnerValue(owner),
                leaseMs: waitMs + ownerLeaseMs,
              }),
          );
          if (!stretched) throw new EngineOwnerLostError();
          if (jobIds.length > 0) {
            await step.waitForEvent(`wait-for-job-${checkpoint}-set`, {
              event: "bakery/job.completed.v1",
              timeout: `${waitMs}ms`,
              if: `async.data.payload.runId == '${runId}' && ` +
                `(${
                  jobIds.map((id) => `async.data.payload.jobId == '${id}'`)
                    .join(" || ")
                })`,
            });
          } else {
            await step.sleep(`wait-for-timer-${checkpoint}`, `${waitMs}ms`);
          }
          const restored = await step.run(
            `renew-engine-owner-after-set-${checkpoint}`,
            () => repository.renewEngineOwner(requireOwnerValue(owner)),
          );
          if (!restored) throw new EngineOwnerLostError();
          return undefined;
        };
        while (
          checkpoint < MAX_WORKFLOW_STEPS && operations < stepOperationBudget
        ) {
          // The answer is the steps that may run now: one, or (inside a
          // parallel group) one next step for each running lane. An older
          // function run may have memoized a single key.
          const loaded = await step.run(
            `load-next-workflow-step-${checkpoint}`,
            () => repository.findNextSet(runId, owner),
          ) as
            | LogicalInvocationKey
            | readonly LogicalInvocationKey[]
            | null
            | undefined;
          const keys: readonly LogicalInvocationKey[] = Array.isArray(loaded)
            ? loaded
            : loaded
            ? [loaded as LogicalInvocationKey]
            : [];
          if (keys.length === 0) {
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
          // Every job of the set is admitted before the first is waited for,
          // so the lanes run at the same time; the waits below then find the
          // finished ones already done (the database decides, not the event).
          if (keys.length > 1) {
            await step.run(
              `admit-workflow-steps-${checkpoint}`,
              () => repository.admitSet(keys, owner),
            );
          }
          const ended = keys.length === 1
            ? await driveKey(keys[0]!)
            : await driveSet(keys);
          if (ended !== undefined) return ended.result;
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
  planHost?: PlanHostReader;
  engineSteps?: EngineStepRunner;
}) {
  const repository = createBakeryPostgresWorkflowRepository({
    database: options.database,
    maxAttempts: 1,
    budgetPolicy: options.budgetPolicy,
    planHost: options.planHost,
    engineSteps: options.engineSteps,
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
