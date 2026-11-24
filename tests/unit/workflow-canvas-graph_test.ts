import { assertEquals } from "@std/assert";
import {
  type CanvasGraph,
  canvasGraph,
  elkGraph,
  placements,
} from "../../apps/web/src/pages/library/canvas-graph.ts";
import { treeOf } from "../../apps/web/src/pages/library/workflow-tree.ts";

type ElkNode = ReturnType<typeof elkGraph>;

const tabOrder = (graph: CanvasGraph): readonly string[] =>
  graph.blocks.map((block) => block.id);

const step = (id: string, uses = "task.brief") => ({
  kind: "action",
  id,
  uses,
});

Deno.test("a straight line is the start card, its steps in order, and End, joined in pairs", () => {
  const graph = canvasGraph(treeOf({ steps: [step("a"), step("b")] }));
  assertEquals(tabOrder(graph), ["start", "a", "b", "end"]);
  assertEquals(graph.edges.map((edge) => edge.id), [
    "start->a",
    "a->b",
    "b->end",
  ]);
});

Deno.test("a workflow with no steps is the start card and End", () => {
  const graph = canvasGraph(treeOf({ steps: [] }));
  assertEquals(tabOrder(graph), ["start", "end"]);
  assertEquals(graph.edges.map((edge) => edge.id), ["start->end"]);
});

Deno.test("a repeat is a box that holds its steps, drawn where it stands in the order", () => {
  const graph = canvasGraph(treeOf({
    steps: [step("a"), {
      kind: "repeat",
      max: 3,
      steps: [step("b"), step("c")],
    }, step("d")],
  }));
  const ids = tabOrder(graph);
  assertEquals(
    ids.filter((id) =>
      id === "a" || id === "b" || id === "c" || id === "d" || id === "end"
    ),
    ["a", "b", "c", "d", "end"],
  );
  const box = graph.blocks.find((block) => block.kind === "box");
  assertEquals(box?.label, "repeat");
  const inside = graph.blocks.filter((block) => block.parent === box?.id).map((
    block,
  ) => block.id);
  assertEquals(inside, ["b", "c"]);
  assertEquals(ids.indexOf(box!.id) < ids.indexOf("b"), true);
  assertEquals(graph.edges.map((edge) => edge.id).includes("b->c"), true);
  assertEquals(
    graph.edges.map((edge) => edge.id).includes(`${box!.id}->d`),
    true,
  );
});

Deno.test("a branch is one If holding its two arms, each with its own steps", () => {
  const graph = canvasGraph(treeOf({
    steps: [{
      kind: "branch",
      then: [step("yes1")],
      else: [step("no1"), step("no2")],
    }, step("after")],
  }));
  const kinds = graph.blocks.map((block) => block.kind);
  assertEquals(kinds.filter((kind) => kind === "if").length, 1);
  assertEquals(kinds.filter((kind) => kind === "arm").length, 2);
  const iff = graph.blocks.find((block) => block.kind === "if")!;
  const arms = graph.blocks.filter((block) => block.parent === iff.id);
  assertEquals(arms.map((arm) => arm.label), ["yes", "otherwise"]);
  assertEquals(
    graph.blocks.filter((block) => block.parent === arms[1].id).map((block) =>
      block.id
    ),
    ["no1", "no2"],
  );
  assertEquals(tabOrder(graph).at(-2), "after");
});

Deno.test("an empty box says so, so the canvas can draw its one line and its plus", () => {
  const graph = canvasGraph(
    treeOf({ steps: [{ kind: "repeat", max: 2, steps: [] }] }),
  );
  assertEquals(graph.blocks.find((block) => block.kind === "box")?.empty, true);
});

Deno.test("a definition that cannot be read draws only the start card", () => {
  const graph = canvasGraph(treeOf({}));
  assertEquals(tabOrder(graph), ["start"]);
  assertEquals(graph.edges.length, 0);
});

Deno.test("ELK gets boxes inside boxes, the arms of an If in a row, and the measured sizes", () => {
  const graph = canvasGraph(treeOf({
    steps: [step("a"), {
      kind: "branch",
      then: [step("y")],
      else: [step("n")],
    }],
  }));
  const laid = elkGraph(graph, new Map([["a", { width: 320, height: 120 }]]));
  const a = laid.children?.find((child) => child.id === "a");
  assertEquals(a?.height, 120);
  const iff = laid.children?.find((child) => child.id.startsWith("if-"));
  assertEquals(iff?.layoutOptions?.["elk.direction"], "RIGHT");
  assertEquals(iff?.children?.length, 2);
  assertEquals(iff?.children?.[0].children?.[0].id, "y");
});

Deno.test("placements list every block once, parents before children", () => {
  const graph = canvasGraph(
    treeOf({ steps: [{ kind: "repeat", max: 2, steps: [step("b")] }] }),
  );
  const laid = elkGraph(graph);
  const fake: ElkNode = structuredClone(laid);
  let at = 0;
  const fill = (held: ElkNode[]) =>
    held.forEach((child) => {
      child.x = at;
      child.y = at;
      at += 10;
      child.width ??= 100;
      child.height ??= 50;
      fill(child.children ?? []);
    });
  fill(fake.children ?? []);
  assertEquals(
    placements(fake).map((placement) => placement.id),
    tabOrder(graph),
  );
});

Deno.test("the arms of an If hang from the same top, whichever one is taller", () => {
  const graph = canvasGraph(treeOf({
    steps: [{ kind: "branch", then: [step("y")], else: [] }],
  }));
  const fake: ElkNode = structuredClone(elkGraph(graph));
  const iff = fake.children?.find((child) => child.id.startsWith("if-"));
  const [yes, otherwise] = iff?.children ?? [];
  yes.x = 0;
  yes.y = 40;
  yes.height = 136;
  otherwise.x = 400;
  otherwise.y = 64;
  otherwise.height = 88;
  const put = placements(fake);
  const at = (id: string) => put.find((placement) => placement.id === id)!;
  assertEquals(at(yes.id).y, 40);
  assertEquals(at(otherwise.id).y, 40);
  assertEquals(at(otherwise.id).x, 400);
  assertEquals(at(otherwise.id).height, 88);
});
