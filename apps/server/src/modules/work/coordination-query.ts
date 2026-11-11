import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { formatMicroUsd, parseMicroUsd } from "./budget.ts";
import {
  type LaneStatus,
  type PlanStatus,
  projectLaneStatuses,
} from "./coordination-plan.ts";
import { loadStaleLaneKeys } from "./coordination-stale.ts";
import { toIso } from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

type PlanRow = {
  id: string;
  application_id: string;
  parent_task_id: string;
  revision: number;
  spec: unknown;
  digest: string;
  budget_limit_usd: string | null;
  status: string;
  origin: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

export type LaneRow = {
  id: string;
  plan_id: string;
  lane_key: string;
  repository_id: string;
  child_task_id: string | null;
  reused_from_lane_id: string | null;
  prerequisites: string[];
  declared_outputs: unknown;
  lane_digest: string;
  status: string;
  child_status: string | null;
  /** True when the lane's completed child consumed an input no longer current. */
  stale: boolean;
  /** Number of typed inputs the plan spec declares for this lane. */
  declared_input_count: number;
};

export const PLAN_COLUMNS = `p.id, p.application_id, p.parent_task_id,
  p.revision, p.spec, p.digest, p.budget_limit_usd::text as budget_limit_usd,
  p.status, p.origin, p.created_by, p.created_at, p.updated_at, p.version`;

/** Lane status a child task implies, before stop-dependent propagation. */
export function laneStatusFromChild(childStatus: string | null): LaneStatus {
  switch (childStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "queued":
    case "active":
    case "waiting_input":
      return "running";
    case "draft":
      return "ready";
    default:
      return "planned";
  }
}

/**
 * Lane status the projection starts from: the child's status, with a
 * completed child reported `stale` when an input it consumed is no longer
 * current. A lane without a child is planned.
 */
export function laneProjectionStatus(lane: LaneRow): LaneStatus {
  if (lane.child_task_id === null) return "planned";
  if (lane.stale && lane.child_status === "completed") return "stale";
  return laneStatusFromChild(lane.child_status);
}

export async function loadPlanLanes(
  transaction: PgTransactionClient,
  organizationId: string,
  planIds: readonly string[],
): Promise<Map<string, LaneRow[]>> {
  const grouped = new Map<string, LaneRow[]>();
  if (planIds.length === 0) return grouped;
  const result = await transaction.query<Omit<LaneRow, "stale">>(
    `select l.id, l.plan_id, l.lane_key, l.repository_id, l.child_task_id,
            l.reused_from_lane_id, l.prerequisites, l.declared_outputs,
            l.lane_digest, l.status, child.status as child_status,
            coalesce((
              select jsonb_array_length(spec_lane -> 'inputs')
                from jsonb_array_elements(p.spec -> 'lanes') spec_lane
               where spec_lane ->> 'key' = l.lane_key
               limit 1
            ), 0)::int as declared_input_count
       from bakery.coordination_lanes l
       join bakery.coordination_plans p
         on p.organization_id = l.organization_id and p.id = l.plan_id
       left join bakery.tasks child
         on child.organization_id = l.organization_id
        and child.id = l.child_task_id
      where l.organization_id = $1 and l.plan_id = any($2::uuid[])
      order by l.plan_id, l.position asc`,
    [organizationId, [...planIds]],
  );
  const unmarked = new Map<string, Omit<LaneRow, "stale">[]>();
  for (const row of result.rows) {
    const rows = unmarked.get(row.plan_id) ?? [];
    rows.push(row);
    unmarked.set(row.plan_id, rows);
  }
  const staleByPlan = await loadStaleLaneKeys(
    transaction,
    organizationId,
    unmarked,
  );
  for (const [planId, rows] of unmarked) {
    const stale = staleByPlan.get(planId) ?? new Set<string>();
    grouped.set(
      planId,
      rows.map((row) => ({ ...row, stale: stale.has(row.lane_key) })),
    );
  }
  return grouped;
}

/** Live projection: lane statuses from child tasks, plan status derived. */
export function liveProjection(
  storedStatus: string,
  lanes: readonly LaneRow[],
): { lanes: Map<string, LaneStatus>; plan: PlanStatus } {
  const derived = projectLaneStatuses(lanes.map((lane) => ({
    key: lane.lane_key,
    prerequisites: lane.prerequisites,
    status: laneProjectionStatus(lane),
  })));
  // A completed plan does not reopen when an upstream output later changes;
  // its lanes still report `stale` and rework is a new plan revision.
  const plan = storedStatus === "planned" || storedStatus === "canceled" ||
      storedStatus === "superseded" || storedStatus === "completed"
    ? storedStatus as PlanStatus
    : derived.plan;
  return { lanes: derived.lanes, plan };
}

function toPlan(row: PlanRow, lanes: readonly LaneRow[]) {
  const projection = liveProjection(row.status, lanes);
  return contractSchemas.CoordinationPlan.parse({
    id: row.id,
    applicationId: row.application_id,
    parentTaskId: row.parent_task_id,
    revision: row.revision,
    spec: row.spec,
    digest: row.digest,
    budgetLimitUsd: row.budget_limit_usd === null
      ? null
      : formatMicroUsd(parseMicroUsd(row.budget_limit_usd)),
    status: projection.plan,
    origin: row.origin ?? { kind: "ad_hoc" },
    createdBy: row.created_by,
    lanes: lanes.map((lane) => ({
      laneKey: lane.lane_key,
      repositoryId: lane.repository_id,
      childTaskId: lane.child_task_id,
      reusedFromLaneId: lane.reused_from_lane_id,
      prerequisites: lane.prerequisites,
      declaredOutputs: lane.declared_outputs,
      laneDigest: lane.lane_digest,
      status: projection.lanes.get(lane.lane_key) ?? "planned",
    })),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  });
}

export async function loadPlanOutput(
  transaction: PgTransactionClient,
  organizationId: string,
  planId: string,
) {
  const result = await transaction.query<PlanRow>(
    `select ${PLAN_COLUMNS}
       from bakery.coordination_plans p
      where p.organization_id = $1 and p.id = $2`,
    [organizationId, planId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const lanes = await loadPlanLanes(transaction, organizationId, [row.id]);
  return toPlan(row, lanes.get(row.id) ?? []);
}

type CursorQuery = { cursor?: string; limit?: number };

function binding(
  action: string,
  organizationId: string,
  principalId: string,
  filters: string,
): CursorBinding {
  return {
    action,
    principalId,
    organizationId,
    ordering: "createdAt:desc,id:desc",
    filters,
    schemaVersion: 1,
  };
}

type Keyset = {
  rows: (Record<string, unknown> & { id: string; cursor_created_at: string })[];
  next: { createdAt: string; id: string } | null;
};

async function keysetRows(
  transaction: PgTransactionClient,
  secret: string,
  options: {
    sql: (where: string, limitParam: string) => string;
    values: unknown[];
    cursor: CursorQuery;
    binding: CursorBinding;
    alias: string;
  },
): Promise<
  Keyset & { encode: (next: Keyset["next"]) => Promise<string | null> }
> {
  const position = await decodeCursor(
    secret,
    options.cursor.cursor,
    options.binding,
  );
  const limit = options.cursor.limit ?? 25;
  const values = [
    ...options.values,
    position?.createdAt ?? null,
    position?.id ?? null,
  ];
  const created = `${options.alias}.created_at`;
  const where = `($${
    values.length - 1
  }::timestamptz is null or (${created}, ${options.alias}.id) < ($${
    values.length - 1
  }, $${values.length}::uuid))`;
  values.push(limit + 1);
  const result = await transaction.query<
    Record<string, unknown> & { id: string; cursor_created_at: string }
  >(options.sql(where, `$${values.length}`), values);
  const visible = result.rows.slice(0, limit);
  const last = visible.at(-1);
  const hasMore = result.rows.length > limit && last !== undefined;
  return {
    rows: visible,
    next: hasMore ? { createdAt: last.cursor_created_at, id: last.id } : null,
    encode: async (next) =>
      next === null ? null : await encodeCursor(secret, options.binding, next),
  };
}

const CURSOR_TS =
  `to_char(%S.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const cursorTs = (alias: string) => CURSOR_TS.replace("%S", alias);

export function createCoordinationQueryHandlers(secret: string) {
  return {
    async plansGet(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const planId = context.params.id;
      if (!planId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      return await loadPlanOutput(transaction, organizationId, planId);
    },

    async plansList(
      context: ActionContext,
      input: z.output<typeof contractSchemas.CoordinationPlanListQuery>,
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const parent = input.parentTaskId ?? null;
      const page = await keysetRows(transaction, secret, {
        alias: "p",
        cursor: input,
        binding: binding(
          "coordinationPlans.list",
          organizationId,
          principalId,
          `parent:${parent ?? ""}`,
        ),
        values: [organizationId, parent],
        sql: (where, limit) =>
          `select ${PLAN_COLUMNS}, ${cursorTs("p")} as cursor_created_at
             from bakery.coordination_plans p
            where p.organization_id = $1
              and ($2::uuid is null or p.parent_task_id = $2::uuid)
              and ${where}
            order by p.created_at desc, p.id desc
            limit ${limit}`,
      });
      const rows = page.rows as unknown as PlanRow[];
      const lanes = await loadPlanLanes(
        transaction,
        organizationId,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => toPlan(row, lanes.get(row.id) ?? [])),
        nextCursor: await page.encode(page.next),
      };
    },

    async taskRepositoriesList(
      context: ActionContext,
      input: CursorQuery,
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const taskId = context.params.id;
      if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const exists = await transaction.query(
        "select 1 from bakery.tasks where organization_id = $1 and id = $2",
        [organizationId, taskId],
      );
      if (exists.rows.length !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const page = await keysetRows(transaction, secret, {
        alias: "t",
        cursor: input,
        binding: binding(
          "taskRepositories.list",
          organizationId,
          principalId,
          `task:${taskId}`,
        ),
        values: [organizationId, taskId],
        sql: (where, limit) =>
          `select t.id, t.task_id, t.repository_id, t.role, t.required,
                  t.provenance, t.created_by, t.created_at, t.updated_at,
                  t.version, ${cursorTs("t")} as cursor_created_at
             from bakery.task_repositories t
            where t.organization_id = $1 and t.task_id = $2::uuid and ${where}
            order by t.created_at desc, t.id desc
            limit ${limit}`,
      });
      return {
        items: page.rows.map((row) => toTaskRepository(row)),
        nextCursor: await page.encode(page.next),
      };
    },

    async rolesList(context: ActionContext, input: CursorQuery) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const applicationId = context.params.id;
      if (!applicationId) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const exists = await transaction.query(
        "select 1 from bakery.applications where organization_id = $1 and id = $2",
        [organizationId, applicationId],
      );
      if (exists.rows.length !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const page = await keysetRows(transaction, secret, {
        alias: "r",
        cursor: input,
        binding: binding(
          "applicationRepositoryRoles.list",
          organizationId,
          principalId,
          `application:${applicationId}`,
        ),
        values: [organizationId, applicationId],
        sql: (where, limit) =>
          `select r.id, r.application_id, r.alias, r.role, r.repository_id,
                  r.created_at, r.updated_at, r.version,
                  ${cursorTs("r")} as cursor_created_at
             from bakery.repository_role_bindings r
            where r.organization_id = $1 and r.application_id = $2::uuid
              and r.alias is not null and r.archived_at is null
              and ${where}
            order by r.created_at desc, r.id desc
            limit ${limit}`,
      });
      return {
        items: page.rows.map((row) => toRole(row)),
        nextCursor: await page.encode(page.next),
      };
    },
  };
}

type Row = Record<string, unknown>;

export function toTaskRepository(row: Row) {
  return contractSchemas.TaskRepository.parse({
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    role: row.role,
    required: row.required,
    provenance: row.provenance,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
    version: row.version,
  });
}

export function toRole(row: Row) {
  return contractSchemas.ApplicationRepositoryRole.parse({
    id: row.id,
    applicationId: row.application_id,
    alias: row.alias,
    role: row.role,
    repositoryId: row.repository_id,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
    version: row.version,
  });
}
