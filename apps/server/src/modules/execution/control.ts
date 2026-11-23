import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
  type OrganizationId,
  organizationId,
} from "@bakery/contracts/contracts";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  ExecutionImplementedAction,
  executionImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  getTraceId,
  problemResponse,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { DEFAULT_AGENT_SPAWN } from "@bakery/config";
import {
  AgentPower,
  assertAgentMayExercise,
  assertAgentMayTarget,
} from "../auth/application/agent-power-grants.ts";
import {
  PostgresAuthorityRunner,
  resolveOrganizationActor,
} from "../auth/adapters/authority-postgres.ts";
import { authorize } from "../auth/application/authorize.ts";
import { parseContract } from "./http.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import {
  type RunRow,
  runWorkspaceBaseShaColumn,
  toRun,
} from "../work/run-command.ts";
import { readRunBudgetSummary } from "../work/budget.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  adapterSupportsControl,
  readAdapterCapabilities,
} from "./adapter-capabilities.ts";
import {
  activeAttempt,
  cancelQueuedJobsOfRun,
  cancelRunWithoutAttempt,
  enqueueWorkerControlCommand,
  resolveCanceledAttemptCleanup,
} from "./coordination.ts";
import {
  createSessionListHandler,
  getAgentSession,
  steerAgentSession,
} from "./sessions.ts";
import { createRunStepNote } from "./step-notes.ts";
import { getHandoffManifest } from "./handoff-manifests.ts";
import { admitHandoffContinuation } from "./handoff-continuations.ts";
import { takeOverRunStep } from "./step-takeover.ts";
import { revertRunStepWrites } from "./step-write-revert.ts";
import { createSessionFeedHandler } from "./session-feed.ts";
import { openSessionFeedStream } from "./session-feed-stream.ts";
import type { ExecutionRouteOptions } from "./shared.ts";
import { transcriptStatusAction } from "./output-transcript.ts";
import {
  parseIdempotencyKey,
  parseWorkerProtocolVersion,
  readAttemptId,
  withWorkerProtocolHeader,
  WORKER_PROTOCOL_VERSION,
  workerTransaction,
} from "./shared.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
const RUN_COLUMNS = "run.id, run.kind, run.task_id, run.workflow_version_id, " +
  "run.skill_source_id, run.repository_profile_id, " +
  "run.repository_profile_revision, run.repository_profile_digest, " +
  "run.observation_id, run.observation_digest, run.base_sha, " +
  "run.requested_by, run.inngest_run_id, run.status, run.budget_limit_usd, " +
  "run.environment, " +
  "run.started_at, run.finished_at, run.created_at, run.updated_at, run.version, " +
  runWorkspaceBaseShaColumn("run");
type RunControlRow = RunRow & {
  application_id: string | null;
  repository_id: string | null;
  conversation_id: string | null;
};
type RunControlInput = z.output<typeof contractSchemas.RunControl>;
type RunOutput = z.output<typeof contractSchemas.Run>;
type RunControlCapabilitiesOutput = z.output<
  typeof contractSchemas.RunControlCapabilities
>;
type RunControlCapabilityReason =
  RunControlCapabilitiesOutput["actions"][number]["reason"];

const RUN_CONTROL_ACTIONS = [
  "pause",
  "resume",
  "cancel",
  "interrupt",
] as const;
type RunControlCapabilityAttempt = {
  attemptStatus: string;
  jobStatus: string;
  fence: string | number;
  currentFence: string | number;
  workerSessionId: string | null;
  hostSessionId: string | null;
  leaseLive: boolean;
  sessionCurrent: boolean;
  /** Steering capabilities the attempt's worker session advertised. */
  adapterCapabilities?: readonly string[];
};
type RunControlCapabilityRead =
  & {
    status: string;
    kind: string;
    /** True when no unfinished job is past `queued`, so the server can cancel. */
    waitingCancelable?: boolean;
  }
  & (
    | RunControlCapabilityAttempt
    | {
      attemptStatus: null;
      jobStatus: null;
      fence: null;
      currentFence: null;
      workerSessionId: null;
      hostSessionId: null;
      leaseLive: null;
      sessionCurrent: null;
    }
  );

/**
 * What may be requested of the run, from its live attempts. A control reaches
 * every live attempt (a plan run in a parallel group has one per lane), so an
 * action can be requested only if it can be requested of each of them: the
 * answer is the first refusal, in attempt order, or `allowed`. One attempt (or
 * a single object) is the case of a run with one live attempt.
 */
export function evaluateRunControlCapabilities(
  runId: string,
  runStatus: string,
  attempts?:
    | RunControlCapabilityAttempt
    | readonly RunControlCapabilityAttempt[],
  waitingCancelable = false,
): RunControlCapabilitiesOutput {
  const live: readonly RunControlCapabilityAttempt[] = attempts === undefined
    ? []
    : "attemptStatus" in attempts
    ? [attempts]
    : attempts;
  const terminalRun = ["completed", "failed", "canceled", "blocked"].includes(
    runStatus,
  );
  if (live.length === 0) {
    const reason: RunControlCapabilityReason = terminalRun
      ? "already_terminal"
      : "no_active_attempt";
    const actions = RUN_CONTROL_ACTIONS.map((action) =>
      // A run waiting for a retry or for admission has no worker to command,
      // but the server can cancel it directly.
      action === "cancel" && waitingCancelable && !terminalRun
        ? { action, canRequest: true, reason: "allowed" as const }
        : { action, canRequest: false, reason }
    );
    return { runId, actions };
  }
  const perAttempt = live.map((attempt) =>
    RUN_CONTROL_ACTIONS.map((action) => {
      const currentFence =
        BigInt(attempt.fence) === BigInt(attempt.currentFence);
      const workerScopeResume = action === "resume" &&
        attempt.hostSessionId !== null;
      const terminal = ["completed", "failed", "canceled"].includes(
        attempt.jobStatus,
      );
      const admitted = action === "resume"
        ? workerScopeResume
        : !terminal && attempt.workerSessionId !== null &&
          activeAttempt(attempt.attemptStatus) && attempt.leaseLive &&
          attempt.sessionCurrent && currentFence;
      const supported = adapterSupportsControl(
        action,
        attempt.adapterCapabilities ?? [],
      );
      const canRequest = admitted && supported;
      return {
        action,
        canRequest,
        reason: admitted && !supported
          ? "unsupported" as const
          : canRequest
          ? "allowed" as const
          : terminal && !workerScopeResume
          ? "already_terminal" as const
          : "authority_unavailable" as const,
      };
    })
  );
  const actions = perAttempt[0].map((first, index) =>
    perAttempt.map((entries) => entries[index]).find((entry) =>
      !entry.canRequest
    ) ?? first
  );
  return { runId, actions };
}

export async function readRunControlCapabilities(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RunControlCapabilitiesOutput> {
  const result = await transaction.query<RunControlCapabilityRead>(
    `select run.status, run.kind,
            selected.status as "attemptStatus",
            selected."jobStatus",
            selected.fence,
            selected."currentFence",
            selected."workerSessionId",
            selected."hostSessionId",
            selected."leaseLive",
            selected."sessionCurrent",
            selected."adapterCapabilities",
            not exists (
              select 1
                from bakery.run_steps as waiting_step
                join bakery.jobs as waiting_job
                  on waiting_job.organization_id = waiting_step.organization_id
                 and waiting_job.run_step_id = waiting_step.id
               where waiting_step.organization_id = run.organization_id
                 and waiting_step.run_id = run.id
                 and waiting_job.status not in
                   ('queued', 'completed', 'failed', 'canceled')
            ) as "waitingCancelable"
       from bakery.workflow_runs as run
       left join lateral (
         select attempt.status,
                job.status as "jobStatus",
                attempt.fence,
                job.current_fence as "currentFence",
                attempt.worker_session_id as "workerSessionId",
                host.worker_session_id as "hostSessionId",
                attempt.lease_expires_at > clock_timestamp() as "leaseLive",
                (
                  attempt.worker_session_id = host.worker_session_id
                  and attempt.worker_session_generation = host.worker_session_generation
                ) is true as "sessionCurrent",
                host.adapter_capabilities as "adapterCapabilities"
           from bakery.run_steps as step
           join bakery.jobs as job
             on job.organization_id = step.organization_id
            and job.run_step_id = step.id
           join bakery.job_attempts as attempt
             on attempt.organization_id = job.organization_id
            and attempt.job_id = job.id
           join bakery.worker_hosts as host
             on host.organization_id = attempt.organization_id
            and host.id = attempt.worker_host_id
          where step.organization_id = run.organization_id
            and step.run_id = run.id
            and attempt.status in ('leased', 'running', 'canceling')
            and job.current_fence = attempt.fence
          order by step.position asc, step.iteration asc,
            attempt.attempt_no desc, attempt.id desc
       ) as selected on true
      where run.organization_id = $1 and run.id = $2`,
    [organizationId, runId],
  );
  // One row per live attempt (one row with null attempt columns when none is
  // live), all from this one statement's snapshot.
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // Capability discovery must reject the same run kinds as command admission.
  if (row.kind !== "workflow") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_kind_unsupported" },
    });
  }
  const attempts = result.rows.filter((entry) => entry.attemptStatus !== null)
    .map((entry) => ({
      ...entry,
      adapterCapabilities: readAdapterCapabilities(
        (entry as { adapterCapabilities?: unknown }).adapterCapabilities,
      ),
    })) as RunControlCapabilityAttempt[];
  return evaluateRunControlCapabilities(
    runId,
    row.status,
    attempts,
    row.waitingCancelable === true,
  );
}

async function runControlCapabilitiesAction(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IdPath>,
): Promise<RunControlCapabilitiesOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const runId = context.params.id ?? input.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return await readRunControlCapabilities(transaction, organizationId, runId);
}

export async function runControlAction(
  context: ActionContext,
  input: RunControlInput,
): Promise<RunOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // An agent controls a run only where a person granted it the power (O52). A
  // person passes untouched. Checked before anything is read or written, so a
  // refusal leaves no trace.
  const exercised = await assertAgentMayExercise(transaction, context, {
    organizationId,
    principalId,
    power: AgentPower.RunControl,
  });
  // Never its own run, another run of its task or its lineage, and the target
  // run's workflow must hold the power too, not only the agent's own.
  await assertAgentMayTarget(transaction, exercised, {
    organizationId,
    power: AgentPower.RunControl,
    targetRunId: runId,
  });
  const runResult = await transaction.query<RunControlRow>(
    `select ${RUN_COLUMNS},
            task.application_id,
            task.repository_id,
            task.conversation_id
       from bakery.workflow_runs as run
       left join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
      where run.organization_id = $1 and run.id = $2
      -- Two controls on one run, from an agent and a person or from two
      -- agents, take turns: the second reads what the first committed (a
      -- cancelled run is then ALREADY_TERMINAL), so only one can take the
      -- run's last transition.
      for update of run`,
    [organizationId, runId],
  );
  const run = runResult.rows[0];
  if (!run) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if ((run.kind ?? "workflow") !== "workflow") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "run_kind_unsupported" },
    });
  }
  if (
    run.task_id === null || run.workflow_version_id === null ||
    run.application_id === null || run.conversation_id === null
  ) {
    throw new Error("WORKFLOW_RUN_OWNER_INVALID");
  }

  const attemptResult = await transaction.query<{
    id: string;
    adapterCapabilities: unknown;
  }>(
    `select attempt.id, host.adapter_capabilities as "adapterCapabilities"
       from bakery.workflow_runs as run
       join bakery.run_steps as step
         on step.organization_id = run.organization_id
        and step.run_id = run.id
       join bakery.jobs as job
         on job.organization_id = step.organization_id
        and job.run_step_id = step.id
       join bakery.job_attempts as attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
       join bakery.worker_hosts as host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where run.organization_id = $1
        and run.id = $2
        and attempt.status in ('leased', 'running', 'canceling')
        and job.current_fence = attempt.fence
      order by step.position asc, step.iteration asc,
        attempt.attempt_no desc, attempt.id desc`,
    [organizationId, runId],
  );
  // A run may have several live attempts (the lanes of a parallel group): a
  // control reaches every one of them, not only the first.
  const attempts = attemptResult.rows;
  if (attempts.length === 0) {
    if (["completed", "failed", "canceled", "blocked"].includes(run.status)) {
      throw new StandardError({ code: "ALREADY_TERMINAL" });
    }
    // A run waiting for a retry or for admission has no worker to command.
    if (input.action !== "cancel") {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    await cancelRunWithoutAttempt(transaction, {
      organizationId,
      runId,
      traceId: context.traceId,
    });
  } else {
    // Every worker must be able to take the command before any is given it:
    // no command row, run revision or event if one never advertised it.
    for (const attempt of attempts) {
      if (
        !adapterSupportsControl(
          input.action,
          readAdapterCapabilities(attempt.adapterCapabilities),
        )
      ) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "unsupported", action: input.action },
        });
      }
    }
    const metadata = requireCommandMetadata(context);
    const requestDigest = await sha256Hex(canonicalJson({
      runId,
      action: input.action,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }));
    for (const attempt of attempts) {
      await enqueueWorkerControlCommand(transaction, {
        organizationId,
        attemptId: attempt.id,
        action: input.action,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey: metadata.idempotencyKey,
        requestDigest,
        traceId: context.traceId,
      });
    }
    if (input.action === "cancel") {
      // Whatever no worker holds ends with the run: jobs still queued.
      await cancelQueuedJobsOfRun(transaction, {
        organizationId,
        runId,
        traceId: context.traceId,
      });
    }
  }
  // Each admitted request is its own run revision. A second request on the
  // same run (pause, then resume) would otherwise repeat the aggregate version
  // and violate `domain_events_aggregate_unique`.
  await transaction.query(
    `update bakery.workflow_runs
        set version = version + 1, updated_at = current_timestamp
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  const updatedResult = await transaction.query<RunControlRow>(
    `select ${RUN_COLUMNS},
            task.application_id,
            task.repository_id,
            task.conversation_id
       from bakery.workflow_runs as run
       join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
      where run.organization_id = $1 and run.id = $2
        and run.kind = 'workflow'`,
    [organizationId, runId],
  );
  const updated = updatedResult.rows[0] ?? run;
  // An agent's control is recorded as the person's request, labelled as an
  // agent's action with the attempt it came from and who it acted for (O50).
  if (exercised.attribution.actorKind === "agent") {
    await appendAudit(transaction, {
      organizationId,
      principalId,
      operation: "runs.control.agent",
      agentSessionId: exercised.origin?.agentSessionId ?? null,
      resourceType: "workflow_run",
      resourceId: runId,
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        action: input.action,
        actorKind: "agent",
        onBehalfOf: principalId,
        ...(exercised.origin === null ? {} : {
          fromRunId: exercised.origin.runId,
          ...(exercised.origin.agentSessionId === null
            ? {}
            : { sessionId: exercised.origin.agentSessionId }),
        }),
      },
    });
  } else {
    // A person's control is recorded as theirs, so a read can say who
    // stopped a run (#61: "Stopped by {name}" on a ticket request).
    await appendAudit(transaction, {
      organizationId,
      principalId,
      operation: "runs.control",
      resourceType: "workflow_run",
      resourceId: runId,
      requestId: context.requestId,
      traceId: context.traceId,
      details: { action: input.action },
    });
  }
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: updated.application_id,
    repositoryId: updated.repository_id,
    taskId: updated.task_id,
    conversationId: updated.conversation_id,
    eventType: "run.control_requested",
    aggregateId: runId,
    aggregateVersion: updated.version,
    payload: { runId, action: input.action },
    traceId: context.traceId,
  });
  return toRun(
    updated,
    await readRunBudgetSummary(transaction, {
      organizationId,
      runId: updated.id,
      limitUsd: String(updated.budget_limit_usd),
    }),
  );
}

/**
 * The run-control, session-read and transcript operations, built so the routes
 * and the session tool gateway (#414) can run the same handlers under the same
 * authority guard. The handlers hold no state, so each caller may build its own.
 */
export function createRunControlRegistry(
  options: Pick<ExecutionRouteOptions, "database" | "secret" | "agentSpawn">,
): ActionRegistry {
  const limits = options.agentSpawn ?? DEFAULT_AGENT_SPAWN;
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(options.database),
    createPostgresCommandRunner(),
  );
  registry.register({
    name: ExecutionImplementedAction.RunsControlCapabilities,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/controls",
    input: contractSchemas.IdPath,
    output: contractSchemas.RunControlCapabilities,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: runControlCapabilitiesAction,
  });
  registry.register({
    name: ExecutionImplementedAction.TranscriptStatus,
    method: HttpMethod.Get,
    path: "/v1/output-streams/:id/transcript",
    input: contractSchemas.TranscriptStatusQuery,
    output: contractSchemas.TranscriptStatus,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: transcriptStatusAction,
  });
  registry.register({
    name: ExecutionImplementedAction.RunsControl,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/controls",
    input: contractSchemas.RunControl,
    output: contractSchemas.Run,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: runControlAction,
  });
  registry.register({
    name: ExecutionImplementedAction.SessionsGet,
    method: HttpMethod.Get,
    path: "/v1/sessions/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.AgentSession,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: getAgentSession,
  });
  registry.register({
    name: ExecutionImplementedAction.SessionsList,
    method: HttpMethod.Get,
    path: "/v1/sessions",
    input: contractSchemas.SessionList,
    output: contractSchemas.AgentSessionPage,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: createSessionListHandler(options.secret),
  });
  registry.register({
    name: ExecutionImplementedAction.SessionsFeed,
    method: HttpMethod.Get,
    path: "/v1/sessions/:id/feed",
    input: contractSchemas.SessionFeedList,
    output: contractSchemas.SessionFeed,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: createSessionFeedHandler(options.secret),
  });
  registry.register({
    name: ExecutionImplementedAction.SessionsSteer,
    method: HttpMethod.Post,
    path: "/v1/sessions/:id/messages",
    input: contractSchemas.SteeringMessage,
    output: contractSchemas.Message,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => steerAgentSession(context, input, limits),
  });
  registry.register({
    name: ExecutionImplementedAction.HandoffManifestsGet,
    method: HttpMethod.Get,
    path: "/v1/handoff-manifests/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.HandoffManifestRecord,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) =>
      getHandoffManifest(context).then((record) =>
        contractSchemas.HandoffManifestRecord.parse(record)
      ),
  });
  registry.register({
    name: ExecutionImplementedAction.HandoffManifestsContinue,
    method: HttpMethod.Post,
    path: "/v1/handoff-manifests/:id/continuations",
    input: contractSchemas.HandoffContinue,
    output: contractSchemas.HandoffContinuation,
    policy: {
      type: ActionKind.Command,
      // The same access as controlling the run: retiring a live attempt to
      // continue it elsewhere is a decision about that one run, like cancelling.
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) =>
      admitHandoffContinuation(context, input).then((record) =>
        contractSchemas.HandoffContinuation.parse(record)
      ),
  });
  registry.register({
    name: ExecutionImplementedAction.RunStepsNote,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/steps/:stepKey/notes",
    input: contractSchemas.RunStepNoteCreate,
    output: contractSchemas.RunStepNote,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context, input) => createRunStepNote(context, input, limits),
  });
  registry.register({
    name: ExecutionImplementedAction.RunStepsTakeOver,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/steps/:stepKey/takeover",
    input: contractSchemas.RunStepTakeOver,
    output: contractSchemas.RunStep,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: takeOverRunStep,
  });
  registry.register({
    name: ExecutionImplementedAction.RunStepsRevertWrites,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/steps/:stepKey/writes/revert",
    input: contractSchemas.RunStepRevertWrites,
    output: contractSchemas.RunStepWritesReverted,
    successStatus: 200,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: revertRunStepWrites,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, executionImplementedActions);

  return registry;
}

export function createExecutionRunControlApp(
  options: ExecutionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const registry = createRunControlRegistry(options);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/runs/*", options.browserSession);
  app.use("/v1/sessions/*", options.browserSession);
  app.use("/v1/handoff-manifests/*", options.browserSession);
  app.use("/v1/output-streams/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  // The event stream reads through the registry, so it authorizes exactly like
  // `sessions.feed`; it is a transport over that action, not a second route.
  app.get(
    "/v1/sessions/:id/feed/stream",
    async (context) =>
      await openSessionFeedStream({
        registry,
        context,
        publicBaseUrl: options.publicBaseUrl,
      }),
  );
  return app;
}

type WorkerCleanupRouteOptions = Pick<
  ExecutionRouteOptions,
  "database" | "publicBaseUrl" | "secret"
>;

const MAX_SQL_BIGINT = 9_223_372_036_854_775_807n;

function workerCleanupHandler(
  options: WorkerCleanupRouteOptions,
  handler: (
    context: Context,
  ) => Promise<Response>,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const requestedVersion = parseWorkerProtocolVersion(
      context.req.raw.headers,
    );
    try {
      return withWorkerProtocolHeader(
        await handler(context),
        requestedVersion,
      );
    } catch (error) {
      const response = problemResponse(context, error, {
        publicBaseUrl: options.publicBaseUrl,
      });
      return withWorkerProtocolHeader(
        response,
        error instanceof StandardError &&
          error.code === "WORKER_PROTOCOL_UNSUPPORTED"
          ? WORKER_PROTOCOL_VERSION
          : requestedVersion,
      );
    }
  };
}

const cleanupEvidenceSchema = z.object({
  fence: z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => {
    try {
      return BigInt(value) <= MAX_SQL_BIGINT;
    } catch {
      return false;
    }
  }).describe("Canonical bounded current attempt fence."),
  workerSessionId: z.string().uuid().describe(
    "Current worker session attesting cleanup.",
  ),
  workerSessionGeneration: z.string().regex(/^(0|[1-9][0-9]*)$/).refine(
    (value) => {
      try {
        return BigInt(value) <= MAX_SQL_BIGINT;
      } catch {
        return false;
      }
    },
  ).describe("Canonical bounded attesting worker session generation."),
  observedByWorkerSessionId: z.string().uuid().describe(
    "Worker session that observed process exit.",
  ),
  observedByWorkerSessionGeneration: z.string().regex(
    /^(0|[1-9][0-9]*)$/,
  ).refine(
    (value) => {
      try {
        return BigInt(value) <= MAX_SQL_BIGINT;
      } catch {
        return false;
      }
    },
  ).describe("Canonical bounded observing worker session generation."),
  exitedAt: z.string().datetime({ offset: true }).describe(
    "RFC 3339 process exit timestamp.",
  ),
}).strict().describe(
  "Worker-attested confirmed cancellation cleanup evidence.",
);

export function createExecutionWorkerCleanupApp(
  options: WorkerCleanupRouteOptions,
): Hono {
  const app = new Hono();
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );
  app.notFound((context) =>
    problemResponse(
      context,
      new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      { publicBaseUrl: options.publicBaseUrl },
    )
  );
  app.post(
    "/v1/worker/attempts/:id/cleanup",
    workerCleanupHandler(options, async (context) => {
      const body = await parseContract(context, cleanupEvidenceSchema);
      const attemptId = readAttemptId(context);
      const evidence = await workerTransaction(
        options.database,
        context.req.raw.headers,
        async (transaction, identity) => {
          if (
            identity.host.worker_session_id !== body.workerSessionId ||
            String(identity.host.worker_session_generation) !==
              body.workerSessionGeneration
          ) {
            throw new StandardError({ code: "STATE_CONFLICT" });
          }
          return await resolveCanceledAttemptCleanup(transaction, {
            organizationId: identity.host.organization_id,
            workerHostId: identity.host.id,
            attemptId,
            fence: body.fence,
            attestingWorkerSessionId: body.workerSessionId,
            attestingWorkerSessionGeneration: body.workerSessionGeneration,
            observerWorkerSessionId: body.observedByWorkerSessionId,
            observerWorkerSessionGeneration:
              body.observedByWorkerSessionGeneration,
            exitedAt: body.exitedAt,
          });
        },
      );
      return context.json(evidence);
    }),
  );
  return app;
}

async function adminControlTransaction<T>(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
  work: (
    transaction: PgTransactionClient,
    organization: OrganizationId,
  ) => Promise<T>,
): Promise<T> {
  const principal = context.get("principal");
  if (!principal) throw new StandardError({ code: "AUTH_REQUIRED" });
  const organizationHeader = context.req.header("Bakery-Organization-Id");
  if (!organizationHeader) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  let organization: OrganizationId;
  try {
    organization = organizationId(organizationHeader);
  } catch (cause) {
    throw new StandardError({ code: "AUTH_FORBIDDEN", cause });
  }
  return await withPgTransaction(options.database, async (transaction) => {
    const actor = await resolveOrganizationActor(
      transaction,
      principal.principalId,
      organization,
    );
    // Attempt-level worker control is admin-only: no catalog action backs this
    // route, so it uses the admin-minimum worker key and honors no action grant.
    authorize(actor, "worker:manage");
    return await work(transaction, organization);
  }, context.req.raw.signal);
}

const controlBodySchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "interrupt"]).describe(
    "Worker control action.",
  ),
  reason: z.string().max(2_000).optional().describe(
    "Optional operator reason.",
  ),
}).strict().describe("Execution control request.");

export function createExecutionControlApp(
  options: ExecutionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );
  app.notFound((context) =>
    problemResponse(
      context,
      new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      { publicBaseUrl: options.publicBaseUrl },
    )
  );
  app.route("/", createExecutionRunControlApp(options));
  app.use("/v1/execution/attempts/*", options.browserSession);
  app.post("/v1/execution/attempts/:id/control", async (context) => {
    const body = await parseContract(context, controlBodySchema);
    const attemptId = readAttemptId(context);
    const idempotencyKey = parseIdempotencyKey(
      context.req.header("Idempotency-Key"),
    );
    const requestDigest = await sha256Hex(canonicalJson({
      attemptId,
      action: body.action,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    }));
    const command = await adminControlTransaction(
      context,
      options,
      (transaction, organization) =>
        enqueueWorkerControlCommand(transaction, {
          organizationId: organization,
          attemptId,
          action: body.action,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          idempotencyKey,
          requestDigest,
          traceId: getTraceId(context.req.raw),
        }),
    );
    return context.json(command, 202);
  });
  return app;
}
