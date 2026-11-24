import { assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

type Delivery = {
  taskId: string;
  runId: string | null;
  state: string;
  stepKey: string | null;
  approvalFor: string | null;
  environment: string | null;
  releaseStatus: string | null;
  pullRequestNumber: number | null;
  targetBranch: string | null;
  stopReason: string | null;
  mergedBranch: string | null;
  pausedBy: string | null;
  pausedByName: string | null;
  pausedReason: string | null;
};

type Ticket = { id: string; delivery?: Delivery | null };

type Started = { ticketId: string; taskId: string; runId: string };

async function start(
  fx: TicketFixture,
  sourceId: string,
  number: number,
): Promise<Started> {
  fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
  const admitted = await fx.admit(sourceId, { number });
  const taskId = admitted.request!.taskId;
  const run = await fx.owner.query<{ id: string }>(
    `select coalesce(request.workflow_run_id, task.current_run_id) as id
       from bakery.ticket_requests as request
       join bakery.tasks as task
         on task.organization_id = request.organization_id
        and task.id = $3
      where request.organization_id = $1 and request.id = $2`,
    [fx.organizationId, admitted.request!.id, taskId],
  );
  return { ticketId: admitted.ticketId!, taskId, runId: run.rows[0].id };
}

async function setRun(
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

async function ask(
  fx: TicketFixture,
  taskId: string,
  kind: "question" | "approval",
  expired = false,
): Promise<void> {
  await fx.owner.query(
    `insert into bakery.questions (
       organization_id, kind, conversation_id, task_id, generation, prompt,
       status, expires_at, subject_type, subject_id
     )
     select organization_id, $3, conversation_id, id, 1, 'Ready?', 'open',
            case when $4 then now() - interval '1 minute' else null end,
            case when $3 = 'approval' then 'plan_revision' else null end,
            case when $3 = 'approval' then gen_random_uuid() else null end
       from bakery.tasks where organization_id = $1 and id = $2`,
    [fx.organizationId, taskId, kind, expired],
  );
}

async function merge(
  fx: TicketFixture,
  taskId: string,
  number: number,
): Promise<void> {
  await fx.owner.query(
    `insert into bakery.pull_requests (
       id, organization_id, task_id, repository_id, provider_number, url,
       head_sha, base_sha, status, merged_sha
     )
     select gen_random_uuid(), organization_id, id, repository_id, $3::integer,
            'https://github.com/example/repo/pull/' || $3::integer::text,
            repeat('a', 40), repeat('b', 40), 'merged', repeat('c', 40)
       from bakery.tasks where organization_id = $1 and id = $2`,
    [fx.organizationId, taskId, number],
  );
}

async function landed(
  fx: TicketFixture,
  taskId: string,
  number: number,
): Promise<void> {
  await merge(fx, taskId, number);
  await fx.owner.query(
    `insert into bakery.pull_request_merge_attempts (
       organization_id, pull_request_id, repository_id, provider_number,
       base_branch, expected_head_sha, merge_method, state, requested_by_id,
       request_id, trace_id
     )
     select opened.organization_id, opened.id, opened.repository_id,
            opened.provider_number, 'release/2', repeat('a', 40), 'squash',
            'merged', task.created_by, 'request-m', 'trace-m'
       from bakery.pull_requests as opened
       join bakery.tasks as task
         on task.organization_id = opened.organization_id
        and task.id = opened.task_id
      where opened.organization_id = $1 and opened.task_id = $2`,
    [fx.organizationId, taskId],
  );
}

async function decide(
  fx: TicketFixture,
  runId: string,
  decision: string,
  reason: string,
): Promise<void> {
  await fx.owner.query(
    `insert into bakery.delivery_decisions (
       id, organization_id, run_id, ordinal, decision, reason, head_sha,
       failed_checks, blocking_fingerprints, limits
     ) values (gen_random_uuid(), $1, $2, 1, $3, $4, repeat('a', 40),
       '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [fx.organizationId, runId, decision, reason],
  );
}

async function suspend(fx: TicketFixture, started: Started): Promise<void> {
  await fx.owner.query(
    `update bakery.ticket_requests
        set disposition = 'suspended', disposition_reason = 'held',
            pause_requested_at = now()
      where organization_id = $1 and external_ticket_id = $2`,
    [fx.organizationId, started.ticketId],
  );
}

async function reject(fx: TicketFixture, ticketId: string): Promise<void> {
  await fx.owner.query(
    `update bakery.ticket_requests
        set disposition = 'rejected', disposition_reason = 'ticket_closed',
            updated_at = now(), version = version + 1
      where organization_id = $1 and external_ticket_id = $2
        and disposition <> 'rejected'`,
    [fx.organizationId, ticketId],
  );
}

async function pauseBatch(
  fx: TicketFixture,
  started: Started,
): Promise<string> {
  const result = await fx.owner.query<{ display_name: string }>(
    `with request as (
       select request.id, task.repository_id, task.created_by
         from bakery.ticket_requests as request
         join bakery.tasks as task
           on task.organization_id = request.organization_id and task.id = $3
        where request.organization_id = $1 and request.external_ticket_id = $2
     ), batch as (
       insert into bakery.batches (
         organization_id, repository_id, started_by, max_issues, max_hours,
         max_spend_usd, continue_mode, state, pause_reason, paused_by,
         paused_at
       )
       select $1, repository_id, created_by, 5, 4, 10, 'carry_on', 'paused',
              'paused_by_person', created_by, now()
         from request
       returning id
     ), member as (
       insert into bakery.batch_issues (
         organization_id, batch_id, position, external_ticket_id, state,
         ticket_request_id
       )
       select $1, batch.id, 1, $2, 'started', request.id
         from batch, request
     )
     select who.display_name from request
       join bakery.principals as who on who.id = request.created_by`,
    [fx.organizationId, started.ticketId, started.taskId],
  );
  return result.rows[0].display_name;
}

async function deploy(fx: TicketFixture, started: Started): Promise<void> {
  await fx.owner.query(
    `insert into bakery.deployments (
       organization_id, repository_id, run_id, environment, commit_sha,
       artifact_digest, status, requested_by_id, request_id, trace_id
     )
     select task.organization_id, task.repository_id, $3, 'production',
            repeat('c', 40), repeat('d', 64), 'healthy', task.created_by,
            'request-1', 'trace-1'
       from bakery.tasks as task
      where task.organization_id = $1 and task.id = $2`,
    [fx.organizationId, started.taskId, started.runId],
  );
}

Deno.test("issue 60: one issues page carries each issue's delivery line", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const working = await start(fx, sourceId, 601);
    const waiting = await start(fx, sourceId, 602);
    const asked = await start(fx, sourceId, 603);
    const lapsed = await start(fx, sourceId, 604);
    const failed = await start(fx, sourceId, 605);
    const merged = await start(fx, sourceId, 606);
    const released = await start(fx, sourceId, 607);
    const paused = await start(fx, sourceId, 608);
    const moved = await start(fx, sourceId, 610);
    const halted = await start(fx, sourceId, 611);
    const done = await start(fx, sourceId, 612);
    const shipped = await start(fx, sourceId, 613);
    const held = await start(fx, sourceId, 614);
    const parked = await start(fx, sourceId, 615);

    for (const each of [working, waiting, asked, lapsed, merged, released]) {
      await setRun(fx, each.runId, "running");
    }
    await ask(fx, waiting.taskId, "approval");
    await ask(fx, asked.taskId, "question");
    await ask(fx, lapsed.taskId, "question", true);
    await setRun(fx, failed.runId, "failed");
    await ask(fx, moved.taskId, "question", true);
    await fx.owner.query(
      `update bakery.questions set created_at = now() - interval '1 hour'
        where organization_id = $1 and task_id = $2`,
      [fx.organizationId, moved.taskId],
    );
    await ask(fx, moved.taskId, "question");
    await setRun(fx, moved.runId, "running");
    await setRun(fx, paused.runId, "paused");
    await merge(fx, merged.taskId, 66);
    await merge(fx, released.taskId, 67);
    await deploy(fx, released);
    await setRun(fx, halted.runId, "running");
    await decide(fx, halted.runId, "stop", "repair_cycles_exhausted");
    await setRun(fx, done.runId, "completed");
    await setRun(fx, shipped.runId, "running");
    await landed(fx, shipped.taskId, 68);
    await setRun(fx, held.runId, "paused");
    await suspend(fx, held);
    await setRun(fx, parked.runId, "paused");
    const pauser = await pauseBatch(fx, parked);

    const list = await read<{ items: Ticket[] }>(
      await ticketCall(fx, "GET", "/v1/external-tickets?limit=25"),
      200,
    );
    await fx.owner.query(
      `delete from bakery.batches where organization_id = $1`,
      [fx.organizationId],
    );
    const byId = new Map(list.items.map((item) => [item.id, item.delivery]));
    const line = (started: Started) => {
      const delivery = byId.get(started.ticketId)!;
      assertEquals(delivery.taskId, started.taskId);
      assertEquals(delivery.runId, started.runId);
      return delivery;
    };

    assertEquals(line(working).state, "working");
    assertEquals(line(waiting).state, "approval_waiting");
    assertEquals(line(waiting).approvalFor, "plan");
    assertEquals(line(working).approvalFor, null);
    assertEquals(line(asked).state, "question_open");
    assertEquals(line(lapsed).state, "question_expired");
    assertEquals(line(failed).state, "stopped");
    assertEquals(line(moved).state, "question_open");
    assertEquals(line(paused).state, "paused");
    assertEquals(line(merged).state, "merged");
    assertEquals(line(merged).pullRequestNumber, 66);
    assertEquals(typeof line(merged).targetBranch, "string");
    assertEquals(line(merged).environment, null);
    assertEquals(line(released).state, "released");
    assertEquals(line(released).environment, "production");
    assertEquals(line(released).releaseStatus, "healthy");

    assertEquals(line(halted).state, "stopped");
    assertEquals(line(halted).stopReason, "repair_cycles_exhausted");
    assertEquals(line(failed).stopReason, null);
    assertEquals(line(working).stopReason, null);

    assertEquals(line(done).state, "finished");
    assertEquals(line(done).mergedBranch, null);

    assertEquals(line(shipped).state, "merged");
    assertEquals(line(shipped).mergedBranch, "release/2");
    assertEquals(line(merged).mergedBranch, null);
    assertEquals(line(released).mergedBranch, null);

    assertEquals(line(held).state, "paused");
    assertEquals(line(held).pausedBy, "bakery");
    assertEquals(line(held).pausedReason, "hold_label_added");
    assertEquals(line(held).pausedByName, null);
    assertEquals(line(parked).state, "paused");
    assertEquals(line(parked).pausedBy, "person");
    assertEquals(line(parked).pausedByName, pauser);
    assertEquals(line(parked).pausedReason, null);
    assertEquals(line(paused).pausedBy, null);
    assertEquals(line(paused).pausedByName, null);
    assertEquals(line(paused).pausedReason, null);
    assertEquals(line(working).pausedBy, null);

    const one = await read<Ticket>(
      await ticketCall(fx, "GET", `/v1/external-tickets/${released.ticketId}`),
      200,
    );
    assertEquals(one.delivery?.state, "released");
  }));

Deno.test("issue 60: an issue with no started work has no delivery line", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 609, labels: [] });
    await fx.admit(sourceId, { number: 609, origin: "poll" });
    const list = await read<{ items: Ticket[] }>(
      await ticketCall(fx, "GET", "/v1/external-tickets"),
      200,
    );
    assertEquals(list.items.length > 0, true);
    for (const item of list.items) assertEquals(item.delivery, null);
  }));

Deno.test("issue 60: rejected requests never supply the delivery line", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const rejectedThenStarted = await start(fx, sourceId, 616);
    await reject(fx, rejectedThenStarted.ticketId);
    const current = await start(fx, sourceId, 616);
    const rejectedOnly = await start(fx, sourceId, 617);
    await reject(fx, rejectedOnly.ticketId);

    const list = await read<{ items: Ticket[] }>(
      await ticketCall(fx, "GET", "/v1/external-tickets"),
      200,
    );
    const byId = new Map(list.items.map((item) => [item.id, item.delivery]));
    assertEquals(
      byId.get(rejectedThenStarted.ticketId)?.taskId,
      current.taskId,
    );
    assertEquals(byId.get(rejectedThenStarted.ticketId)?.runId, current.runId);
    assertEquals(byId.get(rejectedOnly.ticketId), null);
  }));
