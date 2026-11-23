import { assertEquals } from "@std/assert";
import {
  laneCapacityKey,
  lanesToStart,
  type LaneToConsider,
} from "../../apps/server/src/modules/work/coordination-dispatch.ts";
import {
  CoordinationLaneSpecSchema,
  CoordinationPlanSpecSchema,
} from "../../apps/server/src/modules/work/coordination-plan.ts";

// #422: the engine starts the ready lanes of a plan that name what they run,
// as many as the plan's capacity allows.

const lane = (
  key: string,
  status: LaneToConsider["status"],
  extra: Partial<LaneToConsider> = {},
): LaneToConsider => ({ key, status, runs: true, live: false, ...extra });

Deno.test("a plan's capacity is counted under one key per plan", () => {
  assertEquals(laneCapacityKey("p-1"), "plan:p-1");
});

Deno.test("ready lanes that name what they run start in plan order, up to the capacity", () => {
  const lanes = [
    lane("a", "ready"),
    lane("b", "ready"),
    lane("c", "ready"),
    lane("d", "waiting"),
  ];
  assertEquals(lanesToStart(2, lanes), ["a", "b"]);
  assertEquals(lanesToStart(1, lanes), ["a"]);
  assertEquals(lanesToStart(16, lanes), ["a", "b", "c"]);
});

Deno.test("a lane with a live run holds a place, and a full plan starts nothing", () => {
  const lanes = [
    lane("a", "running", { live: true }),
    lane("b", "ready"),
    lane("c", "ready"),
  ];
  assertEquals(lanesToStart(2, lanes), ["b"]);
  assertEquals(lanesToStart(1, lanes), []);
  // Over-full (a lane started by hand): never a negative room.
  assertEquals(
    lanesToStart(1, [
      lane("a", "running", { live: true }),
      lane("b", "running", { live: true }),
      lane("c", "ready"),
    ]),
    [],
  );
});

Deno.test("only a ready lane that names what it runs is started", () => {
  const lanes = [
    lane("planned", "planned"),
    lane("waiting", "waiting"),
    lane("done", "completed"),
    lane("failed", "failed"),
    lane("stopped", "stopped"),
    lane("stale", "stale"),
    lane("by-hand", "ready", { runs: false }),
    lane("go", "ready"),
  ];
  assertEquals(lanesToStart(8, lanes), ["go"]);
});

Deno.test("deciding again from the same state decides the same thing", () => {
  const lanes = [lane("a", "ready"), lane("b", "ready")];
  assertEquals(lanesToStart(1, lanes), lanesToStart(1, lanes));
});

const base = {
  key: "web",
  repositoryAlias: "web",
  title: "web",
  instructions: "build the web client",
  prerequisites: [],
  outputs: [],
  inputs: [],
};
const WORKFLOW = "00000000-0000-4000-8000-0000000000a1";

Deno.test("a lane names what it runs as a workflow and inputs, and may leave it out", () => {
  const without = CoordinationLaneSpecSchema.parse(base);
  assertEquals(Object.hasOwn(without, "run"), false);
  const named = CoordinationLaneSpecSchema.parse({
    ...base,
    run: { workflowId: WORKFLOW, inputs: { target: "web" } },
  });
  assertEquals(named.run, { workflowId: WORKFLOW, inputs: { target: "web" } });
  assertEquals(
    CoordinationLaneSpecSchema.parse({ ...base, run: { workflowId: WORKFLOW } })
      .run,
    { workflowId: WORKFLOW },
  );
});

Deno.test("what a lane runs is refused when it is not a workflow id, has extra fields or carries too much", () => {
  for (
    const run of [
      { workflowId: "not-a-uuid" },
      {},
      { workflowId: WORKFLOW, extra: true },
      { workflowId: WORKFLOW, inputs: { big: "x".repeat(17_000) } },
      { workflowId: WORKFLOW, inputs: [] },
    ]
  ) {
    assertEquals(
      CoordinationLaneSpecSchema.safeParse({ ...base, run }).success,
      false,
      JSON.stringify(run).slice(0, 80),
    );
  }
});

Deno.test("a plan with lanes that name what they run is a plan like any other", () => {
  const plan = CoordinationPlanSpecSchema.parse({
    lanes: [{ ...base, run: { workflowId: WORKFLOW } }],
    maxConcurrency: 1,
    join: "all-required",
    failurePolicy: "stop-dependent",
  });
  assertEquals(plan.lanes[0].run?.workflowId, WORKFLOW);
});
