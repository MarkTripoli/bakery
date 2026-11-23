import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  failureCodeOf,
  internalContext,
  liveActor,
} from "../workflows/automations/start.ts";
import { inSavepoint } from "./ticket-sync.ts";
import { lockApplication } from "./postgres.ts";
import { evaluateLaneAdmission } from "./coordination-admission.ts";
import {
  CoordinationPlanSpecSchema,
  type LaneStatus,
  projectLaneStatuses,
} from "./coordination-plan.ts";
import { laneProjectionStatus, loadPlanLanes } from "./coordination-query.ts";
import { createRunCommand } from "./run-command.ts";

/**
 * The engine starts the ready lanes of a plan itself (#422, chapter 25 section
 * 5, change 2). A lane that names what it runs (`run: {workflow, inputs}`) is
 * started once its prerequisites are done, and only while the plan has room:
 * the plan's `maxConcurrency` is its capacity, held under a capacity key, and
 * the dispatcher starts a ready lane only while fewer lane children than that
 * have a live run. Nobody else has to start a lane, and a lane that finishes
 * asks for the dispatcher again, so the plan's own pace follows its capacity.
 */

/** What a plan's capacity is counted under; one key today, so a rule over another can be added beside it. */
export function laneCapacityKey(planId: string): string {
  return `plan:${planId}`;
}

/** Child statuses that hold a place: the lane's run was admitted and has not ended. */
const LIVE_CHILD_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "active",
  "waiting_input",
  "blocked",
  "waiting_capacity",
]);

export type LaneToConsider = Readonly<{
  key: string;
  /** The lane's projected status: ready means a child that waits to be started with its prerequisites done. */
  status: LaneStatus;
  /** Whether the lane names what it runs. */
  runs: boolean;
  /** Whether its child holds a place now: it has a run that has not ended. */
  live: boolean;
}>;

/**
 * Which lanes to start now, in plan order: the ready lanes that name what they
 * run, as many as the plan has room for. A pure function of the plan's state, so
 * asking again after a crash, or twice at once, decides the same thing.
 */
export function lanesToStart(
  limit: number,
  lanes: readonly LaneToConsider[],
): string[] {
  const live = lanes.filter((lane) => lane.live).length;
  const room = Math.max(0, limit - live);
  return lanes
    .filter((lane) => lane.runs && lane.status === "ready")
    .slice(0, room)
    .map((lane) => lane.key);
}

export type LaneDispatchResult = Readonly<{
  /** Lane keys whose run was started. */
  started: readonly string[];
  /** Lanes a refusal that waiting will not change kept from starting, with its short code. */
  refused: readonly Readonly<{ laneKey: string; code: string }>[];
}>;

const DETERMINISTIC: ReadonlySet<string> = new Set([
  "UNPROCESSABLE",
  "VALIDATION_FAILED",
  "STATE_CONFLICT",
  "RESOURCE_NOT_FOUND",
  "AUTH_FORBIDDEN",
  "BUDGET_CAP_EXCEEDED",
]);

/** Refusals that go away with time or with an upstream lane, so the lane is tried again. */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "lane_prerequisite_incomplete",
  "lane_outputs_missing",
  "lane_prerequisite_stale",
  "task_not_startable",
]);

/**
 * Starts the plan's ready lanes, in a transaction of its own (the consumer of
 * `coordination.lanes_dispatch_requested`). Lock order is the one a cancel and a
 * materialize use: the application, then the lane children by id, then the
 * parent task, then the plan. A lane is started as the person who made the plan
 * if they still may; otherwise nothing is started and the reason is recorded.
 * Each start is in a savepoint, so one refusal undoes only its own run.
 */
export async function dispatchReadyLanes(
  transaction: PgTransactionClient,
  input: { organizationId: string; planId: string; traceId: string },
): Promise<LaneDispatchResult> {
  const head = await transaction.query<
    { application_id: string; parent_task_id: string }
  >(
    `select application_id, parent_task_id from bakery.coordination_plans
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.planId],
  );
  const where = head.rows[0];
  if (!where) return { started: [], refused: [] };
  await lockApplication(
    transaction,
    input.organizationId,
    where.application_id,
  );
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1
        and id in (
          select child_task_id from bakery.coordination_lanes
           where organization_id = $1 and plan_id = $2
             and child_task_id is not null
        )
      order by id
      for update`,
    [input.organizationId, input.planId],
  );
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1 and id = $2 for update`,
    [input.organizationId, where.parent_task_id],
  );
  const planRow = await transaction.query<
    {
      status: string;
      spec: unknown;
      created_by: string;
      budget_limit_usd: string | null;
    }
  >(
    `select status, spec, created_by, budget_limit_usd::text as budget_limit_usd
       from bakery.coordination_plans
      where organization_id = $1 and id = $2 for update`,
    [input.organizationId, input.planId],
  );
  const plan = planRow.rows[0];
  // Only a live, materialized plan starts lanes; a canceled or superseded one never does.
  if (!plan || plan.status !== "materialized") {
    return { started: [], refused: [] };
  }
  const spec = CoordinationPlanSpecSchema.parse(plan.spec);
  const lanes = (await loadPlanLanes(transaction, input.organizationId, [
    input.planId,
  ])).get(input.planId) ?? [];
  const projection = projectLaneStatuses(lanes.map((lane) => ({
    key: lane.lane_key,
    prerequisites: lane.prerequisites,
    status: laneProjectionStatus(lane),
  })));
  const specByKey = new Map(spec.lanes.map((lane) => [lane.key, lane]));
  const considered: LaneToConsider[] = lanes.map((lane) => ({
    key: lane.lane_key,
    status: projection.lanes.get(lane.lane_key) ?? "planned",
    runs: specByKey.get(lane.lane_key)?.run !== undefined,
    live: LIVE_CHILD_STATUSES.has(lane.child_status ?? ""),
  }));
  const toStart = lanesToStart(spec.maxConcurrency, considered);
  if (toStart.length === 0) return { started: [], refused: [] };

  const actor = await liveActor(
    transaction,
    input.organizationId,
    plan.created_by,
  );
  const started: string[] = [];
  const refused: { laneKey: string; code: string }[] = [];
  if (actor === null) {
    for (const key of toStart) {
      refused.push({ laneKey: key, code: "actor_unavailable" });
    }
    return { started, refused };
  }
  const trace = { requestId: crypto.randomUUID(), traceId: input.traceId };
  for (const key of toStart) {
    const lane = lanes.find((candidate) => candidate.lane_key === key)!;
    const run = specByKey.get(key)!.run!;
    if (lane.child_task_id === null) continue;
    const childTaskId = lane.child_task_id;
    try {
      await inSavepoint(transaction, "coordination_lane_start", async () => {
        // A lane whose upstream outputs are not committed yet is not ready: it is
        // tried again when they are, not refused for good.
        const admission = await evaluateLaneAdmission(
          transaction,
          input.organizationId,
          childTaskId,
        );
        if (admission?.reason) {
          throw new StandardError({
            code: "STATE_CONFLICT",
            params: { reason: admission.reason },
          });
        }
        // The child task pinned its repository's settings when the plan was
        // materialized; its run starts under the same pin.
        const profile = await transaction.query<{ id: string | null }>(
          `select repository_profile_id as id from bakery.tasks
            where organization_id = $1 and id = $2`,
          [input.organizationId, childTaskId],
        );
        const profileId = profile.rows[0]?.id ?? null;
        const runInput = contractSchemas.RunCreate.safeParse({
          ...(profileId === null ? {} : { repositoryProfileId: profileId }),
          workflowId: run.workflowId,
          executionMode: "repository",
          // The plan's shared ceiling is each child's own limit, and the plan's
          // total is still held across every child (the shared plan budget).
          ...(plan.budget_limit_usd === null
            ? {}
            : { budgetLimitUsd: plan.budget_limit_usd }),
          ...(run.inputs === undefined ? {} : { inputs: run.inputs }),
        });
        if (!runInput.success) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { reason: "lane_run_input_invalid" },
          });
        }
        await createRunCommand(
          internalContext(transaction, actor, trace, { id: childTaskId }, {
            operation: "runs.create",
            idempotencyKey: `coordination-lane:${lane.id}`,
            target: `/v1/tasks/${childTaskId}/runs`,
          }),
          runInput.data,
        );
      });
      started.push(key);
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      if (!DETERMINISTIC.has(error.code)) throw error;
      const code = failureCodeOf(error);
      if (TRANSIENT_REASONS.has(code)) continue;
      refused.push({ laneKey: key, code });
    }
  }
  return { started, refused };
}
