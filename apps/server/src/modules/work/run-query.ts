import { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type RunRow,
  runWorkspaceBaseShaColumn,
  toRun,
} from "./run-command.ts";
import { readRunBudgetSummary } from "./budget.ts";
import { toIso } from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

const RUN_ORDERING = "createdAt:desc,id:desc";
const RUN_STEP_ORDERING = "position:asc,iteration:asc,id:asc";

const RUN_COLUMNS =
  "id, kind, task_id, workflow_version_id, skill_source_id, repository_profile_id, " +
  "repository_profile_revision, repository_profile_digest, observation_id, " +
  "observation_digest, base_sha, requested_by, " +
  "inngest_run_id, status, budget_limit_usd, started_at, finished_at, " +
  "created_at, updated_at, version, " +
  runWorkspaceBaseShaColumn("workflow_runs");

const RUN_STEP_COLUMNS =
  "id, run_id, step_key, position, iteration, status, input, output, error, " +
  "started_at, finished_at, created_at, updated_at, version";

type CursorQuery = z.output<typeof contractSchemas.CursorQuery>;
type RunOutput = z.output<typeof contractSchemas.Run>;
type RunStepOutput = z.output<typeof contractSchemas.RunStep>;
const runStepStatuses: Record<RunStepOutput["status"], true> = {
  pending: true,
  running: true,
  waiting: true,
  completed: true,
  failed: true,
  skipped: true,
  canceled: true,
};
const terminalRunStatuses: Record<RunOutput["status"], boolean> = {
  queued: false,
  running: false,
  waiting_input: false,
  waiting_capacity: false,
  paused: false,
  canceling: false,
  canceled: true,
  completed: true,
  failed: true,
  blocked: false,
};
const terminalRunStepStatuses: Record<RunStepOutput["status"], boolean> = {
  pending: false,
  running: false,
  waiting: false,
  canceled: true,
  completed: true,
  failed: true,
  skipped: true,
};

function isRunStepStatus(value: string): value is RunStepOutput["status"] {
  return Object.hasOwn(runStepStatuses, value);
}

type RunStepRow = {
  id: string;
  run_id: string;
  step_key: string;
  position: number;
  iteration: number;
  status: string;
  input: unknown;
  output: unknown | null;
  error: unknown | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type KeysetRunRow = RunRow & { cursor_created_at: string };
type KeysetRunStepRow = RunStepRow;

function runBinding(
  organizationId: string,
  principalId: string,
  taskId: string,
): CursorBinding {
  return {
    action: "runs.list",
    principalId,
    organizationId,
    ordering: RUN_ORDERING,
    filters: JSON.stringify({ taskId }),
    schemaVersion: 1,
  };
}

function runStepBinding(
  organizationId: string,
  principalId: string,
  runId: string,
): CursorBinding {
  return {
    action: "runSteps.list",
    principalId,
    organizationId,
    ordering: RUN_STEP_ORDERING,
    filters: JSON.stringify({ runId }),
    schemaVersion: 1,
  };
}

function cloneJson(value: unknown, code: string): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("JSON_UNDEFINED");
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}

function toRunStep(row: RunStepRow): RunStepOutput {
  if (
    !Number.isInteger(row.position) ||
    !Number.isInteger(row.iteration) ||
    !Number.isInteger(row.version) ||
    !isRunStepStatus(row.status)
  ) {
    throw new Error("WORK_READ_RUN_STEP_INVALID");
  }
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    iteration: Number(row.iteration),
    status: row.status as RunStepOutput["status"],
    input: cloneJson(row.input, "WORK_READ_RUN_STEP_INPUT_INVALID"),
    output: row.output === null
      ? null
      : cloneJson(row.output, "WORK_READ_RUN_STEP_OUTPUT_INVALID"),
    error: row.error === null
      ? null
      : cloneJson(row.error, "WORK_READ_RUN_STEP_ERROR_INVALID"),
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: Number(row.version),
  };
}

async function assertTaskVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<void> {
  const result = await transaction.query<{ id: string }>(
    `select id
       from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, taskId],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

async function assertRunVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RunRow> {
  const result = await transaction.query<RunRow>(
    `select ${RUN_COLUMNS}
       from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

export function createRunQueryHandlers(secret: string) {
  return {
    async runsList(context: ActionContext, input: unknown) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const taskId = context.params.id;
      if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      await assertTaskVisible(transaction, organizationId, taskId);
      const query = input as CursorQuery;
      const binding = runBinding(organizationId, principalId, taskId);
      const position = await decodeCursor(secret, query.cursor, binding);
      const limit = query.limit ?? 25;
      const result = await transaction.query<KeysetRunRow>(
        `select ${RUN_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.workflow_runs
         where organization_id = $1
           and kind = 'workflow'
           and task_id = $2
           and ($3::timestamptz is null or (created_at, id) < ($3, $4::uuid))
         order by created_at desc, id desc
         limit $5`,
        [
          organizationId,
          taskId,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = result.rows.slice(0, limit);
      const items: RunOutput[] = [];
      for (const row of visible) {
        items.push(
          toRun(
            row,
            await readRunBudgetSummary(transaction, {
              organizationId,
              runId: row.id,
              limitUsd: String(row.budget_limit_usd),
            }),
          ),
        );
      }
      const last = visible.at(-1);
      return {
        items,
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            createdAt: last.cursor_created_at,
            id: last.id,
          })
          : null,
      };
    },

    async runsGet(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const runId = context.params.id;
      if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const run = await assertRunVisible(transaction, organizationId, runId);
      return toRun(
        run,
        await readRunBudgetSummary(transaction, {
          organizationId,
          runId: run.id,
          limitUsd: String(run.budget_limit_usd),
        }),
      );
    },

    async runStepsList(context: ActionContext, input: unknown) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const runId = context.params.id;
      if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const run = await assertRunVisible(transaction, organizationId, runId);
      if ((run.kind ?? "workflow") !== "workflow") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "run_kind_unsupported" },
        });
      }
      const query = input as CursorQuery;
      const binding = runStepBinding(organizationId, principalId, runId);
      const position = await decodeCursor(secret, query.cursor, binding);
      const limit = query.limit ?? 25;
      const result = await transaction.query<KeysetRunStepRow>(
        `select ${RUN_STEP_COLUMNS}
           from bakery.run_steps
          where organization_id = $1
            and run_id = $2
            and (
              $3::integer is null or
              (position, iteration, id) > ($3, $4, $5::uuid)
            )
          order by position asc, iteration asc, id asc
          limit $6`,
        [
          organizationId,
          runId,
          position?.position ?? null,
          position?.iteration ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = result.rows.slice(0, limit);
      const last = visible.at(-1);
      const items = visible.map(toRunStep);
      const terminalStep = items.find((step) =>
        terminalRunStepStatuses[step.status] === true
      );
      if (
        terminalRunStatuses[run.status as RunOutput["status"]] === true &&
        terminalStep
      ) {
        const auditRowCount = await appendAudit(transaction, {
          organizationId,
          principalId,
          operation: "runs.steps.list",
          resourceType: "workflow_run",
          resourceId: runId,
          requestId: context.requestId,
          traceId: context.traceId,
          outcome: "allowed",
          details: {
            observedStepId: terminalStep.id,
            observedStepStatus: terminalStep.status,
          },
        });
        if (auditRowCount !== 1) {
          throw new Error("WORK_READ_RUN_STEPS_AUDIT_INSERT_FAILED");
        }
      }
      return {
        items,
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            position: last.position,
            iteration: last.iteration,
            id: last.id,
          })
          : null,
      };
    },
  };
}
