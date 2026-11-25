import { assert, assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";
import { seedAttempt } from "../helpers/ticket-admission/seed-attempt.ts";

type Attempt = {
  id: string;
  jobId: string;
  taskId: string | null;
  taskTitle: string | null;
  stepKey: string | null;
  jobAction: string;
  codingAgent: string | null;
  model: string | null;
  status: string;
  leaseState: string;
};
type Page = { items: Attempt[]; nextCursor: string | null };
type Host = { id: string; activeAttemptCount: number };

Deno.test("a machine's attempts split into now, needs attention and finished, and its count is the scheduler's (#70)", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 961, labels: [EXECUTE_LABEL] });
    fx.reader.setIssue({ number: 962, labels: [EXECUTE_LABEL] });
    const first = await fx.admit(sourceId, { number: 961, intent: "start" });
    const second = await fx.admit(sourceId, { number: 962, intent: "start" });
    const attempt = await seedAttempt(
      fx,
      first.request!.workflowRunId!,
      ["steer"],
      "Work test worker",
    );
    const other = await seedAttempt(
      fx,
      second.request!.workflowRunId!,
      ["steer"],
      "Other test worker",
    );
    const extra: string[] = [];
    try {
      const list = async (state: string, query = "", hostId = attempt.hostId) =>
        await read<Page>(
          await ticketCall(
            fx,
            "GET",
            `/v1/workers/${hostId}/attempts?state=${state}${query}`,
          ),
          200,
        );
      const ids = async (state: string) =>
        (await list(state)).items.map((item) => item.id);
      const count = async (hostId = attempt.hostId) =>
        (await read<Host>(
          await ticketCall(fx, "GET", `/v1/workers/${hostId}`),
          200,
        )).activeAttemptCount;
      const set = (sql: string) =>
        fx.owner.query(
          `update bakery.job_attempts set ${sql} where id = $1`,
          [attempt.attemptId],
        );

      const [now] = (await list("now")).items;
      assertEquals(now.id, attempt.attemptId);
      assertEquals(now.leaseState, "active");
      const job = (await fx.owner.query<
        {
          action: string;
          step_key: string;
          title: string;
          task_id: string;
          harness: string | null;
          model: string | null;
        }
      >(
        `select job.action, step.step_key, task.title, task.id as task_id,
                job.agent_config->>'harness' as harness,
                job.billing->>'model' as model
           from bakery.jobs job
           join bakery.run_steps step on step.id = job.run_step_id
           join bakery.workflow_runs run on run.id = step.run_id
           join bakery.tasks task on task.id = run.task_id
          where job.id = $1`,
        [now.jobId],
      )).rows[0];
      assertEquals(
        [now.taskId, now.taskTitle, now.stepKey, now.jobAction, now.model],
        [job.task_id, job.title, job.step_key, job.action, job.model],
      );
      assertEquals(now.codingAgent, job.harness);
      assertEquals(await ids("needs_attention"), []);
      assertEquals(await ids("finished"), []);
      assertEquals(await count(), 1);
      assertEquals(await count(other.hostId), 1);

      for (const status of ["leased", "canceling"]) {
        await set(`status = '${status}'`);
        assertEquals(await ids("now"), [attempt.attemptId], status);
        assertEquals(await count(), 1, `${status} holds a slot`);
      }
      await set("lease_expires_at = clock_timestamp() - interval '1 second'");
      assertEquals(await ids("now"), []);
      assertEquals(
        (await list("needs_attention")).items[0].leaseState,
        "expired",
      );
      assertEquals(await count(), 0, "an expired lease holds no slot");
      await set("lease_expires_at = clock_timestamp() + interval '5 minutes'");
      for (
        const [status, lease] of [["quarantined", "unknown"], ["lost", "lost"]]
      ) {
        await set(`status = '${status}'`);
        const [row] = (await list("needs_attention")).items;
        assertEquals([row.id, row.leaseState], [attempt.attemptId, lease]);
        assertEquals(await count(), 0, `${status} holds no slot`);
      }
      for (const status of ["completed", "failed", "canceled"]) {
        await set(`status = '${status}', ended_at = clock_timestamp()`);
        const [row] = (await list("finished")).items;
        assertEquals([row.id, row.leaseState], [attempt.attemptId, "closed"]);
        assertEquals(await ids("now"), []);
        assertEquals(await ids("needs_attention"), []);
      }
      assertEquals(
        await count(other.hostId),
        1,
        "the other machine is its own",
      );
      assertEquals(
        (await list("now", "", other.hostId)).items.map((item) => item.id),
        [other.attemptId],
      );

      const conversation = (await fx.owner.query<{ conversation_id: string }>(
        `select task.conversation_id from bakery.jobs job
           join bakery.run_steps step on step.id = job.run_step_id
           join bakery.workflow_runs run on run.id = step.run_id
           join bakery.tasks task on task.id = run.task_id
          where job.id = $1`,
        [now.jobId],
      )).rows[0].conversation_id;
      const sibling = crypto.randomUUID();
      await fx.owner.query(
        `insert into bakery.tasks (id, organization_id, application_id,
           conversation_id, title, task_type, status, priority, created_by,
           created_at)
         values ($1, $2, $3, $4, 'Later task on the same conversation',
           'feature', 'draft', 50, $5, clock_timestamp() + interval '1 hour')`,
        [
          sibling,
          fx.organizationId,
          fx.applicationId,
          conversation,
          fx.adminId,
        ],
      );
      const message = crypto.randomUUID();
      await fx.owner.query(
        `insert into bakery.messages (id, organization_id, conversation_id,
           message_type, body, client_message_id, sequence, intent)
         values ($1, $2, $3, 'human', 'go', $4,
           (select coalesce(max(sequence), 0) + 1 from bakery.messages
             where conversation_id = $3), 'agent_request')`,
        [message, fx.organizationId, conversation, `proof-${message}`],
      );
      const turn = crypto.randomUUID();
      await fx.owner.query(
        `insert into bakery.conversation_turns (id, organization_id,
           conversation_id, trigger_message_id, status)
         values ($1, $2, $3, $4, 'completed')`,
        [turn, fx.organizationId, conversation, message],
      );
      const originalStep = (await fx.owner.query<{ run_step_id: string }>(
        "select run_step_id from bakery.jobs where id = $1",
        [now.jobId],
      )).rows[0].run_step_id;
      await fx.owner.query(
        `update bakery.jobs set run_step_id = null, conversation_turn_id = $2,
           action = 'coordinator.turn' where id = $1`,
        [now.jobId, turn],
      );
      const turnRows = (await list("finished")).items;
      assertEquals(
        turnRows.length,
        1,
        "one row though two tasks share the conversation",
      );
      assertEquals(
        [
          turnRows[0].taskId,
          turnRows[0].taskTitle,
          turnRows[0].stepKey,
          turnRows[0].jobAction,
        ],
        [job.task_id, job.title, null, "coordinator.turn"],
      );
      await fx.owner.query(
        `update bakery.jobs set conversation_turn_id = null,
           action = 'repository.inspect' where id = $1`,
        [now.jobId],
      );
      const [taskless] = (await list("finished")).items;
      assertEquals(
        [
          taskless.id,
          taskless.taskId,
          taskless.taskTitle,
          taskless.stepKey,
          taskless.jobAction,
        ],
        [attempt.attemptId, null, null, null, "repository.inspect"],
      );
      await fx.owner.query(
        `update bakery.jobs set run_step_id = $2, action = $3 where id = $1`,
        [now.jobId, originalStep, job.action],
      );
      await fx.owner.query(
        "delete from bakery.conversation_turns where id = $1",
        [turn],
      );
      await fx.owner.query("delete from bakery.messages where id = $1", [
        message,
      ]);
      await fx.owner.query("delete from bakery.tasks where id = $1", [sibling]);

      const stale = crypto.randomUUID();
      extra.push(stale);
      await fx.owner.query(
        `insert into bakery.job_attempts (id, organization_id, job_id,
           worker_host_id, worker_session_id, worker_session_generation,
           attempt_no, fence, lease_token_hash, lease_expires_at, status)
         select $1, organization_id, job_id, worker_host_id, worker_session_id,
                0, 2, 2, $2, clock_timestamp() + interval '5 minutes', 'running'
           from bakery.job_attempts where id = $3`,
        [stale, `lease-${stale}`, attempt.attemptId],
      );
      const [superseded] = (await list("needs_attention")).items;
      assertEquals([superseded.id, superseded.leaseState], [stale, "unknown"]);
      assertEquals(
        await count(),
        1,
        "the scheduler still counts its live lease",
      );

      for (let n = 3; n <= 5; n++) {
        const id = crypto.randomUUID();
        extra.push(id);
        await fx.owner.query(
          `insert into bakery.job_attempts (id, organization_id, job_id,
             worker_host_id, worker_session_id, worker_session_generation,
             attempt_no, fence, lease_token_hash, lease_expires_at, status,
             ended_at, created_at)
           select $1, organization_id, job_id, worker_host_id, worker_session_id,
                  0, $2::int, $2::int, $3, clock_timestamp(), 'completed',
                  clock_timestamp(), clock_timestamp() + make_interval(secs => $2::int)
             from bakery.job_attempts where id = $4`,
          [id, n, `lease-${id}`, attempt.attemptId],
        );
      }
      const all = await ids("finished");
      assertEquals(all.length, 4);
      const one = await list("finished", "&limit=1");
      assertEquals(one.items.map((item) => item.id), [all[0]]);
      assert(one.nextCursor !== null);
      const seen = [...one.items];
      let cursor: string | null = one.nextCursor;
      while (cursor !== null) {
        const page: Page = await list(
          "finished",
          `&limit=1&cursor=${encodeURIComponent(cursor)}`,
        );
        seen.push(...page.items);
        cursor = page.nextCursor;
      }
      assertEquals(seen.map((item) => item.id), all);

      const crossState = await ticketCall(
        fx,
        "GET",
        `/v1/workers/${attempt.hostId}/attempts?state=now&limit=1&cursor=${
          encodeURIComponent(one.nextCursor!)
        }`,
      );
      assertEquals(crossState.status, 400, await crossState.text());
      const crossHost = await ticketCall(
        fx,
        "GET",
        `/v1/workers/${other.hostId}/attempts?state=finished&limit=1&cursor=${
          encodeURIComponent(one.nextCursor!)
        }`,
      );
      assertEquals(crossHost.status, 400, await crossHost.text());
      for (
        const bad of [
          "",
          "?state=running",
          "?state=now&limit=0",
          "?state=now&state=finished",
        ]
      ) {
        const response = await ticketCall(
          fx,
          "GET",
          `/v1/workers/${attempt.hostId}/attempts${bad}`,
        );
        assertEquals(response.status, 400, `${bad}: ${await response.text()}`);
      }

      const raw = JSON.stringify(await list("finished"));
      for (
        const secret of ["lease-", "fence", "agent_config", "billing", "result"]
      ) {
        assert(!raw.includes(secret), `the page carries no ${secret}`);
      }
      const missing = await ticketCall(
        fx,
        "GET",
        `/v1/workers/${crypto.randomUUID()}/attempts?state=now`,
      );
      assertEquals(missing.status, 404, await missing.text());
    } finally {
      for (const id of extra) {
        await fx.owner.query("delete from bakery.job_attempts where id = $1", [
          id,
        ]);
      }
      await attempt.cleanup();
      await other.cleanup();
    }
  }));
