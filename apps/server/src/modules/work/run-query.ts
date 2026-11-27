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
import { isTaskStatus, toIso } from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import { readRunsWaitingOnModel } from "../execution/route-continuations.ts";
import { readRunReleaseStep } from "../workflow-adapter/release-step.ts";
import { readLimitStop } from "../workflow-adapter/limit-stop.ts";

const RUN_ORDERING = "createdAt:desc,id:desc";
const RUN_STEP_ORDERING = "position:asc,iteration:asc,id:asc";

const RUN_COLUMNS =
  "id, kind, task_id, workflow_version_id, skill_source_id, repository_profile_id, " +
  "repository_profile_revision, repository_profile_digest, observation_id, " +
  "observation_digest, base_sha, requested_by, " +
  "inngest_run_id, status, budget_limit_usd, environment, started_at, " +
  "finished_at, " +
  "created_at, updated_at, version, " +
  runWorkspaceBaseShaColumn("workflow_runs");

/**
 * The newest handoff manifest an attempt of the step saved, as one JSON
 * object or null. Correlated on the unaliased `run_steps` row, so it works in
 * a plain select, a `for update` select and an update's `returning`; the
 * (organization_id, run_step_id, created_at desc, id) index serves it.
 */
const RUN_STEP_HANDOFF_MANIFEST_COLUMN =
  "(select json_build_object('id', manifest.id, 'status', manifest.status, " +
  "'savedAt', manifest.created_at) " +
  "from bakery.handoff_manifests manifest " +
  "where manifest.organization_id = run_steps.organization_id " +
  "and manifest.run_step_id = run_steps.id " +
  "order by manifest.created_at desc, manifest.id desc limit 1) " +
  "as handoff_manifest";

export const RUN_STEP_COLUMNS =
  "id, run_id, step_key, position, iteration, status, input, output, error, " +
  "started_at, finished_at, created_at, updated_at, version, " +
  RUN_STEP_HANDOFF_MANIFEST_COLUMN;

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
  needs_human: true,
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
  needs_human: true,
};
const terminalRunStepStatuses: Record<RunStepOutput["status"], boolean> = {
  pending: false,
  running: false,
  waiting: false,
  canceled: true,
  completed: true,
  failed: true,
  skipped: true,
  needs_human: true,
};

function isRunStepStatus(value: string): value is RunStepOutput["status"] {
  return Object.hasOwn(runStepStatuses, value);
}

export type RunStepRow = {
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
  handoff_manifest: { id: string; status: string; savedAt: string } | null;
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

export function toRunStep(row: RunStepRow): RunStepOutput {
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
    handoffManifest: toStepHandoffManifest(row.handoff_manifest),
  };
}

const handoffManifestStatuses: Record<
  NonNullable<RunStepOutput["handoffManifest"]>["status"],
  true
> = { pending: true, continued: true, blocked: true };

function toStepHandoffManifest(
  value: RunStepRow["handoff_manifest"],
): RunStepOutput["handoffManifest"] {
  if (value === null || value === undefined) return null;
  if (!Object.hasOwn(handoffManifestStatuses, value.status)) {
    throw new Error("WORK_READ_RUN_STEP_HANDOFF_MANIFEST_INVALID");
  }
  return {
    id: value.id,
    status: value.status as NonNullable<
      RunStepOutput["handoffManifest"]
    >["status"],
    savedAt: toIso(value.savedAt),
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

/** At most this many blocking tasks are listed on a run read. */
const MAX_BLOCKING_TASKS = 25;
const DEPENDENCY_INCOMPLETE = "dependency_incomplete";

type RunBlocking = Pick<RunOutput, "blockedReason" | "blockingTasks">;

/**
 * Why a run is blocked and which tasks it waits on, read live. The reason is
 * the one admission froze in the run snapshot (`admission.reason`) and is
 * served only while the run is `blocked`. For `dependency_incomplete` the
 * blocking tasks are the run task's dependencies that are not `completed`
 * now, oldest dependency first; every predicate names the organization, so
 * another organization's task never appears.
 */
async function readRunBlocking(
  transaction: PgTransactionClient,
  organizationId: string,
  run: RunRow,
): Promise<RunBlocking> {
  if (run.status !== "blocked") {
    return { blockedReason: null, blockingTasks: [] };
  }
  const stored = await transaction.query<{ reason: string | null }>(
    `select snapshot -> 'admission' ->> 'reason' as reason
       from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, run.id],
  );
  const blockedReason = stored.rows[0]?.reason ?? null;
  if (blockedReason !== DEPENDENCY_INCOMPLETE || run.task_id === null) {
    return { blockedReason, blockingTasks: [] };
  }
  const tasks = await transaction.query<
    { id: string; title: string; status: string }
  >(
    `select task.id, task.title, task.status
       from bakery.task_dependencies as dependency
       join bakery.tasks as task
         on task.organization_id = dependency.organization_id
        and task.id = dependency.depends_on_task_id
      where dependency.organization_id = $1
        and dependency.task_id = $2
        and task.status <> 'completed'
      order by dependency.created_at asc, dependency.id asc
      limit $3`,
    [organizationId, run.task_id, MAX_BLOCKING_TASKS],
  );
  return {
    blockedReason,
    blockingTasks: tasks.rows.map((task) => {
      if (!isTaskStatus(task.status)) {
        throw new Error("WORK_READ_TASK_INVALID");
      }
      return { id: task.id, title: task.title, status: task.status };
    }),
  };
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
      const waiting = await readRunsWaitingOnModel(
        transaction,
        organizationId,
        visible.map((row) => row.id),
      );
      const items: RunOutput[] = [];
      for (const row of visible) {
        items.push({
          ...toRun(
            row,
            await readRunBudgetSummary(transaction, {
              organizationId,
              runId: row.id,
              limitUsd: String(row.budget_limit_usd),
            }),
          ),
          ...await readRunBlocking(transaction, organizationId, row),
          waitingOnModel: waiting.has(row.id),
        });
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
      return {
        ...toRun(
          run,
          await readRunBudgetSummary(transaction, {
            organizationId,
            runId: run.id,
            limitUsd: String(run.budget_limit_usd),
          }),
        ),
        ...await readRunBlocking(transaction, organizationId, run),
        waitingOnModel: (await readRunsWaitingOnModel(
          transaction,
          organizationId,
          [run.id],
        )).has(run.id),
        releaseStep: await readRunReleaseStep(transaction, {
          organizationId,
          runId: run.id,
        }),
        limitStop: run.status === "failed"
          ? await readLimitStop(transaction, organizationId, run.id) ?? null
          : null,
      };
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
