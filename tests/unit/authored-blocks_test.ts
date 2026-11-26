import { assertEquals } from "@std/assert";
import {
  groupsOfTree,
  stepsOfTree,
  treeOf,
} from "../../apps/web/src/pages/library/workflow-tree.ts";
import {
  definitionOf,
  type EditorStep,
} from "../../apps/web/src/pages/library/editor-state.ts";

const act = (id: string) => ({ id, uses: "workflow.noop" });
const held = (id: string): EditorStep => ({
  id,
  uses: "",
  agentVersionId: null,
  skills: [],
});
const labels = (step: unknown) =>
  groupsOfTree(treeOf({ steps: [step] })).map((group) => group.label);
const drawn = (step: unknown) =>
  stepsOfTree(treeOf({ steps: [step] })).map((one) => one.id);

Deno.test("a parallel: block draws the steps of its branches", () => {
  const node = {
    id: "fan",
    parallel: {
      branches: [
        { id: "a", steps: [act("one")] },
        { id: "b", steps: [act("two")] },
      ],
    },
  };
  assertEquals(labels(node), ["together"]);
  assertEquals(drawn(node), ["one", "two"]);
});

Deno.test("a forEach: block draws its steps and its limit", () => {
  const node = {
    id: "each",
    forEach: { items: "$input.list", max: 3, as: "item", steps: [act("one")] },
  };
  const [group] = groupsOfTree(treeOf({ steps: [node] }));
  assertEquals([group!.label, group!.max], ["each", 3]);
  assertEquals(drawn(node), ["one"]);
});

Deno.test("a call: block is drawn as a call, not as a nameless step", () => {
  const node = { id: "sub", call: { workflow: "x" } };
  assertEquals(labels(node), ["call"]);
  assertEquals(drawn(node), []);
});

Deno.test("repeat:, branch:, wait: and steps: blocks keep their own drawing", () => {
  assertEquals(
    labels({ id: "r", repeat: { max: 2, steps: [act("one")] } }),
    ["repeat"],
  );
  assertEquals(
    labels({ id: "b", branch: { when: "x", then: [act("one")], else: [] } }),
    ["yes", "otherwise"],
  );
  assertEquals(labels({ id: "w", wait: { duration: "PT1H" } }), ["wait"]);
  assertEquals(drawn({ id: "s", steps: [act("one")] }), ["one"]);
});

Deno.test("fewest and ask are read from inside repeat:", () => {
  const node = {
    id: "r",
    repeat: { min: 2, max: 4, allow: 3, steps: [act("one")] },
  };
  const [group] = groupsOfTree(treeOf({ steps: [node] }));
  assertEquals(
    [group!.loop!.min, group!.loop!.max, group!.loop!.allow],
    [2, 4, 3],
  );
});

Deno.test("a loop inside a parallel branch or a forEach: is written where it is", () => {
  const loop = () => ({ id: "r", repeat: { max: 2, steps: [act("one")] } });
  for (
    const node of [
      { id: "fan", parallel: { branches: [{ id: "a", steps: [loop()] }] } },
      { id: "each", forEach: { max: 3, steps: [loop()] } },
    ]
  ) {
    const found = groupsOfTree(treeOf({ steps: [node] }))
      .find((group) => group.label === "repeat")!;
    const written = definitionOf({ steps: [node] }, [held(node.id)], [
      { path: found.loop!.path, min: null, max: 7, allow: null },
    ]);
    assertEquals(
      JSON.stringify(written).includes('"repeat":{"max":7'),
      true,
      node.id,
    );
  }
});
