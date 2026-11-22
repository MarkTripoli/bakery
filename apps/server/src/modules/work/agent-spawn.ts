import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { AgentSpawnConfig } from "@bakery/config";
import { appendAudit } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  agentHoldsPower,
  AgentPower,
  attemptOrigin,
} from "../auth/application/agent-power-grants.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  childRunEnvironment,
  type RunEnvironment,
  toRunEnvironment,
} from "./run-environment.ts";

/**
 * An agent starting a run is a spawn, and a spawn is the one agent power that
 * can recurse (chapter 25 sections 9 and 18.1, issue #413). Depth and count are
 * therefore safety bounds, not throttles, and the checks run at admission,
 * before anything is written, in a stated order:
 *
 *   1. permission  the run_start power, for the workflow of the spawning run
 *                  and of every ancestor (a child never holds more than its
 *                  parent),
 *   2. depth       how far down the spawn chain the new run would sit,
 *   3. count       how many live runs the spawning run already has,
 *   4. budget      the limit asked for against what the parent has left.
 *
 * Permission comes first so a caller who may not spawn is not told that a limit
 * exists. Each refusal has its own named reason.
 */
export const SpawnRefusal = Object.freeze(
  {
    RequiresGrant: "spawn_requires_grant",
    DepthExceeded: "spawn_depth_exceeded",
    CountExceeded: "spawn_count_exceeded",
    BudgetRequired: "spawn_budget_required",
    BudgetExceeded: "spawn_budget_exceeded",
  } as const,
);
export type SpawnRefusal = typeof SpawnRefusal[keyof typeof SpawnRefusal];
type AgentPowerName = typeof AgentPower[keyof typeof AgentPower];

export type SpawnFacts = Readonly<{
  /** Whether every workflow along the spawn chain holds the run_start power. */
  holdsPower: boolean;
  /** The spawning run's own depth: 0 for a run a person started. */
  parentDepth: number;
  /** Live runs the spawning run has already spawned. */
  liveChildren: number;
  /** The limit the agent asked for, in micro-USD, or null when it named none. */
  requestedBudgetMicro: bigint | null;
  /** What the spawning run has left after its own spend and its live children. */
  parentHeadroomMicro: bigint;
  limits: AgentSpawnConfig;
}>;

/**
 * The decision, with no I/O so every boundary is a unit test. It returns the
 * first refusal in the stated order, or null when the spawn may proceed.
 */
export function decideSpawn(facts: SpawnFacts): SpawnRefusal | null {
  if (!facts.holdsPower) return SpawnRefusal.RequiresGrant;
  // The new run would sit one below its parent; the bound is the deepest it may be.
  if (facts.parentDepth + 1 > facts.limits.maxDepth) {
    return SpawnRefusal.DepthExceeded;
  }
  if (facts.liveChildren >= facts.limits.maxChildren) {
    return SpawnRefusal.CountExceeded;
  }
  // An agent's child must carry a limit, so a spawn cannot be unbounded.
  if (facts.requestedBudgetMicro === null) return SpawnRefusal.BudgetRequired;
  if (facts.requestedBudgetMicro > facts.parentHeadroomMicro) {
    return SpawnRefusal.BudgetExceeded;
  }
  return null;
}

/**
 * The spawn chain of a run, the run itself first, and what it means: the depth
 * (how many ancestors it has) and whether every workflow along it holds the
 * run_start power. Authority is the intersection, so one workflow without the
 * grant takes the power from the whole chain below it.
 */
export async function spawnAuthority(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  power: AgentPowerName = AgentPower.RunStart,
): Promise<{ holdsPower: boolean; depth: number }> {
  const chain = await transaction.query<{ workflowId: string }>(
    `with recursive chain as (
       select run.id, run.spawned_by_run_id, version.workflow_id, 0 as up
         from bakery.workflow_runs as run
         join bakery.workflow_versions as version
           on version.organization_id = run.organization_id
          and version.id = run.workflow_version_id
        where run.organization_id = $1 and run.id = $2
       union all
       select parent.id, parent.spawned_by_run_id, version.workflow_id,
              chain.up + 1
         from chain
         join bakery.workflow_runs as parent
           on parent.organization_id = $1 and parent.id = chain.spawned_by_run_id
         join bakery.workflow_versions as version
           on version.organization_id = parent.organization_id
          and version.id = parent.workflow_version_id
     )
     select workflow_id as "workflowId" from chain order by up`,
    [organizationId, runId],
  );
  const workflows = [...new Set(chain.rows.map((row) => row.workflowId))];
  let holdsPower = workflows.length > 0;
  for (const workflowId of workflows) {
    if (
      !(await agentHoldsPower(transaction, {
        organizationId,
        power,
        workflowId,
        accessTokenId: null,
      }))
    ) {
      holdsPower = false;
      break;
    }
  }
  return { holdsPower, depth: Math.max(0, chain.rows.length - 1) };
}

/**
 * Admits an agent creating a task: only below the task of the run it acts from,
 * and only with the run_start power along its chain. A person's task is
 * unchanged. Without this an agent granted run_start could create tasks anywhere.
 */
export async function admitAgentTask(
  transaction: PgTransactionClient,
  context: ActionContext,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    parentId: string | undefined;
  }>,
): Promise<void> {
  const attribution = attributeAction(context, input.principalId);
  if (attribution.actorKind === "person") return;
  if (context.agentSession === undefined) {
    throw refusal(SpawnRefusal.RequiresGrant);
  }
  const origin = await attemptOrigin(
    transaction,
    input.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) throw refusal(SpawnRefusal.RequiresGrant);
  const { holdsPower } = await spawnAuthority(
    transaction,
    input.organizationId,
    origin.runId,
  );
  if (!holdsPower) throw refusal(SpawnRefusal.RequiresGrant);
  // A task an agent creates hangs under its own run's task, or below it.
  const below = input.parentId === undefined ? [] : (await transaction.query(
    `with recursive up as (
       select id, parent_task_id from bakery.tasks
        where organization_id = $1 and id = $2
       union all
       select task.id, task.parent_task_id
         from up
         join bakery.tasks as task
           on task.organization_id = $1 and task.id = up.parent_task_id
     )
     select 1 from up
      where id = (select task_id from bakery.workflow_runs
                   where organization_id = $1 and id = $3)`,
    [input.organizationId, input.parentId, origin.runId],
  )).rows;
  if (below.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/** Wraps the task-creating command with {@link admitAgentTask}. */
export function withAgentTaskChecks<
  Create extends (context: ActionContext, input: never) => Promise<unknown>,
>(create: Create): Create {
  const guarded = async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    await admitAgentTask(transaction, context, {
      organizationId,
      principalId,
      parentId: (input as { parentId?: string }).parentId,
    });
    return await (create as unknown as (
      c: ActionContext,
      i: unknown,
    ) => Promise<unknown>)(
      context,
      input,
    );
  };
  return guarded as unknown as Create;
}

const TERMINAL = "('completed', 'failed', 'canceled', 'blocked')";

/** A USD decimal string to micro-USD, exact. */
export function toMicroUsd(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n +
    BigInt((fraction + "000000").slice(0, 6));
}

/** What an admitted spawn needs afterwards, to record it. */
export type SpawnAdmission = Readonly<{
  parentRunId: string;
  parentDepth: number;
  sessionId: string | null;
  /** The spawning run's environment, which the spawned run inherits. */
  parentEnvironment: RunEnvironment;
}>;

/**
 * Admits an agent's run start, or refuses it with a named reason and writes
 * nothing. A person's start returns null and is unchanged.
 *
 * The spawning run's row is locked first, so two spawns from the same parent
 * cannot both take the last slot: the second waits, then reads the count the
 * first left.
 */
export async function admitAgentSpawn(
  transaction: PgTransactionClient,
  context: ActionContext,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    taskId: string;
    requestedBudgetUsd: string | undefined;
    limits: AgentSpawnConfig;
  }>,
): Promise<SpawnAdmission | null> {
  const attribution = attributeAction(context, input.principalId);
  if (attribution.actorKind === "person") return null;
  // An agent without a session (a token agent) has no run to spawn from.
  if (context.agentSession === undefined) {
    throw refusal(SpawnRefusal.RequiresGrant);
  }
  const origin = await attemptOrigin(
    transaction,
    input.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) throw refusal(SpawnRefusal.RequiresGrant);

  await transaction.query(
    `select id from bakery.workflow_runs
      where organization_id = $1 and id = $2
      for update`,
    [input.organizationId, origin.runId],
  );

  const { holdsPower, depth } = await spawnAuthority(
    transaction,
    input.organizationId,
    origin.runId,
  );

  // The target must be a task below the spawning run's own task: an agent
  // starts work inside its tree, never on an arbitrary task.
  const inTree = await transaction.query(
    `with recursive up as (
       select id, parent_task_id from bakery.tasks
        where organization_id = $1 and id = $2
       union all
       select task.id, task.parent_task_id
         from up
         join bakery.tasks as task
           on task.organization_id = $1 and task.id = up.parent_task_id
     )
     select 1 from up
      where id = (select task_id from bakery.workflow_runs
                   where organization_id = $1 and id = $3)
        and id <> $2`,
    [input.organizationId, input.taskId, origin.runId],
  );
  // The same refusal as an unknown task: no oracle for what exists elsewhere.
  if (inTree.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  const live = await transaction.query<{ children: string; allocated: string }>(
    `select count(*)::text as children,
            coalesce(sum(budget_limit_usd), 0)::text as allocated
       from bakery.workflow_runs
      where organization_id = $1 and spawned_by_run_id = $2
        and status not in ${TERMINAL}`,
    [input.organizationId, origin.runId],
  );
  const parent = await transaction.query<
    { limit: string; spent: string; environment: string }
  >(
    `select run.budget_limit_usd::text as "limit", run.environment,
            coalesce((
              select account.reserved_usd + account.settled_usd
                from bakery.budget_accounts as account
               where account.organization_id = run.organization_id
                 and account.scope = 'run' and account.run_id = run.id
            ), 0)::text as spent
       from bakery.workflow_runs as run
      where run.organization_id = $1 and run.id = $2`,
    [input.organizationId, origin.runId],
  );
  const parentRow = parent.rows[0];
  const headroom = parentRow
    ? toMicroUsd(parentRow.limit) - toMicroUsd(parentRow.spent) -
      toMicroUsd(live.rows[0].allocated)
    : 0n;

  const refused = decideSpawn({
    holdsPower,
    parentDepth: depth,
    liveChildren: Number(live.rows[0].children),
    requestedBudgetMicro: input.requestedBudgetUsd === undefined
      ? null
      : toMicroUsd(input.requestedBudgetUsd),
    parentHeadroomMicro: headroom,
    limits: input.limits,
  });
  if (refused !== null) throw refusal(refused);
  return {
    parentRunId: origin.runId,
    parentDepth: depth,
    sessionId: origin.agentSessionId,
    parentEnvironment: toRunEnvironment(parentRow?.environment),
  };
}

/**
 * Links the admitted run to the run that spawned it and records the spawn as an
 * agent's action. In the run's own transaction, so a spawn and its record exist
 * together or not at all, like every other command here.
 */
export async function recordAgentSpawn(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    runId: string;
    admission: SpawnAdmission;
  }>,
): Promise<void> {
  await transaction.query(
    `update bakery.workflow_runs set spawned_by_run_id = $3
      where organization_id = $1 and id = $2`,
    [facts.organizationId, facts.runId, facts.admission.parentRunId],
  );
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "runs.spawn.agent",
    agentSessionId: facts.admission.sessionId,
    resourceType: "workflow_run",
    resourceId: facts.runId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      actorKind: "agent",
      onBehalfOf: facts.principalId,
      fromRunId: facts.admission.parentRunId,
      depth: facts.admission.parentDepth + 1,
      ...(facts.admission.sessionId === null
        ? {}
        : { sessionId: facts.admission.sessionId }),
    },
  });
}

function refusal(reason: SpawnRefusal): StandardError {
  return new StandardError({
    code: reason === SpawnRefusal.RequiresGrant
      ? "AUTH_FORBIDDEN"
      : "STATE_CONFLICT",
    params: { reason },
  });
}

/**
 * Wraps the run-creating command so an agent's start is admitted by
 * {@link admitAgentSpawn} first and recorded after. A person's start passes
 * through untouched.
 */
export function withAgentSpawnChecks<
  Create extends (context: ActionContext, input: never) => Promise<unknown>,
>(create: Create, limits: AgentSpawnConfig): Create {
  const guarded = async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const taskId = context.params.id;
    if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const admission = await admitAgentSpawn(transaction, context, {
      organizationId,
      principalId,
      taskId,
      requestedBudgetUsd: (input as { budgetLimitUsd?: string }).budgetLimitUsd,
      limits,
    });
    // A spawned run is pinned to its parent's environment unless it asks for
    // one, and an offline parent can never open a live child.
    const pinned = admission === null ? input : {
      ...(input as Record<string, unknown>),
      environment: childRunEnvironment(
        admission.parentEnvironment,
        (input as { environment?: RunEnvironment }).environment,
      ),
    };
    const run =
      await (create as unknown as (c: ActionContext, i: unknown) => Promise<
        { id: string }
      >)(context, pinned);
    if (admission !== null) {
      await recordAgentSpawn(transaction, context, {
        organizationId,
        principalId,
        runId: run.id,
        admission,
      });
    }
    return run;
  };
  return guarded as unknown as Create;
}
