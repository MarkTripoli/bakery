import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type CoordinationFixture,
  fourLaneSpec,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  commitArtifact,
  completeLane,
  createPlan,
  getPlan,
  laneOf,
  materialize,
  planOf,
  publishOutput,
  reconcileTask,
  runInputs,
  startRun,
} from "../helpers/coordination-lanes.ts";

const withInstructions = (
  spec: ReturnType<typeof fourLaneSpec>,
  laneKey: string,
  instructions: string,
) => ({
  ...spec,
  lanes: spec.lanes.map((lane) =>
    lane.key === laneKey ? { ...lane, instructions } : lane
  ),
});

async function taskStatus(fx: CoordinationFixture, taskId: string) {
  const rows = await fx.owner`
    select status from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  return rows[0].status as string;
}

Deno.test("restart mid-plan, partial delivery and reuse of completed children", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const spec = fourLaneSpec();

    // A restart between lanes loses nothing: the next lane still admits with
    // the frozen typed inputs and the plan completes.
    const midPlan = await materialize(
      fx,
      (await planOf(await createPlan(fx, await fx.insertTask("restart"), spec)))
        .id,
    );
    await completeLane(fx, midPlan, "contract", "contract");
    await completeLane(fx, midPlan, "web", "patch");
    await fx.restart();
    assertEquals(
      (await getPlan(fx, midPlan.id)).status,
      "materialized",
      "the plan survives the restart and still waits on mobile",
    );
    await completeLane(fx, midPlan, "mobile", "patch");
    await fx.restart();
    const integration = await completeLane(fx, midPlan, "integration");
    assertEquals((await runInputs(fx, integration.runId)).length, 2);
    assertEquals((await getPlan(fx, midPlan.id)).status, "completed");

    // One failed required child fails the parent's completion although the
    // sibling lanes completed: partial delivery, and the dependant is stopped.
    const failParent = await fx.insertTask("failure");
    const rev1 = await materialize(
      fx,
      (await planOf(await createPlan(fx, failParent, spec))).id,
    );
    await completeLane(fx, rev1, "contract", "contract");
    await completeLane(fx, rev1, "web", "patch");
    await fx.owner`
      update bakery.tasks set status = 'failed', version = version + 1
       where organization_id = ${fx.organizationId}
         and id = ${childOf(rev1, "mobile")}`;
    await reconcileTask(fx, childOf(rev1, "mobile"));
    await fx.restart();
    const partial = await getPlan(fx, rev1.id);
    assertEquals(partial.status, "partially_delivered");
    assertEquals(
      Object.fromEntries(partial.lanes.map((l) => [l.laneKey, l.status])),
      {
        contract: "completed",
        web: "completed",
        mobile: "failed",
        integration: "stopped",
      },
    );
    const refused = await startRun(fx, childOf(rev1, "integration"));
    assertEquals(refused.status, 409);
    assertEquals((await refused.json()).reason, "lane_prerequisite_failed");

    // The next revision reuses the completed children after the restart and
    // reworks only what changed: mobile, then integration downstream of it.
    const rev2 = await materialize(
      fx,
      (await planOf(
        await createPlan(
          fx,
          failParent,
          withInstructions(spec, "mobile", "Workflow lane mobile, retried"),
        ),
      )).id,
    );
    assertEquals(rev2.revision, 2);
    for (const key of ["contract", "web"]) {
      assertEquals(
        laneOf(rev2, key).childTaskId,
        laneOf(rev1, key).childTaskId,
      );
      assertEquals(laneOf(rev2, key).status, "completed");
    }
    assertNotEquals(
      laneOf(rev2, "mobile").childTaskId,
      childOf(rev1, "mobile"),
    );
    assertNotEquals(
      laneOf(rev2, "integration").childTaskId,
      childOf(rev1, "integration"),
    );
    assertEquals((await getPlan(fx, rev1.id)).status, "superseded");
  } finally {
    await fx.close();
  }
});

Deno.test("a new upstream output makes dependants stale, blocks completion and is reworked once", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const spec = fourLaneSpec();
    const parent = await fx.insertTask("stale");
    const rev1 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    await completeLane(fx, rev1, "contract", "contract");
    await completeLane(fx, rev1, "web", "patch");
    await completeLane(fx, rev1, "mobile", "patch");
    assertEquals(
      (await getPlan(fx, rev1.id)).status,
      "materialized",
      "integration has not run",
    );

    // The contract lane commits a new version through the real commit path;
    // the hook reconciles the plan and persists the stale lanes.
    await commitArtifact(fx, childOf(rev1, "contract"), "contract");
    await fx.restart();
    const stale = await getPlan(fx, rev1.id);
    assertEquals(
      Object.fromEntries(stale.lanes.map((l) => [l.laneKey, l.status])),
      {
        contract: "completed",
        web: "stale",
        mobile: "stale",
        integration: "waiting",
      },
    );
    assertEquals(stale.status, "materialized", "stale blocks completion");
    const stored = await fx.owner`
      select lane_key, status from bakery.coordination_lanes
       where plan_id = ${rev1.id} order by position`;
    assertEquals(
      Object.fromEntries(stored.map((l) => [l.lane_key, l.status])),
      {
        contract: "completed",
        web: "stale",
        mobile: "stale",
        integration: "waiting",
      },
      "reconcile persisted the stale lanes",
    );

    // Admission refuses the final consumer while a prerequisite is stale.
    const blocked = await startRun(fx, childOf(rev1, "integration"));
    assertEquals(blocked.status, 409);
    assertEquals((await blocked.json()).reason, "lane_prerequisite_stale");

    // Forcing the integration child to completed does not complete the plan.
    await fx.owner`
      update bakery.tasks set status = 'completed', version = version + 1
       where organization_id = ${fx.organizationId}
         and id = ${childOf(rev1, "integration")}`;
    await reconcileTask(fx, childOf(rev1, "integration"));
    const forced = await getPlan(fx, rev1.id);
    assertEquals(forced.status, "materialized");
    assertEquals(
      (await fx.owner`
        select status from bakery.coordination_plans where id = ${rev1.id}`)[0]
        .status,
      "materialized",
      "the stored parent status never reached completed",
    );

    // The same request is rework, not a replay: a new revision reuses the
    // contract child and reworks web, mobile and the integration consumer.
    const rev2 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    assertEquals(rev2.revision, 2);
    assertEquals(
      laneOf(rev2, "contract").childTaskId,
      childOf(rev1, "contract"),
    );
    for (const key of ["web", "mobile", "integration"]) {
      assertNotEquals(laneOf(rev2, key).childTaskId, childOf(rev1, key), key);
    }
    assertEquals((await getPlan(fx, rev1.id)).status, "superseded");
    const web2 = await completeLane(fx, rev2, "web", "patch");
    const frozen = await runInputs(fx, web2.runId);
    assertEquals(frozen.length, 1);
    const current = (await fx.owner`
      select current_version_id as id from bakery.artifacts
       where organization_id = ${fx.organizationId}
         and task_id = ${childOf(rev1, "contract")} and name = 'contract'`)[0];
    assertEquals(frozen[0].artifactVersionId, current.id, "rework sees v2");
    await completeLane(fx, rev2, "mobile", "patch");
    await completeLane(fx, rev2, "integration");
    const settled = await getPlan(fx, rev2.id);
    assertEquals(settled.status, "completed", "the reworked revision settles");
    assert(settled.lanes.every((l) => l.status === "completed"));
    // Replaying the settled request creates nothing.
    assertEquals(
      (await planOf(await createPlan(fx, parent, spec))).id,
      rev2.id,
    );
  } finally {
    await fx.close();
  }
});

Deno.test("revision R3 reuses what R2 completed while R2 is still in flight", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const spec = fourLaneSpec();
    const parent = await fx.insertTask("r1-r2-r3");
    const rev1 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    await completeLane(fx, rev1, "contract", "contract");
    await completeLane(fx, rev1, "web", "patch");
    await completeLane(fx, rev1, "mobile", "patch");
    await publishOutput(fx, childOf(rev1, "contract"), "contract");
    await reconcileTask(fx, childOf(rev1, "contract"));

    // R2 reworks web and mobile; only web finishes, mobile is in flight.
    const rev2 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    assertEquals(rev2.revision, 2);
    const web2 = childOf(rev2, "web");
    const mobile2 = childOf(rev2, "mobile");
    assertNotEquals(web2, childOf(rev1, "web"));
    await completeLane(fx, rev2, "web", "patch");
    const mobileRun = await startRun(fx, mobile2);
    assertEquals(mobileRun.status, 201);

    // R3 changes the mobile lane. It reuses contract and the web child R2
    // completed (not the stale R1 one), cancels R2's in-flight mobile child and
    // reworks mobile and the integration consumer.
    const rev3 = await materialize(
      fx,
      (await planOf(
        await createPlan(
          fx,
          parent,
          withInstructions(spec, "mobile", "Workflow lane mobile, changed"),
        ),
      )).id,
    );
    assertEquals(rev3.revision, 3);
    assertEquals(
      laneOf(rev3, "contract").childTaskId,
      childOf(rev1, "contract"),
    );
    assertEquals(laneOf(rev3, "web").childTaskId, web2);
    assertEquals(laneOf(rev3, "web").status, "completed");
    assertNotEquals(laneOf(rev3, "mobile").childTaskId, mobile2);
    assertNotEquals(
      laneOf(rev3, "integration").childTaskId,
      childOf(rev2, "integration"),
    );
    assertEquals((await getPlan(fx, rev2.id)).status, "superseded");
    assertEquals(await taskStatus(fx, mobile2), "canceled");
    assertEquals(await taskStatus(fx, web2), "completed", "evidence is kept");
    await completeLane(fx, rev3, "mobile", "patch");
    await completeLane(fx, rev3, "integration");
    assertEquals((await getPlan(fx, rev3.id)).status, "completed");
  } finally {
    await fx.close();
  }
});

Deno.test("admission refuses a run when any upstream lane is stale, direct or transitive", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const lane = (
      key: string,
      alias: string,
      from: string | null,
      output: string | null,
    ) => ({
      key,
      repositoryAlias: alias,
      title: key,
      instructions: key,
      prerequisites: from ? [from] : [],
      outputs: output ? [{ key: output, kind: "artifact" }] : [],
      inputs: from ? [{ fromLane: from, outputKey: `${from}-out` }] : [],
    });
    const chain = {
      lanes: [
        lane("a", "api", null, "a-out"),
        lane("b", "web", "a", "b-out"),
        lane("c", "mobile", "b", "c-out"),
        lane("d", "integration", "c", null),
      ],
      maxConcurrency: 1,
      join: "all-required",
      failurePolicy: "stop-dependent",
    };
    const plan = await materialize(
      fx,
      (await planOf(
        await createPlan(fx, await fx.insertTask("chain"), chain),
      )).id,
    );
    await completeLane(fx, plan, "a", "a-out");
    await completeLane(fx, plan, "b", "b-out");
    await completeLane(fx, plan, "c", "c-out");
    // `a` publishes again: `b` consumed the old version, so `b` is stale. `c`
    // consumed `b`'s unchanged output, so `c` is not itself stale, yet `d`
    // sits downstream of the stale `b` and must be refused.
    await publishOutput(fx, childOf(plan, "a"), "a-out");
    const view = await getPlan(fx, plan.id);
    assertEquals(
      Object.fromEntries(view.lanes.map((l) => [l.laneKey, l.status])),
      { a: "completed", b: "stale", c: "completed", d: "waiting" },
    );
    const refused = await startRun(fx, childOf(plan, "d"));
    assertEquals(refused.status, 409);
    assertEquals((await refused.json()).reason, "lane_prerequisite_stale");
    const runs = await fx.owner`
      select count(*)::int as count from bakery.workflow_runs
       where organization_id = ${fx.organizationId}
         and task_id = ${childOf(plan, "d")}`;
    assertEquals(runs[0].count, 0, "a refused admission writes no run");
  } finally {
    await fx.close();
  }
});

Deno.test("a lane completed without recorded inputs is stale and never reused", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const spec = fourLaneSpec();
    const parent = await fx.insertTask("inputless");
    const rev1 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    await completeLane(fx, rev1, "contract", "contract");
    // `web` declares an input but completes with no run, so nothing records
    // which contract version it saw.
    await fx.owner`
      update bakery.tasks set status = 'completed', version = version + 1
       where organization_id = ${fx.organizationId}
         and id = ${childOf(rev1, "web")}`;
    await reconcileTask(fx, childOf(rev1, "web"));
    const view = await getPlan(fx, rev1.id);
    assertEquals(laneOf(view, "contract").status, "completed");
    assertEquals(laneOf(view, "web").status, "stale");
    assertEquals(view.status, "materialized");

    const rev2 = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, spec))).id,
    );
    assertEquals(rev2.revision, 2, "a stale plan is reworked, not replayed");
    assertEquals(
      laneOf(rev2, "contract").childTaskId,
      childOf(rev1, "contract"),
    );
    assertNotEquals(laneOf(rev2, "web").childTaskId, childOf(rev1, "web"));
  } finally {
    await fx.close();
  }
});

const CHILD_TIMEOUT_MS = 180_000;
const childPath = new URL(
  "./prove-saved-and-ad-hoc-coordination-use-the-same-semantics.child.ts",
  import.meta.url,
).pathname;
const childArgs = (stage: string) => [
  "run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
  "--allow-run",
  "--allow-write",
  "--allow-sys=uid,statfs,osRelease",
  childPath,
  stage,
];

Deno.test("a plan process killed mid-operation is continued by a fresh process", async () => {
  // Process one builds the plan, admits a lane run and holds the parent and
  // plan row locks in an open transaction; it is killed with SIGKILL there.
  const seed = new Deno.Command(Deno.execPath(), {
    args: childArgs("seed"),
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      seed.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, CHILD_TIMEOUT_MS);
  let handoff: string | null = null;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of seed.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const line = buffer.split("\n").find((l) => l.startsWith("READY "));
      if (line) {
        handoff = line.slice("READY ".length);
        break;
      }
    }
    assert(handoff, "the seed process never reached its locked state");
    seed.kill("SIGKILL");
    const status = await seed.status;
    assertEquals(status.signal, "SIGKILL", "the seed process was killed");
  } finally {
    clearTimeout(timer);
  }
  // Process two starts fresh over the same database and continues.
  const next = await new Deno.Command(Deno.execPath(), {
    args: childArgs("continue"),
    env: { ...Deno.env.toObject(), COORDINATION_HANDOFF: handoff },
    stdout: "piped",
    stderr: "inherit",
    signal: AbortSignal.timeout(CHILD_TIMEOUT_MS),
  }).output();
  const text = new TextDecoder().decode(next.stdout);
  assertEquals(next.code, 0, text);
  assert(text.includes("CONTINUED"), text);
});
