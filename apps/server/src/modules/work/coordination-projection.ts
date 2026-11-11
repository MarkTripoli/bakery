import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import { takeFailedLifecycleTasks } from "@bakery/persistence/attempts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type LaneStatus,
  type PlanStatus,
  projectLaneStatuses,
} from "./coordination-plan.ts";
import {
  laneProjectionStatus,
  loadPlanLanes,
  PLAN_COLUMNS,
} from "./coordination-query.ts";

// Persisted coordination projection and shared plan helpers. Kept apart from
// the command module so engine and execution code can reconcile a plan without
// importing the command handlers (and the execution module they import).

export type PlanRecord = {
  id: string;
  application_id: string;
  parent_task_id: string;
  revision: number;
  spec: unknown;
  digest: string;
  budget_limit_usd: string | null;
  status: string;
  version: number;
  origin: unknown;
};

export type Facts = {
  organizationId: string;
  principalId: string;
  requestId: string;
  traceId: string;
};

/** Engine-originated facts (terminal hooks): no acting principal, no audit. */
export type SystemFacts = Readonly<{
  organizationId: string;
  principalId: null;
  traceId: string;
}>;

export async function recordFacts(
  transaction: PgTransactionClient,
  facts: Facts | SystemFacts,
  options: {
    operation: string;
    resourceType: string;
    resourceId: string;
    eventType: string;
    version: number;
    applicationId: string;
    repositoryId?: string | null;
    taskId?: string | null;
    details?: unknown;
  },
): Promise<void> {
  if (facts.principalId !== null) {
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: facts.principalId,
      operation: options.operation,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      requestId: (facts as Facts).requestId,
      traceId: facts.traceId,
      details: options.details ?? {},
    });
  }
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: options.applicationId,
    repositoryId: options.repositoryId ?? null,
    taskId: options.taskId ?? null,
    eventType: options.eventType,
    aggregateId: options.resourceId,
    aggregateVersion: options.version,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.version,
    },
    traceId: facts.traceId,
  });
}

export async function loadPlanForUpdate(
  transaction: PgTransactionClient,
  organizationId: string,
  planId: string,
): Promise<PlanRecord> {
  const result = await transaction.query<PlanRecord>(
    `select ${PLAN_COLUMNS}
       from bakery.coordination_plans p
      where p.organization_id = $1 and p.id = $2
      for update`,
    [organizationId, planId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

export async function bumpPlan(
  transaction: PgTransactionClient,
  organizationId: string,
  planId: string,
  status: PlanStatus,
): Promise<number> {
  const result = await transaction.query<{ version: number }>(
    `update bakery.coordination_plans
        set status = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning version`,
    [organizationId, planId, status],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row.version;
}

export async function setLaneStatus(
  transaction: PgTransactionClient,
  organizationId: string,
  laneId: string,
  status: LaneStatus,
): Promise<void> {
  await transaction.query(
    `update bakery.coordination_lanes
        set status = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status <> $3`,
    [organizationId, laneId, status],
  );
}

// --- Projection ------------------------------------------------------------

/**
 * Persists the parent projection from the child tasks' states: all required
 * lanes completed -> completed; a failed lane stops its dependants while
 * independent lanes continue; the parent never reports success while required
 * work is incomplete. Safe to call repeatedly.
 */
export async function reconcileCoordinationPlan(
  transaction: PgTransactionClient,
  facts: Facts | SystemFacts,
  planId: string,
): Promise<void> {
  // Lock order: parent task, then the plan row (see lockCoordinationScope).
  const parent = await transaction.query<{ parent_task_id: string }>(
    `select parent_task_id from bakery.coordination_plans
      where organization_id = $1 and id = $2`,
    [facts.organizationId, planId],
  );
  if (parent.rows[0]) {
    await transaction.query(
      `select id from bakery.tasks
        where organization_id = $1 and id = $2 for update`,
      [facts.organizationId, parent.rows[0].parent_task_id],
    );
  }
  const plan = await loadPlanForUpdate(
    transaction,
    facts.organizationId,
    planId,
  );
  if (
    !["materialized", "partially_delivered", "failed"].includes(plan.status)
  ) {
    return;
  }
  const lanes =
    (await loadPlanLanes(transaction, facts.organizationId, [planId]))
      .get(planId) ?? [];
  const projection = projectLaneStatuses(lanes.map((lane) => ({
    key: lane.lane_key,
    prerequisites: lane.prerequisites,
    status: laneProjectionStatus(lane),
  })));
  for (const lane of lanes) {
    const next = projection.lanes.get(lane.lane_key);
    if (next && next !== lane.status) {
      await setLaneStatus(transaction, facts.organizationId, lane.id, next);
    }
  }
  if (projection.plan === plan.status) return;
  const version = await bumpPlan(
    transaction,
    facts.organizationId,
    planId,
    projection.plan,
  );
  await recordFacts(transaction, facts, {
    operation: "coordinationPlans.project",
    resourceType: "coordination_plan",
    resourceId: planId,
    eventType: "coordinationPlan.updated",
    version,
    applicationId: plan.application_id,
    taskId: plan.parent_task_id,
    details: { status: projection.plan },
  });
}

/**
 * Reconciles every live plan that owns this child task. Terminal task and run
 * paths (failure projection, cancellation lifecycle) call it inside their
 * transaction, after the child task is locked and updated, so the persisted
 * plan/lane status and the `coordinationPlan.updated` event follow the child.
 */
export async function reconcileCoordinationForTask(
  transaction: PgTransactionClient,
  facts: Facts | SystemFacts,
  taskId: string,
): Promise<void> {
  const plans = await transaction.query<{ plan_id: string }>(
    `select distinct plan_id from bakery.coordination_lanes
      where organization_id = $1 and child_task_id = $2`,
    [facts.organizationId, taskId],
  );
  for (const { plan_id } of plans.rows) {
    await reconcileCoordinationPlan(transaction, facts, plan_id);
  }
}

/**
 * Artifact-commit entry: reconciles only when the committed artifact is a
 * declared output of a lane on this task (key and artifact type match), so
 * transcript, manifest and other commits never touch the parent row.
 *
 * Lock order: the caller already holds its attempt, job and artifact locks and
 * possibly the child task; reconcile then takes the parent task and the plan
 * rows, last. That is the order `lockCoordinationScope` uses for cancel and
 * materialize (hosts, attempts, jobs, runs, children, parent, plans), so a
 * commit and a cancel or materialize never wait on each other in a cycle.
 */
export async function reconcileCoordinationForCommittedOutput(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    taskId: string;
    artifactName: string;
    artifactType: string;
    traceId: string;
  },
): Promise<void> {
  const declared = await transaction.query(
    `select 1 from bakery.coordination_lanes
      where organization_id = $1 and child_task_id = $2
        and declared_outputs @> $3::jsonb
      limit 1`,
    [
      input.organizationId,
      input.taskId,
      JSON.stringify([{
        key: input.artifactName,
        artifactType: input.artifactType,
      }]),
    ],
  );
  if (declared.rows.length === 0) return;
  await reconcileCoordinationForTerminalTask(transaction, {
    organizationId: input.organizationId,
    taskId: input.taskId,
    traceId: input.traceId,
  });
}

/** Terminal-hook entry for engine code that has no acting principal. */
export async function reconcileCoordinationForTerminalTask(
  transaction: PgTransactionClient,
  input: { organizationId: string; taskId: string; traceId: string },
): Promise<void> {
  await reconcileCoordinationForTask(transaction, {
    organizationId: input.organizationId,
    principalId: null,
    traceId: input.traceId,
  }, input.taskId);
}

/**
 * Reconciles the plans of lane tasks that the persistence attempt lifecycle
 * failed in this transaction (invalid assignment payload, exhausted attempt
 * budget after lease expiry). Worker transactions and the execution
 * coordinator call it before commit, after their own row locks, so the
 * parent task and plan rows still come last.
 */
export async function reconcileFailedLifecycleTasks(
  transaction: PgTransactionClient,
): Promise<void> {
  for (const task of takeFailedLifecycleTasks(transaction)) {
    await reconcileCoordinationForTerminalTask(transaction, task);
  }
}
