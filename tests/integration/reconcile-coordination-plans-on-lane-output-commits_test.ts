import { assert, assertEquals } from "@std/assert";
import {
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
