import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { BatchImplementedAction } from "@bakery/contracts/implemented-actions";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { workflowPresetById } from "@bakery/contracts/workflow-presets";
import { appendAudit } from "@bakery/persistence";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { parseMicroUsd } from "./budget.ts";
import { authorizeTicketAdmission } from "./ticket-request-command.ts";
import { smallestBatchSpend } from "./batch-startable.ts";
import type { BudgetRuntimeConfig } from "@bakery/config";
import { requireWorkTransaction } from "./work-transaction.ts";
import { mayActOnQuestion } from "../auth/application/run-grants.ts";

/**
 * Batches (#58): a bounded run of issues in one repository.
 *
 * A batch is a supervisor's record, not an engine. It holds the three limits, the
 * carry-on choice and the state; each issue it works on is an ordinary ticket
 * request and task, and the batch only points at them. Nothing here runs work.
 * The supervisor (a separate function) reads these rows and calls the existing
 * admission and run actions.
 *
 * Every control is safe to repeat: asking for what is already so returns the batch
 * as it is, and anything the state does not allow is a named conflict.
 */

type Batch = z.output<typeof contractSchemas.Batch>;
type BatchIssue = z.output<typeof contractSchemas.BatchIssue>;
type BatchCreate = z.output<typeof contractSchemas.BatchCreate>;
type BatchStop = z.output<typeof contractSchemas.BatchStop>;

/** The columns the supervisor reads that the Batch output does not carry. */
export type BatchStateRow = { nextApproved: boolean };

export const LIVE_BATCH_STATES = [
  "running",
  "waiting",
  "paused",
  "stopping",
  "finishing",
] as const;

type Row = {
  id: string;
  repository_id: string;
  preset_id: string | null;
  started_by: string;
  max_issues: number;
  max_hours: number;
  max_spend_usd: string;
  continue_mode: string;
  state: string;
  pause_reason: string | null;
  paused_by: string | null;
  paused_at: Date | null;
  finish_reason: string | null;
  finished_at: Date | null;
  stopped_by: string | null;
  stop_cancelled_current: boolean;
  started_at: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
  elapsed_seconds: string;
};

const COLUMNS =
  `batch.id, batch.repository_id, batch.preset_id, batch.started_by, batch.max_issues,
  batch.max_hours, batch.max_spend_usd::text as max_spend_usd,
  batch.continue_mode, batch.state, batch.pause_reason, batch.paused_by,
  batch.paused_at, batch.finish_reason, batch.finished_at, batch.stopped_by,
  batch.stop_cancelled_current, batch.started_at, batch.created_at,
  batch.updated_at, batch.version,
  floor(extract(epoch from (coalesce(batch.finished_at, now()) - batch.started_at)))::text
    as elapsed_seconds`;

type IssueRow = {
  id: string;
  position: number;
  external_ticket_id: string;
  issue_number: string | null;
  issue_title: string | null;
  state: string;
  reason: string | null;
  ticket_request_id: string | null;
  cost_usd: string | null;
  spent: string | null;
  started_at: Date | null;
  merged_at: Date | null;
};

const iso = (value: Date | null) => value ? value.toISOString() : null;

/** Micro-dollars as the contract's decimal string: whole part, up to six places. */
function formatUsd(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function toIssue(row: IssueRow): BatchIssue {
  return {
    id: row.id,
    position: row.position,
    externalTicketId: row.external_ticket_id,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    state: row.state,
    reason: row.reason,
    ticketRequestId: row.ticket_request_id,
    costUsd: row.cost_usd === null
      ? null
      : formatUsd(parseMicroUsd(row.cost_usd, "cost")),
    startedAt: iso(row.started_at),
    mergedAt: iso(row.merged_at),
  } as BatchIssue;
}

/**
 * A batch with its issues and what is used of each limit. Spend is summed from the
 * issues' recorded cost and, for one still running, from its run's usage so far.
 */
export async function loadBatch(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
  options: { lock?: boolean; viewerPrincipalId?: string } = {},
): Promise<Batch> {
  const found = await transaction.query<Row>(
    `select ${COLUMNS} from bakery.batches as batch
      where batch.organization_id = $1 and batch.id = $2${
      options.lock ? " for update of batch" : ""
    }`,
    [organizationId, id],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const issues = (await transaction.query<IssueRow>(
    `select issue.id, issue.position, issue.external_ticket_id,
            ticket.number as issue_number, ticket.snapshot ->> 'title' as issue_title,
            issue.state, issue.reason, issue.ticket_request_id, issue.cost_usd::text as cost_usd,
            coalesce(issue.cost_usd, live.cost)::text as spent,
            issue.started_at, issue.merged_at
       from bakery.batch_issues as issue
       join bakery.external_tickets as ticket
         on ticket.organization_id = issue.organization_id
        and ticket.id = issue.external_ticket_id
       left join bakery.ticket_requests as request
         on request.organization_id = issue.organization_id
        and request.id = issue.ticket_request_id
       left join lateral (
         select sum(usage.cost_usd) as cost from bakery.usage_records as usage
          where usage.organization_id = issue.organization_id
            and usage.run_id = request.workflow_run_id
       ) as live on issue.cost_usd is null
      where issue.organization_id = $1 and issue.batch_id = $2
      order by issue.position`,
    [organizationId, id],
  )).rows;
  let spent = 0n;
  for (const issue of issues) {
    if (issue.spent !== null) spent += parseMicroUsd(issue.spent, "spent");
  }
  return {
    id: row.id,
    repositoryId: row.repository_id,
    presetId: row.preset_id,
    startedBy: row.started_by,
    maxIssues: row.max_issues,
    maxHours: row.max_hours,
    maxSpendUsd: formatUsd(parseMicroUsd(row.max_spend_usd, "max_spend")),
    continueMode: row.continue_mode,
    state: row.state,
    pauseReason: row.pause_reason,
    pausedBy: row.paused_by,
    pausedAt: iso(row.paused_at),
    finishReason: row.finish_reason,
    finishedAt: iso(row.finished_at),
    stoppedBy: row.stopped_by,
    stopCancelledCurrent: row.stop_cancelled_current,
    startedAt: row.started_at.toISOString(),
    issuesDone: issues.filter((issue) => issue.state === "merged").length,
    elapsedSeconds: Number(row.elapsed_seconds),
    spentUsd: formatUsd(spent),
    issues: issues.map(toIssue),
    waitingOn: options.viewerPrincipalId
      ? await readWaitingOn(
        transaction,
        organizationId,
        id,
        options.viewerPrincipalId,
      )
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as Batch;
}

type WaitingRow = {
  id: string;
  kind: string;
  task_id: string;
  created_at: Date;
  cursor_created_at: string;
  audience: { type: string; principalIds?: string[] };
};

/** How many open items are read at a time while looking for one the viewer may see. */
const WAITING_PAGE = 50;

/**
 * What the issue being worked on is waiting for a person to do: its task's oldest
 * open question or approval that the viewer may see, read now. An item private to
 * named people does not exist for anyone else, exactly as it does in
 * `questions.get` and `approvals.get`, so the oldest one the viewer may see wins,
 * however many older private ones come before it. Null when no issue is being
 * worked on, nothing is open, or the viewer may see none of it. The question's
 * text is not read here; the task page shows it.
 */
async function readWaitingOn(
  transaction: PgTransactionClient,
  organizationId: string,
  batchId: string,
  viewerPrincipalId: string,
) {
  let row: WaitingRow | undefined;
  // Keyset on (created_at, id), oldest first, until one is visible or none are left.
  let after: { createdAt: string; id: string } | null = null;
  while (row === undefined) {
    const found: { rows: WaitingRow[] } = await transaction.query<WaitingRow>(
      `select question.id, question.kind, question.task_id, question.created_at,
              to_char(question.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
              question.audience
         from bakery.batch_issues as issue
         join bakery.ticket_requests as request
           on request.organization_id = issue.organization_id
          and request.id = issue.ticket_request_id
         join bakery.workflow_runs as run
           on run.organization_id = request.organization_id
          and run.id = request.workflow_run_id
         join bakery.questions as question
           on question.organization_id = run.organization_id
          and question.task_id = run.task_id
        where issue.organization_id = $1 and issue.batch_id = $2
          and issue.state = 'started' and question.status = 'open'
          and (question.run_id is null or question.run_id = run.id)
          and ($4::timestamptz is null
               or (question.created_at, question.id) > ($4, $5::uuid))
        order by question.created_at, question.id
        limit $3`,
      [
        organizationId,
        batchId,
        WAITING_PAGE,
        after?.createdAt ?? null,
        after?.id ?? null,
      ],
    );
    for (const candidate of found.rows) {
      if (
        await mayActOnQuestion(
          transaction,
          organizationId,
          viewerPrincipalId,
          candidate,
          candidate.kind === "approval" ? "approve" : "answer",
        )
      ) {
        row = candidate;
        break;
      }
    }
    const last = found.rows.at(-1);
    if (
      row !== undefined || last === undefined ||
      found.rows.length < WAITING_PAGE
    ) {
      break;
    }
    after = { createdAt: last.cursor_created_at, id: last.id };
  }
  if (!row) return null;
  const named = row.audience.type === "principals"
    ? (row.audience.principalIds ?? []).slice(0, 3)
    : [];
  const people = named.length === 0 ? [] : (await transaction.query<
    { principal_id: string; display_name: string }
  >(
    `select principal.id as principal_id, principal.display_name
       from bakery.principals as principal
      where principal.id = any($1::uuid[])
      order by array_position($1::uuid[], principal.id)`,
    [named],
  )).rows;
  return {
    kind: row.kind,
    questionId: row.id,
    taskId: row.task_id,
    since: row.created_at.toISOString(),
    askedOf: people.map((person) => ({
      principalId: person.principal_id,
      displayName: person.display_name,
    })),
  };
}

function batchId(context: ActionContext): string {
  if (!context.params.id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return context.params.id;
}

function conflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function audit(
  context: ActionContext,
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  batch: Batch,
  operation: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    operation,
    resourceType: "batch",
    resourceId: batch.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { repositoryId: batch.repositoryId, ...details },
  });
}

/** `batches.get`. */
export async function getBatch(context: ActionContext): Promise<Batch> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  return await loadBatch(transaction, organizationId, batchId(context), {
    viewerPrincipalId: principalId,
  });
}

/** `batches.list`: newest first, optionally one repository's. */
export function createBatchesListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: z.output<typeof contractSchemas.BatchQuery>,
  ): Promise<{ items: Batch[]; nextCursor: string | null }> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: BatchImplementedAction.BatchesList,
      organizationId,
      principalId,
      ordering: "createdAt:desc,id:desc",
      filters: JSON.stringify({
        repositoryId: input.repositoryId ?? null,
        state: input.state ?? null,
      }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const rows = (await transaction.query<
      { id: string; cursor_created_at: string }
    >(
      `select batch.id,
              to_char(batch.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.batches as batch
        where batch.organization_id = $1
          and ($2::uuid is null or batch.repository_id = $2)
          and ($6::text is null or batch.state = $6)
          and ($3::timestamptz is null
               or (batch.created_at, batch.id) < ($3, $4::uuid))
        order by batch.created_at desc, batch.id desc
        limit $5`,
      [
        organizationId,
        input.repositoryId ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
        input.state ?? null,
      ],
    )).rows;
    const visible = rows.slice(0, limit);
    const items: Batch[] = [];
    for (const row of visible) {
      items.push(
        await loadBatch(transaction, organizationId, row.id, {
          viewerPrincipalId: principalId,
        }),
      );
    }
    const last = visible.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last
        ? await encodeCursor(cursorSecret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * `batches.create`. Someone who may start work (the same authority a ticket request
 * needs) starts a bounded run in a repository that is taking issues. All three limits
 * and the carry-on choice are required: the schema refuses a body without them, and
 * the amount must be above zero and at least what one issue needs to start (the preset's
 * smallest budget, read live). One live batch per repository, by the table's index.
 */
export function createBatchHandler(
  dependencies: { budget: BudgetRuntimeConfig | undefined },
) {
  return (context: ActionContext, input: BatchCreate): Promise<Batch> =>
    createBatch(context, input, dependencies.budget);
}

export async function createBatch(
  context: ActionContext,
  input: BatchCreate,
  budget?: BudgetRuntimeConfig,
): Promise<Batch> {
  authorizeTicketAdmission(context);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const spend = parseMicroUsd(input.maxSpendUsd, "max_spend");
  if (spend <= 0n) {
    throw unprocessable(["maxSpendUsd"], "max_spend_not_positive");
  }
  const repository = await transaction.query(
    `select 1 from bakery.repositories
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, input.repositoryId],
  );
  if (repository.rows.length === 0) {
    throw unprocessable(["repositoryId"], "repository_not_found");
  }
  const taking = await transaction.query(
    `select 1 from bakery.ticket_sources
      where organization_id = $1 and repository_id = $2 and enabled`,
    [organizationId, input.repositoryId],
  );
  if (taking.rows.length === 0) {
    throw conflict("repository_not_taking_issues");
  }
  // Below the smallest spend that can start one issue, the batch could never start
  // anything. When the repository cannot run work now there is no smallest amount to
  // judge by, and the supervisor says why when it tries to start.
  const preset = workflowPresetById(input.presetId);
  if (preset === undefined) {
    throw unprocessable(["presetId"], "workflow_unknown");
  }
  const smallest = await smallestBatchSpend(
    transaction,
    organizationId,
    input.repositoryId,
    budget,
    preset,
  );
  if (smallest !== null && spend < parseMicroUsd(smallest, "smallest_spend")) {
    throw unprocessable(["maxSpendUsd"], "max_spend_below_smallest");
  }
  let id: string;
  try {
    id = (await transaction.query<{ id: string }>(
      `insert into bakery.batches (
         organization_id, repository_id, preset_id, started_by, max_issues,
         max_hours, max_spend_usd, continue_mode
       ) values ($1, $2, $3, $4, $5, $6, $7::numeric, $8)
       returning id`,
      [
        organizationId,
        input.repositoryId,
        input.presetId,
        principalId,
        input.maxIssues,
        input.maxHours,
        formatUsd(spend),
        input.continueMode,
      ],
    )).rows[0]!.id;
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      throw conflict("batch_already_running");
    }
    throw error;
  }
  const created = await loadBatch(transaction, organizationId, id, {
    viewerPrincipalId: principalId,
  });
  await audit(
    context,
    transaction,
    { organizationId, principalId },
    created,
    "batches.create",
    {
      presetId: created.presetId,
      maxIssues: created.maxIssues,
      maxHours: created.maxHours,
      maxSpendUsd: created.maxSpendUsd,
      continueMode: created.continueMode,
    },
  );
  return created;
}

type Control = {
  /** The state asked for; already there is a repeat and returns the batch as is. */
  to: "paused" | "running" | "finished";
  from: readonly string[];
  operation: string;
  /** Why a state outside `from` (and not already `to`) is refused. */
  refusal: string;
};

async function control(
  context: ActionContext,
  spec: Control,
  apply: (
    transaction: PgTransactionClient,
    batch: Batch,
    principalId: string,
  ) => Promise<void>,
): Promise<Batch> {
  authorizeTicketAdmission(context);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const current = await loadBatch(
    transaction,
    organizationId,
    batchId(context),
    { lock: true, viewerPrincipalId: principalId },
  );
  if (current.state === spec.to) return current;
  if (!spec.from.includes(current.state)) throw conflict(spec.refusal);
  await apply(transaction, current, principalId);
  const changed = await loadBatch(transaction, organizationId, current.id, {
    viewerPrincipalId: principalId,
  });
  await audit(
    context,
    transaction,
    { organizationId, principalId },
    changed,
    spec.operation,
    {
      from: current.state,
      to: changed.state,
    },
  );
  return changed;
}

const touch = "updated_at = now(), version = version + 1";

/** `batches.pause`: nothing new starts; the current issue runs to its end. */
export function pauseBatch(context: ActionContext): Promise<Batch> {
  return control(
    context,
    {
      to: "paused",
      from: ["running", "waiting"],
      operation: "batches.pause",
      refusal: "batch_cannot_pause",
    },
    async (transaction, batch, principalId) => {
      await transaction.query(
        `update bakery.batches
            set state = 'paused', pause_reason = 'paused_by_person',
                paused_by = $2, paused_at = now(), ${touch}
          where id = $1`,
        [batch.id, principalId],
      );
    },
  );
}

/** `batches.resume`: a paused batch goes on; the supervisor checks the issue again first. */
export function resumeBatch(context: ActionContext): Promise<Batch> {
  return control(
    context,
    {
      to: "running",
      from: ["paused"],
      operation: "batches.resume",
      refusal: "batch_not_paused",
    },
    async (transaction, batch) => {
      await transaction.query(
        `update bakery.batches
            set state = 'running', pause_reason = null, paused_by = null,
                paused_at = null, ${touch}
          where id = $1`,
        [batch.id],
      );
    },
  );
}

/** `batches.startNext`: the person says yes to the next issue after Ask me first. */
export function startNextInBatch(context: ActionContext): Promise<Batch> {
  return control(
    context,
    {
      to: "running",
      from: ["waiting"],
      operation: "batches.startNext",
      refusal: "batch_not_waiting",
    },
    async (transaction, batch) => {
      await transaction.query(
        `update bakery.batches set state = 'running', next_approved = true, ${touch}
          where id = $1`,
        [batch.id],
      );
    },
  );
}

/** `batches.finish`: "Finish here" after Ask me first. */
export function finishBatch(context: ActionContext): Promise<Batch> {
  return control(
    context,
    {
      to: "finished",
      from: ["waiting"],
      operation: "batches.finish",
      refusal: "batch_not_waiting",
    },
    async (transaction, batch) => {
      await transaction.query(
        `update bakery.batches
            set state = 'finished', finish_reason = 'finished_by_person',
                finished_at = now(), ${touch}
          where id = $1`,
        [batch.id],
      );
    },
  );
}

/**
 * `batches.stop`. Nothing new starts either way, and the batch is Stopping until the
 * issue being worked on has ended. Letting it finish just waits; asking to cancel it
 * records the request, and the supervisor cancels the run and the batch is Stopped
 * once the issue has actually ended. With nothing running it simply stops. Stopping
 * can be escalated to a cancel, and repeating a stop changes nothing.
 */
export async function stopBatch(
  context: ActionContext,
  input: BatchStop,
): Promise<Batch> {
  authorizeTicketAdmission(context);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const current = await loadBatch(
    transaction,
    organizationId,
    batchId(context),
    { lock: true, viewerPrincipalId: principalId },
  );
  if (current.state === "stopped") return current;
  if (!(LIVE_BATCH_STATES as readonly string[]).includes(current.state)) {
    throw conflict("batch_ended");
  }
  const running = current.issues.some((issue) => issue.state === "started");
  const cancels = input.cancelCurrent && running;
  if (
    current.state === "stopping" && !(cancels && !current.stopCancelledCurrent)
  ) return current;
  await transaction.query(
    running
      ? `update bakery.batches
            set state = 'stopping', stopped_by = $2, stop_cancelled_current = $3,
                ${touch}
          where id = $1`
      : `update bakery.batches
            set state = 'stopped', stopped_by = $2, stop_cancelled_current = false,
                finish_reason = 'stopped_by_person', finished_at = now(), ${touch}
          where id = $1`,
    running ? [current.id, principalId, cancels] : [current.id, principalId],
  );
  const changed = await loadBatch(transaction, organizationId, current.id, {
    viewerPrincipalId: principalId,
  });
  await audit(
    context,
    transaction,
    { organizationId, principalId },
    changed,
    "batches.stop",
    {
      from: current.state,
      to: changed.state,
      cancelCurrent: input.cancelCurrent,
    },
  );
  return changed;
}
