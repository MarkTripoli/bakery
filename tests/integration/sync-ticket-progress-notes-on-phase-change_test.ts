import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EXECUTE_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  PROGRESS_RETRY_SECONDS,
  syncSourceProgress,
} from "../../apps/server/src/modules/work/ticket-progress-sync.ts";
import type {
  TicketStatusChange,
  TicketStatusWriter,
} from "../../apps/server/src/modules/work/ticket-statuses.ts";
import type {
  TicketLabelChange,
  TicketLabelResult,
  TicketLabelWriter,
} from "../../apps/server/src/modules/work/ticket-labels.ts";

/** Records the label changes the sync asks for, and fails the next one when told to. */
function memoryLabels(): TicketLabelWriter & {
  changes: { add: readonly string[]; remove: readonly string[] }[];
  failNext: string | null;
} {
  const writer = {
    changes: [] as { add: readonly string[]; remove: readonly string[] }[],
    failNext: null as string | null,
    apply(change: TicketLabelChange): Promise<TicketLabelResult> {
      if (writer.failNext !== null) {
        const problemCode = writer.failNext;
        writer.failNext = null;
        return Promise.resolve({ kind: "failed", problemCode });
      }
      writer.changes.push({ add: change.add, remove: change.remove });
      return Promise.resolve({ kind: "applied" });
    },
  };
  return writer;
}

/**
 * Issue 32: Bakery keeps one status note on a ticket true as its request moves
 * through phases. It writes on a phase change only, never invents delivery,
 * keeps the title off a public ticket, and a note that did not post leaves
 * the request and the last good phase alone.
 */

async function admitted(
  fx: TicketFixture,
  number: number,
  completion = "merged",
) {
  const sourceId = await fx.insertSource({
    policy: fx.policy({ completion: completion as "merged" }),
  });
  fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
  const result = await fx.admit(sourceId, { number, intent: "start" });
  return { sourceId, request: result.request!, ticketId: result.ticketId! };
}

const sync = (
  fx: TicketFixture,
  sourceId: string,
  labels?: TicketLabelWriter,
) =>
  syncSourceProgress(
    { database: fx.runtime, writer: fx.notes, labels },
    {
      organizationId: fx.organizationId,
      sourceId,
      signal: new AbortController().signal,
    },
  );

async function link(fx: TicketFixture, requestId: string) {
  const row = await fx.owner.query<{
    sync_health: string;
    status_comment_external_id: string | null;
    last_synced_run_revision: number | null;
    last_problem_code: string | null;
  }>(
    `select link.sync_health, link.status_comment_external_id,
            link.last_synced_run_revision, link.last_problem_code
       from bakery.ticket_task_links as link
       join bakery.ticket_requests as request
         on request.ticket_task_link_id = link.id
      where request.id = $1`,
    [requestId],
  );
  return row.rows[0];
}

const setRun = (
  fx: TicketFixture,
  runId: string | null,
  status: string,
  finishedMinutesAgo?: number,
) =>
  fx.owner.query(
    `update bakery.workflow_runs
        set status = $3,
            finished_at = case when $4::integer is null then null
              else now() - make_interval(mins => $4::integer) end
      where organization_id = $1 and id = $2`,
    [fx.organizationId, runId, status, finishedMinutesAgo ?? null],
  );

const setVisibility = (fx: TicketFixture, visibility: string) =>
  fx.owner.query(
    "update bakery.external_tickets set visibility = $2 where organization_id = $1",
    [fx.organizationId, visibility],
  );

Deno.test("the note is written on a phase change only, rewritten in place, and the public one carries no task title", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request, ticketId } = await admitted(fx, 1101);
    await setVisibility(fx, "public");
    assertEquals(await sync(fx, sourceId), {
      posted: 1,
      failed: 0,
      skipped: 0,
    });
    assertEquals(fx.notes.posts.length, 1);
    const first = await link(fx, request.id);
    assertEquals(first.sync_health, "healthy");
    assert(first.status_comment_external_id !== null);
    const body = fx.notes.posts[0].body;
    assertStringIncludes(body, "Queued");
    const title = (await fx.owner.query<{ title: string }>(
      "select title from bakery.tasks where id = $1",
      [request.taskId],
    )).rows[0].title;
    assertEquals(
      body.includes(title),
      false,
      "public note names no task title",
    );

    // The same phase again writes nothing.
    assertEquals((await sync(fx, sourceId)).posted, 0);
    assertEquals(fx.notes.posts.length, 1);

    // A new phase rewrites the same comment.
    await setRun(fx, request.workflowRunId, "running");
    assertEquals((await sync(fx, sourceId)).posted, 1);
    assertEquals(fx.notes.posts.length, 2);
    assertEquals(
      fx.notes.posts[1].existingExternalId,
      first.status_comment_external_id,
    );
    assertStringIncludes(fx.notes.posts[1].body, "Working");
    assertEquals(fx.notes.comments.size, 1, "one status comment per link");

    // A private ticket may name the task.
    await setVisibility(fx, "private");
    await setRun(fx, request.workflowRunId, "paused");
    await sync(fx, sourceId);
    assertStringIncludes(fx.notes.posts.at(-1)!.body, title.slice(0, 20));
    void ticketId;
  }));

Deno.test("a finished run waits for its pull request and the merge, then reads delivered", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request } = await admitted(fx, 1102);
    await setRun(fx, request.workflowRunId, "completed", 0);
    await sync(fx, sourceId);
    assertStringIncludes(
      fx.notes.posts.at(-1)!.body,
      "waiting for its pull request.",
    );
    await fx.registerPullRequest({
      sourceId,
      taskId: request.taskId,
      number: 11020,
      status: "open",
    });
    await sync(fx, sourceId);
    const waiting = fx.notes.posts.at(-1)!.body;
    assertStringIncludes(waiting, "waiting for its pull request to merge");
    assertStringIncludes(waiting, "Pull request #11020: open");
    assertEquals(waiting.includes("Delivered"), false);
    await fx.owner.query(
      "update bakery.pull_requests set status = 'merged' where organization_id = $1 and provider_number = 11020",
      [fx.organizationId],
    );
    await sync(fx, sourceId);
    assertStringIncludes(fx.notes.posts.at(-1)!.body, "Delivered.");
  }));

Deno.test("a note that did not post keeps the request and the last good phase, and is retried after the wait", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request } = await admitted(fx, 1103);
    const labels = memoryLabels();
    await sync(fx, sourceId, labels); // queued, posted, labelled
    const good = await link(fx, request.id);
    await setRun(fx, request.workflowRunId, "running");
    fx.notes.next.push({ kind: "failed", problemCode: "grant_missing" });
    assertEquals((await sync(fx, sourceId, labels)).failed, 1);
    assertEquals(
      labels.changes,
      [{ add: ["bakery:queued"], remove: [] }],
      "a note that failed leaves Bakery's label as it was",
    );
    const failed = await link(fx, request.id);
    assertEquals(failed.sync_health, "failed");
    assertEquals(failed.last_problem_code, "grant_missing");
    assertEquals(
      failed.last_synced_run_revision,
      good.last_synced_run_revision,
    );
    assertEquals(
      failed.status_comment_external_id,
      good.status_comment_external_id,
    );
    const stored = await fx.owner.query<{ disposition: string }>(
      "select disposition from bakery.ticket_requests where id = $1",
      [request.id],
    );
    assertEquals(
      stored.rows[0].disposition !== "failed",
      true,
      "accepted work is untouched",
    );

    // Inside the wait nothing is written.
    const before = fx.notes.posts.length;
    assertEquals((await sync(fx, sourceId, labels)).posted, 0);
    assertEquals(fx.notes.posts.length, before);
    assertEquals(labels.changes.length, 1, "nor is a label");

    // After it, the note is written again and the link is healthy.
    await fx.owner.query(
      `update bakery.ticket_task_links
          set updated_at = now() - make_interval(secs => $1)
        where organization_id = $2`,
      [PROGRESS_RETRY_SECONDS + 5, fx.organizationId],
    );
    assertEquals((await sync(fx, sourceId, labels)).posted, 1);
    assertEquals(labels.changes.at(-1), {
      add: ["bakery:working"],
      remove: ["bakery:queued"],
    });
    const healed = await link(fx, request.id);
    assertEquals(healed.sync_health, "healthy");
    assertEquals(healed.last_problem_code, null);
    assertEquals(
      healed.last_synced_run_revision !== good.last_synced_run_revision,
      true,
    );
  }));

Deno.test("Bakery's progress label follows the phase: the new one is added before the old one comes off, and only Bakery's labels change", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request } = await admitted(fx, 1104);
    const labels = memoryLabels();
    await sync(fx, sourceId, labels);
    await setRun(fx, request.workflowRunId, "running");
    await sync(fx, sourceId, labels);
    // Finished with no pull request yet, then with one open: both read "review".
    await setRun(fx, request.workflowRunId, "completed", 0);
    await sync(fx, sourceId, labels);
    await fx.registerPullRequest({
      sourceId,
      taskId: request.taskId,
      number: 11040,
      status: "open",
    });
    await sync(fx, sourceId, labels);
    await fx.owner.query(
      "update bakery.pull_requests set status = 'merged' where organization_id = $1 and provider_number = 11040",
      [fx.organizationId],
    );
    await sync(fx, sourceId, labels);
    assertEquals(labels.changes, [
      { add: ["bakery:queued"], remove: [] },
      { add: ["bakery:working"], remove: ["bakery:queued"] },
      { add: ["bakery:review"], remove: ["bakery:working"] },
      // The same label for the next phase is not written again.
      { add: ["bakery:done"], remove: ["bakery:review"] },
    ]);
  }));

Deno.test("a label that did not change leaves the one comment alone, and the next sync writes the label again", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request } = await admitted(fx, 1105);
    const labels = memoryLabels();
    await sync(fx, sourceId, labels);
    const first = await link(fx, request.id);
    await setRun(fx, request.workflowRunId, "running");
    labels.failNext = "grant_missing";
    assertEquals((await sync(fx, sourceId, labels)).failed, 1);
    const failed = await link(fx, request.id);
    assertEquals(failed.sync_health, "failed");
    assertEquals(failed.last_problem_code, "grant_missing");
    // The note posted, so its id is kept and no second comment follows.
    assertEquals(
      failed.status_comment_external_id,
      first.status_comment_external_id,
    );
    assertEquals(
      failed.last_synced_run_revision,
      first.last_synced_run_revision,
    );
    await fx.owner.query(
      `update bakery.ticket_task_links
          set updated_at = now() - make_interval(secs => $1)
        where organization_id = $2`,
      [PROGRESS_RETRY_SECONDS + 5, fx.organizationId],
    );
    assertEquals((await sync(fx, sourceId, labels)).posted, 1);
    assertEquals(fx.notes.comments.size, 1, "one status comment");
    assertEquals(labels.changes.at(-1), {
      add: ["bakery:working"],
      remove: ["bakery:queued"],
    });
  }));

Deno.test("a first note that posted but whose label failed is rewritten in place on the retry, never posted twice", () =>
  withTicketFixture(async (fx) => {
    const { sourceId } = await admitted(fx, 1106);
    const labels = memoryLabels();
    labels.failNext = "grant_missing";
    assertEquals((await sync(fx, sourceId, labels)).failed, 1);
    assertEquals(fx.notes.comments.size, 1, "the first note posted");
    await fx.owner.query(
      `update bakery.ticket_task_links
          set updated_at = now() - make_interval(secs => $1)
        where organization_id = $2`,
      [PROGRESS_RETRY_SECONDS + 5, fx.organizationId],
    );
    assertEquals((await sync(fx, sourceId, labels)).posted, 1);
    assertEquals(
      fx.notes.comments.size,
      1,
      "the retry rewrites, it does not post a second comment",
    );
    assertEquals(
      fx.notes.posts.at(-1)!.existingExternalId !== null,
      true,
      "the retry carries the first comment's id",
    );
    assertEquals(labels.changes.at(-1), { add: ["bakery:queued"], remove: [] });
  }));

Deno.test("two syncs at once write one note and one label change", () =>
  withTicketFixture(async (fx) => {
    const { sourceId } = await admitted(fx, 1107);
    const labels = memoryLabels();
    const [first, second] = await Promise.all([
      sync(fx, sourceId, labels),
      sync(fx, sourceId, labels),
    ]);
    assertEquals(
      first.posted + second.posted,
      1,
      JSON.stringify([first, second]),
    );
    assertEquals(fx.notes.posts.length, 1);
    assertEquals(labels.changes.length, 1);
  }));

Deno.test("deployed_healthy: a closed pull request, a merged one with no deployment and a closed issue are never read as delivered", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, request, ticketId } = await admitted(
      fx,
      1108,
      "deployed_healthy",
    );
    const labels = memoryLabels();
    await setRun(fx, request.workflowRunId, "completed", 11);
    await fx.registerPullRequest({
      sourceId,
      taskId: request.taskId,
      number: 11080,
      status: "open",
    });
    await sync(fx, sourceId, labels);
    await fx.owner.query(
      "update bakery.pull_requests set status = 'closed' where organization_id = $1 and provider_number = 11080",
      [fx.organizationId],
    );
    await sync(fx, sourceId, labels);
    assertEquals(
      fx.notes.posts.at(-1)!.body.includes("Delivered"),
      false,
      fx.notes.posts.at(-1)!.body,
    );
    await fx.owner.query(
      "update bakery.pull_requests set status = 'merged' where organization_id = $1 and provider_number = 11080",
      [fx.organizationId],
    );
    await fx.owner.query(
      "update bakery.external_tickets set state = 'closed' where organization_id = $1",
      [fx.organizationId],
    );
    await sync(fx, sourceId, labels);
    const last = fx.notes.posts.at(-1)!.body;
    assertEquals(last.includes("Delivered"), false, last);
    assertStringIncludes(last, "waiting for a healthy release");
    assertEquals(
      labels.changes.some((change) => change.add.includes("bakery:done")),
      false,
      JSON.stringify(labels.changes),
    );
    const rechecked = await fx.recheck(ticketId);
    assertEquals(
      rechecked.request?.disposition === "completed",
      false,
      "the request does not complete without a deployment",
    );
  }));

function memoryStatuses(): TicketStatusWriter & {
  changes: TicketStatusChange[];
} {
  const writer = {
    changes: [] as TicketStatusChange[],
    set(change: TicketStatusChange) {
      writer.changes.push(change);
      return Promise.resolve({ kind: "set" as const });
    },
  };
  return writer;
}

async function deliverOnce(
  fx: TicketFixture,
  number: number,
  outcomeStatuses?: { delivered?: string },
) {
  const sourceId = await fx.insertSource({
    policy: outcomeStatuses === undefined
      ? fx.policy()
      : { ...fx.policy(), outcomeStatuses },
  });
  fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
  const request = (await fx.admit(sourceId, { number, intent: "start" }))
    .request!;
  const statuses = memoryStatuses();
  const syncWithStatuses = () =>
    syncSourceProgress(
      { database: fx.runtime, writer: fx.notes, statuses },
      {
        organizationId: fx.organizationId,
        sourceId,
        signal: new AbortController().signal,
      },
    );
  await syncWithStatuses();
  assertEquals(statuses.changes.length, 0, "nothing is set before delivery");
  await setRun(fx, request.workflowRunId, "completed", 0);
  await syncWithStatuses();
  await syncWithStatuses();
  assertStringIncludes(fx.notes.posts.at(-1)!.body, "Delivered.");
  return { request, statuses };
}

Deno.test("a delivered request sets the policy's delivered status once, and none without it", () =>
  withTicketFixture(async (fx) => {
    const named = await deliverOnce(fx, 1201, {
      delivered: "closed:completed",
    });
    assertEquals(named.statuses.changes.length, 1);
    assertEquals(named.statuses.changes[0].statusId, "closed:completed");
    assertEquals(
      named.statuses.changes[0].idempotencyKey,
      `${named.request.id}:status:delivered`,
    );
    const absent = await deliverOnce(fx, 1202);
    assertEquals(absent.statuses.changes.length, 0);
  }));
