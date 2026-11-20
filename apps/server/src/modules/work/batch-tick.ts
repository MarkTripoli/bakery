import type { Inngest } from "inngest";
import { appendAudit } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { authorize } from "../auth/application/authorize.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { parseMicroUsd } from "./budget.ts";
import {
  type BatchStateRow,
  LIVE_BATCH_STATES,
  loadBatch,
} from "./batch-commands.ts";
import {
  decideBatchStep,
  type Decision,
  type StepBatch,
  type StepWorld,
} from "./batch-supervisor.ts";

/**
 * The batch supervisor's tick (#58): reads each live batch, asks the pure decision
 * function what to do, and does it. A supervisor, not an engine: it holds no plan or
 * step state and runs no work. It reads what became of an issue's ordinary request,
 * and where it must act (start the next issue, cancel a run) it goes through a port
 * that calls the existing admission and run actions.
 *
 * Both ports are optional. A batch that needs to start an issue when no start port is
 * wired pauses with a named reason, so nothing pretends to work; a cancel with no
 * port leaves the batch Stopping, which is true.
 */

export type StartResult =
  | Readonly<{
    started: true;
    externalTicketId: string;
    ticketRequestId: string;
    /** Issues considered and passed over on the way, with the existing reason codes. */
    passedOver?: readonly { externalTicketId: string; reason: string }[];
  }>
  | Readonly<{
    started: false;
    passedOver?: readonly { externalTicketId: string; reason: string }[];
  }>;

export type BatchPorts = {
  /** Starts the next eligible issue through the existing admission, as the starter. */
  startNext?: (
    transaction: PgTransactionClient,
    input: {
      organizationId: string;
      batchId: string;
      repositoryId: string;
      startedBy: string;
    },
  ) => Promise<StartResult>;
  /** Cancels the run of an issue's request through the existing run control. Idempotent. */
  cancelRun?: (
    transaction: PgTransactionClient,
    input: {
      organizationId: string;
      ticketRequestId: string;
      startedBy: string;
    },
  ) => Promise<void>;
};

export type IssueOutcome = "running" | "merged" | "failed" | "cancelled";

/**
 * What became of an issue's request. Every way a run can end is an end, so a batch never
 * waits on something that will not change:
 *
 * - merged: its run's merge entry is.
 * - failed: the run failed, or is blocked (a blocked run waits for a person, which a batch
 *   cannot), or it completed and will not merge: no merge is in flight and no pull request is
 *   still open, as when the pull request was closed unmerged or never opened.
 * - cancelled: the run was cancelled.
 * - running: anything still moving or waiting on its merge, including a request that has not
 *   started a run yet.
 */
export async function readIssueOutcome(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketRequestId: string,
): Promise<IssueOutcome> {
  const result = await transaction.query<
    {
      status: string | null;
      merged: boolean;
      merging: boolean;
      pr_open: boolean;
    }
  >(
    `select run.status as status,
            exists (
              select 1 from bakery.merge_entries as entry
               where entry.organization_id = request.organization_id
                 and entry.run_id = request.workflow_run_id
                 and entry.status = 'merged'
            ) as merged,
            exists (
              select 1 from bakery.merge_entries as entry
               where entry.organization_id = request.organization_id
                 and entry.run_id = request.workflow_run_id
                 and entry.status in ('queued', 'validating', 'merging')
            ) as merging,
            exists (
              select 1 from bakery.ticket_task_links as link
                join bakery.pull_requests as pr
                  on pr.organization_id = link.organization_id
                 and pr.task_id = link.task_id
               where link.organization_id = request.organization_id
                 and link.id = request.ticket_task_link_id
                 and pr.status = 'open'
            ) as pr_open
       from bakery.ticket_requests as request
       left join bakery.workflow_runs as run
         on run.organization_id = request.organization_id
        and run.id = request.workflow_run_id
      where request.organization_id = $1 and request.id = $2`,
    [organizationId, ticketRequestId],
  );
  const row = result.rows[0];
  if (!row) return "failed";
  if (row.merged) return "merged";
  if (row.status === "failed" || row.status === "blocked") return "failed";
  if (row.status === "canceled") return "cancelled";
  if (row.status === "completed" && !row.merging && !row.pr_open) {
    return "failed";
  }
  return "running";
}

/** Whether the starter may still start work: a member who holds task and run write. */
async function authorityHeld(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      principalId as never,
      organizationId as never,
    );
    authorize(actor, "task:write");
    authorize(actor, "run:write");
    return true;
  } catch {
    // A removed member, a suspended one or a lost role all read the same: not held.
    return false;
  }
}

async function record(
  transaction: PgTransactionClient,
  organizationId: string,
  batchId: string,
  repositoryId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "batches.supervise",
    resourceType: "batch",
    resourceId: batchId,
    requestId: `batch-supervisor:${batchId}`,
    traceId: `batch-supervisor:${batchId}`,
    details: { repositoryId, ...details },
  });
}

const touch = "updated_at = now(), version = version + 1";

async function apply(
  transaction: PgTransactionClient,
  ports: BatchPorts,
  batch: Awaited<ReturnType<typeof loadBatch>> & { organizationId: string },
  decision: Decision,
): Promise<void> {
  const { organizationId, id } = batch;
  switch (decision.kind) {
    case "none":
      return;
    case "record_end": {
      await transaction.query(
        `update bakery.batch_issues as issue
            set state = $3,
                cost_usd = (
                  select coalesce(sum(usage.cost_usd), 0)
                    from bakery.ticket_requests as request
                    join bakery.usage_records as usage
                      on usage.organization_id = request.organization_id
                     and usage.run_id = request.workflow_run_id
                   where request.organization_id = issue.organization_id
                     and request.id = issue.ticket_request_id
                ),
                merged_at = case when $3 = 'merged' then now() else merged_at end,
                ${touch}
          where issue.organization_id = $1 and issue.id = $2`,
        [organizationId, decision.issueId, decision.outcome],
      );
      break;
    }
    case "finishing":
      await transaction.query(
        `update bakery.batches set state = 'finishing', finish_reason = $2, ${touch}
          where id = $1`,
        [id, decision.reason],
      );
      break;
    case "finish":
      await transaction.query(
        `update bakery.batches
            set state = 'finished', finish_reason = $2, finished_at = now(),
                next_approved = false, ${touch}
          where id = $1`,
        [id, decision.reason],
      );
      break;
    case "stop":
      await transaction.query(
        `update bakery.batches
            set state = 'stopped', finish_reason = 'stopped_by_person',
                finished_at = now(), ${touch}
          where id = $1`,
        [id],
      );
      break;
    case "wait":
      await transaction.query(
        `update bakery.batches set state = 'waiting', ${touch} where id = $1`,
        [id],
      );
      break;
    case "cancel_current": {
      const issue = batch.issues.find((entry) => entry.id === decision.issueId);
      if (!ports.cancelRun || !issue?.ticketRequestId) return;
      await ports.cancelRun(transaction, {
        organizationId,
        ticketRequestId: issue.ticketRequestId,
        startedBy: batch.startedBy,
      });
      // The run control audits the cancel itself, and this repeats each tick until the
      // run ends, so the supervisor adds no row of its own here.
      return;
    }
    case "start_next": {
      if (!ports.startNext) {
        // No way to start an issue from here: say so, rather than finish or hang.
        await transaction.query(
          `update bakery.batches
              set state = 'paused', pause_reason = 'starting_not_available',
                  paused_at = now(), ${touch}
            where id = $1`,
          [id],
        );
        break;
      }
      const result = await ports.startNext(transaction, {
        organizationId,
        batchId: id,
        repositoryId: batch.repositoryId,
        startedBy: batch.startedBy,
      });
      let position = batch.issues.reduce(
        (max, issue) => Math.max(max, issue.position),
        0,
      );
      for (const passed of result.passedOver ?? []) {
        position += 1;
        // An issue passed over earlier is looked at again every time: its row is
        // updated with the latest reason instead of added twice.
        await transaction.query(
          `insert into bakery.batch_issues
             (organization_id, batch_id, position, external_ticket_id, state, reason)
           values ($1, $2, $3, $4, 'passed_over', $5)
           on conflict (batch_id, external_ticket_id) do update
             set reason = excluded.reason, updated_at = now(),
                 version = bakery.batch_issues.version + 1
             where bakery.batch_issues.state = 'passed_over'`,
          [
            organizationId,
            id,
            position,
            passed.externalTicketId,
            passed.reason,
          ],
        );
      }
      if (result.started) {
        // An issue passed over earlier and ready now becomes the started one, keeping
        // its place in the list.
        await transaction.query(
          `insert into bakery.batch_issues
             (organization_id, batch_id, position, external_ticket_id, state,
              ticket_request_id, started_at)
           values ($1, $2, $3, $4, 'started', $5, now())
           on conflict (batch_id, external_ticket_id) do update
             set state = 'started', reason = null,
                 ticket_request_id = excluded.ticket_request_id,
                 started_at = now(), updated_at = now(),
                 version = bakery.batch_issues.version + 1
             where bakery.batch_issues.state = 'passed_over'`,
          [
            organizationId,
            id,
            position + 1,
            result.externalTicketId,
            result.ticketRequestId,
          ],
        );
        await transaction.query(
          `update bakery.batches set next_approved = false, ${touch} where id = $1`,
          [id],
        );
      } else {
        await transaction.query(
          `update bakery.batches
              set state = 'finished', finish_reason = 'nothing_eligible',
                  finished_at = now(), ${touch}
            where id = $1`,
          [id],
        );
      }
      break;
    }
  }
  await record(transaction, organizationId, id, batch.repositoryId, {
    decision: decision.kind,
    ...("reason" in decision ? { reason: decision.reason } : {}),
    ...("outcome" in decision ? { outcome: decision.outcome } : {}),
  });
}

/** One batch, one transaction: lock it, decide, apply. Skips a batch another tick holds. */
async function superviseOne(
  database: PgDatabase,
  ports: BatchPorts,
  organizationId: string,
  batchId: string,
  now: Date,
): Promise<Decision> {
  return await withPgTransaction(database, async (transaction) => {
    const locked = await transaction.query<BatchStateRow>(
      `select next_approved as "nextApproved" from bakery.batches
        where organization_id = $1 and id = $2
          and state = any($3::text[])
          for update skip locked`,
      [organizationId, batchId, [...LIVE_BATCH_STATES]],
    );
    if (!locked.rows[0]) return { kind: "none" } as Decision;
    const batch = await loadBatch(transaction, organizationId, batchId);
    const started = batch.issues.find((issue) => issue.state === "started");
    const current = started?.ticketRequestId
      ? {
        issueId: started.id,
        outcome: await readIssueOutcome(
          transaction,
          organizationId,
          started.ticketRequestId,
        ),
      }
      : null;
    const step: StepBatch = {
      state: batch.state as StepBatch["state"],
      continueMode: batch.continueMode as StepBatch["continueMode"],
      maxIssues: batch.maxIssues,
      maxHours: batch.maxHours,
      maxSpendMicroUsd: parseMicroUsd(batch.maxSpendUsd, "max_spend"),
      startedAt: new Date(batch.startedAt),
      stopCancelledCurrent: batch.stopCancelledCurrent,
      nextApproved: locked.rows[0].nextApproved,
      finishReason: batch.finishReason,
      issues: batch.issues.map((issue) => ({
        id: issue.id,
        state: issue.state as StepBatch["issues"][number]["state"],
      })),
    };
    const world: StepWorld = {
      now,
      spentMicroUsd: parseMicroUsd(batch.spentUsd, "spent"),
      authorityOk: await authorityHeld(
        transaction,
        organizationId,
        batch.startedBy,
      ),
      current,
    };
    const decision = decideBatchStep(step, world);
    await apply(transaction, ports, { ...batch, organizationId }, decision);
    return decision;
  });
}

/**
 * One sweep over the live batches. A failure in one batch is counted and does not stop
 * the others; the next tick tries it again.
 */
export type BatchTickFailure = {
  organizationId: string;
  batchId: string;
  error: unknown;
};

/** One structured line, like the other work logs: names the batch and the error, never its message. */
function logTickFailure(failure: BatchTickFailure): void {
  console.error(JSON.stringify({
    component: "work",
    event: "batch_tick_failed",
    organizationId: failure.organizationId,
    batchId: failure.batchId,
    errorName: failure.error instanceof Error
      ? failure.error.name
      : typeof failure.error,
    ...(failure.error instanceof StandardError
      ? { code: failure.error.code }
      : {}),
  }));
}

export async function superviseBatches(
  database: PgDatabase,
  ports: BatchPorts = {},
  now: Date = new Date(),
  onFailure: (failure: BatchTickFailure) => void = logTickFailure,
): Promise<{ looked: number; acted: number; failed: number }> {
  const live = await database.query<{ id: string; organization_id: string }>(
    `select id, organization_id from bakery.batches
      where state = any($1::text[]) order by updated_at asc limit 50`,
    [[...LIVE_BATCH_STATES]],
  );
  let acted = 0;
  let failed = 0;
  for (const row of live.rows) {
    try {
      const decision = await superviseOne(
        database,
        ports,
        row.organization_id,
        row.id,
        now,
      );
      if (decision.kind !== "none") acted += 1;
    } catch (error) {
      failed += 1;
      // A batch that cannot move, behind a provider that is down for one, would otherwise show
      // nothing at all: say so, and try again next tick.
      onFailure({
        organizationId: row.organization_id,
        batchId: row.id,
        error,
      });
    }
  }
  return { looked: live.rows.length, acted, failed };
}

export const BATCH_SUPERVISOR_FUNCTION_ID = "batch-supervisor";
/** Every minute: the time limit is a watchdog, so a quiet batch still stops on time. */
export const BATCH_SUPERVISOR_CRON = "* * * * *";

/** The supervisor as one Inngest function: one run at a time, one sweep per tick. */
export function createBatchSupervisorWorkflow(options: {
  client: Inngest;
  database: PgDatabase;
  ports?: BatchPorts;
}) {
  return options.client.createFunction(
    {
      id: BATCH_SUPERVISOR_FUNCTION_ID,
      retries: 1,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: BATCH_SUPERVISOR_CRON }],
    },
    async ({ step }) =>
      await step.run(
        "supervise",
        () => superviseBatches(options.database, options.ports ?? {}),
      ),
  );
}
