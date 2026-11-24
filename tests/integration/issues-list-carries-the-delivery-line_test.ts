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

    for (const each of [working, waiting, asked, lapsed, merged, released]) {
      await setRun(fx, each.runId, "running");
    }
    await ask(fx, waiting.taskId, "approval");
    await ask(fx, asked.taskId, "question");
    await ask(fx, lapsed.taskId, "question", true);
    await setRun(fx, failed.runId, "failed");
    await setRun(fx, paused.runId, "paused");
    await merge(fx, merged.taskId, 66);
    await merge(fx, released.taskId, 67);
    await deploy(fx, released);

    const list = await read<{ items: Ticket[] }>(
      await ticketCall(fx, "GET", "/v1/external-tickets?limit=25"),
      200,
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
    assertEquals(line(paused).state, "paused");
    assertEquals(line(merged).state, "merged");
    assertEquals(line(merged).pullRequestNumber, 66);
    assertEquals(typeof line(merged).targetBranch, "string");
    assertEquals(line(merged).environment, null);
    assertEquals(line(released).state, "released");
    assertEquals(line(released).environment, "production");
    assertEquals(line(released).releaseStatus, "healthy");

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
