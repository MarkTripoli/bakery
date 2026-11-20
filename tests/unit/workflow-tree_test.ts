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

Deno.test("an unknown node is drawn as an unknown step, never dropped", () => {
  // The owner's spec says a node is never dropped (section 8); design-ux ruled
  // the same on G2: a step a run would take must not vanish from the page.
  const tree = treeOf({
    steps: [{ kind: "something-new", id: "x", uses: "a.b" }],
  });
  assertEquals(tree.nodes.length, 1);
  const card = tree.nodes[0];
  assertEquals(card.kind === "step" ? card.problem : null, "unknown");
  assertEquals(card.kind === "step" ? card.code : null, "something-new");
  assertEquals(tree.stepCount, 1);
});

Deno.test("a node that is not an object is drawn as unreadable, and nothing crashes", () => {
  const tree = treeOf({ steps: ["not-a-node", 42] });
  assertEquals(tree.nodes.length, 2);
  assertEquals(
    tree.nodes.every((node) =>
      node.kind === "step" && node.problem === "unreadable"
    ),
    true,
  );
  assertEquals(treeOf({}).stepCount, 0);
  assertEquals(treeOf(null).stepCount, 0);
});

Deno.test("an empty arm is still drawn, so a person can tell it from a missing one", () => {
  // design-ux's ruling (comment 6917906748): both arms of a condition are
  // always drawn, and a group with no steps inside keeps its place.
  const tree = treeOf({
    steps: [{ kind: "branch", then: [step("yes-1")], else: [] }],
  });
  assertEquals(tree.nodes.length, 2);
  const arms = tree.nodes.map((node) =>
    node.kind === "group" ? [node.label, node.children.length] : null
  );
  assertEquals(arms, [["yes", 1], ["otherwise", 0]]);
  const parallel = treeOf({ steps: [{ kind: "parallel", lanes: [] }] });
  assertEquals(parallel.nodes.length, 1);
  assertEquals(parallel.stepCount, 0);
});

Deno.test("a step with no id and no type is drawn as unreadable, not dropped", () => {
  const tree = treeOf({ steps: [{ kind: "action" }] });
  assertEquals(tree.nodes.length, 1);
  const card = tree.nodes[0];
  assertEquals(card.kind === "step" ? card.problem : null, "unreadable");
  assertEquals(tree.stepCount, 1);
});

Deno.test("a step Bakery knows but the picker does not offer is edited in code", () => {
  // A type the "Add a step" list does not offer, and a step carrying a setting
  // the panel cannot show, are drawn as cards marked "Edited in code" — not as
  // problems, and never as ordinary editable steps.
  const codeOnly = treeOf({
    steps: [step("brief", "task.brief"), step("add", "harness.implement")],
  });
  assertEquals(
    stepsOfTree(codeOnly).map((one) => one.codeOnly === true),
    [true, false],
  );
  const ownIf = treeOf({
    steps: [{ ...step("add", "harness.implement"), if: { kind: "literal" } }],
  });
  assertEquals(stepsOfTree(ownIf)[0].codeOnly, true);
  const customRetry = treeOf({
    steps: [{
      ...step("add", "harness.implement"),
      retry: { maxAttempts: 3, backoffMs: 1000, on: [] },
    }],
  });
  assertEquals(stepsOfTree(customRetry)[0].codeOnly, true);
});

Deno.test("only an unreadable list of steps draws no steps at all", () => {
  // Case 3 of the ruling: the page says so in a notice. An empty list is a new
  // workflow, not an unreadable one.
  assertEquals(treeOf({}).unreadable, true);
  assertEquals(treeOf(null).unreadable, true);
  assertEquals(treeOf({ steps: "written in code" }).unreadable, true);
  const empty = treeOf({ steps: [] });
  assertEquals(empty.unreadable, false);
  assertEquals(empty.nodes.length, 0);
  assertEquals(empty.straightLine, true);
});

Deno.test("a step that authors sealed or files is drawn as code-only (#448)", () => {
  const tree = treeOf({
    steps: [
      { ...step("sealed", "harness.implement"), sealed: true },
      { ...step("unsealed", "harness.implement"), sealed: false },
      {
        ...step("files", "harness.implement"),
        files: { read: ["src/**"] },
      },
      step("plain", "harness.implement"),
    ],
  });
  assertEquals(
    stepsOfTree(tree).map((one) => [one.id, one.codeOnly]),
    [["sealed", true], ["unsealed", true], ["files", true], ["plain", false]],
  );
});
