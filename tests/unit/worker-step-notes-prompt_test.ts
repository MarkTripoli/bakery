import { assertEquals } from "@std/assert";
import { withStepNotes } from "../../apps/worker/src/step-notes-prompt.ts";

// #412: the notes a person left for a step reach the agent as prompt text and
// nothing else, and a malformed entry is skipped rather than trusted.

Deno.test("a step's notes are appended to its prompt as a list", () => {
  assertEquals(
    withStepNotes("Do the task.", {
      stepNotes: ["Use the helper.", "Be brief."],
    }),
    "Do the task.\n\nNotes left for this step before it started:\n- Use the helper.\n- Be brief.",
  );
});

Deno.test("a prompt is unchanged when the input has no usable notes", () => {
  for (
    const input of [
      undefined,
      null,
      {},
      { stepNotes: "not a list" },
      { stepNotes: [] },
      { stepNotes: [1, null, "", "x".repeat(4001)] },
    ]
  ) assertEquals(withStepNotes("Do the task.", input), "Do the task.");
});

Deno.test("at most twenty notes are taken", () => {
  const notes = Array.from({ length: 25 }, (_, index) => `note ${index}`);
  const lines = withStepNotes("p", { stepNotes: notes }).split("\n- ");
  assertEquals(lines.length - 1, 20);
});
