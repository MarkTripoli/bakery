import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { reconcileCoordinationForTerminalTask } from "../../apps/server/src/modules/work/coordination-projection.ts";
import {
  fourLaneSpec,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  commitArtifact,
  completeLane,
  createPlan,
  deliverDependencyReleases,
  getPlan,
  laneOf,
  materialize,
  planOf,
  startRun,
} from "../helpers/coordination-lanes.ts";

const settled = async (promise: Promise<unknown>, ms: number) =>
  await Promise.race([
    promise.then(() => "done" as const),
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), ms)
    ),
  ]);

Deno.test("only a declared lane output reconciles the plan on artifact commit", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("declared outputs");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
    );
    await completeLane(fx, plan, "contract", "contract");
    await completeLane(fx, plan, "web", "patch");

    // Another transaction holds the parent task row. A reconcile must wait for
    // it; a commit that does not reconcile must not.
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => locked = resolve);
    const holder = fx.owner.begin(async (sql) => {
      await sql`
        select id from bakery.tasks
         where organization_id = ${fx.organizationId} and id = ${parent} for update`;
      locked();
      await held;
    });
    await lockTaken;
    try {
      const webTask = childOf(plan, "web");
      // A transcript-like artifact is not a declared output: no parent lock.
      assertEquals(
        await settled(commitArtifact(fx, webTask, "transcript", "log"), 5000),
        "done",
      );
      // A declared output reconciles, so it waits for the parent row.
      const declared = commitArtifact(fx, webTask, "patch", "patch");
      assertEquals(await settled(declared, 700), "pending");
      release();
      await declared;
    } finally {
      release();
      await holder;
    }
  } finally {
    await fx.close();
  }
});

Deno.test("sibling output commits, cancel and materialize replay never deadlock", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("concurrent commits");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
    );
    await completeLane(fx, plan, "contract", "contract");
    await completeLane(fx, plan, "web", "patch");
    await completeLane(fx, plan, "mobile", "patch");
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([
        commitArtifact(fx, childOf(plan, "web"), "patch", "patch"),
        commitArtifact(fx, childOf(plan, "mobile"), "patch", "patch"),
        commitArtifact(fx, childOf(plan, "contract"), "contract", "patch"),
        materialize(fx, plan.id),
        getPlan(fx, plan.id),
      ]);
      for (const result of results) {
        assertEquals(
          result.status,
          "fulfilled",
          result.status === "rejected" ? String(result.reason) : "",
        );
      }
    }
    const view = await getPlan(fx, plan.id);
    assert(
      ["web", "mobile"].every((key) => laneOf(view, key).status === "stale"),
      "the contract commits made both writers stale",
    );
    const canceled = await Promise.allSettled([
      fx.send(
        fx.developer,
        "POST",
        `/v1/coordination-plans/${plan.id}/cancel`,
        {
          body: {},
        },
      ),
      commitArtifact(fx, childOf(plan, "web"), "patch", "patch"),
      commitArtifact(fx, childOf(plan, "contract"), "contract", "patch"),
    ]);
    for (const result of canceled) assertEquals(result.status, "fulfilled");
    const response = (canceled[0] as PromiseFulfilledResult<Response>).value;
    assertEquals(response.status, 201, await response.clone().text());
  } finally {
    await fx.close();
  }
});

Deno.test("#57: canceling a plan releases runs blocked on its lane children", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("plan to cancel");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
    );
    // An ordinary task outside the plan waits on the contract lane's child.
    const outside = await fx.insertTask("waits on a lane child", {
      repo: "api",
    });
    const laneChild = childOf(plan, "contract");
    await fx.owner`
      insert into bakery.task_dependencies (
        organization_id, task_id, depends_on_task_id, condition
      ) values (${fx.organizationId}, ${outside}, ${laneChild}, 'completed')`;
    const started = await startRun(fx, outside);
    assertEquals(started.status, 201, await started.clone().text());
    const runId = (await started.json() as { id: string }).id;
    const statusOf = async () =>
      (await fx.owner`select status from bakery.workflow_runs
        where organization_id = ${fx.organizationId} and id = ${runId}`)[0]
        .status;
    assertEquals(await statusOf(), "blocked");
    // The lane child has no live worker, so the plan cancel ends it directly.
    const canceled = await fx.send(
      fx.developer,
      "POST",
      `/v1/coordination-plans/${plan.id}/cancel`,
      { body: {} },
    );
    assertEquals(canceled.status, 201, await canceled.clone().text());
    // The cancel records the release request; its consumer ends the run.
    assertEquals(await statusOf(), "blocked");
    assert(await deliverDependencyReleases(fx) >= 1);
    assertEquals(await statusOf(), "canceled");
    const audit = await fx.owner`
      select details from bakery.audit_events
       where organization_id = ${fx.organizationId}
         and operation = 'runs.dependency_cancel' and resource_id = ${runId}`;
    assertEquals(audit.length, 1);
    const details = audit[0].details as Record<string, unknown>;
    assertEquals(details.reason, "dependency_canceled");
    assertEquals(details.dependencyTaskId, laneChild);
  } finally {
    await fx.close();
  }
});

Deno.test("#57: a prerequisite ending races its dependant's plan cancel without deadlock", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    for (let round = 0; round < 5; round++) {
      const parent = await fx.insertTask(`race parent ${round}`);
      const plan = await materialize(
        fx,
        (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
      );
      // The contract lane's child waits on a task outside the plan.
      const prerequisite = await fx.insertTask(`race prerequisite ${round}`, {
        repo: "api",
      });
      const laneChild = childOf(plan, "contract");
      await fx.owner`
        insert into bakery.task_dependencies (
          organization_id, task_id, depends_on_task_id, condition
        ) values (${fx.organizationId}, ${laneChild}, ${prerequisite},
                  'completed')`;
      const started = await startRun(fx, laneChild);
      assertEquals(started.status, 201, await started.clone().text());
      const run = await started.json() as { id: string; status: string };
      assertEquals(run.status, "blocked");
      const before = (await fx.owner`
        select version from bakery.workflow_runs
         where organization_id = ${fx.organizationId} and id = ${run.id}`)[0];

      // (a) the prerequisite fails and its terminal hook runs, against (b) a
      // cancel of the plan that owns the dependant, each in its own
      // transaction, released together.
      const results = await Promise.allSettled([
        withPgTransaction(fx.ownerPg, async (transaction) => {
          await transaction.query(
            `update bakery.tasks set status = 'failed', version = version + 1
              where organization_id = $1 and id = $2`,
            [fx.organizationId, prerequisite],
          );
          await reconcileCoordinationForTerminalTask(transaction, {
            organizationId: fx.organizationId,
            taskId: prerequisite,
            traceId: `dependency-race-${round}`,
          });
        }),
        fx.send(
          fx.developer,
          "POST",
          `/v1/coordination-plans/${plan.id}/cancel`,
          { body: {} },
        ),
      ]);
      for (const result of results) {
        assertEquals(
          result.status,
          "fulfilled",
          result.status === "rejected" ? String(result.reason) : "",
        );
      }
      const response = (results[1] as PromiseFulfilledResult<Response>).value;
      const text = await response.text();
      assert(!text.includes("40P01"), text);
      assertEquals(response.status, 201, text);
      // The deferred release runs after both committed; it finds the
      // dependant already canceled by the plan cancel, or cancels it.
      await deliverDependencyReleases(fx);

      // The dependant run ended exactly once: one blocked -> canceled
      // transition, by the release (one dependency_cancel audit) or by the
      // plan cancel (none), never both and never left blocked.
      const ended = (await fx.owner`
        select run.status, run.version, task.status as task_status
          from bakery.workflow_runs run
          join bakery.tasks task
            on task.organization_id = run.organization_id
           and task.id = run.task_id
         where run.organization_id = ${fx.organizationId}
           and run.id = ${run.id}`)[0];
      assertEquals(ended.status, "canceled", `round ${round}`);
      assertEquals(ended.task_status, "canceled", `round ${round}`);
      assertEquals(ended.version, before.version + 1, `round ${round}`);
      const audits = await fx.owner`
        select details from bakery.audit_events
         where organization_id = ${fx.organizationId}
           and operation = 'runs.dependency_cancel'
           and resource_id = ${run.id}`;
      assert(audits.length <= 1, `round ${round}: ${audits.length} audits`);
      if (audits.length === 1) {
        assertEquals(
          (audits[0].details as Record<string, unknown>).dependencyTaskId,
          prerequisite,
        );
      }
      assertEquals((await getPlan(fx, plan.id)).status, "canceled");
    }
  } finally {
    await fx.close();
  }
});

Deno.test("#57: a lane child ending while its plan cancels never deadlocks, in either run id order", async () => {
  // Adapted from QA probe T8 on #466: the ending lane child's transaction
  // holds its OWN run lock first (as the worker-result path does), a run
  // outside the plan is blocked on that child, and the plan is canceled
  // through the real route at the same time. Run ids are random, so the
  // rounds cover both orders of id(dependant run) vs id(lane run); at
  // cdb78556 every "dependant first" round deadlocked (cancel 500).
  const fx = await openCoordinationFixture();
  const tally = {
    dependantFirst: { rounds: 0, ok: 0 },
    laneRunFirst: { rounds: 0, ok: 0 },
  };
  try {
    await fx.seedAliases();
    for (let round = 0; round < 24; round++) {
      const parent = await fx.insertTask(`pinned parent ${round}`);
      const plan = await materialize(
        fx,
        (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
      );
      const laneChild = childOf(plan, "contract");
      const laneStart = await startRun(fx, laneChild);
      assertEquals(laneStart.status, 201, await laneStart.clone().text());
      const laneRun = (await laneStart.json() as { id: string }).id;
      const outside = await fx.insertTask(`pinned outside ${round}`, {
        repo: "api",
      });
      await fx.owner`
        insert into bakery.task_dependencies (
          organization_id, task_id, depends_on_task_id, condition
        ) values (${fx.organizationId}, ${outside}, ${laneChild}, 'completed')`;
      const outsideStart = await startRun(fx, outside);
      assertEquals(outsideStart.status, 201, await outsideStart.clone().text());
      const dependant = await outsideStart.json() as {
        id: string;
        status: string;
      };
      assertEquals(dependant.status, "blocked");
      const bucket = dependant.id < laneRun
        ? tally.dependantFirst
        : tally.laneRunFirst;
      bucket.rounds++;

      let lockTaken!: () => void;
      const locked = new Promise<void>((resolve) => lockTaken = resolve);
      let proceed!: () => void;
      const gate = new Promise<void>((resolve) => proceed = resolve);
      const ending = withPgTransaction(fx.ownerPg, async (transaction) => {
        await transaction.query(
          `select id from bakery.workflow_runs
            where organization_id = $1 and id = $2 for update`,
          [fx.organizationId, laneRun],
        );
        lockTaken();
        await gate;
        await transaction.query(
          `update bakery.tasks set status = 'completed', version = version + 1
            where organization_id = $1 and id = $2`,
          [fx.organizationId, laneChild],
        );
        await reconcileCoordinationForTerminalTask(transaction, {
          organizationId: fx.organizationId,
          taskId: laneChild,
          traceId: `pinned-order-${round}`,
        });
      });
      await locked;
      const cancel = fx.send(
        fx.developer,
        "POST",
        `/v1/coordination-plans/${plan.id}/cancel`,
        { body: {} },
      );
      // Let the cancel take every run lock it can before the lane run's.
      await new Promise((resolve) => setTimeout(resolve, 500));
      proceed();
      const results = await Promise.allSettled([ending, cancel]);
      for (const result of results) {
        assertEquals(
          result.status,
          "fulfilled",
          `round ${round}: ${
            result.status === "rejected" ? String(result.reason) : ""
          }`,
        );
      }
      const response = (results[1] as PromiseFulfilledResult<Response>).value;
      const text = await response.text();
      assert(!text.includes("40P01"), `round ${round}: ${text}`);
      assertEquals(response.status, 201, `round ${round}: ${text}`);
      assertEquals(
        (await getPlan(fx, plan.id)).status,
        "canceled",
        `round ${round}`,
      );

      // The lane child completed before the cancel took its run, so the
      // deferred release queues and starts the outside run exactly once.
      await deliverDependencyReleases(fx);
      await deliverDependencyReleases(fx);
      const after = (await fx.owner`
        select run.status, task.status as task_status,
               (select count(*)::int from bakery.domain_events e
                 where e.organization_id = run.organization_id
                   and e.aggregate_id = run.id
                   and e.event_type = 'run.requested') as requested
          from bakery.workflow_runs run
          join bakery.tasks task
            on task.organization_id = run.organization_id
           and task.id = run.task_id
         where run.organization_id = ${fx.organizationId}
           and run.id = ${dependant.id}`)[0];
      assertEquals(after.status, "queued", `round ${round}`);
      assertEquals(after.task_status, "queued", `round ${round}`);
      assertEquals(after.requested, 1, `round ${round}`);
      bucket.ok++;
    }
    console.log(`#57 pinned-order tally: ${JSON.stringify(tally)}`);
    assert(tally.dependantFirst.rounds > 0, "no dependant-first round");
    assert(tally.laneRunFirst.rounds > 0, "no lane-run-first round");
  } finally {
    await fx.close();
  }
});
