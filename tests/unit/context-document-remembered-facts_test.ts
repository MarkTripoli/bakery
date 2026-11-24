import { assertEquals, assertFalse } from "@std/assert";
import { renderContextDocument } from "../../apps/worker/src/context-document.ts";

const base = {
  runId: "00000000-0000-4000-8000-0000000000b1",
  stepKey: "implement",
  goal: "Make the change.",
  outputs: [],
  inputs: [],
  contextDir: "/attempt/context",
  outputDir: "/attempt/out",
};

Deno.test("a step with no facts renders no remembered-facts section", () => {
  const rendered = renderContextDocument(base);
  assertFalse(rendered.includes("Remembered facts"));
});

Deno.test("each fact renders its wording and the date it was recorded", () => {
  const rendered = renderContextDocument({
    ...base,
    facts: [{ wording: "Tests run with pnpm.", recordedAt: "2026-11-20" }],
  });
  assertEquals(rendered.includes("## Remembered facts"), true);
  assertEquals(rendered.includes("Tests run with pnpm."), true);
  assertEquals(rendered.includes("recorded 2026-11-20"), true);
});

Deno.test("facts left out to fit the bound are counted, not silently dropped", () => {
  const rendered = renderContextDocument({
    ...base,
    facts: [{ wording: "Only fact.", recordedAt: "2026-11-20" }],
    factsOmitted: 3,
  });
  assertEquals(
    rendered.includes(
      "3 more facts were left out to stay inside this step's limit.",
    ),
    true,
  );
});

Deno.test("one omitted fact reads as a single fact, not three", () => {
  const rendered = renderContextDocument({ ...base, factsOmitted: 1 });
  assertEquals(
    rendered.includes(
      "1 more fact was left out to stay inside this step's limit.",
    ),
    true,
  );
});
