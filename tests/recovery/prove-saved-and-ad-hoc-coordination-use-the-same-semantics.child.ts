import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type CoordinationFixtureState,
  fourLaneSpec,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  commitArtifact,
  completeLane,
  createPlan,
  finishRun,
  getPlan,
  laneOf,
  materialize,
  planOf,
  publishOutput,
  startRun,
} from "../helpers/coordination-lanes.ts";

/**
 * Two stages run as separate OS processes by the recovery test:
 * `seed` builds a plan, admits a lane run and dies holding row locks;
 * `continue` is a fresh process that attaches to the same rows and proves
 * reuse, stale detection and rework.
 */
const stage = Deno.args[0];

if (stage === "seed") {
  const fx = await openCoordinationFixture();
  await fx.seedAliases();
  const parent = await fx.insertTask("process restart");
  const plan = await materialize(
    fx,
    (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
  );
  await completeLane(fx, plan, "contract", "contract");
  await completeLane(fx, plan, "web", "patch");
  // Mobile has an admitted, unfinished run when this process dies.
  const run = await startRun(fx, childOf(plan, "mobile"));
  assertEquals(run.status, 201);
  const handoff = { state: fx.state, parent, planId: plan.id };
  // Die mid-operation: an open transaction holds the parent task and plan
  // rows, exactly what a crashed reconcile or cancel would leave behind.
  await fx.owner.begin(async (sql) => {
    await sql`
      select id from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${parent} for update`;
    await sql`
      select id from bakery.coordination_plans
       where organization_id = ${fx.organizationId} and id = ${plan.id} for update`;
    console.log(`READY ${JSON.stringify(handoff)}`);
    await new Promise<void>(() => {});
  });
} else if (stage === "continue") {
  const handoff = JSON.parse(Deno.env.get("COORDINATION_HANDOFF") ?? "null") as
    | { state: CoordinationFixtureState; parent: string; planId: string }
    | null;
  assert(handoff, "COORDINATION_HANDOFF is required");
  const fx = await openCoordinationFixture({ attach: handoff.state });
  try {
    // The dead process's locks are gone: this read would block otherwise.
    const rev1 = await getPlan(fx, handoff.planId);
    assertEquals(rev1.status, "materialized");
    assertEquals(
      Object.fromEntries(rev1.lanes.map((l) => [l.laneKey, l.status])),
      {
        contract: "completed",
        web: "completed",
        mobile: "running",
        integration: "waiting",
      },
    );
    // Finish the run the dead process admitted.
    const mobileTask = childOf(rev1, "mobile");
    const run = (await fx.owner`
      select id from bakery.workflow_runs
       where organization_id = ${fx.organizationId} and task_id = ${mobileTask}`)[
      0
    ].id as string;
    await publishOutput(fx, mobileTask, "patch");
    await finishRun(fx, run, mobileTask);
    // Upstream rework: the contract lane commits a new version.
    await commitArtifact(fx, childOf(rev1, "contract"), "contract");
    const stale = await getPlan(fx, rev1.id);
    assertEquals(laneOf(stale, "web").status, "stale");
    assertEquals(laneOf(stale, "mobile").status, "stale");
    assertEquals(stale.status, "materialized");
    const blocked = await startRun(fx, childOf(rev1, "integration"));
    assertEquals(blocked.status, 409);
    assertEquals((await blocked.json()).reason, "lane_prerequisite_stale");
    // Rework: a new revision reuses the contract child only.
    const rev2 = await materialize(
      fx,
      (await planOf(await createPlan(fx, handoff.parent, fourLaneSpec()))).id,
    );
    assertEquals(rev2.revision, 2);
    assertEquals(
      laneOf(rev2, "contract").childTaskId,
      childOf(rev1, "contract"),
    );
    for (const key of ["web", "mobile", "integration"]) {
      assertNotEquals(laneOf(rev2, key).childTaskId, childOf(rev1, key), key);
    }
    await completeLane(fx, rev2, "web", "patch");
    await completeLane(fx, rev2, "mobile", "patch");
    await completeLane(fx, rev2, "integration");
    assertEquals((await getPlan(fx, rev2.id)).status, "completed");
    console.log("CONTINUED");
  } finally {
    await fx.close();
  }
} else {
  throw new Error(`unknown stage ${stage}`);
}
Deno.exit(0);
