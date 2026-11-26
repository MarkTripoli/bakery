import { assertEquals } from "@std/assert";
import {
  anyChange,
  publishChanges,
} from "../../apps/web/src/pages/library/publish-changes.ts";

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
  assertEquals(anyChange(changes), false);
});

Deno.test("steps are listed as new, changed and removed by name", () => {
  const changes = publishChanges(
    { steps: [brief, work] },
    { steps: [{ ...brief, name: "Set the scene" }, loop(3)] },
    t,
  );
  assertEquals(changes.added, ["harnessImplement", "repeat"]);
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
    [changes.added, changes.changed, changes.removed],
    [[], ["repeat"], []],
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
