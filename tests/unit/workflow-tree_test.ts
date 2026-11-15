import { assertEquals } from "@std/assert";
import {
  countSteps,
  stepsOfTree,
  treeOf,
} from "../../apps/web/src/pages/library/workflow-tree.ts";

const step = (id: string, uses = "task.brief") => ({
  kind: "action",
  id,
  uses,
});

Deno.test("a straight line draws one card per step and is editable end to end", () => {
  const tree = treeOf({
    steps: [step("brief"), step("review", "agent.review")],
  });
  assertEquals(tree.straightLine, true);
  assertEquals(tree.stepCount, 2);
  assertEquals(stepsOfTree(tree).map((one) => one.id), ["brief", "review"]);
});

Deno.test("a branch draws its two arms as groups a person cannot change", () => {
  const tree = treeOf({
    steps: [{
      kind: "branch",
      then: [step("yes-1")],
      else: [step("else-1"), step("else-2")],
    }],
  });
  assertEquals(tree.straightLine, false);
  assertEquals(
    tree.nodes.map((node) => node.kind === "group" ? node.label : node.kind),
    [
      "yes",
      "otherwise",
    ],
  );
  assertEquals(tree.stepCount, 3);
  assertEquals(
    tree.nodes.every((node) => node.kind === "group" && node.editedInCode),
    true,
  );
});

Deno.test("parallel lanes and a repeat draw as one group each", () => {
  const parallel = treeOf({
    steps: [{
      kind: "parallel",
      lanes: [{ steps: [step("a")] }, { steps: [step("b")] }],
    }],
  });
  assertEquals(parallel.nodes.length, 1);
  assertEquals(parallel.stepCount, 2);
  const repeat = treeOf({
    steps: [{
      kind: "repeat",
      max: 3,
      seed: { form: "sequence", steps: [step("seed")] },
      steps: [step("body")],
    }],
  });
  assertEquals(repeat.nodes.length, 1);
  assertEquals(repeat.stepCount, 2);
  assertEquals(
    repeat.nodes[0].kind === "group" ? repeat.nodes[0].label : null,
    "repeat",
  );
});

Deno.test("a sequence inside a sequence is flattened, not nested needlessly", () => {
  const tree = treeOf({
    steps: [{
      kind: "sequence",
      steps: [step("a"), { kind: "sequence", steps: [step("b")] }],
    }],
  });
  assertEquals(tree.stepCount, 2);
  assertEquals(tree.nodes.every((node) => node.kind === "step"), true);
});

Deno.test("a wait draws as a group with nothing inside it, and counts no steps", () => {
  const tree = treeOf({ steps: [{ kind: "wait" }] });
  assertEquals(tree.stepCount, 0);
  assertEquals(tree.nodes[0].kind, "group");
  assertEquals(countSteps(tree.nodes[0]), 0);
});

Deno.test("an unknown node shape draws nothing rather than guessing", () => {
  assertEquals(treeOf({ steps: [{ kind: "something-new" }] }).nodes.length, 0);
  assertEquals(treeOf({}).stepCount, 0);
  assertEquals(treeOf(null).stepCount, 0);
});
