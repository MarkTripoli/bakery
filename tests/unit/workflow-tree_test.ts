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

const fixLoop = (extra: Record<string, unknown> = {}) => ({
  kind: "repeat",
  max: 2,
  seed: { form: "sequence", steps: [step("seed")] },
  steps: [
    step("repair", "harness.repair"),
    step("check", "quality.check"),
    step("review", "review.independent"),
  ],
  ...extra,
});

const groupOf = (definition: unknown) => {
  const node = treeOf(definition).nodes[0];
  if (node.kind !== "group") throw new Error("expected a group");
  return node;
};

Deno.test("a repeat that repairs and ends in an independent review is a fix block with its limit", () => {
  const group = groupOf({ steps: [fixLoop()] });
  assertEquals(group.label, "fix");
  assertEquals(group.max, 2);
  assertEquals(group.editedInCode, true);
  assertEquals(treeOf({ steps: [fixLoop()] }).stepCount, 4);
});

Deno.test("every other repeat keeps the word Repeat and carries no limit", () => {
  const plain = groupOf({
    steps: [{ kind: "repeat", max: 3, steps: [step("body")] }],
  });
  assertEquals(plain.label, "repeat");
  assertEquals(plain.max, undefined);
  // A repair with no review at the end, a review with no repair, and a review
  // that is not last are not the fix block.
  const noReview = groupOf({
    steps: [fixLoop({ steps: [step("repair", "harness.repair")] })],
  });
  assertEquals(noReview.label, "repeat");
  const noRepair = groupOf({
    steps: [fixLoop({ steps: [step("review", "review.independent")] })],
  });
  assertEquals(noRepair.label, "repeat");
  const reviewFirst = groupOf({
    steps: [fixLoop({
      steps: [
        step("review", "review.independent"),
        step("repair", "harness.repair"),
      ],
    })],
  });
  assertEquals(reviewFirst.label, "repeat");
  // The seed does not count as the block's own steps.
  const seeded = groupOf({
    steps: [fixLoop({
      seed: { form: "sequence", steps: [step("repair", "harness.repair")] },
      steps: [step("review", "review.independent")],
    })],
  });
  assertEquals(seeded.label, "repeat");
});

Deno.test("a fix block with no readable limit is not named, so it never states a limit it lacks", () => {
  for (const max of [undefined, 0, -1, 2.5, "3", null]) {
    const group = groupOf({ steps: [fixLoop({ max })] });
    assertEquals(group.label, "repeat", String(max));
    assertEquals(group.max, undefined, String(max));
  }
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

const eachLoop = (extra: Record<string, unknown> = {}) => ({
  kind: "forEach",
  items: "issues",
  as: "issue",
  max: 12,
  steps: [step("implement"), step("check", "quality.check")],
  ...extra,
});

Deno.test("a forEach is a For each item block with its limit and its steps drawn once", () => {
  const tree = treeOf({ steps: [step("brief"), eachLoop(), step("review")] });
  const group = tree.nodes[1];
  if (group.kind !== "group") throw new Error("expected a group");
  assertEquals(group.label, "each");
  assertEquals(group.max, 12);
  assertEquals(group.editedInCode, true);
  assertEquals(group.children.length, 2);
  assertEquals(tree.stepCount, 4);
  assertEquals(tree.straightLine, false);
});

Deno.test("a forEach with no readable limit is drawn without one, never with an invented one", () => {
  for (const max of [undefined, 0, -1, 2.5, "12", null]) {
    const group = groupOf({ steps: [eachLoop({ max })] });
    assertEquals(group.label, "each");
    assertEquals(group.max, undefined);
  }
});

Deno.test("a forEach with no steps is an empty block, and one inside a repeat nests", () => {
  const empty = groupOf({ steps: [eachLoop({ steps: [] })] });
  assertEquals(empty.children.length, 0);
  const nested = groupOf({
    steps: [{ kind: "repeat", max: 3, steps: [eachLoop({ max: 1 })] }],
  });
  assertEquals(nested.label, "repeat");
  const inner = nested.children[0];
  if (inner.kind !== "group") throw new Error("expected a nested group");
  assertEquals(inner.label, "each");
  assertEquals(inner.max, 1);
});

Deno.test("a repeat carries its own numbers and where they live (#419)", () => {
  const tree = treeOf({
    steps: [
      {
        kind: "repeat",
        id: "fix",
        min: 2,
        max: 4,
        allow: 3,
        seed: { form: "literal", value: null },
        until: { kind: "literal", value: false },
        steps: [{ kind: "action", id: "repair", uses: "harness.repair" }, {
          kind: "action",
          id: "review",
          uses: "review.independent",
        }],
      },
    ],
  });
  const group = tree.nodes[0];
  if (group.kind !== "group") throw new Error("a repeat is a group");
  assertEquals(group.label, "fix");
  assertEquals(group.loop, {
    min: 2,
    max: 4,
    allow: 3,
    fix: true,
    path: ["steps", 0],
  });
});

Deno.test("a repeat the editor cannot read its max for offers no numbers", () => {
  const tree = treeOf({
    steps: [{
      kind: "repeat",
      seed: { form: "literal", value: null },
      steps: [],
    }],
  });
  const group = tree.nodes[0];
  if (group.kind !== "group") throw new Error("a repeat is a group");
  assertEquals(group.loop, undefined);
});
