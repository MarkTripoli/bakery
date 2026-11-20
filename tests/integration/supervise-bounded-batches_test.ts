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
  type BatchPorts,
  superviseBatches,
} from "../../apps/server/src/modules/work/batch-tick.ts";
import {
  AFTER_SINCE,
  automaticPolicy,
  EXECUTE_LABEL,
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
       id, organization_id, repository_id, started_by, max_issues, max_hours,
       max_spend_usd, continue_mode, state
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      fx.organizationId,
      fx.repositoryId,
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
    start: [] as { startedBy: string; batchId: string }[],
    cancel: [] as { startedBy: string; ticketRequestId: string }[],
  };
  let next = 1;
  const deps = fx.automationDeps();
  const ports: BatchPorts = {
    startNext: async (_transaction, input) => {
      calls.start.push({
        startedBy: input.startedBy,
        batchId: input.batchId,
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
