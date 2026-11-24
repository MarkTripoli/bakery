import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  createBatch,
  finishBatch,
  pauseBatch,
  resumeBatch,
  startNextInBatch,
  stopBatch,
} from "../../apps/server/src/modules/work/batch-commands.ts";

/**
 * Batches without a database (#58): what a start needs, and every control's state
 * transitions, including repeats and refusals. The fake keeps one batch row and
 * applies the state the SQL asks for, so each transition is read back as the real
 * table would return it. The same handlers run against Postgres in the integration
 * file, where the index, the locks and the derived spend actually execute.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const BATCH = "11111111-1111-4111-8111-111111111111";
const PERSON = "44444444-4444-4444-8444-444444444444";

type Options = {
  state?: string;
  issues?: { state: string }[];
  repository?: boolean;
  taking?: boolean;
  role?: string;
  insertError?: string;
};

function stand(options: Options = {}) {
  let state = options.state ?? "running";
  let stopCancelled = false;
  let pausedBy: string | null = null;
  const writes: { sql: string; values: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const issues = (options.issues ?? []).map((issue, index) => ({
    id: `issue-${index}`,
    position: index + 1,
    external_ticket_id: "t",
    state: issue.state,
    reason: null,
    ticket_request_id: null,
    cost_usd: null,
    spent: null,
    started_at: null,
    merged_at: null,
  }));
  const transaction = {
    query: (sql: string, values: unknown[] = []) => {
      if (sql.includes("from bakery.batches as batch")) {
        return Promise.resolve({
          rows: [{
            id: BATCH,
            repository_id: REPO,
            preset_id: "fixed-coding",
            started_by: PERSON,
            max_issues: 5,
            max_hours: 8,
            max_spend_usd: "25.000000",
            continue_mode: "ask_first",
            state,
            pause_reason: state === "paused" ? "paused_by_person" : null,
            paused_by: pausedBy,
            paused_at: null,
            finish_reason: null,
            finished_at: null,
            stopped_by: null,
            stop_cancelled_current: stopCancelled,
            started_at: new Date("2026-11-19T10:00:00Z"),
            created_at: new Date("2026-11-19T10:00:00Z"),
            updated_at: new Date("2026-11-19T10:00:00Z"),
            version: 1,
            elapsed_seconds: "60",
          }],
          rowCount: 1,
        });
      }
      // The waitingOn read (#58) joins the issues to the task's open questions;
      // none are open here, so it must not be answered with the issue rows.
      if (sql.includes("join bakery.questions")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("from bakery.batch_issues")) {
        return Promise.resolve({ rows: issues, rowCount: issues.length });
      }
      if (/^\s*update bakery\.batches/i.test(sql)) {
        writes.push({ sql, values });
        const next = /state = '([a-z]+)'/.exec(sql)?.[1];
        if (next) state = next;
        if (sql.includes("paused_by = $2")) pausedBy = String(values[1]);
        if (sql.includes("stop_cancelled_current = $3")) {
          stopCancelled = values[2] === true;
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (/^\s*insert into bakery\.batches/i.test(sql)) {
        writes.push({ sql, values });
        if (options.insertError) {
          return Promise.reject(
            Object.assign(new Error("dup"), { code: options.insertError }),
          );
        }
        return Promise.resolve({ rows: [{ id: BATCH }], rowCount: 1 });
      }
      if (sql.includes("from bakery.repositories")) {
        const ok = options.repository !== false;
        return Promise.resolve({ rows: ok ? [{}] : [], rowCount: ok ? 1 : 0 });
      }
      if (sql.includes("from bakery.ticket_sources")) {
        const ok = options.taking !== false;
        return Promise.resolve({ rows: ok ? [{}] : [], rowCount: ok ? 1 : 0 });
      }
      if (/insert into bakery\.audit_events/i.test(sql)) audits.push(values);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const context = {
    transaction,
    params: { id: BATCH },
    principal: { principalId: PERSON },
    requestId: "r",
    traceId: "t",
    authority: {
      organizationId: ORG,
      role: options.role ?? "developer",
      capabilities: [],
      subject: { principalId: PERSON, principalType: "human" },
    },
    commandMetadata: {
      operation: "batches.x",
      idempotencyKey: "k",
      target: BATCH,
    },
  } as unknown as ActionContext;
  return { context, writes, audits };
}

async function refusedWith(
  run: () => Promise<unknown>,
  code: string,
  reason?: string,
) {
  const error = await assertRejects(run, StandardError);
  assertEquals(error.code, code);
  if (reason) {
    const found = error.params as {
      reason?: string;
      issues?: { code: string }[];
    };
    assertEquals(found.reason ?? found.issues?.[0]?.code, reason);
  }
}

const valid = {
  repositoryId: REPO,
  presetId: "fixed-coding" as const,
  maxIssues: 5,
  maxHours: 8,
  maxSpendUsd: "25",
  continueMode: "ask_first" as const,
};

Deno.test("a start needs a spend above zero, a repository that exists and takes issues, and one live batch", async () => {
  {
    const { context, writes } = stand();
    await refusedWith(
      () => createBatch(context, { ...valid, maxSpendUsd: "0" } as never),
      "UNPROCESSABLE",
      "max_spend_not_positive",
    );
    assertEquals(writes, []);
  }
  {
    const { context, writes } = stand({ repository: false });
    await refusedWith(
      () => createBatch(context, valid as never),
      "UNPROCESSABLE",
      "repository_not_found",
    );
    assertEquals(writes, []);
  }
  {
    const { context, writes } = stand({ taking: false });
    await refusedWith(
      () => createBatch(context, valid as never),
      "STATE_CONFLICT",
      "repository_not_taking_issues",
    );
    assertEquals(writes, []);
  }
  {
    // The unique index answers a second live batch in the repository.
    const { context } = stand({ insertError: "23505" });
    await refusedWith(
      () => createBatch(context, valid as never),
      "STATE_CONFLICT",
      "batch_already_running",
    );
  }
});

Deno.test("someone without the authority to start work cannot start or steer a batch", async () => {
  for (
    const run of [
      (c: ActionContext) => createBatch(c, valid as never),
      (c: ActionContext) => pauseBatch(c),
      (c: ActionContext) => resumeBatch(c),
      (c: ActionContext) => startNextInBatch(c),
      (c: ActionContext) => finishBatch(c),
      (c: ActionContext) => stopBatch(c, { cancelCurrent: false }),
    ]
  ) {
    const { context, writes } = stand({ role: "viewer" });
    await refusedWith(() => run(context), "AUTH_FORBIDDEN");
    assertEquals(writes, []);
  }
});

Deno.test("a start with the smallest positive amount is accepted and stored with the starter and the choice", async () => {
  const { context, writes } = stand();
  const created = await createBatch(
    context,
    { ...valid, maxSpendUsd: "0.000001" } as never,
  );
  assertEquals(created.id, BATCH);
  assertEquals(created.presetId, "fixed-coding");
  const insert = writes.find((w) =>
    /insert into bakery\.batches/i.test(w.sql)
  )!;
  assertEquals(insert.values.slice(1), [
    REPO,
    "fixed-coding",
    PERSON,
    5,
    8,
    "0.000001",
    "ask_first",
  ]);
});

Deno.test("a start names a built-in workflow, and a missing or unknown one is refused before anything is stored", async () => {
  for (const presetId of [undefined, "", "no-such-workflow"]) {
    const { context, writes } = stand();
    await refusedWith(
      () => createBatch(context, { ...valid, presetId } as never),
      "UNPROCESSABLE",
      "workflow_unknown",
    );
    assertEquals(writes, []);
  }
});

Deno.test("pause stops new starts, repeats are harmless, and only a running or waiting batch can be paused", async () => {
  const running = stand({ state: "running" });
  assertEquals((await pauseBatch(running.context)).state, "paused");
  assertEquals((await pauseBatch(running.context)).state, "paused");
  // The repeat wrote nothing more.
  assertEquals(running.writes.length, 1);
  assertEquals(
    (await pauseBatch(stand({ state: "waiting" }).context)).state,
    "paused",
  );
  for (const state of ["stopping", "finishing", "finished", "stopped"]) {
    await refusedWith(
      () => pauseBatch(stand({ state }).context),
      "STATE_CONFLICT",
      "batch_cannot_pause",
    );
  }
});

Deno.test("resume, start next and finish each need the state they are for", async () => {
  assertEquals(
    (await resumeBatch(stand({ state: "paused" }).context)).state,
    "running",
  );
  assertEquals(
    (await resumeBatch(stand({ state: "running" }).context)).state,
    "running",
  );
  for (
    const state of ["waiting", "stopping", "finishing", "finished", "stopped"]
  ) {
    await refusedWith(
      () => resumeBatch(stand({ state }).context),
      "STATE_CONFLICT",
      "batch_not_paused",
    );
  }
  assertEquals(
    (await startNextInBatch(stand({ state: "waiting" }).context)).state,
    "running",
  );
  for (
    const state of ["paused", "stopping", "finishing", "finished", "stopped"]
  ) {
    await refusedWith(
      () => startNextInBatch(stand({ state }).context),
      "STATE_CONFLICT",
      "batch_not_waiting",
    );
  }
  assertEquals(
    (await finishBatch(stand({ state: "waiting" }).context)).state,
    "finished",
  );
  assertEquals(
    (await finishBatch(stand({ state: "finished" }).context)).state,
    "finished",
  );
  for (
    const state of ["running", "paused", "stopping", "finishing", "stopped"]
  ) {
    await refusedWith(
      () => finishBatch(stand({ state }).context),
      "STATE_CONFLICT",
      "batch_not_waiting",
    );
  }
});

Deno.test("stop: nothing new starts either way, and the batch is Stopping until the current issue has ended", async () => {
  const working = [{ state: "started" }];
  // Let it finish: Stopping, with no cancel asked for.
  const letFinish = await stopBatch(stand({ issues: working }).context, {
    cancelCurrent: false,
  });
  assertEquals(letFinish.state, "stopping");
  assertEquals(letFinish.stopCancelledCurrent, false);
  // Cancel it: still Stopping, and the request to cancel is recorded for the supervisor.
  // It is not Stopped until the run has really ended.
  const cancel = await stopBatch(stand({ issues: working }).context, {
    cancelCurrent: true,
  });
  assertEquals(cancel.state, "stopping");
  assertEquals(cancel.stopCancelledCurrent, true);
  // Nothing is running: it simply stops, whatever was asked, and cancels nothing.
  for (const cancelCurrent of [false, true]) {
    const idle = await stopBatch(
      stand({ issues: [{ state: "merged" }] }).context,
      { cancelCurrent },
    );
    assertEquals(idle.state, "stopped");
    assertEquals(idle.stopCancelledCurrent, false);
  }
  // Stopping can be escalated to a cancel once, and any repeat changes nothing.
  const stopping = stand({ state: "stopping", issues: working });
  assertEquals(
    (await stopBatch(stopping.context, { cancelCurrent: false })).state,
    "stopping",
  );
  assertEquals(stopping.writes.length, 0);
  const escalated = await stopBatch(stopping.context, { cancelCurrent: true });
  assertEquals(escalated.state, "stopping");
  assertEquals(escalated.stopCancelledCurrent, true);
  assertEquals(stopping.writes.length, 1);
  await stopBatch(stopping.context, { cancelCurrent: true });
  assertEquals(stopping.writes.length, 1);
  // Already stopped is a repeat; a batch that finished on its own is not stoppable.
  assertEquals(
    (await stopBatch(stand({ state: "stopped" }).context, {
      cancelCurrent: true,
    })).state,
    "stopped",
  );
  await refusedWith(
    () =>
      stopBatch(stand({ state: "finished" }).context, { cancelCurrent: false }),
    "STATE_CONFLICT",
    "batch_ended",
  );
});

Deno.test("what a control does is audited by name and states, never by more", async () => {
  const { context, audits } = stand({ state: "running" });
  await pauseBatch(context);
  assertEquals(audits.length, 1);
  assertEquals(audits[0][2], "batches.pause");
  assertEquals(audits[0][3], "batch");
  const details = JSON.parse(audits[0][8] as string);
  assertEquals(details.from, "running");
  assertEquals(details.to, "paused");
  // Only the repository and the two states: nothing else rides along.
  assertEquals(Object.keys(details).sort(), ["from", "repositoryId", "to"]);
});
