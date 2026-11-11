/**
 * Issue 82 integration lane: the `runs.create` guard and the lock order,
 * proved with real row locks. `holdRow` takes a lock in a third transaction,
 * `raceInOrder` queues the two racers behind it in a chosen order (observed in
 * pg_locks, never a sleep) and `assertNoDeadlock` fails a 40P01. Both orders
 * of every pair are run, because a wrong lock order deadlocks in one of them.
 */
import { assert, assertEquals } from "@std/assert";
import { assertNoDeadlock, holdRow, raceInOrder } from "../lock-race.ts";
import {
  ACCEPTANCE_BODY,
  EXECUTE_LABEL,
  HOLD_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";

const APPLICATION_LOCK =
  "select id from bakery.applications where organization_id = $1 and id = $2 for update";

function holdApplication(fx: TicketFixture) {
  return holdRow(fx.owner, APPLICATION_LOCK, [
    fx.organizationId,
    fx.applicationId,
  ]);
}

/** Moves a started human-approval request's task to an automatic plan stage, so `runs.create` reaches the ticket guard without needing an approval. */
async function openTaskToHandRun(fx: TicketFixture, taskId: string) {
  await fx.owner.query(
    `update bakery.tasks set approval_policy = '{"plan":"automatic"}'::jsonb
      where organization_id = $1 and id = $2`,
    [fx.organizationId, taskId],
  );
}

/** Edits an issue's body so its request's pinned digest no longer matches, then lets a duplicate call suspend it. */
async function suspendByEdit(
  fx: TicketFixture,
  sourceId: string,
  number: number,
) {
  fx.reader.setIssue({
    number,
    labels: [EXECUTE_LABEL],
    body: `${ACCEPTANCE_BODY}- and it logs\n`,
  });
  const suspended = await fx.admit(sourceId, { number, intent: "start" });
  assertEquals(suspended.request?.disposition, "suspended", `issue ${number}`);
  return suspended;
}

Deno.test("issue 82 guard: runs.create is refused for a task with a suspended request and only for that task", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    const admitWaiting = async (number: number) => {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      const result = await fx.admit(sourceId, { number, intent: "start" });
      assertEquals(result.request?.disposition, "waiting");
      await openTaskToHandRun(fx, result.request!.taskId);
      return result.request!;
    };

    // A suspended request: its task refuses a run.
    const suspended = await admitWaiting(201);
    await suspendByEdit(fx, sourceId, 201);
    const refused = await fx.startRun(suspended.taskId);
    assertEquals(refused.status, 409, refused.text);
    assert(refused.text.includes("ticket_request_suspended"), refused.text);
    assertEquals((await fx.counts(sourceId)).runs, 0);

    // A request that is not suspended does not block a hand-started run.
    const waiting = await admitWaiting(202);
    const started = await fx.startRun(waiting.taskId);
    assertEquals(started.status, 201, started.text);

    // A terminal request does not block: the slot and the guard both freed.
    const canceled = await admitWaiting(203);
    await suspendByEdit(fx, sourceId, 203);
    assertEquals((await fx.startRun(canceled.taskId)).status, 409);
    await fx.owner.query(
      `update bakery.ticket_requests set disposition = 'canceled',
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [fx.organizationId, canceled.id],
    );
    const afterTerminal = await fx.startRun(canceled.taskId);
    assertEquals(afterTerminal.status, 201, afterTerminal.text);

    // A task no request owns is untouched by the suspended one.
    const unrelated = await fx.startRun(await fx.createPlainTask());
    assertEquals(unrelated.status, 201, unrelated.text);
    assertEquals((await fx.counts(sourceId)).runs, 2);
  }));

Deno.test("issue 82 guard: a planning-only task still answers planning_only before the ticket guard", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 211, labels: [EXECUTE_LABEL] });
    const planned = await fx.admit(sourceId, { number: 211, intent: "plan" });
    const refused = await fx.startRun(planned.request!.taskId);
    assertEquals(refused.status, 409, refused.text);
    assert(refused.text.includes("planning_only"), refused.text);
    assertEquals((await fx.counts(sourceId)).runs, 0);
  }));

Deno.test("issue 82 locks: a plan-to-start upgrade and HTTP runs.create on the same task never deadlock, in either order", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    const orders = [
      { number: 301, order: "admission first" },
      { number: 302, order: "runs.create first" },
    ] as const;
    for (const { number, order } of orders) {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      const planned = await fx.admit(sourceId, { number, intent: "plan" });
      assertEquals(planned.request?.disposition, "waiting");
      const taskId = planned.request!.taskId;
      const upgrade = () => fx.admit(sourceId, { number, intent: "start" });
      const runsCreate = async () => {
        const response = await fx.startRun(taskId);
        return response;
      };
      const hold = await holdApplication(fx);
      const [first, second] = order === "admission first"
        ? await raceInOrder(fx.owner, hold, upgrade, runsCreate)
        : await raceInOrder(fx.owner, hold, runsCreate, upgrade);
      assertNoDeadlock(first);
      assertNoDeadlock(second);
      for (const outcome of [first, second]) {
        if (outcome.status === "fulfilled") {
          const value = outcome.value as { status?: number; text?: string };
          if (value.status !== undefined) {
            assert(
              value.status === 201 || value.status === 409,
              `${order}: runs.create answered ${value.status} ${value.text}`,
            );
          }
        }
      }
      // The upgrade ran exactly once and left exactly one run on the task.
      const task = await fx.owner.query<
        { planning_only: boolean; runs: string }
      >(
        `select planning_only,
                (select count(*) from bakery.workflow_runs
                  where task_id = $2) as runs
           from bakery.tasks where organization_id = $1 and id = $2`,
        [fx.organizationId, taskId],
      );
      assertEquals(task.rows[0].planning_only, false, order);
      assertEquals(Number(task.rows[0].runs), 1, order);
    }
  }));

Deno.test("issue 82 locks: two admissions of the same ticket serialize on the ticket row and converge", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    // A held ticket has a row and a report but no request.
    fx.reader.setIssue({ number: 311, labels: [EXECUTE_LABEL, HOLD_LABEL] });
    const parked = await fx.admit(sourceId, { number: 311, intent: "start" });
    assertEquals(parked.kind, "unadmitted");
    fx.reader.setIssue({ number: 311, labels: [EXECUTE_LABEL] });
    const hold = await holdRow(
      fx.owner,
      "select id from bakery.external_tickets where organization_id = $1 and id = $2 for update",
      [fx.organizationId, parked.ticketId],
    );
    const admit = () => fx.admit(sourceId, { number: 311, intent: "start" });
    const [a, b] = await raceInOrder(fx.owner, hold, admit, admit);
    assertNoDeadlock(a);
    assertNoDeadlock(b);
    assertEquals(a.status, "fulfilled");
    assertEquals(b.status, "fulfilled");
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      assertEquals([a.value.kind, b.value.kind], ["admitted", "existing"]);
      assertEquals(a.value.request?.id, b.value.request?.id);
    }
    const counts = await fx.counts(sourceId);
    assertEquals([counts.requests, counts.tasks, counts.runs], [1, 1, 1]);
  }));

Deno.test("issue 82 locks: two admissions of different tickets in one application never deadlock, in either order", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    // The case where both tickets reach createTaskCommand and createRunCommand
    // for one application row: the application lock must come first for both.
    for (const [x, y] of [[321, 322], [323, 324]]) {
      for (const number of [x, y]) {
        fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      }
      const hold = await holdApplication(fx);
      const [a, b] = await raceInOrder(
        fx.owner,
        hold,
        () => fx.admit(sourceId, { number: x, intent: "start" }),
        () => fx.admit(sourceId, { number: y, intent: "start" }),
      );
      assertNoDeadlock(a);
      assertNoDeadlock(b);
      assertEquals([a.status, b.status], ["fulfilled", "fulfilled"]);
      if (a.status === "fulfilled" && b.status === "fulfilled") {
        assertEquals([a.value.kind, b.value.kind], ["admitted", "admitted"]);
        assert(a.value.request!.id !== b.value.request!.id);
      }
    }
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.requests, counts.tasks, counts.runs],
      [4, 4, 4],
    );
  }));

Deno.test("issue 82 locks: a source policy update racing an admission pins the old or the new revision, never a mix", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    const update = () =>
      fx.runtime.query(
        `update bakery.ticket_sources
            set policy = $2::jsonb, policy_revision = policy_revision + 1,
                updated_at = now(), version = version + 1
          where organization_id = $1 and id = $3`,
        [
          fx.organizationId,
          JSON.stringify(fx.policy({ approval: "human_approval" })),
          sourceId,
        ],
      );
    const holdSource = () =>
      holdRow(
        fx.owner,
        "select id from bakery.ticket_sources where organization_id = $1 and id = $2 for update",
        [fx.organizationId, sourceId],
      );

    // Admission queued first: it takes the share lock, the update waits for
    // it, and the request pins revision 1 with the automatic policy (a run).
    fx.reader.setIssue({ number: 331, labels: [EXECUTE_LABEL] });
    const [admitted, updated] = await raceInOrder(
      fx.owner,
      await holdSource(),
      () => fx.admit(sourceId, { number: 331, intent: "start" }),
      update,
    );
    assertNoDeadlock(admitted);
    assertNoDeadlock(updated);
    assertEquals(admitted.status, "fulfilled");
    if (admitted.status === "fulfilled") {
      const request = admitted.value.request!;
      assertEquals(request.sourcePolicyRevision, 1);
      assertEquals(admitted.value.report.sourcePolicyRevision, 1);
      assertEquals(request.disposition, "admitted");
      assert(request.workflowRunId !== null, "the old policy created the run");
    }

    // Update queued first: the admission reads revision 2 and its policy
    // (human approval), so the request waits and no run is created.
    fx.reader.setIssue({ number: 332, labels: [EXECUTE_LABEL] });
    await fx.owner.query(
      `update bakery.ticket_sources set policy = $2::jsonb,
              policy_revision = policy_revision + 1, updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $3`,
      [fx.organizationId, JSON.stringify(fx.policy()), sourceId],
    );
    const [updatedFirst, admittedSecond] = await raceInOrder(
      fx.owner,
      await holdSource(),
      update,
      () => fx.admit(sourceId, { number: 332, intent: "start" }),
    );
    assertNoDeadlock(updatedFirst);
    assertNoDeadlock(admittedSecond);
    assertEquals(admittedSecond.status, "fulfilled");
    if (admittedSecond.status === "fulfilled") {
      const request = admittedSecond.value.request!;
      assertEquals(request.sourcePolicyRevision, 4);
      assertEquals(admittedSecond.value.report.sourcePolicyRevision, 4);
      assertEquals(request.disposition, "waiting");
      assertEquals(
        request.workflowRunId,
        null,
        "the new policy waits for approval",
      );
    }
  }));
