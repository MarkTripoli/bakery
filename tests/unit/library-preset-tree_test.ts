import { assertEquals } from "@std/assert";
import { presetDefinition } from "../../apps/web/src/pages/library/preset-tree.ts";
import { treeOf } from "../../apps/web/src/pages/library/workflow-tree.ts";

const REVIEWED = [
  { id: "flow.brief", uses: "task.brief" },
  { id: "flow.implement", uses: "harness.implement" },
  { id: "flow.check", uses: "quality.check" },
  { id: "flow.review", uses: "review.independent" },
  {
    id: "repair.repair_implement",
    uses: "harness.repair",
    repeatId: "repair",
    repeatMax: 2,
  },
  {
    id: "repair.repair_check",
    uses: "quality.check",
    repeatId: "repair",
    repeatMax: 2,
  },
  {
    id: "repair.repair_review",
    uses: "review.independent",
    repeatId: "repair",
    repeatMax: 2,
  },
];

Deno.test("a preset's repair loop is drawn as one Fix until it passes block with its limit", () => {
  const tree = treeOf(presetDefinition(REVIEWED));
  assertEquals(
    tree.nodes.map((node) =>
      node.kind === "group" ? [node.label, node.max] : node.id
    ),
    ["flow.brief", "flow.implement", "flow.check", "flow.review", ["fix", 2]],
  );
  // No step is dropped: seven steps in, seven cards out.
  assertEquals(tree.stepCount, 7);
});

Deno.test("a preset with no repeat is the same flat line it always was", () => {
  const tree = treeOf(presetDefinition([
    { id: "flow.brief", uses: "task.brief" },
    { id: "flow.implement", uses: "harness.implement" },
  ]));
  assertEquals(tree.nodes.map((node) => node.kind), ["step", "step"]);
});

Deno.test("two repeats stay two blocks, and a repeat with no limit stays in the line", () => {
  const two = treeOf(presetDefinition([
    { id: "a.x", uses: "harness.repair", repeatId: "a", repeatMax: 3 },
    { id: "a.y", uses: "review.independent", repeatId: "a", repeatMax: 3 },
    { id: "b.x", uses: "agent.review", repeatId: "b", repeatMax: 4 },
  ]));
  assertEquals(
    two.nodes.map((node) =>
      node.kind === "group" ? [node.label, node.max] : node.id
    ),
    // The second is a plain repeat: it keeps its word and names no limit.
    [["fix", 3], ["repeat", undefined]],
  );
  const unlimited = treeOf(presetDefinition([
    { id: "a.x", uses: "harness.repair", repeatId: "a" },
    { id: "a.y", uses: "review.independent", repeatId: "a" },
  ]));
  assertEquals(unlimited.nodes.map((node) => node.kind), ["step", "step"]);
});
