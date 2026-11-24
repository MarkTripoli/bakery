import { assertEquals } from "@std/assert";
import {
  boundStepFacts,
  STEP_FACTS_BYTE_BUDGET,
  STEP_FACTS_MAX,
  type StepFactRow,
} from "../../apps/server/src/modules/knowledge/step-facts.ts";

function fact(n: number, wording = `fact ${n}`): StepFactRow {
  return {
    memoryId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    revisionId: `00000000-0000-4000-8000-${String(n + 500).padStart(12, "0")}`,
    wording,
    recordedAt: "2026-11-20T10:00:00.000Z",
  };
}

Deno.test("every candidate inside both caps is kept whole and nothing is omitted", () => {
  const chosen = boundStepFacts([fact(1), fact(2), fact(3)]);
  assertEquals(chosen.facts.length, 3);
  assertEquals(chosen.omitted, 0);
});

Deno.test("the count cap keeps the first facts and says exactly how many were left out", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => fact(index + 1));
  const chosen = boundStepFacts(candidates, { max: 5 });
  assertEquals(chosen.facts.map((entry) => entry.wording), [
    "fact 1",
    "fact 2",
    "fact 3",
    "fact 4",
    "fact 5",
  ]);
  assertEquals(chosen.omitted, 15);
});

Deno.test("the byte cap counts the wording it hands the agent and stops there", () => {
  const candidates = [
    fact(1, "a".repeat(40)),
    fact(2, "b".repeat(40)),
    fact(3, "c".repeat(40)),
  ];
  const chosen = boundStepFacts(candidates, { max: 10, byteBudget: 100 });
  assertEquals(chosen.facts.length, 2);
  assertEquals(chosen.omitted, 1);
});

Deno.test("a wording larger than the whole budget keeps no fact and omits every one", () => {
  const chosen = boundStepFacts([fact(1, "x".repeat(10_000))]);
  assertEquals(chosen.facts, []);
  assertEquals(chosen.omitted, 1);
});

Deno.test("the defaults are a count and a byte budget, not an unbounded list", () => {
  const candidates = Array.from(
    { length: STEP_FACTS_MAX + 3 },
    (_, index) => fact(index + 1),
  );
  const chosen = boundStepFacts(candidates);
  assertEquals(chosen.facts.length, STEP_FACTS_MAX);
  assertEquals(chosen.omitted, 3);
  assertEquals(STEP_FACTS_BYTE_BUDGET > 0, true);
});
