import { assertEquals } from "@std/assert";
import {
  definitionOf,
  type EditorStep,
  isPlainGroup,
  nodeIds,
} from "../../apps/web/src/pages/library/editor-state.ts";

const brief = { id: "brief", uses: "task.brief" };
const build = {
  id: "build",
  uses: "harness.implement",
  needs: ["brief"],
  with: { repositoryId: "$input.repositoryId" },
};
const repair = { id: "repair", needs: ["flow"], repeat: { max: 3 } };
const spec = { steps: [{ id: "flow", steps: [brief, build] }, repair] };
const step = (id: string, uses: string): EditorStep => ({
  id,
  uses,
  agentVersionId: null,
  skills: [],
  list: "flow",
});

Deno.test("only a wrapper holding plain actions is edited inside", () => {
  assertEquals(isPlainGroup(spec.steps[0]), true);
  assertEquals(isPlainGroup(repair), false);
  assertEquals(isPlainGroup({ id: "g", if: "x", steps: [brief] }), false);
  assertEquals(
    isPlainGroup({ id: "g", steps: [{ id: "r", repeat: { max: 1 } }] }),
    false,
  );
});

Deno.test("steps left alone keep the definition as it was", () => {
  assertEquals(
    definitionOf(spec, [
      step("brief", "task.brief"),
      step("build", "harness.implement"),
    ]),
    spec,
  );
});

Deno.test("a step added inside the group is written there and the loop is untouched", () => {
  const saved = definitionOf(spec, [
    step("brief", "task.brief"),
    step("ask", "human.approval"),
    step("build", "harness.implement"),
  ]);
  assertEquals(saved.steps, [
    {
      id: "flow",
      steps: [brief, { id: "ask", uses: "human.approval" }, build],
    },
    repair,
  ]);
});

Deno.test("every id in the definition is taken, wherever it sits", () => {
  assertEquals(
    [...nodeIds(spec.steps)].sort(),
    ["brief", "build", "flow", "repair"],
  );
});
