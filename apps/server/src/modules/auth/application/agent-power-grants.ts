import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";
import { assignedAgentSessionSql } from "@bakery/persistence/claims";
import {
  type ActionAttribution,
  attributeAction,
} from "./action-attribution.ts";

/**
 * The powers an agent holds only where a person granted them (chapter 25
 * sections 18.2 and 18.3, O50 to O52, issue #414).
 *
 * An agent reads by default and authors drafts; deciding, controlling a run and
 * starting one are off by default and granted per workflow or per seat (O52). A
 * person is never asked for a grant here: the person's role and the action's
 * catalog permission already decided that. Each guarded operation calls
 * {@link assertAgentMayExercise} with its own power, so a power added later
 * inherits the same guard and the parity test covers it.
 */
export const AgentPower = Object.freeze(
  {
    /** Decide an approval or answer a decision a person would otherwise make. */
    Decide: "decide",
    /** Pause, resume, cancel, interrupt or retry a run. */
    RunControl: "run_control",
    /** Start a run. Count, depth and budget checks apply on top of the grant. */
    RunStart: "run_start",
    /** Steer a run an agent spawned, through the same operations a person uses. */
    Steer: "steer",
    /**
     * Also steer a reviewer's step. Off by default (O18): the review is then
     * labelled steered and does not count as independent.
     */
    SteerReviewer: "steer_reviewer",
    /**
     * Write comments on documents and drafts from a session, as the person the
     * run is for. The call is still judged as that person; the power only
     * offers the tools, and a revoked grant stops the next call.
     */
    Comment: "comment",
    /**
     * Edit work items (title, description and the other task fields a person
     * edits) from a session, as the person the run is for.
     */
    EditWork: "edit_work",
    /**
     * Draft a connection from a session: a personal one with no secret that
     * stays off until the person it acts for completes and enables it.
     */
    DraftConnection: "draft_connection",
  } as const,
);
export type AgentPower = typeof AgentPower[keyof typeof AgentPower];

export const AGENT_POWERS: readonly AgentPower[] = Object.freeze(
  Object.values(AgentPower),
);

export function isAgentPower(value: unknown): value is AgentPower {
  return typeof value === "string" &&
    (AGENT_POWERS as readonly string[]).includes(value);
}

/**
 * How far up or down the task tree the own-work check walks. The tree has no
 * cycle by construction, but a recursive query with no bound would never end on
 * one, so the walk is bounded and a lineage deeper than this is not searched
 * further: far past any real nesting, and cheap to read.
 */
const LINEAGE_DEPTH_BOUND = 64;

/** The refusal for an agent acting on work that is its own or its lineage's. */
export const AGENT_TARGET_OWN_WORK = "agent_target_own_work";

/** The refusal an agent without a grant receives, for every power. */
export const AGENT_POWER_REQUIRES_GRANT = "agent_power_requires_grant";

/** The run, workflow and agent session an attempt belongs to. */
export type AttemptOrigin = Readonly<{
  runId: string;
  /** The task the run belongs to: the work the session is part of. */
  taskId: string;
  workflowId: string;
  agentSessionId: string | null;
}>;

/**
 * Finds the run and workflow an attempt belongs to, or null when it has none.
 *
 * The chain is attempt, job, run step, run, workflow version, workflow. A job
 * with no run (a coordinator turn) has no workflow, so no grant can cover it
 * and the agent holds no power there: refused rather than guessed.
 */
export async function attemptOrigin(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<AttemptOrigin | null> {
  const found = await transaction.query<{
    runId: string;
    taskId: string;
    workflowId: string;
    agentSessionId: string | null;
  }>(
    `select run.id as "runId", run.task_id as "taskId",
            version.workflow_id as "workflowId",
            -- The session the attempt's claim handed it, not a later one.
            ${assignedAgentSessionSql("job")} as "agentSessionId"
       from bakery.job_attempts as attempt
       join bakery.jobs as job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps as step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs as run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       join bakery.workflow_versions as version
         on version.organization_id = run.organization_id
        and version.id = run.workflow_version_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [organizationId, attemptId],
  );
  return found.rows[0] ?? null;
}

/**
 * The agent session an action's audit row names (O50): the session of the
 * attempt a session call came from, or null for a person's own action, a token
 * agent's and an attempt that belongs to no run.
 */
export async function auditAgentSessionId(
  transaction: PgTransactionClient,
  context: Pick<ActionContext, "agentSession">,
  organizationId: string,
): Promise<string | null> {
  if (context.agentSession === undefined) return null;
  const origin = await attemptOrigin(
    transaction,
    organizationId,
    context.agentSession.attemptId,
  );
  return origin?.agentSessionId ?? null;
}

/**
 * Whether a live grant gives this agent the power: a grant for the workflow it
 * runs under with no seat, or a grant for its seat that names the workflow or
 * every workflow. An agent without an access token (a session of a worker) can
 * only hold a workflow grant.
 */
export async function agentHoldsPower(
  transaction: PgTransactionClient,
  scope: Readonly<{
    organizationId: string;
    power: AgentPower;
    workflowId: string | null;
    accessTokenId: string | null;
  }>,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1 from bakery.agent_power_grants
      where organization_id = $1 and power = $2
        and (workflow_id = $3::uuid
             or (workflow_id is null and access_token_id is not null))
        and (access_token_id is null or access_token_id = $4::uuid)
      limit 1`,
    [scope.organizationId, scope.power, scope.workflowId, scope.accessTokenId],
  );
  return found.rows.length === 1;
}

/**
 * What an agent's call is attributed to, once its power is proven.
 *
 * `run` and `agentSessionId` are the origin of a session call, so the record of
 * what the agent did can name the run it acted from and the session that made
 * the call (O50), and so a guard can refuse an agent acting on its own work.
 */
export type ExercisedPower = Readonly<{
  attribution: ActionAttribution;
  origin: AttemptOrigin | null;
}>;

/**
 * Refuses an agent's use of an off-by-default power unless a grant covers it,
 * and returns the attribution to record. A person passes untouched: their role
 * and the action's permission already decided it. Call it after the subject row
 * is locked and before anything is written, so a refusal writes nothing.
 */
export async function assertAgentMayExercise(
  transaction: PgTransactionClient,
  context: Pick<ActionContext, "principal" | "accessToken" | "agentSession">,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    power: AgentPower;
  }>,
): Promise<ExercisedPower> {
  const attribution = attributeAction(context, scope.principalId);
  if (attribution.actorKind === "person") {
    return { attribution, origin: null };
  }
  const origin = context.agentSession === undefined
    ? null
    : await attemptOrigin(
      transaction,
      scope.organizationId,
      context.agentSession.attemptId,
    );
  // A session call whose attempt belongs to no run has no origin, so it reaches
  // the lookup with no workflow and no seat, which no grant matches (a grant
  // with neither covers nobody, see agentHoldsPower): it holds nothing. A token
  // agent has no attempt and is matched by its seat alone. No separate refusal
  // is needed; a test pins the result.
  if (
    await agentHoldsPower(transaction, {
      organizationId: scope.organizationId,
      power: scope.power,
      workflowId: origin?.workflowId ?? null,
      accessTokenId: attribution.accessTokenId,
    })
  ) return { attribution, origin };
  throw refusal();
}

function refusal(): StandardError {
  return new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: AGENT_POWER_REQUIRES_GRANT },
  });
}

/**
 * Refuses an agent acting on a run that is its own work, and on a run whose
 * workflow has not granted the power (chapter 25 sections 18.2 and 18.3, O51,
 * O52). The permission guard above proves the agent's own workflow holds the
 * power; this proves the target's does too, so one grant cannot reach every
 * workflow, and that the target is not the agent's own work, so a grant cannot
 * be used to approve or control what the agent produced.
 *
 * The agent's own work is its own run, any other run of its task (a retry or a
 * later run is the same work), and any run in its task lineage, the tasks above
 * it and below it. A person passes untouched.
 */
export async function assertAgentMayTarget(
  transaction: PgTransactionClient,
  exercised: ExercisedPower,
  scope: Readonly<{
    organizationId: string;
    power: AgentPower;
    targetRunId: string;
  }>,
): Promise<void> {
  if (exercised.attribution.actorKind === "person") return;
  const target = await transaction.query<
    { taskId: string; workflowId: string }
  >(
    `select run.task_id as "taskId", version.workflow_id as "workflowId"
       from bakery.workflow_runs as run
       join bakery.workflow_versions as version
         on version.organization_id = run.organization_id
        and version.id = run.workflow_version_id
      where run.organization_id = $1 and run.id = $2`,
    [scope.organizationId, scope.targetRunId],
  );
  const row = target.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const origin = exercised.origin;
  if (origin !== null) {
    // Own run included: it belongs to the agent's own task, which is in the lineage.
    const lineage = await transaction.query(
      `with recursive up as (
         select id, parent_task_id, 0 as depth from bakery.tasks
          where organization_id = $1 and id = $2
         union all
         select task.id, task.parent_task_id, up.depth + 1
           from up
           join bakery.tasks as task
             on task.organization_id = $1 and task.id = up.parent_task_id
          where up.depth < ${LINEAGE_DEPTH_BOUND}
       ), down as (
         select id, 0 as depth from bakery.tasks
          where organization_id = $1 and id = $2
         union all
         select task.id, down.depth + 1
           from down
           join bakery.tasks as task
             on task.organization_id = $1 and task.parent_task_id = down.id
          where down.depth < ${LINEAGE_DEPTH_BOUND}
       )
       select 1 where $3::uuid in (select id from up)
                   or $3::uuid in (select id from down)`,
      [scope.organizationId, origin.taskId, row.taskId],
    );
    if (lineage.rows.length > 0) throw ownWork();
  }

  if (
    !(await agentHoldsPower(transaction, {
      organizationId: scope.organizationId,
      power: scope.power,
      workflowId: row.workflowId,
      accessTokenId: exercised.attribution.accessTokenId,
    }))
  ) throw refusal();
}

function ownWork(): StandardError {
  return new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: AGENT_TARGET_OWN_WORK },
  });
}
