import { assertEquals } from "@std/assert";
import {
  describeGivenFact,
  describeGivenFacts,
} from "../../apps/server/src/modules/knowledge/step-given.ts";
import type { StepFact } from "../../apps/server/src/modules/knowledge/step-facts.ts";

const recorded: StepFact = {
  memoryId: "00000000-0000-4000-8000-0000000000c1",
  revisionId: "00000000-0000-4000-8000-0000000000c2",
  wording: "Tests run with pnpm.",
  recordedAt: "2026-11-20T10:00:00.000Z",
};

Deno.test("a fact whose revision is still current reads as given", () => {
  const given = describeGivenFact(recorded, {
    currentRevisionId: recorded.revisionId,
    status: "active",
  });
  assertEquals(given.state, "given");
  assertEquals(given.wording, "Tests run with pnpm.");
  assertEquals(given.recordedAt, "2026-11-20T10:00:00.000Z");
});

Deno.test("a fact with a newer revision reads as corrected since", () => {
  const given = describeGivenFact(recorded, {
    currentRevisionId: "00000000-0000-4000-8000-0000000000c3",
    status: "active",
  });
  assertEquals(given.state, "corrected_since");
});

Deno.test("a fact that was stopped reads as stopped since, not corrected", () => {
  const given = describeGivenFact(recorded, {
    currentRevisionId: recorded.revisionId,
    status: "retired",
  });
  assertEquals(given.state, "stopped_since");
});

Deno.test("a fact the reader can no longer find reads as stopped since", () => {
  assertEquals(describeGivenFact(recorded, undefined).state, "stopped_since");
});

Deno.test("a list keeps the step's order and judges each fact on its own", () => {
  const second: StepFact = {
    ...recorded,
    memoryId: "00000000-0000-4000-8000-0000000000c4",
    wording: "Reviewers read the diff.",
  };
  const given = describeGivenFacts(
    [recorded, second],
    new Map([[
      second.memoryId,
      {
        currentRevisionId: "00000000-0000-4000-8000-0000000000c5",
        status: "active",
      },
    ]]),
  );
  assertEquals(given.map((fact) => fact.state), [
    "stopped_since",
    "corrected_since",
  ]);
  assertEquals(given.map((fact) => fact.wording), [
    "Tests run with pnpm.",
    "Reviewers read the diff.",
  ]);
});
