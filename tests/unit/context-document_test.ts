import { assert, assertEquals } from "@std/assert";
import {
  type ContextDocument,
  renderContextDocument,
  validateContextDocument,
} from "../../apps/worker/src/context-document.ts";

const base: ContextDocument = {
  runId: "11111111-1111-4111-8111-111111111111",
  stepKey: "implement",
  goal: "Implement the approved plan.",
  outputs: ["bakery.implementation-summary"],
  inputs: [
    {
      slot: "brief",
      path: "inputs/brief.md",
      digest: "a".repeat(64),
      sizeBytes: 42,
      mediaType: "text/markdown",
    },
  ],
  contextDir: "/attempt/context",
  outputDir: "/attempt/outputs",
};

Deno.test("the index names every pinned input with its digest", () => {
  const markdown = renderContextDocument(base);
  assert(markdown.includes("## Inputs"));
  assert(markdown.includes("`inputs/brief.md`"));
  assert(markdown.includes("`" + "a".repeat(64) + "`"));
  assert(markdown.includes("42 bytes"));
  assert(markdown.includes("`bakery.implementation-summary`"));
  assert(markdown.includes("`/attempt/outputs`"));
});

Deno.test("the index tells the step not to refetch a newer copy", () => {
  assert(
    renderContextDocument(base).includes("Do not fetch an artifact again"),
  );
});

Deno.test("an empty declaration says so instead of leaving a blank section", () => {
  const markdown = renderContextDocument({
    ...base,
    outputs: [],
    inputs: [],
  });
  assert(markdown.includes("This step declares no outputs."));
  assert(markdown.includes("This step declares no inputs."));
  assert(!markdown.includes("| Slot |"));
});

Deno.test("a path that leaves the context directory is refused", () => {
  for (const path of ["../secret", "/etc/passwd", "inputs/../x", "a//b"]) {
    assertEquals(
      validateContextDocument({
        ...base,
        inputs: [{ ...base.inputs[0], path }],
      }),
      { reason: "context_input_path_unsafe" },
      path,
    );
  }
});

Deno.test("an empty slot is refused instead of rendering a nameless row", () => {
  // The gap this closes was reachable and shipped: every check looked at the
  // path, and `slots.has("")` is simply false, so an input with no slot
  // validated clean and the index rendered a row whose name was blank. A
  // reader cannot tell what it is reading, which is the exact failure the
  // index exists to prevent.
  for (const slot of ["", "   "]) {
    assertEquals(
      validateContextDocument({
        ...base,
        inputs: [{ ...base.inputs[0], slot }],
      }),
      { reason: "context_input_slot_missing" },
      JSON.stringify(slot),
    );
  }
});

Deno.test("a repeated slot or path is refused rather than silently merged", () => {
  const two = (slot: string, path: string) => ({
    ...base,
    inputs: [base.inputs[0], { ...base.inputs[0], slot, path }],
  });
  assertEquals(validateContextDocument(two("brief", "inputs/other.md")), {
    reason: "context_input_slot_repeated",
  });
  assertEquals(validateContextDocument(two("other", "inputs/brief.md")), {
    reason: "context_input_path_repeated",
  });
});

Deno.test("a document without a goal is refused", () => {
  assertEquals(
    validateContextDocument({ ...base, goal: "   " }),
    { reason: "context_goal_missing" },
  );
});

Deno.test("a safe document validates", () => {
  assertEquals(validateContextDocument(base), null);
});
