import { assertEquals } from "@std/assert";
import { publishChanges } from "../../apps/web/src/pages/library/publish-changes.ts";

const t = (key: string) => key.split(".").at(-1)!;
const brief = { id: "brief", uses: "task.brief" };
const work = { id: "work", uses: "harness.implement" };
const loop = (max: number) => ({
  id: "again",
  repeat: { max, steps: [{ id: "fix", uses: "harness.implement" }] },
});

Deno.test("the same steps in another key order are no change", () => {
  const changes = publishChanges(
    { steps: [{ uses: "task.brief", id: "brief" }] },
    { steps: [brief] },
    t,
  );
  assertEquals(changes.differs, false);
});

Deno.test("steps are listed as new, changed and removed by name", () => {
  const changes = publishChanges(
    { steps: [brief, work] },
    { steps: [{ ...brief, name: "Set the scene" }, loop(3)] },
    t,
  );
  assertEquals(changes.added, ["repeat", "harnessImplement"]);
  assertEquals(changes.changed, ["Set the scene"]);
  assertEquals(changes.removed, ["harnessImplement"]);
});

Deno.test("a repeat number alone changes the block and nothing inside it", () => {
  const changes = publishChanges(
    { steps: [loop(3)] },
    { steps: [loop(5)] },
    t,
  );
  assertEquals(
    [changes.added, changes.changed, changes.removed, changes.limits.length],
    [[], [], [], 1],
  );
});

Deno.test("a move is reported as a change of order only", () => {
  const changes = publishChanges(
    { steps: [brief, work] },
    { steps: [work, brief] },
    t,
  );
  assertEquals(changes.changed, []);
  assertEquals(changes.reordered, true);
});

Deno.test("a first version lists every step as new", () => {
  const changes = publishChanges(null, { steps: [brief, work] }, t);
  assertEquals(changes.added, ["taskBrief", "harnessImplement"]);
  assertEquals(changes.settings, false);
});

Deno.test("a change outside the steps is a change of settings", () => {
  const changes = publishChanges(
    { description: "a", steps: [brief] },
    { description: "b", steps: [brief] },
    t,
  );
  assertEquals(changes.settings, true);
});

Deno.test("blocks are named as the diagram names them, and wrappers are not listed", () => {
  const changes = publishChanges(null, {
    steps: [
      { id: "flow", steps: [brief] },
      {
        id: "repair",
        repeat: {
          max: 2,
          steps: [
            { id: "mend", uses: "harness.repair" },
            { id: "look", uses: "review.independent" },
          ],
        },
      },
    ],
  }, t);
  assertEquals(changes.added, [
    "taskBrief",
    "fixUntilPasses",
    "harnessRepair",
    "reviewIndependent",
  ]);
});

Deno.test("a change to a wrapper alone is still something to publish", () => {
  const changes = publishChanges(
    { steps: [{ id: "flow", steps: [brief] }] },
    { steps: [{ id: "flow", if: "$inputs.go", steps: [brief] }] },
    t,
  );
  assertEquals([changes.changed, changes.grouped], [[], true]);
});

const gate = (name: string) => ({
  id: "approve",
  uses: "human.approval",
  name,
});
const twoGates = (first: string) => ({
  steps: [
    { id: "a", steps: [gate(first)] },
    { id: "b", steps: [gate("Approve the plan")] },
  ],
});

Deno.test("a change to the first of two steps that share an id is listed", () => {
  const changes = publishChanges(
    twoGates("Approve the requirements"),
    twoGates("Approve the budget"),
    t,
  );
  assertEquals(changes.changed, ["Approve the budget"]);
  assertEquals(changes.differs, true);
  assertEquals(publishChanges(null, twoGates("One"), t).added, [
    "One",
    "Approve the plan",
  ]);
});

Deno.test("adding or removing a group around a step is something to publish", () => {
  for (
    const wrapper of [
      { id: "g", steps: [brief] },
      { id: "g", if: "$input.go", steps: [brief] },
    ]
  ) {
    for (
      const [before, after] of [[[wrapper], [brief]], [[brief], [wrapper]]]
    ) {
      const changes = publishChanges({ steps: before }, { steps: after }, t);
      assertEquals(
        [changes.added, changes.removed, changes.grouped, changes.differs],
        [[], [], true, true],
      );
    }
  }
});

Deno.test("a plan gate is listed once, by the name its card shows", () => {
  const changes = publishChanges(null, {
    steps: [{
      id: "gate",
      branch: {
        when: '$input.gates == "plan"',
        then: [gate("Approve the plan")],
      },
    }],
  }, t);
  assertEquals(changes.added, ["Approve the plan"]);
});

Deno.test("the closing stop is called End", () => {
  const changes = publishChanges(null, {
    steps: [brief, { id: "done", uses: "workflow.stop" }],
  }, t);
  assertEquals(changes.added, ["taskBrief", "pathEnd"]);
});

Deno.test("a limit change says the new and the old number", () => {
  const changes = publishChanges(
    { steps: [loop(2)] },
    { steps: [loop(3)] },
    t,
  );
  assertEquals(changes.limits, [{
    name: "repeat",
    unit: "tries",
    max: 3,
    was: 2,
  }]);
  assertEquals(changes.changed, []);
});

Deno.test("a difference the list cannot name still counts", () => {
  const changes = publishChanges(
    { steps: [brief], extra: [] },
    { steps: [brief, 1], extra: [] },
    t,
  );
  assertEquals([changes.other, changes.differs], [true, true]);
});
