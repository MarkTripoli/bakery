import { assert, assertEquals } from "@std/assert";
import { WORKFLOW_PRESETS } from "../../packages/contracts/src/workflow-presets.ts";
import {
  groupsOfTree,
  stepsOfTree,
  treeOf,
} from "../../apps/web/src/pages/library/workflow-tree.ts";
import {
  stepGlyph,
  stepLine,
  stepName,
} from "../../apps/web/src/pages/library/workflow-state.ts";

const preset = (id: string) => {
  const found = WORKFLOW_PRESETS.find((candidate) => candidate.id === id);
  assert(found, id);
  return found.spec as unknown;
};

/** Every step that runs an action in an authored document, at any depth. */
function actionsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(actionsIn);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Record<string, unknown>;
  const own = typeof node.uses === "string" ? [node.uses] : [];
  return [
    ...own,
    ...actionsIn(node.steps),
    ...actionsIn(node.branch),
    ...actionsIn(node.repeat),
    ...actionsIn(node.then),
    ...actionsIn(node.else),
  ];
}

const translate = (key: never) => `t:${key}`;

Deno.test("a preset's repair loop is drawn as one Fix until it passes block with its limit", () => {
  const tree = treeOf(preset("fixed-coding-reviewed"));
  assertEquals(
    tree.nodes.map((node) =>
      node.kind === "group" ? [node.label, node.max] : node.uses
    ),
    [
      "task.brief",
      "harness.implement",
      "quality.check",
      "review.independent",
      ["fix", 2],
    ],
  );
  assertEquals(tree.stepCount, 7);
});

Deno.test("a flat preset is the same straight line it always was", () => {
  const tree = treeOf(preset("fixed-coding"));
  assertEquals(tree.nodes.map((node) => node.kind), ["step", "step"]);
  assertEquals(tree.stepCount, 2);
});

Deno.test("every built-in draws every step it runs: none dropped, none unreadable (#429)", () => {
  for (const { id, spec } of WORKFLOW_PRESETS) {
    const tree = treeOf(spec);
    assertEquals(tree.unreadable, false, id);
    for (const step of stepsOfTree(tree)) {
      assertEquals(step.problem, undefined, `${id}: ${step.id}`);
      assert(step.uses !== "", `${id}: ${step.id} has no action`);
    }
  }
});

Deno.test("the row counts the cards the diagram draws: the Deliver templates are 10, 13, 16 and 16 (#429)", () => {
  assertEquals(
    ["deliver-oneshot", "deliver-lean", "deliver-full", "deliver-prd"].map(
      (id) => treeOf(preset(id)).stepCount,
    ),
    [10, 13, 16, 16],
  );
});

Deno.test("a sign-off on gates: plan is one approval card, and the run's last stop is the End marker (#429)", () => {
  for (
    const id of [
      "deliver-oneshot",
      "deliver-lean",
      "deliver-full",
      "deliver-prd",
    ]
  ) {
    const tree = treeOf(preset(id));
    const steps = stepsOfTree(tree);
    const approvals = steps.filter((step) => step.uses === "human.approval");
    assert(approvals.length >= 1, id);
    for (const approval of approvals) {
      assert(approval.name?.startsWith("Approve "), `${id}: ${approval.id}`);
      assert(approval.description?.includes("Skipped if"), id);
    }
    assertEquals(groupsOfTree(tree).map((group) => group.label), ["fix"], id);
    const last = steps[steps.length - 1]!;
    assertEquals([last.uses, last.end], ["workflow.stop", true], id);
  }
});

Deno.test("a branch that is not that exact sign-off keeps its Yes and Otherwise arms", () => {
  const tree = treeOf({
    steps: [
      {
        id: "pick",
        branch: {
          when: "$input.fast",
          then: [{ id: "a", uses: "task.brief" }],
          else: [{ id: "b", uses: "task.brief" }],
        },
      },
      {
        id: "other",
        branch: {
          when: '$input.gates == "plan"',
          then: [{ id: "a2", uses: "task.brief" }],
          else: [],
        },
      },
    ],
  });
  assertEquals(groupsOfTree(tree).map((group) => group.label), [
    "yes",
    "otherwise",
    "yes",
    "otherwise",
  ]);
});

Deno.test("a stop in the middle is a card and is counted; only the last one is the End marker", () => {
  const tree = treeOf({
    steps: [
      { id: "a", uses: "task.brief" },
      { id: "halt", uses: "workflow.stop" },
      { id: "b", uses: "task.brief" },
      { id: "end", uses: "workflow.stop" },
    ],
  });
  const steps = stepsOfTree(tree);
  assertEquals(steps.map((step) => step.end), [
    undefined,
    undefined,
    undefined,
    true,
  ]);
  assertEquals(tree.stepCount, 3);
});

Deno.test("no Deliver writer is left as a Custom agent task: each has its own name and line (#429)", () => {
  for (
    const id of [
      "deliver-oneshot",
      "deliver-lean",
      "deliver-full",
      "deliver-prd",
    ]
  ) {
    const writers = stepsOfTree(treeOf(preset(id))).filter((step) =>
      step.uses === "agent.freeform"
    );
    assert(writers.length >= 2, id);
    const names = writers.map((step) => stepName(step, translate));
    for (const step of writers) {
      assert(
        step.name !== undefined && step.description !== undefined,
        `${id}: ${step.id}`,
      );
    }
    assertEquals(new Set(names).size, names.length, `${id}: names repeat`);
  }
});

Deno.test("a card's name and line are the step's own, else its action's; a reviewer is a shield", () => {
  const [own, plain, reviewer] = stepsOfTree(treeOf({
    steps: [
      {
        id: "a",
        uses: "agent.freeform",
        name: "Write it",
        description: "Says it.",
      },
      { id: "b", uses: "agent.freeform" },
      { id: "c", uses: "agent.freeform", role: "reviewer" },
    ],
  }));
  assertEquals(stepName(own!, translate), "Write it");
  assertEquals(stepLine(own!, translate), "Says it.");
  assertEquals(
    stepName(plain!, translate),
    "t:library.workflow.action.agentFreeform",
  );
  assertEquals(
    stepLine(plain!, translate),
    "t:library.workflow.actionLine.agentFreeform",
  );
  assertEquals(stepGlyph(plain!), "document");
  assertEquals(stepGlyph(reviewer!), "shield");
});

Deno.test("a document with no list of steps stays unreadable, and an unknown node is kept as a step", () => {
  assertEquals(treeOf(undefined).unreadable, true);
  assertEquals(treeOf({ steps: "nope" }).unreadable, true);
  const kept = treeOf({ steps: [{ id: "odd", somethingNew: {} }] });
  assertEquals(kept.stepCount, 1);
  assertEquals(stepsOfTree(kept)[0]!.id, "odd");
});
