import { assert, assertEquals } from "@std/assert";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { reconcileCoordinationForTerminalTask } from "../../apps/server/src/modules/work/coordination-projection.ts";
import {
  type CoordinationFixture,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";

// A run admitted blocked on `dependency_incomplete` leaves `blocked` when its
// prerequisite tasks end: queued and started once all completed, canceled
// naming the prerequisite when one failed or was canceled.

async function dependsOn(
  fx: CoordinationFixture,
  taskId: string,
  prerequisiteId: string,
) {
  await fx.owner`
    insert into bakery.task_dependencies (
      organization_id, task_id, depends_on_task_id, condition, version
    ) values (${fx.organizationId}, ${taskId}, ${prerequisiteId}, 'completed', 1)`;
}

async function startRun(fx: CoordinationFixture, taskId: string) {
  const response = await fx.sendTask(
    fx.developer,
    "POST",
    `/v1/tasks/${taskId}/runs`,
    {
      body: {
        workflowVersionId: fx.workflowVersionId,
        repositoryProfileId: fx.repositories.api.profileId,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { taskId },
      },
    },
  );
  const text = await response.text();
  assertEquals(response.status, 201, text);
  return JSON.parse(text) as { id: string; status: string };
}

/**
 * Ends a prerequisite task the way a terminal path does: the task status
 * changes and the terminal hook runs in the same transaction.
 */
async function endTask(
  fx: CoordinationFixture,
  taskId: string,
  status: "completed" | "failed" | "canceled",
) {
  await withPgTransaction(fx.ownerPg, async (transaction) => {
    await transaction.query(
      `update bakery.tasks set status = $3, version = version + 1
        where organization_id = $1 and id = $2`,
      [fx.organizationId, taskId, status],
    );
    await reconcileCoordinationForTerminalTask(transaction, {
      organizationId: fx.organizationId,
      taskId,
      traceId: "dependency-release-trace",
    });
  });
}

/** Repeats only the terminal hook, as a duplicate completion signal would. */
async function signalAgain(fx: CoordinationFixture, taskId: string) {
  await withPgTransaction(fx.ownerPg, async (transaction) => {
    await reconcileCoordinationForTerminalTask(transaction, {
      organizationId: fx.organizationId,
      taskId,
      traceId: "dependency-release-duplicate",
    });
  });
}

async function runState(fx: CoordinationFixture, runId: string) {
  const rows = await fx.owner`
    select run.status, run.version, run.finished_at,
           run.snapshot -> 'admission' as admission,
           task.status as task_status,
           (select count(*)::int from bakery.domain_events e
             where e.organization_id = run.organization_id
               and e.aggregate_id = run.id
               and e.event_type = 'run.requested') as requested,
           (select count(*)::int from bakery.outbox o
              join bakery.domain_events e on e.id = o.event_id
             where e.organization_id = run.organization_id
               and e.aggregate_id = run.id
               and e.event_type = 'run.requested'
               and o.destination = 'inngest'
               and o.delivery_key = 'run:' || run.id || ':version:' || run.version) as start_outbox
      from bakery.workflow_runs run
      join bakery.tasks task
        on task.organization_id = run.organization_id and task.id = run.task_id
     where run.organization_id = ${fx.organizationId} and run.id = ${runId}`;
  return rows[0];
}

async function audits(fx: CoordinationFixture, runId: string) {
  return await fx.owner`
    select operation, principal_id, details from bakery.audit_events
     where organization_id = ${fx.organizationId} and resource_id = ${runId}
       and operation in ('runs.resume', 'runs.dependency_cancel')
     order by created_at, id`;
}

Deno.test("dependency release: a blocked run is queued and started when its prerequisite completes", async () => {
  const fx = await openCoordinationFixture();
  try {
    const a = await fx.insertTask("prerequisite a", { repo: "api" });
    const b = await fx.insertTask("dependant b", { repo: "api" });
    await dependsOn(fx, b, a);
    const run = await startRun(fx, b);
    assertEquals(run.status, "blocked");
    const blocked = await runState(fx, run.id);
    assertEquals(blocked.requested, 0);
    assertEquals(blocked.task_status, "blocked");

    await endTask(fx, a, "completed");
    const resumed = await runState(fx, run.id);
    assertEquals(resumed.status, "queued");
    assertEquals(resumed.task_status, "queued");
    assertEquals(resumed.version, blocked.version + 1);
    // The start effect admission uses: one run.requested with its Inngest
    // outbox row keyed by the new run version.
    assertEquals(resumed.requested, 1);
    assertEquals(resumed.start_outbox, 1);
    // The frozen admission is history and is not rewritten.
    assertEquals(resumed.admission, blocked.admission);
    assertEquals(resumed.admission.reason, "dependency_incomplete");
    const trail = await audits(fx, run.id);
    assertEquals(trail.map((row) => row.operation), ["runs.resume"]);
    assertEquals(trail[0].principal_id, null);
    assertEquals(trail[0].details.resolvedReason, "dependency_incomplete");

    // Idempotency: a duplicate completion signal does not queue twice.
    await signalAgain(fx, a);
    await endTask(fx, a, "completed");
    const again = await runState(fx, run.id);
    assertEquals(again.status, "queued");
    assertEquals(again.version, resumed.version);
    assertEquals(again.requested, 1);
    assertEquals((await audits(fx, run.id)).length, 1);
  } finally {
    await fx.close();
  }
});

Deno.test("dependency release: a run waits for every prerequisite and is queued exactly once", async () => {
  const fx = await openCoordinationFixture();
  try {
    const a = await fx.insertTask("prerequisite a", { repo: "api" });
    const c = await fx.insertTask("prerequisite c", { repo: "api" });
    const b = await fx.insertTask("dependant b", { repo: "api" });
    await dependsOn(fx, b, a);
    await dependsOn(fx, b, c);
    const run = await startRun(fx, b);
    assertEquals(run.status, "blocked");
    const blocked = await runState(fx, run.id);

    await endTask(fx, a, "completed");
    const waiting = await runState(fx, run.id);
    assertEquals(waiting.status, "blocked");
    assertEquals(waiting.task_status, "blocked");
    assertEquals(waiting.version, blocked.version);
    assertEquals(waiting.requested, 0);

    await endTask(fx, c, "completed");
    await signalAgain(fx, a);
    await signalAgain(fx, c);
    const resumed = await runState(fx, run.id);
    assertEquals(resumed.status, "queued");
    assertEquals(resumed.version, blocked.version + 1);
    assertEquals(resumed.requested, 1);
    assertEquals(resumed.start_outbox, 1);
    assertEquals((await audits(fx, run.id)).length, 1);
  } finally {
    await fx.close();
  }
});

Deno.test("dependency release: a failed or canceled prerequisite cancels the blocked run and names it", async () => {
  const fx = await openCoordinationFixture();
  try {
    for (const outcome of ["failed", "canceled"] as const) {
      const a = await fx.insertTask(`prerequisite ${outcome}`, { repo: "api" });
      const b = await fx.insertTask(`dependant ${outcome}`, { repo: "api" });
      const d = await fx.insertTask(`transitive ${outcome}`, { repo: "api" });
      await dependsOn(fx, b, a);
      await dependsOn(fx, d, b);
      const run = await startRun(fx, b);
      const transitive = await startRun(fx, d);
      assertEquals(run.status, "blocked");
      assertEquals(transitive.status, "blocked");
      const blocked = await runState(fx, run.id);
      const mark = (await fx.owner`
        select max(organization_sequence) as mark from bakery.domain_events
         where organization_id = ${fx.organizationId}`)[0].mark;

      await endTask(fx, a, outcome);
      const ended = await runState(fx, run.id);
      assertEquals(ended.status, "canceled", outcome);
      assertEquals(ended.task_status, "canceled", outcome);
      assertEquals(ended.version, blocked.version + 1);
      assert(ended.finished_at !== null);
      assertEquals(ended.requested, 0);
      assertEquals(ended.admission, blocked.admission);
      const trail = await audits(fx, run.id);
      assertEquals(trail.map((row) => row.operation), [
        "runs.dependency_cancel",
      ]);
      assertEquals(trail[0].details, {
        fromStatus: "blocked",
        status: "canceled",
        reason: `dependency_${outcome}`,
        dependencyTaskId: a,
      });
      const events = await fx.owner`
        select event_type from bakery.domain_events
         where organization_id = ${fx.organizationId}
           and aggregate_id in (${run.id}, ${b})
           and organization_sequence > ${mark}
         order by organization_sequence`;
      assertEquals(events.map((row) => row.event_type), [
        "run.updated",
        "tasks.updated",
      ]);

      // The cancellation cascades to a run blocked on the canceled task.
      const cascaded = await runState(fx, transitive.id);
      assertEquals(cascaded.status, "canceled");
      assertEquals((await audits(fx, transitive.id))[0].details, {
        fromStatus: "blocked",
        status: "canceled",
        reason: "dependency_canceled",
        dependencyTaskId: b,
      });

      // A repeated signal changes nothing.
      await signalAgain(fx, a);
      assertEquals((await runState(fx, run.id)).version, ended.version);
      assertEquals((await audits(fx, run.id)).length, 1);
    }
  } finally {
    await fx.close();
  }
});

Deno.test("dependency release: a run blocked for another reason is left alone", async () => {
  const fx = await openCoordinationFixture();
  try {
    const a = await fx.insertTask("prerequisite a", { repo: "api" });
    const b = await fx.insertTask("dependant b", { repo: "api" });
    await dependsOn(fx, b, a);
    const run = await startRun(fx, b);
    // A run that was requested before (it started, then blocked for budget)
    // is not this hook's to resume.
    await withPgTransaction(fx.ownerPg, async (transaction) => {
      await appendDomainEvent(transaction, {
        organizationId: fx.organizationId,
        applicationId: fx.applicationId,
        taskId: b,
        eventType: "run.requested",
        aggregateId: run.id,
        aggregateVersion: 1,
        payload: { runId: run.id },
        traceId: "budget-block-trace",
      });
    });
    const before = await runState(fx, run.id);
    await endTask(fx, a, "completed");
    const after = await runState(fx, run.id);
    assertEquals(after.status, "blocked");
    assertEquals(after.version, before.version);
    assertEquals((await audits(fx, run.id)).length, 0);
  } finally {
    await fx.close();
  }
});
