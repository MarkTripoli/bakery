/**
 * Issue 58 integration lane: a batch and its supervisor on real Postgres.
 *
 * Transactions run as the application role. Requests and runs are real: each
 * issue is admitted through the ticket fixture, so the supervisor reads the same
 * request, run, merge-entry and usage rows it reads in production. Only the two
 * ports are faked (start and cancel) so each case can say exactly what the
 * supervisor asked for and as whom.
 *
 * Two kinds of row are too heavy to seed honestly (a merge entry needs a pull
 * request and a review cycle, a usage record needs an attempt and a worker). They
 * are inserted by `insertWithoutForeignKeys` as the owner with foreign keys off,
 * and only the columns the supervisor reads are meaningful. That shortcut is test
 * only and is named so a reader sees it.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PgDatabase } from "../../packages/persistence/src/postgres.ts";
import {
  createBatchesListHandler,
  createBatchHandler,
  getBatch,
  loadBatch,
} from "../../apps/server/src/modules/work/batch-commands.ts";
import {
  createBatchStartableHandler,
  smallestBatchSpend,
} from "../../apps/server/src/modules/work/batch-startable.ts";
import { presetBudgetPolicy } from "../helpers/fixed-coding-preset.ts";
import { createBatchStartPort } from "../../apps/server/src/modules/work/batch-start-port.ts";
import {
  type BatchPorts,
  readIssueOutcome,
  superviseBatches,
} from "../../apps/server/src/modules/work/batch-tick.ts";
import { admitTicket } from "../../apps/server/src/modules/work/ticket-admission.ts";
import {
  ACCEPTANCE_BODY,
  AFTER_SINCE,
  automaticPolicy,
  EXECUTE_LABEL,
  HOLD_LABEL,
  recordOpenIssues,
  seedLabeler,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";

/**
 * A ticket fixture whose batch rows are removed before it closes. Batch issues point
 * at ticket requests and tickets, which the fixture's own teardown deletes children
 * first, and it does not know this table; the delete also runs when the body fails, so
 * a teardown error never hides the body's.
 */
function withBatches<T>(
  work: (fixture: TicketFixture) => Promise<T>,
): Promise<T> {
  return withTicketFixture(async (fx) => {
    try {
      return await work(fx);
    } finally {
      await fx.owner.query(
        `delete from bakery.batch_issues where organization_id = $1`,
        [fx.organizationId],
      );
      await fx.owner.query(
        `delete from bakery.batches where organization_id = $1`,
        [fx.organizationId],
      );
    }
  });
}

type BatchInit = {
  presetId?: string;
  startedBy?: string;
  maxIssues?: number;
  maxHours?: number;
  maxSpendUsd?: string;
  continueMode?: "carry_on" | "ask_first";
  state?: string;
};

async function insertBatch(
  fx: TicketFixture,
  init: BatchInit = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fx.runtime.query(
    `insert into bakery.batches (
       id, organization_id, repository_id, preset_id, started_by, max_issues,
       max_hours, max_spend_usd, continue_mode, state
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      fx.organizationId,
      fx.repositoryId,
      init.presetId ?? "fixed-coding",
      init.startedBy ?? fx.adminId,
      init.maxIssues ?? 2,
      init.maxHours ?? 8,
      init.maxSpendUsd ?? "50",
      init.continueMode ?? "carry_on",
      init.state ?? "running",
    ],
  );
  return id;
}

async function batchRow(fx: TicketFixture, batchId: string) {
  const result = await fx.owner.query<{
    state: string;
    finish_reason: string | null;
    pause_reason: string | null;
    next_approved: boolean;
    stop_cancelled_current: boolean;
    finished_at: Date | null;
  }>(
    `select state, finish_reason, pause_reason, next_approved,
            stop_cancelled_current, finished_at
       from bakery.batches where id = $1`,
    [batchId],
  );
  return result.rows[0];
}

async function issueRows(fx: TicketFixture, batchId: string) {
  const result = await fx.owner.query<{
    state: string;
    position: number;
    ticket_request_id: string | null;
    cost_usd: string | null;
    merged_at: Date | null;
  }>(
    `select state, position, ticket_request_id, cost_usd, merged_at
       from bakery.batch_issues where batch_id = $1 order by position`,
    [batchId],
  );
  return result.rows;
}

/** A start port that admits the next numbered issue through the real admission. */
function admittingPorts(fx: TicketFixture, sourceId: string) {
  const calls = {
    start: [] as {
      startedBy: string;
      batchId: string;
      presetId: string | null;
    }[],
    cancel: [] as { startedBy: string; ticketRequestId: string }[],
  };
  let next = 1;
  const deps = fx.automationDeps();
  const ports: BatchPorts = {
    startNext: async (_transaction, input) => {
      calls.start.push({
        startedBy: input.startedBy,
        batchId: input.batchId,
        presetId: input.presetId,
      });
      const number = next++;
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: AFTER_SINCE,
      });
      const result = await fx.admit(sourceId, {
        number,
        origin: "manual",
        intent: "start",
        deps,
      });
      assert(result.request, "the admission produced a request");
      // An issue the batch is waiting on has a run in flight. Say so, whatever status the
      // admission left the run in, because a blocked run counts as over.
      await setRunStatus(fx, await runOf(fx, result.request.id), "queued");
      return {
        started: true,
        externalTicketId: result.request.externalTicketId,
        ticketRequestId: result.request.id,
      };
    },
    cancelRun: (_transaction, input) => {
      calls.cancel.push({
        startedBy: input.startedBy,
        ticketRequestId: input.ticketRequestId,
      });
      return Promise.resolve();
    },
  };
  return { ports, calls };
}

async function runOf(fx: TicketFixture, ticketRequestId: string) {
  const result = await fx.owner.query<{ workflow_run_id: string | null }>(
    `select workflow_run_id from bakery.ticket_requests
      where organization_id = $1 and id = $2`,
    [fx.organizationId, ticketRequestId],
  );
  const runId = result.rows[0]?.workflow_run_id;
  assert(runId, "the admitted request has a run the supervisor can read");
  return runId;
}

/**
 * TEST ONLY. Inserts one row as the owner with foreign keys off, giving every
 * required column a dummy of its type unless the caller names it. Used for the
 * rows the supervisor only reads a few columns of.
 */
async function insertWithoutForeignKeys(
  database: PgDatabase,
  table: string,
  values: Record<string, unknown>,
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const columns = await client.query<
      { column_name: string; data_type: string }
    >(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'bakery' and table_name = $1
          and is_nullable = 'NO' and column_default is null
          and is_generated = 'NEVER'`,
      [table],
    );
    const names: string[] = [];
    const params: unknown[] = [];
    for (const column of columns.rows) {
      names.push(column.column_name);
      if (column.column_name in values) {
        params.push(values[column.column_name]);
        continue;
      }
      params.push(dummyOf(column.data_type));
    }
    for (const [name, value] of Object.entries(values)) {
      if (names.includes(name)) continue;
      names.push(name);
      params.push(value);
    }
    await client.query(
      `insert into bakery.${table} (${names.join(", ")}) values (${
        names.map((_, index) => `$${index + 1}`).join(", ")
      })`,
      params,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dummyOf(dataType: string): unknown {
  switch (dataType) {
    case "uuid":
      return crypto.randomUUID();
    case "integer":
    case "bigint":
    case "numeric":
    case "smallint":
      return 0;
    case "boolean":
      return false;
    case "jsonb":
    case "json":
      return "{}";
    case "ARRAY":
      return "{}";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return new Date();
    default:
      return "x";
  }
}

async function mergeIssue(fx: TicketFixture, runId: string): Promise<void> {
  await insertWithoutForeignKeys(fx.owner, "merge_entries", {
    organization_id: fx.organizationId,
    run_id: runId,
    status: "merged",
  });
}

async function setRunStatus(
  fx: TicketFixture,
  runId: string,
  status: string,
): Promise<void> {
  await fx.owner.query(
    `update bakery.workflow_runs set status = $3
      where organization_id = $1 and id = $2`,
    [fx.organizationId, runId, status],
  );
}

Deno.test("batches: the structure keeps one live batch per repository and fixes identity", () =>
  withBatches(async (fx) => {
    const first = await insertBatch(fx);

    await assertRejects(
      () => insertBatch(fx),
      Error,
      "batches_one_live_per_repository",
    );

    // Identity is fixed by grant: the repository, the starter and the three limits
    // cannot be changed by the application role, only the state and its reasons.
    for (
      const column of [
        "repository_id",
        "started_by",
        "max_issues",
        "max_hours",
        "max_spend_usd",
        "continue_mode",
      ]
    ) {
      await assertRejects(
        () =>
          fx.runtime.query(
            `update bakery.batches set ${column} = ${column} where id = $1`,
            [first],
          ),
        Error,
        "permission denied",
      );
    }
    await fx.runtime.query(
      `update bakery.batches set state = 'finished', finished_at = now()
        where id = $1`,
      [first],
    );

    // Once it has ended the repository is free for a new batch.
    const second = await insertBatch(fx);
    assertEquals((await batchRow(fx, second)).state, "running");
  }));

Deno.test("batches: a tick starts one issue as the starter, waits while it runs, and records how it ended", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 2 });
    const { ports, calls } = admittingPorts(fx, sourceId);

    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
    assertEquals(calls.start[0].startedBy, fx.adminId);
    assertEquals(calls.start[0].presetId, "fixed-coding");
    let issues = await issueRows(fx, batchId);
    assertEquals(issues.map((issue) => issue.state), ["started"]);
    const firstRequest = issues[0].ticket_request_id!;

    // While the issue runs nothing else starts.
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
    assertEquals((await batchRow(fx, batchId)).state, "running");

    // Its merge is recorded with a cost, and only then does the next one start.
    await mergeIssue(fx, await runOf(fx, firstRequest));
    await superviseBatches(fx.runtime, ports);
    issues = await issueRows(fx, batchId);
    assertEquals(issues[0].state, "merged");
    assert(issues[0].merged_at !== null, "a merged issue records when");
    assertEquals(Number(issues[0].cost_usd), 0);

    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 2);
    issues = await issueRows(fx, batchId);
    assertEquals(issues.map((issue) => issue.state), ["merged", "started"]);

    // The second merge reaches the issue limit: the batch ends and says why.
    await mergeIssue(fx, await runOf(fx, issues[1].ticket_request_id!));
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    const ended = await batchRow(fx, batchId);
    assertEquals(ended.state, "finished");
    assertEquals(ended.finish_reason, "issues_reached");
    assert(ended.finished_at !== null, "a finished batch records when");
    assertEquals(calls.start.length, 2, "nothing starts after the limit");
  }));

Deno.test("batches: a workflow that cannot start pauses the batch with its own reason and nothing is asked after it", () =>
  withBatches(async (fx) => {
    await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 3 });
    let asked = 0;
    const ports: BatchPorts = {
      startNext: () => {
        asked++;
        return Promise.resolve({
          started: false,
          pause: "workflow_cannot_start",
        });
      },
      cancelRun: () => Promise.resolve(),
    };

    await superviseBatches(fx.runtime, ports);
    const paused = await batchRow(fx, batchId);
    assertEquals(paused.state, "paused");
    assertEquals(paused.pause_reason, "workflow_cannot_start");

    await superviseBatches(fx.runtime, ports);
    assertEquals(asked, 1, "a paused batch asks nothing more");
  }));

Deno.test("batches: a failed or cancelled issue ends the batch with that reason and starts nothing more", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);

    for (
      const [status, reason] of [
        ["failed", "issue_failed"],
        ["canceled", "issue_cancelled"],
      ] as const
    ) {
      const batchId = await insertBatch(fx, { maxIssues: 5 });
      const { ports, calls } = admittingPorts(fx, sourceId);
      await superviseBatches(fx.runtime, ports);
      const [issue] = await issueRows(fx, batchId);
      await setRunStatus(fx, await runOf(fx, issue.ticket_request_id!), status);

      await superviseBatches(fx.runtime, ports);
      await superviseBatches(fx.runtime, ports);
      const ended = await batchRow(fx, batchId);
      assertEquals(ended.state, "finished", status);
      assertEquals(ended.finish_reason, reason, status);
      assertEquals(calls.start.length, 1, `${status}: nothing more starts`);
      assertEquals(
        (await issueRows(fx, batchId))[0].state,
        status === "failed" ? "failed" : "cancelled",
      );
    }
  }));

Deno.test("batches: ask first starts the first issue, then waits for a person's yes after each merge, and the yes is used once", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, {
      continueMode: "ask_first",
      maxIssues: 3,
    });
    const { ports, calls } = admittingPorts(fx, sourceId);

    // Starting the batch is the first yes: the first issue starts by itself.
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
    const [first] = await issueRows(fx, batchId);
    await mergeIssue(fx, await runOf(fx, first.ticket_request_id!));

    // After it merges the batch asks: nothing starts until a person says yes.
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1, "no second issue starts without a yes");
    assertEquals((await batchRow(fx, batchId)).state, "waiting");

    // The person's "start next" (`batches.startNext`) moves a waiting batch back to
    // running with the yes, in one write; the supervisor does nothing for a waiting one.
    await fx.runtime.query(
      `update bakery.batches
          set state = 'running', next_approved = true,
              updated_at = now(), version = version + 1
        where id = $1 and state = 'waiting'`,
      [batchId],
    );
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 2);
    assertEquals(
      (await batchRow(fx, batchId)).next_approved,
      false,
      "the yes is consumed by the start",
    );

    // The next one asks again once this one has merged.
    const second = (await issueRows(fx, batchId))[1];
    await mergeIssue(fx, await runOf(fx, second.ticket_request_id!));
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 2, "a third issue is not started unasked");
    assertEquals((await batchRow(fx, batchId)).state, "waiting");
  }));

Deno.test("batches: a starter who lost authority ends the batch and starts nothing", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { startedBy: fx.developerId! });
    await fx.owner.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId],
    );
    const { ports, calls } = admittingPorts(fx, sourceId);

    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 0);
    const ended = await batchRow(fx, batchId);
    assertEquals(ended.state, "finished");
    assertEquals(ended.finish_reason, "authority_lost");
  }));

Deno.test("batches: a stop that cancels stays Stopping until the issue has ended", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 5 });
    const { ports, calls } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    const [issue] = await issueRows(fx, batchId);
    const requestId = issue.ticket_request_id!;

    await fx.runtime.query(
      `update bakery.batches
          set state = 'stopping', stop_cancelled_current = true,
              stopped_by = $2
        where id = $1`,
      [batchId, fx.adminId],
    );

    // The supervisor asks run control to cancel, and the batch is not "stopped"
    // while the run is still going: that would claim an end that has not happened.
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.cancel.length >= 1, true, "the cancel was asked for");
    assertEquals(calls.cancel[0].ticketRequestId, requestId);
    assertEquals(calls.cancel[0].startedBy, fx.adminId);
    assertEquals((await batchRow(fx, batchId)).state, "stopping");

    await setRunStatus(fx, await runOf(fx, requestId), "canceled");
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals((await batchRow(fx, batchId)).state, "stopped");
    assertEquals(calls.start.length, 1, "nothing started while stopping");
  }));

Deno.test("batches: spend is derived from the issues' usage, and reaching the limit finishes the batch after the running issue", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 5, maxSpendUsd: "10" });
    const { ports, calls } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    const [issue] = await issueRows(fx, batchId);
    const runId = await runOf(fx, issue.ticket_request_id!);

    await insertWithoutForeignKeys(fx.owner, "usage_records", {
      organization_id: fx.organizationId,
      run_id: runId,
      cost_usd: "10.000000",
    });

    // The limit is reached while the issue is still running: nothing new starts,
    // and the batch says it is finishing and why.
    await superviseBatches(fx.runtime, ports);
    const finishing = await batchRow(fx, batchId);
    assertEquals(finishing.state, "finishing");
    assertEquals(finishing.finish_reason, "spend_exhausted");
    assertEquals(calls.start.length, 1);

    // When the issue merges, its cost is recorded and the batch ends with the reason.
    await mergeIssue(fx, runId);
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    const ended = await batchRow(fx, batchId);
    assertEquals(ended.state, "finished");
    assertEquals(ended.finish_reason, "spend_exhausted");
    assertEquals(Number((await issueRows(fx, batchId))[0].cost_usd), 10);
  }));

Deno.test("batches: a batch is invisible to another organization, by id and in the list", () =>
  withBatches(async (fx) => {
    const id = await insertBatch(fx);
    const other = crypto.randomUUID();

    // The owner organization reads it; another organization is told it does not exist.
    assertEquals(
      (await loadBatch(fx.runtime as never, fx.organizationId, id)).id,
      id,
    );
    const refused = await assertRejects(() =>
      loadBatch(fx.runtime as never, other, id)
    );
    assertEquals((refused as { code?: string }).code, "RESOURCE_NOT_FOUND");

    const list = (organizationId: string) =>
      createBatchesListHandler("test-secret")({
        transaction: fx.runtime,
        authority: { organizationId, subject: { principalId: fx.adminId } },
      } as never, {} as never);
    assertEquals(
      (await list(fx.organizationId)).items.map((batch) => batch.id),
      [id],
    );
    assertEquals((await list(other)).items.length, 0);
  }));

Deno.test("batches: a tick skips a batch another tick holds, and acts once it is free", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 2 });
    const { ports, calls } = admittingPorts(fx, sourceId);

    // Another tick is mid-way through this batch: it holds the batch's row lock. Held from a
    // separate connection, so the case is deterministic: the tick must skip the batch, not wait.
    const holder = await fx.owner.connect();
    try {
      await holder.query("begin");
      await holder.query(
        `select id from bakery.batches where id = $1 for update`,
        [batchId],
      );

      // Without the skip, the tick would wait on this lock while this test waits for the tick,
      // so the wait is bounded: a tick that has not returned in a few seconds is waiting.
      const tick = superviseBatches(fx.runtime, ports);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<"waited">((resolve) => {
        timer = setTimeout(() => resolve("waited"), 5_000);
      });
      const outcome = await Promise.race([
        tick.then(() => "done" as const),
        waited,
      ]);
      clearTimeout(timer);
      if (outcome === "waited") {
        await holder.query("commit");
        await tick;
        throw new Error(
          "the tick waited for a batch another tick holds instead of skipping it",
        );
      }
      assertEquals(calls.start.length, 0, "a held batch is not started");
      assertEquals((await issueRows(fx, batchId)).length, 0);
      assertEquals((await batchRow(fx, batchId)).state, "running");

      await holder.query("commit");
    } catch (cause) {
      await holder.query("rollback").catch(() => undefined);
      throw cause;
    } finally {
      holder.release();
    }

    // Once the lock is free the same tick acts, exactly once.
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
    assertEquals((await issueRows(fx, batchId)).length, 1);
  }));

Deno.test("batches: every way a run can end is an end, and a run waiting on its merge is not", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx);
    const { ports } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    const requestId = (await issueRows(fx, batchId))[0].ticket_request_id!;
    const runId = await runOf(fx, requestId);
    const outcome = () =>
      readIssueOutcome(fx.runtime as never, fx.organizationId, requestId);

    // Still moving, or waiting on a person or on capacity: not an end.
    for (
      const status of [
        "queued",
        "running",
        "waiting_input",
        "waiting_capacity",
        "paused",
        "canceling",
      ]
    ) {
      await setRunStatus(fx, runId, status);
      assertEquals(await outcome(), "running", `run ${status}`);
    }
    // Over: cancelled, failed, or blocked (it waits for a person, which a batch cannot).
    for (
      const [status, expected] of [
        ["canceled", "cancelled"],
        ["failed", "failed"],
        ["blocked", "failed"],
        ["needs_human", "failed"],
      ] as const
    ) {
      await setRunStatus(fx, runId, status);
      assertEquals(await outcome(), expected, `run ${status}`);
    }

    // Completed with nothing left to merge: the run will not merge, so the issue ended.
    await setRunStatus(fx, runId, "completed");
    assertEquals(
      await outcome(),
      "failed",
      "completed, no pull request, no merge",
    );

    // Completed, but its pull request is still open: it is waiting on its merge.
    const task = await fx.owner.query<{ task_id: string }>(
      `select link.task_id
         from bakery.ticket_requests as request
         join bakery.ticket_task_links as link
           on link.organization_id = request.organization_id
          and link.id = request.ticket_task_link_id
        where request.organization_id = $1 and request.id = $2`,
      [fx.organizationId, requestId],
    );
    await insertWithoutForeignKeys(fx.owner, "pull_requests", {
      organization_id: fx.organizationId,
      task_id: task.rows[0].task_id,
      status: "open",
    });
    assertEquals(await outcome(), "running", "completed, pull request open");
    // ...and once that pull request is closed without merging, it ended.
    await fx.owner.query(
      `update bakery.pull_requests set status = 'closed'
        where organization_id = $1 and task_id = $2`,
      [fx.organizationId, task.rows[0].task_id],
    );
    assertEquals(
      await outcome(),
      "failed",
      "completed, pull request closed unmerged",
    );

    // A merge in flight is not an end either; a cancelled one is, and a merged one is a merge.
    await insertWithoutForeignKeys(fx.owner, "merge_entries", {
      organization_id: fx.organizationId,
      run_id: runId,
      status: "queued",
    });
    assertEquals(await outcome(), "running", "completed, merge queued");
    for (const status of ["validating", "merging"]) {
      await fx.owner.query(
        `update bakery.merge_entries set status = $3
          where organization_id = $1 and run_id = $2`,
        [fx.organizationId, runId, status],
      );
      assertEquals(await outcome(), "running", `completed, merge ${status}`);
    }
    await fx.owner.query(
      `update bakery.merge_entries set status = 'canceled'
        where organization_id = $1 and run_id = $2`,
      [fx.organizationId, runId],
    );
    assertEquals(await outcome(), "failed", "completed, merge cancelled");
    await fx.owner.query(
      `update bakery.merge_entries set status = 'merged'
        where organization_id = $1 and run_id = $2`,
      [fx.organizationId, runId],
    );
    assertEquals(await outcome(), "merged");
  }));

Deno.test("batches: a stop that cancels ends once the run has completed without merging", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 5 });
    const { ports, calls } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    const requestId = (await issueRows(fx, batchId))[0].ticket_request_id!;
    await fx.runtime.query(
      `update bakery.batches
          set state = 'stopping', stop_cancelled_current = true, stopped_by = $2
        where id = $1`,
      [batchId, fx.adminId],
    );

    // Ana's run completes, but its pull request is closed unmerged. A cancel now only finds the
    // run already over, so the batch used to read it as running and stay Stopping for good.
    await setRunStatus(fx, await runOf(fx, requestId), "completed");
    await superviseBatches(fx.runtime, ports);
    await superviseBatches(fx.runtime, ports);
    assertEquals((await batchRow(fx, batchId)).state, "stopped");
    assertEquals((await issueRows(fx, batchId))[0].state, "failed");
    assertEquals(calls.start.length, 1, "nothing started while stopping");
  }));

Deno.test("batches: a stop that cancels ends when its starter has lost authority", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { startedBy: fx.developerId! });
    const { ports, calls } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
    await fx.runtime.query(
      `update bakery.batches
          set state = 'stopping', stop_cancelled_current = true, stopped_by = $2
        where id = $1`,
      [batchId, fx.adminId],
    );
    await fx.owner.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId],
    );

    // The cancel is made as the starter, who can no longer act: it ends and says why, rather
    // than asking for a cancel it can never make.
    await superviseBatches(fx.runtime, ports);
    const ended = await batchRow(fx, batchId);
    assertEquals(ended.state, "finished");
    assertEquals(ended.finish_reason, "authority_lost");
    assertEquals(
      calls.cancel.length,
      0,
      "no cancel was attempted as someone who cannot",
    );
  }));

Deno.test("batches: a tick that fails says which batch and why, and the batch is tried again", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx);
    const failures: {
      organizationId: string;
      batchId: string;
      error: unknown;
    }[] = [];
    const down: BatchPorts = {
      startNext: () => Promise.reject(new Error("PROVIDER_UNAVAILABLE")),
    };

    const failed = await superviseBatches(
      fx.runtime,
      down,
      new Date(),
      (failure) => failures.push(failure),
    );
    assertEquals(failed, { looked: 1, acted: 0, failed: 1 });
    assertEquals(failures.length, 1);
    assertEquals(failures[0].batchId, batchId);
    assertEquals(failures[0].organizationId, fx.organizationId);
    assertEquals((failures[0].error as Error).message, "PROVIDER_UNAVAILABLE");
    // Nothing was half done: the batch is as it was, and the next tick tries it again.
    assertEquals((await batchRow(fx, batchId)).state, "running");
    assertEquals((await issueRows(fx, batchId)).length, 0);

    const { ports, calls } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    assertEquals(calls.start.length, 1);
  }));

/** One real admission as a manual start, stamped with the trace id it was asked under. */
async function admitWithTrace(
  fx: TicketFixture,
  sourceId: string,
  number: number,
  trace: string,
): Promise<string> {
  fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
  fx.reader.setLabelApplied(number, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
  const result = await admitTicket(fx.automationDeps(), {
    organizationId: fx.organizationId,
    sourceId,
    number,
    intent: "start",
    origin: "manual",
    caller: await fx.actor(fx.adminId),
    prefetch: null,
    signal: new AbortController().signal,
    trace: { requestId: trace, traceId: trace },
  } as never);
  assert(result.request, "the admission produced a request");
  return result.request.id;
}

function realStartPort(
  fx: TicketFixture,
): NonNullable<BatchPorts["startNext"]> {
  return createBatchStartPort({
    database: fx.runtime,
    reader: fx.reader as never,
    budget: undefined,
    admit: ((_deps: unknown, call: Parameters<typeof admitTicket>[1]) =>
      admitTicket(fx.automationDeps(), call)) as typeof admitTicket,
    resolveCaller: (_database, _organizationId, principalId) =>
      fx.actor(principalId),
  });
}

async function requestCount(fx: TicketFixture): Promise<number> {
  const result = await fx.owner.query<{ n: string }>(
    `select count(*)::text as n from bakery.ticket_requests where organization_id = $1`,
    [fx.organizationId],
  );
  return Number(result.rows[0].n);
}

Deno.test("batches: a request this batch admitted before its tick failed is taken back, not passed over", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx);
    // The admission committed under this batch's trace id; the tick that asked for it then
    // lost its transaction, so the batch has no row for the issue.
    const orphan = await admitWithTrace(fx, sourceId, 1, `batch:${batchId}`);
    assertEquals((await issueRows(fx, batchId)).length, 0);

    await superviseBatches(fx.runtime, { startNext: realStartPort(fx) });

    const issues = await issueRows(fx, batchId);
    assertEquals(issues.map((issue) => issue.state), ["started"]);
    assertEquals(issues[0].ticket_request_id, orphan);
    assertEquals(
      await requestCount(fx),
      1,
      "no second request was made for the issue",
    );
    assertEquals((await batchRow(fx, batchId)).state, "running");
  }));

Deno.test("batches: a request a person made for the issue is not taken, only passed over", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx);
    await admitWithTrace(fx, sourceId, 1, "a-person-pressed-start");

    await superviseBatches(fx.runtime, { startNext: realStartPort(fx) });

    const issues = await issueRows(fx, batchId);
    assertEquals(issues.map((issue) => issue.state), ["passed_over"]);
    assertEquals(issues[0].ticket_request_id, null);
    assertEquals(await requestCount(fx), 1);
    assertEquals(
      (await batchRow(fx, batchId)).finish_reason,
      "nothing_eligible",
    );
  }));

/** The context an action handler reads: the real transaction and the caller's authority. */
function actionContext(fx: TicketFixture, principalId = fx.adminId) {
  const context = {
    transaction: fx.runtime,
    params: {},
    principal: { principalId },
    requestId: "startable-test",
    traceId: "startable-test",
    authority: {
      organizationId: fx.organizationId,
      role: "developer",
      capabilities: [],
      subject: { principalId, principalType: "human" },
    },
    commandMetadata: {
      operation: "batches.create",
      idempotencyKey: crypto.randomUUID(),
      target: fx.repositoryId,
    },
  };
  return context as never;
}

Deno.test("batches: the startable list is what a batch would take, lowest number first, and pages by keyset", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    // 3 and 7 carry no request label: a batch starts an issue as a manual request, so the
    // label check does not keep them out. 5 is held. 9 has a request open already.
    fx.reader.setIssue({ number: 7, title: "Seventh", body: ACCEPTANCE_BODY });
    fx.reader.setIssue({ number: 3, title: "Third", body: ACCEPTANCE_BODY });
    fx.reader.setIssue({
      number: 5,
      title: "Held",
      body: ACCEPTANCE_BODY,
      labels: [HOLD_LABEL],
    });
    fx.reader.setIssue({
      number: 9,
      title: "Taken",
      body: ACCEPTANCE_BODY,
      labels: [EXECUTE_LABEL],
    });
    fx.reader.setLabelApplied(9, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    const taken = await fx.admit(sourceId, {
      number: 9,
      origin: "manual",
      intent: "start",
      deps: fx.automationDeps(),
    });
    assert(taken.request, "issue 9 has an open request");
    await recordOpenIssues(fx, sourceId);

    const startable = createBatchStartableHandler({
      cursorSecret: "test-secret",
      budget: presetBudgetPolicy,
    });
    const all = await startable(actionContext(fx), {
      repositoryId: fx.repositoryId,
    } as never);
    assertEquals(all.items.map((item) => item.number), ["3", "7"]);
    assertEquals(all.items.map((item) => item.title), ["Third", "Seventh"]);
    assertEquals(all.nextCursor, null);
    for (const item of all.items) assert(item.checkedAt.endsWith("Z"));

    // One at a time: the cursor resumes after the last number, and is the end after 7.
    const first = await startable(actionContext(fx), {
      repositoryId: fx.repositoryId,
      limit: 1,
    } as never);
    assertEquals(first.items.map((item) => item.number), ["3"]);
    assert(first.nextCursor !== null);
    const second = await startable(actionContext(fx), {
      repositoryId: fx.repositoryId,
      limit: 1,
      cursor: first.nextCursor,
    } as never);
    assertEquals(second.items.map((item) => item.number), ["7"]);
    assertEquals(second.nextCursor, null);

    // Another organization cannot read this repository's issues.
    const stranger = await assertRejects(() =>
      startable(
        {
          ...(actionContext(fx) as Record<string, unknown>),
          authority: {
            organizationId: crypto.randomUUID(),
            role: "developer",
            capabilities: [],
            subject: { principalId: fx.adminId, principalType: "human" },
          },
        } as never,
        { repositoryId: fx.repositoryId } as never,
      )
    );
    assertEquals((stranger as { code?: string }).code, "RESOURCE_NOT_FOUND");
  }));

Deno.test("batches: the smallest spend is the preset's minimum, and a start below it is refused", () =>
  withBatches(async (fx) => {
    await fx.insertSource({ policy: automaticPolicy(fx) });
    const smallest = await smallestBatchSpend(
      fx.runtime,
      fx.organizationId,
      fx.repositoryId,
      presetBudgetPolicy,
    );
    assert(smallest !== null, "the funded fixture repository can run work");
    const listed = await createBatchStartableHandler({
      cursorSecret: "test-secret",
      budget: presetBudgetPolicy,
    })(actionContext(fx), { repositoryId: fx.repositoryId } as never);
    assertEquals(listed.smallestSpendUsd, smallest);

    const create = (maxSpendUsd: string) =>
      createBatchHandler({ budget: presetBudgetPolicy })(actionContext(fx), {
        repositoryId: fx.repositoryId,
        presetId: "fixed-coding",
        maxIssues: 2,
        maxHours: 8,
        maxSpendUsd,
        continueMode: "carry_on",
      } as never);
    const below = (Number(smallest) - 0.01).toFixed(2);
    const refused = await assertRejects(() => create(below));
    assertEquals((refused as { code?: string }).code, "UNPROCESSABLE");
    assertEquals(
      (refused as { params?: { issues?: { code: string }[] } }).params
        ?.issues?.[0]?.code,
      "max_spend_below_smallest",
    );
    assertEquals(
      (await fx.owner.query(
        "select 1 from bakery.batches where organization_id = $1",
        [fx.organizationId],
      )).rows.length,
      0,
      "a refused start stores nothing",
    );
    const accepted = await create(smallest);
    assertEquals(accepted.state, "running");
    assertEquals(accepted.presetId, "fixed-coding");
    assertEquals(
      (await fx.owner.query<{ preset_id: string }>(
        "select preset_id from bakery.batches where id = $1",
        [accepted.id],
      )).rows[0].preset_id,
      "fixed-coding",
    );
  }));

Deno.test("batches: the list filters by state, keeps its cursor to that filter, and each issue names its ticket", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const finished = await insertBatch(fx, { state: "finished" });
    const stopped = await insertBatch(fx, { state: "stopped" });
    const live = await insertBatch(fx, { state: "running" });
    const list = createBatchesListHandler("test-secret");
    const ids = async (query: Record<string, unknown>) =>
      (await list(actionContext(fx), query as never)).items.map((batch) =>
        batch.id
      );
    assertEquals(await ids({ state: "finished" }), [finished]);
    assertEquals(await ids({ state: "stopped" }), [stopped]);
    assertEquals(await ids({ state: "running" }), [live]);
    assertEquals(await ids({ state: "paused" }), []);
    assertEquals((await ids({})).sort(), [finished, stopped, live].sort());

    // A cursor belongs to the filter it came from.
    const page = await list(actionContext(fx), {
      limit: 1,
      state: "finished",
    } as never);
    assertEquals(page.items.length, 1);
    const twoFinished = await insertBatch(fx, { state: "finished" });
    const firstPage = await list(actionContext(fx), {
      limit: 1,
      state: "finished",
    } as never);
    assert(firstPage.nextCursor !== null);
    const crossed = await assertRejects(() =>
      list(actionContext(fx), {
        limit: 1,
        state: "stopped",
        cursor: firstPage.nextCursor,
      } as never)
    );
    assertEquals((crossed as { code?: string }).code, "INVALID_CURSOR");
    assertEquals(
      (await ids({ state: "finished", limit: 5 })).sort(),
      [finished, twoFinished].sort(),
    );

    // An issue of a batch carries its ticket's number and title as last stored.
    fx.reader.setIssue({ number: 4, title: "Fourth", body: ACCEPTANCE_BODY });
    await recordOpenIssues(fx, sourceId);
    const ticket = (await fx.owner.query<{ id: string }>(
      `select id from bakery.external_tickets
        where organization_id = $1 and number = '4'`,
      [fx.organizationId],
    )).rows[0];
    await fx.runtime.query(
      `insert into bakery.batch_issues (
         organization_id, batch_id, position, external_ticket_id, state
       ) values ($1, $2, 1, $3, 'passed_over')`,
      [fx.organizationId, live, ticket.id],
    );
    const loaded = await loadBatch(
      fx.runtime as never,
      fx.organizationId,
      live,
    );
    assertEquals(loaded.issues[0].issueNumber, "4");
    assertEquals(loaded.issues[0].issueTitle, "Fourth");
  }));

Deno.test("batches: a batch says what the issue being worked on waits for, and clears it when answered", () =>
  withBatches(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const batchId = await insertBatch(fx, { maxIssues: 2 });
    const { ports } = admittingPorts(fx, sourceId);
    await superviseBatches(fx.runtime, ports);
    const issues = await issueRows(fx, batchId);
    assertEquals(issues.map((issue) => issue.state), ["started"]);
    const runId = await runOf(fx, issues[0].ticket_request_id!);
    const taskId = (await fx.owner.query<{ task_id: string }>(
      `select task_id from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [fx.organizationId, runId],
    )).rows[0].task_id;
    const readAs = async (viewerPrincipalId?: string) =>
      (await loadBatch(fx.runtime as never, fx.organizationId, batchId, {
        viewerPrincipalId,
      })).waitingOn;
    const read = () => readAs(fx.adminId);

    // Nothing is open: the batch is not waiting on anyone.
    assertEquals(await read(), null);

    // An approval put to one named person on this issue's task.
    const questionId = crypto.randomUUID();
    await insertWithoutForeignKeys(fx.owner, "questions", {
      id: questionId,
      organization_id: fx.organizationId,
      task_id: taskId,
      run_id: runId,
      kind: "approval",
      status: "open",
      audience: JSON.stringify({
        type: "principals",
        principalIds: [fx.adminId],
      }),
    });
    const waiting = await read();
    assert(waiting !== null, "an open approval on the task is shown");
    assertEquals(waiting.kind, "approval");
    assertEquals(waiting.questionId, questionId);
    assertEquals(waiting.taskId, taskId);
    assertEquals(waiting.askedOf.map((person) => person.principalId), [
      fx.adminId,
    ]);
    assert(waiting.since.endsWith("Z"), "it says since when");

    // A question for the task's participants names nobody, and an answered one clears.
    await fx.owner.query(
      `update bakery.questions set audience = '{"type":"task_participants"}'::jsonb
        where organization_id = $1 and id = $2`,
      [fx.organizationId, questionId],
    );
    assertEquals((await read())?.askedOf, []);

    // A read with no viewer shows nothing, and an item private to someone else
    // does not exist for this viewer: the next one they may see is shown instead.
    assertEquals(await readAs(undefined), null);
    const privateId = crypto.randomUUID();
    await insertWithoutForeignKeys(fx.owner, "questions", {
      id: privateId,
      organization_id: fx.organizationId,
      task_id: taskId,
      run_id: runId,
      kind: "question",
      status: "open",
      created_at: "2000-01-01T00:00:00Z",
      audience: JSON.stringify({
        type: "principals",
        principalIds: [crypto.randomUUID()],
      }),
    });
    assertEquals(
      (await read())?.questionId,
      questionId,
      "the older private question is hidden from a caller outside its audience",
    );
    await fx.owner.query(
      `update bakery.questions set status = 'answered'
        where organization_id = $1 and id = $2`,
      [fx.organizationId, privateId],
    );
    await fx.owner.query(
      `update bakery.questions set status = 'answered'
        where organization_id = $1 and id = $2`,
      [fx.organizationId, questionId],
    );
    assertEquals(await read(), null);
  }));

// ---- what the batch waits for, through its handlers (#58 item 3) ----

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** A batch with its first issue started: the run and task its open questions belong to. */
async function startedIssue(fx: TicketFixture) {
  const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
  seedLabeler(fx);
  const batchId = await insertBatch(fx, { maxIssues: 2 });
  const { ports } = admittingPorts(fx, sourceId);
  await superviseBatches(fx.runtime, ports);
  const issues = await issueRows(fx, batchId);
  const runId = await runOf(fx, issues[0].ticket_request_id!);
  const taskId = (await fx.owner.query<{ task_id: string }>(
    `select task_id from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [fx.organizationId, runId],
  )).rows[0].task_id;
  return { batchId, runId, taskId, ports };
}

const PROMPT_TEXT = "the question text a batch read must never carry";

/** An open approval on a task, for everyone on it unless `over` narrows it. */
async function openQuestion(
  fx: TicketFixture,
  taskId: string,
  runId: string | null,
  over: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  await insertWithoutForeignKeys(fx.owner, "questions", {
    id,
    organization_id: fx.organizationId,
    task_id: taskId,
    run_id: runId,
    kind: "approval",
    status: "open",
    prompt: PROMPT_TEXT,
    audience: JSON.stringify({ type: "task_participants" }),
    ...over,
  });
  return id;
}

/** `batches.get` as one caller, whole. */
async function getBatchAs(
  fx: TicketFixture,
  batchId: string,
  principalId: string,
) {
  const context = actionContext(fx, principalId) as unknown as {
    params: Record<string, string>;
  };
  context.params = { id: batchId };
  return await getBatch(context as never);
}

Deno.test("batches: get and list show a private question only to the people it was put to", () =>
  withBatches(async (fx) => {
    const { batchId, runId, taskId } = await startedIssue(fx);
    const outsider = crypto.randomUUID();
    const list = createBatchesListHandler("test-secret");
    const listedAs = async (who: string) =>
      (await list(actionContext(fx, who), {} as never)).items.find((item) =>
        item.id === batchId
      )?.waitingOn ?? null;
    const getAs = async (who: string) =>
      (await getBatchAs(fx, batchId, who)).waitingOn;

    const privateId = await openQuestion(fx, taskId, runId, {
      created_at: hoursAgo(3),
      audience: JSON.stringify({
        type: "principals",
        principalIds: [fx.adminId],
      }),
    });
    assertEquals(
      (await getAs(fx.adminId))?.questionId,
      privateId,
      "the person it was put to sees it through get",
    );
    assertEquals(
      (await listedAs(fx.adminId))?.questionId,
      privateId,
      "and through list",
    );
    assertEquals(
      await getAs(outsider),
      null,
      "someone else cannot tell it exists, through get",
    );
    assertEquals(await listedAs(outsider), null, "or through list");

    // The next item the outsider may see wins; the audience still sees the older one first.
    const publicId = await openQuestion(fx, taskId, runId, {
      created_at: hoursAgo(1),
    });
    assertEquals((await getAs(outsider))?.questionId, publicId);
    assertEquals((await listedAs(outsider))?.questionId, publicId);
    assertEquals((await getAs(fx.adminId))?.questionId, privateId);
  }));

Deno.test("batches: the batch waits for the oldest open question of this issue's task and run, names three people, and stops when the issue ends", () =>
  withBatches(async (fx) => {
    const { batchId, runId, taskId, ports } = await startedIssue(fx);
    const reader = fx.adminId;
    const people = Array.from({ length: 4 }, () => crypto.randomUUID());
    const waiting = async () =>
      (await getBatchAs(fx, batchId, reader)).waitingOn;
    try {
      for (const [index, id] of people.entries()) {
        await fx.owner.query(
          `insert into bakery.principals (id, display_name, principal_type)
           values ($1, $2, 'service')`,
          [id, `Waiting person ${index}`],
        );
      }
      // Another task's question, and another run's question on this task, are not this issue's.
      await openQuestion(fx, crypto.randomUUID(), runId, {
        created_at: hoursAgo(6),
      });
      await openQuestion(fx, taskId, crypto.randomUUID(), {
        created_at: hoursAgo(5),
      });
      assertEquals(await waiting(), null);

      const newer = await openQuestion(fx, taskId, runId, {
        created_at: hoursAgo(1),
      });
      // Put to four people: only the first three are named, in the order given.
      const older = await openQuestion(fx, taskId, null, {
        created_at: hoursAgo(3),
        audience: JSON.stringify({
          type: "principals",
          principalIds: [...people, reader],
        }),
      });
      const first = await waiting();
      assertEquals(first?.questionId, older, "the oldest open one comes first");
      assertEquals(
        first?.askedOf.map((person) => person.displayName),
        ["Waiting person 0", "Waiting person 1", "Waiting person 2"],
      );
      assert(
        !JSON.stringify(await getBatchAs(fx, batchId, reader)).includes(
          PROMPT_TEXT,
        ),
        "the question's text is not part of a batch",
      );

      await fx.owner.query(
        `update bakery.questions set status = 'answered' where id = $1`,
        [older],
      );
      assertEquals(
        (await waiting())?.questionId,
        newer,
        "the next one once answered",
      );

      // The issue ends: its open question is no longer what the batch waits for.
      await mergeIssue(fx, runId);
      await setRunStatus(fx, runId, "completed" as never);
      await superviseBatches(fx.runtime, ports);
      const states = (await issueRows(fx, batchId)).map((issue) => issue.state);
      assert(states[0] !== "started", "the first issue is no longer started");
      assertEquals(await waiting(), null);
    } finally {
      await fx.owner.query(
        `delete from bakery.questions where organization_id = $1 and prompt = $2`,
        [fx.organizationId, PROMPT_TEXT],
      );
      await fx.owner.query(
        `delete from bakery.principals where id = any($1::uuid[])`,
        [people],
      );
    }
  }));

Deno.test("batches: an item the viewer may see is found behind more than a page of older private ones", () =>
  withBatches(async (fx) => {
    const { batchId, runId, taskId } = await startedIssue(fx);
    const outsider = crypto.randomUUID();
    const someoneElse = JSON.stringify({
      type: "principals",
      principalIds: [crypto.randomUUID()],
    });
    try {
      // 55 older questions private to someone else: more than one page of candidates.
      for (let index = 0; index < 55; index++) {
        await openQuestion(fx, taskId, runId, {
          created_at: new Date(Date.now() - (200 - index) * 60_000)
            .toISOString(),
          audience: someoneElse,
        });
      }
      const visible = await openQuestion(fx, taskId, runId, {
        created_at: hoursAgo(1),
      });
      assertEquals(
        (await getBatchAs(fx, batchId, outsider)).waitingOn?.questionId,
        visible,
        "the 56th item is found, not hidden behind the first 50",
      );
      // And a viewer who may see none of them is told nothing.
      await fx.owner.query(
        `update bakery.questions set status = 'answered' where id = $1`,
        [visible],
      );
      assertEquals((await getBatchAs(fx, batchId, outsider)).waitingOn, null);
    } finally {
      await fx.owner.query(
        `delete from bakery.questions where organization_id = $1 and prompt = $2`,
        [fx.organizationId, PROMPT_TEXT],
      );
    }
  }));
