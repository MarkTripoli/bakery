import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  coordinationOriginKey,
  CoordinationPlanOriginSchema,
  CoordinationPlanSpecSchema,
  projectLaneStatuses,
  validateCoordinationStructure,
} from "../../apps/server/src/modules/work/coordination-plan.ts";
import {
  type ConsumedInput,
  findStaleLanes,
  type FinishedRunInputs,
  hasStaleUpstream,
  latestCompletedRunInputs,
  outputLookupKey,
} from "../../apps/server/src/modules/work/coordination-stale.ts";
import {
  findParallelNode,
  mapParallelNodeToPlanSpec,
  WorkflowMappingError,
} from "../../apps/server/src/modules/work/coordination-workflow.ts";
import {
  fourLaneSpec,
  fourLaneWorkflowDocument,
} from "../helpers/coordination-fixture.ts";

// --- Saved-workflow mapper ---------------------------------------------------

const node = () => findParallelNode(fourLaneWorkflowDocument(), "delivery");

Deno.test("the mapper turns a parallel node into the spec an ad hoc request would send", () => {
  const mapped = mapParallelNodeToPlanSpec(node());
  assertEquals(mapped, fourLaneSpec());
  assertEquals(
    validateCoordinationStructure(CoordinationPlanSpecSchema.parse(mapped)),
    [],
  );
});

Deno.test("the mapper normalizes ids and export names and refuses what it cannot map", () => {
  const withLanes = (lanes: unknown[], outputs: Record<string, unknown> = {}) =>
    findParallelNode({
      steps: [{
        kind: "parallel",
        id: "p",
        maxConcurrency: 2,
        join: "all-required",
        failurePolicy: "stop-dependent",
        lanes,
        outputs,
      }],
    }, "p");
  const lane = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    needs: [],
    repository: "api",
    steps: [],
    ...extra,
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      assert(error instanceof WorkflowMappingError);
      return error.code;
    }
    throw new Error("expected a mapping error");
  };

  const mapped = mapParallelNodeToPlanSpec(withLanes(
    [
      lane("Build_Api"),
      lane("web_app", { needs: ["Build_Api"], repository: "web" }),
    ],
    { Build_Api: { Out_Name: {} } },
  ));
  assertEquals(mapped.lanes.map((l) => l.key), ["build-api", "web-app"]);
  assertEquals(mapped.lanes[0].outputs.map((o) => o.key), ["out-name"]);
  assertEquals(mapped.lanes[1].prerequisites, ["build-api"]);
  assertEquals(mapped.lanes[1].inputs, [
    { fromLane: "build-api", outputKey: "out-name" },
  ]);
  assertEquals(
    mapped.lanes[0].title,
    "Build_Api",
    "title keeps the authored id",
  );

  assertEquals(
    code(() => mapParallelNodeToPlanSpec(withLanes([lane("1bad")]))),
    "workflow_lane_key_unmappable",
  );
  assertEquals(
    code(() =>
      mapParallelNodeToPlanSpec(withLanes([lane("a_b"), lane("a-b")]))
    ),
    "workflow_lane_key_unmappable",
    "two ids that normalize to one key collide",
  );
  assertEquals(
    code(() =>
      mapParallelNodeToPlanSpec(
        withLanes([lane("a", { repository: "my_repo" })]),
      )
    ),
    "workflow_lane_key_unmappable",
    "an alias is never renamed",
  );
  assertEquals(
    code(() =>
      mapParallelNodeToPlanSpec(
        withLanes([lane("a", { repository: "my.repo" })]),
      )
    ),
    "workflow_lane_key_unmappable",
  );
  const manyOutputs = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`out${i}`, {}]),
  );
  assertEquals(
    code(() =>
      mapParallelNodeToPlanSpec(withLanes([lane("a")], { a: manyOutputs }))
    ),
    "workflow_node_exceeds_coordination_limits",
  );
  const fan = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`k${i}`, {}]),
  );
  const consumers = withLanes(
    [
      ...Array.from({ length: 5 }, (_, i) => lane(`s${i}`)),
      lane("sink", { needs: ["s0", "s1", "s2", "s3", "s4"] }),
    ],
    Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`s${i}`, fan]),
    ),
  );
  assertEquals(
    code(() => mapParallelNodeToPlanSpec(consumers)),
    "workflow_node_exceeds_coordination_limits",
    "5 lanes x 8 outputs is 40 inputs, over the 32 limit",
  );
});

Deno.test("a node that is missing or not parallel is refused with a typed error", () => {
  const document = fourLaneWorkflowDocument();
  for (const nodeId of ["define", "nowhere", "contract"]) {
    const error = assertThrows(
      () => findParallelNode(document, nodeId),
      WorkflowMappingError,
    );
    assertEquals(error.code, "workflow_node_not_parallel");
  }
});

Deno.test("the lane instructions render step ids and action names in authored order", () => {
  const mapped = mapParallelNodeToPlanSpec(findParallelNode({
    steps: [{
      kind: "parallel",
      id: "p",
      maxConcurrency: 1,
      join: "all-required",
      failurePolicy: "stop-dependent",
      lanes: [{
        id: "only",
        needs: [],
        repository: "api",
        steps: [
          { kind: "action", id: "zeta", action: "agent.implement" },
          {
            kind: "sequence",
            id: "inner",
            steps: [{ kind: "action", id: "alpha", action: "repo.verify" }],
          },
        ],
      }],
      outputs: {},
    }],
  }, "p"));
  assertEquals(
    mapped.lanes[0].instructions,
    "Workflow lane only, steps in order:\n- zeta: agent.implement\n- inner (sequence)\n  - alpha: repo.verify",
  );
});

// --- Origin ------------------------------------------------------------------

Deno.test("origin accepts the three kinds and refuses a non-https or oversized ticket link", async () => {
  const ok = [
    { kind: "ad_hoc" },
    { kind: "ticket", provider: "jira", reference: "BAK-1" },
    {
      kind: "ticket",
      provider: "github",
      reference: "12",
      url: "https://github.com/o/r/issues/12",
    },
    {
      kind: "saved_workflow",
      workflowId: crypto.randomUUID(),
      workflowVersionId: crypto.randomUUID(),
      nodeId: "delivery",
    },
  ];
  for (const origin of ok) {
    assert(CoordinationPlanOriginSchema.safeParse(origin).success);
  }
  const base = { kind: "ticket", provider: "jira", reference: "BAK-1" };
  for (
    const bad of [
      { ...base, url: "http://x.test/1" },
      { ...base, url: "ftp://x.test/1" },
      { ...base, url: "not a url" },
      { ...base, url: `https://x.test/${"a".repeat(2048)}` },
      { ...base, reference: "" },
      { ...base, extra: 1 },
      { kind: "ad_hoc", extra: 1 },
      { kind: "other" },
    ]
  ) {
    assertEquals(CoordinationPlanOriginSchema.safeParse(bad).success, false);
  }
  assertEquals(
    await coordinationOriginKey({
      kind: "ticket",
      provider: "a",
      reference: "b",
    }),
    await coordinationOriginKey(
      { reference: "b", provider: "a", kind: "ticket" } as never,
    ),
    "key order never changes origin equality",
  );
});

// --- Stale check -------------------------------------------------------------

const input = (
  fromLane: string,
  outputKey: string,
  artifactVersionId: string,
  sha256 = "s-" + artifactVersionId,
): ConsumedInput => ({ fromLane, outputKey, artifactVersionId, sha256 });

const current = (
  entries: [string, string, string | null][],
) =>
  new Map(
    entries.map(([lane, output, version]) => [
      outputLookupKey(lane, output),
      version === null ? null : { versionId: version, sha256: "s-" + version },
    ]),
  );

Deno.test("a completed lane is stale when a consumed version is no longer current", () => {
  const lanes = [
    {
      key: "a",
      prerequisites: [],
      completed: true,
      expectsInputs: false,
      consumed: [],
    },
    {
      key: "b",
      prerequisites: ["a"],
      completed: true,
      expectsInputs: true,
      consumed: [input("a", "x", "v1")],
    },
    {
      key: "c",
      prerequisites: ["b"],
      completed: true,
      expectsInputs: true,
      consumed: [input("b", "y", "w1")],
    },
  ];
  assertEquals(
    findStaleLanes(lanes, current([["a", "x", "v1"], ["b", "y", "w1"]])),
    new Set(),
  );
  assertEquals(
    findStaleLanes(lanes, current([["a", "x", "v2"], ["b", "y", "w1"]])),
    new Set(["b"]),
    "only the direct consumer is stale",
  );
  assertEquals(
    findStaleLanes(lanes, current([["a", "x", null], ["b", "y", "w1"]])),
    new Set(["b"]),
    "a vanished output is stale",
  );
  const sameVersionOtherHash = new Map([
    [outputLookupKey("a", "x"), { versionId: "v1", sha256: "other" }],
    [outputLookupKey("b", "y"), { versionId: "w1", sha256: "s-w1" }],
  ]);
  assertEquals(findStaleLanes(lanes, sameVersionOtherHash), new Set(["b"]));
  assertEquals(
    findStaleLanes(
      lanes.map((l) => ({ ...l, completed: l.key !== "b" })),
      current([["a", "x", "v2"], ["b", "y", "w1"]]),
    ),
    new Set(),
    "a lane whose child has not completed is never stale",
  );
});

Deno.test("a completed lane that declares inputs but recorded none is stale", () => {
  const lane = (expectsInputs: boolean) => [{
    key: "b",
    prerequisites: ["a"],
    completed: true,
    expectsInputs,
    consumed: [],
  }];
  assertEquals(findStaleLanes(lane(true), current([])), new Set(["b"]));
  assertEquals(
    findStaleLanes(lane(false), current([])),
    new Set(),
    "a lane that declares no inputs has nothing to be stale against",
  );
});

Deno.test("a follow-up run that completed later supplies the consumed inputs", () => {
  const run = (
    id: string,
    status: string,
    finishedAt: string | null,
    inputs: ConsumedInput[],
  ): FinishedRunInputs => ({
    id,
    status,
    finishedAt,
    createdAt: "2026-10-28T00:00:00.000000Z",
    inputs,
  });
  const first = run("r1", "completed", "2026-10-28T01:00:00.000000Z", [
    input("a", "x", "v1"),
  ]);
  const followUp = run("r2", "completed", "2026-10-28T02:00:00.000000Z", [
    input("a", "x", "v2"),
  ]);
  const failed = run("r3", "failed", "2026-10-28T03:00:00.000000Z", [
    input("a", "x", "v3"),
  ]);
  assertEquals(latestCompletedRunInputs([first, followUp, failed]), [
    input("a", "x", "v2"),
  ]);
  assertEquals(latestCompletedRunInputs([followUp, first]), [
    input("a", "x", "v2"),
  ]);
  assertEquals(latestCompletedRunInputs([failed]), []);
  const lanes = [{
    key: "b",
    prerequisites: ["a"],
    completed: true,
    expectsInputs: true,
    consumed: latestCompletedRunInputs([first, followUp]),
  }];
  assertEquals(
    findStaleLanes(lanes, current([["a", "x", "v2"]])),
    new Set(),
    "the follow-up run consumed the current version, so the lane is current",
  );
});

Deno.test("a stale lane anywhere upstream blocks a dependant in a three-lane chain A -> B -> C", () => {
  const prerequisites = new Map<string, readonly string[]>([
    ["a", []],
    ["b", ["a"]],
    ["c", ["b"]],
  ]);
  assertEquals(hasStaleUpstream("c", prerequisites, new Set(["b"])), true);
  assertEquals(
    hasStaleUpstream("c", prerequisites, new Set(["a"])),
    true,
    "transitive: A is two lanes upstream of C",
  );
  assertEquals(hasStaleUpstream("b", prerequisites, new Set(["a"])), true);
  assertEquals(
    hasStaleUpstream("b", prerequisites, new Set(["c"])),
    false,
    "a downstream lane never blocks an upstream one",
  );
  assertEquals(
    hasStaleUpstream("c", prerequisites, new Set(["c"])),
    false,
    "a lane's own staleness is rework, not an upstream block",
  );
  assertEquals(
    hasStaleUpstream("a", prerequisites, new Set(["a", "b"])),
    false,
  );
});

// --- Projection with stale lanes ----------------------------------------------

Deno.test("projection keeps the parent open while a lane is stale and holds its dependants", () => {
  const lane = (
    key: string,
    status: Parameters<typeof projectLaneStatuses>[0][number]["status"],
    prerequisites: string[] = [],
  ) => ({ key, status, prerequisites });
  const open = projectLaneStatuses([
    lane("a", "completed"),
    lane("b", "stale", ["a"]),
    lane("c", "completed", ["b"]),
  ]);
  assertEquals(open.plan, "materialized", "stale is not completed");
  assertEquals(open.lanes.get("b"), "stale");

  const held = projectLaneStatuses([
    lane("a", "stale"),
    lane("b", "completed", ["a"]),
    lane("c", "ready", ["b"]),
  ]);
  assertEquals(
    held.lanes.get("c"),
    "waiting",
    "a stale lane two levels up keeps a ready lane from starting",
  );

  const failed = projectLaneStatuses([
    lane("a", "completed"),
    lane("b", "stale", ["a"]),
    lane("c", "failed", ["a"]),
  ]);
  assertEquals(
    failed.plan,
    "partially_delivered",
    "a failed lane still decides the outcome and stale evidence counts as delivered",
  );
  assertEquals(
    projectLaneStatuses([lane("a", "completed"), lane("b", "completed", ["a"])])
      .plan,
    "completed",
  );
});
