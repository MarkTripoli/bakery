import { assertEquals } from "@std/assert";
import {
  compareRules,
  runRulesFacts,
} from "../../apps/web/src/pages/run-rules.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const STEP_1 = "11111111-1111-4111-8111-111111111111";
const STEP_2 = "22222222-2222-4222-8222-222222222222";

const check = (
  policyDigest: string,
  checkerDigest: string | null,
  runStepId: string | null,
  createdAt: string,
) => ({ policyDigest, checkerDigest, runStepId, createdAt });

Deno.test("no check rows record no rules and no checks", () => {
  assertEquals(runRulesFacts([]), { rules: [], checks: null });
});

Deno.test("one fingerprint across many rows is one fingerprint, with the newest checks fingerprint", () => {
  const facts = runRulesFacts([
    check(A, B, STEP_1, "2026-11-18T10:00:00.000Z"),
    check(A, C, STEP_1, "2026-11-18T10:05:00.000Z"),
    check(A, null, null, "2026-11-18T10:06:00.000Z"),
  ]);
  assertEquals(facts.rules, [{ digest: A, stepId: STEP_1 }]);
  assertEquals(facts.checks, C);
});

Deno.test("a run that holds two rules fingerprints lists the newest first, each with the step it first applied to", () => {
  const facts = runRulesFacts([
    check(A, null, STEP_1, "2026-11-18T10:00:00.000Z"),
    check(B, null, STEP_2, "2026-11-18T11:00:00.000Z"),
    check(B, null, STEP_2, "2026-11-18T11:05:00.000Z"),
  ]);
  assertEquals(facts.rules, [
    { digest: B, stepId: STEP_2 },
    { digest: A, stepId: STEP_1 },
  ]);
  assertEquals(facts.checks, null);
});

Deno.test("the comparison uses the newest fingerprint and never says same without evidence", () => {
  const facts = runRulesFacts([
    check(A, null, STEP_1, "2026-11-18T10:00:00.000Z"),
    check(B, null, STEP_2, "2026-11-18T11:00:00.000Z"),
  ]);
  assertEquals(compareRules(facts, B), "same");
  assertEquals(compareRules(facts, A), "changed");
  assertEquals(compareRules(facts, C), "changed");
  assertEquals(compareRules(facts, undefined), "unknown");
  assertEquals(compareRules(runRulesFacts([]), A), "unknown");
});
