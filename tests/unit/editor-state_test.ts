import { assertEquals } from "@std/assert";
import {
  addStep,
  definitionText,
  moveStep,
  newStepId,
  readDefinitionText,
  removeStep,
  sameDefinition,
  setStepField,
  stepsOf,
} from "../../apps/web/src/pages/library/editor-state.ts";

const base = {
  name: "Release train",
  steps: [
    { id: "brief", uses: "task.brief" },
    { id: "implement", uses: "harness.implement", agentVersionId: "x" },
    { id: "review", uses: "agent.review" },
  ],
};

Deno.test("a new step is named for its action and never repeats a key", () => {
  assertEquals(newStepId("harness.implement", []), "implement");
  assertEquals(newStepId("harness.implement", ["implement"]), "implement-2");
  assertEquals(
    newStepId("harness.implement", ["implement", "implement-2"]),
    "implement-3",
  );
  assertEquals(newStepId("", []), "step");
});

Deno.test("adding, removing and moving steps change the steps and keep everything else", () => {
  const added = addStep(base, "agent.review");
  assertEquals(stepsOf(added).map((s) => s.id), [
    "brief",
    "implement",
    "review",
    "review-2",
  ]);
  assertEquals(added.name, "Release train");
  const middle = addStep(base, "task.brief", 0);
  assertEquals(stepsOf(middle).map((s) => s.id), [
    "brief",
    "brief-2",
    "implement",
    "review",
  ]);
  assertEquals(stepsOf(removeStep(base, 1)).map((s) => s.id), [
    "brief",
    "review",
  ]);
  const moved = moveStep(base, 2, -1);
  assertEquals(stepsOf(moved).map((s) => s.id), [
    "brief",
    "review",
    "implement",
  ]);
  assertEquals(moveStep(base, 0, -1), base);
  assertEquals(moveStep(base, 2, 1), base);
  // The other fields of a step travel with it.
  assertEquals(stepsOf(moved)[2]?.agentVersionId, "x");
  // The input is not changed.
  assertEquals(base.steps.length, 3);
});

Deno.test("a step's key and action can be set, and the rest of the step stays", () => {
  const renamed = setStepField(base, 1, "id", "build");
  assertEquals(stepsOf(renamed)[1], {
    id: "build",
    uses: "harness.implement",
    agentVersionId: "x",
  });
  assertEquals(
    stepsOf(setStepField(base, 0, "uses", "agent.review"))[0]?.uses,
    "agent.review",
  );
});

Deno.test("a definition without a step list has none to edit, and odd entries show as empty steps", () => {
  assertEquals(stepsOf({ workflow: { kind: "fixed" } }), []);
  assertEquals(stepsOf({ steps: [3, null] }).map((s) => [s.id, s.uses]), [
    ["", ""],
    ["", ""],
  ]);
});

Deno.test("the Code tab's text round-trips, and a mistake says what is wrong", () => {
  const text = definitionText(base);
  const read = readDefinitionText(text);
  assertEquals(read.ok && sameDefinition(read.definition, base), true);
  assertEquals(readDefinitionText("[1]").ok, false);
  const broken = readDefinitionText('{"steps": [');
  assertEquals(broken.ok, false);
  assertEquals(!broken.ok && broken.message.length > 0, true);
  assertEquals(sameDefinition(base, setStepField(base, 0, "id", "x")), false);
});
