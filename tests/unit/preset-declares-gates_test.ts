import { assertEquals } from "@std/assert";
import { presetDeclaresGates } from "../../apps/web/src/pages/library/library-state.ts";

Deno.test("a preset declares gates only when its definition lists a gates input", () => {
  assertEquals(
    presetDeclaresGates({
      inputs: { brief: { type: "TaskBrief" }, gates: { type: "string" } },
    }),
    true,
  );
  assertEquals(presetDeclaresGates({ inputs: { brief: {} } }), false);
  assertEquals(presetDeclaresGates({ inputs: {} }), false);
  assertEquals(presetDeclaresGates({ steps: [] }), false);
  assertEquals(presetDeclaresGates({ inputs: null }), false);
  assertEquals(presetDeclaresGates({ inputs: ["gates"] }), false);
  assertEquals(presetDeclaresGates(null), false);
  assertEquals(presetDeclaresGates(undefined), false);
});
