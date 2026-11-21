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

const sync = (fx: TicketFixture, sourceId: string) =>
  syncSourceProgress(
    { database: fx.runtime, writer: fx.notes },
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
    await sync(fx, sourceId); // queued, posted
    const good = await link(fx, request.id);
    await setRun(fx, request.workflowRunId, "running");
    fx.notes.next.push({ kind: "failed", problemCode: "grant_missing" });
    assertEquals((await sync(fx, sourceId)).failed, 1);
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
    assertEquals((await sync(fx, sourceId)).posted, 0);
    assertEquals(fx.notes.posts.length, before);

    // After it, the note is written again and the link is healthy.
    await fx.owner.query(
      `update bakery.ticket_task_links
          set updated_at = now() - make_interval(secs => $1)
        where organization_id = $2`,
      [PROGRESS_RETRY_SECONDS + 5, fx.organizationId],
    );
    assertEquals((await sync(fx, sourceId)).posted, 1);
    const healed = await link(fx, request.id);
    assertEquals(healed.sync_health, "healthy");
    assertEquals(healed.last_problem_code, null);
    assertEquals(
      healed.last_synced_run_revision !== good.last_synced_run_revision,
      true,
    );
  }));
