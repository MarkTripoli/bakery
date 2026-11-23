import { assert, assertEquals } from "@std/assert";
import { createSplitStepRunner } from "../../apps/server/src/modules/work/coordination-split-step.ts";
import type { EngineStepRequest } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import {
  type CoordinationFixture,
  fourLaneSpec,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  completeLane,
  getPlan,
  reconcileTask,
  startRun,
} from "../helpers/coordination-lanes.ts";

// #422 slice 2. A coordination.split step is settled by the engine in its
// admission: the parent run's own step makes the plan of child work items as the
// person who started the run, materializes it, and waits for the plan's terminal
// projection. A step looked at again is the same request and finds its plan.

/** A parent task with a run, and the engine's request for its split step. */
async function atTheSplit(
  fx: CoordinationFixture,
  input: Record<string, unknown>,
) {
  await fx.seedAliases();
  const parent = await fx.insertTask("split parent", { repo: "api" });
  const started = await startRun(fx, parent);
  const text = await started.text();
  assertEquals(started.status, 201, text);
  const run = JSON.parse(text) as { id: string };
  const runner = createSplitStepRunner({ database: fx.ownerPg });
  const request: EngineStepRequest = {
    organizationId: fx.organizationId,
    runId: run.id,
    taskId: parent,
    repositoryId: null,
    requestedBy: fx.developer.principalId,
    traceId: "trace-422",
    stepKey: "split",
    iteration: 0,
    action: "coordination.split",
    input,
  };
  return { parent, runner, request };
}

const splitInput = (overrides: Record<string, unknown> = {}) => ({
  split: { ...fourLaneSpec(), ...overrides },
});

const plansOf = async (fx: CoordinationFixture, parent: string) =>
  await fx.owner<
    { id: string; status: string; origin: Record<string, unknown> }[]
  >`
    select id, status, origin from bakery.coordination_plans
     where organization_id = ${fx.organizationId} and parent_task_id = ${parent}`;

Deno.test("a split step makes its plan once, materializes it, and waits while lanes run (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    const { parent, runner, request } = await atTheSplit(fx, splitInput());
    assert(runner.handles("coordination.split"));
    assert(!runner.handles("tool.call"));
    assertEquals(await runner.run(request), { kind: "pending" });
    const [plan, ...rest] = await plansOf(fx, parent);
    assertEquals(rest, []);
    assertEquals(plan.origin.kind, "saved_workflow");
    assertEquals(plan.origin.nodeId, "split");
    const materialized = await getPlan(fx, plan.id);
    assertEquals(materialized.lanes.length, 4);
    assert(materialized.lanes.every((lane) => lane.childTaskId !== null));
    // Looked at again, after a crash or a retry: the same plan, not a second.
    assertEquals(await runner.run(request), { kind: "pending" });
    assertEquals((await plansOf(fx, parent)).map((p) => p.id), [plan.id]);
  } finally {
    await fx.close();
  }
});

Deno.test("a split step completes once every lane of its plan has completed (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    const { parent, runner, request } = await atTheSplit(fx, splitInput());
    assertEquals(await runner.run(request), { kind: "pending" });
    const [{ id: planId }] = await plansOf(fx, parent);
    const plan = await getPlan(fx, planId);
    for (
      const [key, output] of [
        ["contract", "contract"],
        ["web", "patch"],
        ["mobile", "patch"],
        ["integration", undefined],
      ] as const
    ) {
      const { runId: _run } = await completeLane(fx, plan, key, output);
      const lane = plan.lanes.find((l) => l.laneKey === key)!;
      await reconcileTask(fx, lane.childTaskId!);
      // Not yet while a lane is still to run.
      if (key !== "integration") {
        assertEquals(await runner.run(request), { kind: "pending" });
      }
    }
    const done = await runner.run(request);
    assertEquals(done.kind, "completed");
    assertEquals(
      done.kind === "completed" ? done.output : null,
      { planId, status: "completed", lanes: 4, completedLanes: 4 },
    );
    assertEquals((await plansOf(fx, parent)).length, 1);
  } finally {
    await fx.close();
  }
});

Deno.test("a split step fails with a fixed code when its plan is canceled (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    const { parent, runner, request } = await atTheSplit(fx, splitInput());
    assertEquals(await runner.run(request), { kind: "pending" });
    const [{ id: planId }] = await plansOf(fx, parent);
    const canceled = await fx.send(
      fx.developer,
      "POST",
      `/v1/coordination-plans/${planId}/cancel`,
      { body: {} },
    );
    assertEquals(canceled.status, 201, await canceled.text());
    const result = await runner.run(request);
    assertEquals(result.kind, "failed");
    assertEquals(
      result.kind === "failed" ? result.code : null,
      "SPLIT_PLAN_CANCELED",
    );
  } finally {
    await fx.close();
  }
});

Deno.test("a split step refuses input that is not a split and a plan that is refused (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    const bad = await atTheSplit(fx, splitInput({ maxConcurrency: 0 }));
    const invalid = await bad.runner.run(bad.request);
    assertEquals(invalid.kind, "failed");
    assertEquals(
      invalid.kind === "failed" ? invalid.code : null,
      "SPLIT_INPUT_INVALID",
    );
    assertEquals((await plansOf(fx, bad.parent)).length, 0);

    // A lane that names a workflow the organization does not have is refused
    // before anything is created.
    const lanes = fourLaneSpec().lanes.map((lane) => ({
      ...lane,
      run: { workflowId: crypto.randomUUID() },
    }));
    const unknown = await atTheSplit(fx, splitInput({ lanes }));
    const refused = await unknown.runner.run(unknown.request);
    assertEquals(refused.kind, "failed");
    assertEquals(
      refused.kind === "failed" ? refused.code : null,
      "SPLIT_PLAN_INVALID",
    );
    assertEquals((await plansOf(fx, unknown.parent)).length, 0);
  } finally {
    await fx.close();
  }
});
