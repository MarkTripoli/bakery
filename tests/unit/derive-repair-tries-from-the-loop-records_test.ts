import { assertEquals } from "@std/assert";
import {
  deriveRepairTries,
  type TryCycle,
  tryOfStep,
  type TryStep,
} from "../../apps/server/src/modules/delivery/repair-tries.ts";

// #62. The per-try record of a review and repair loop is derived from the
// cycles, decisions, steps and usage the run already holds. These cases pin the
// derivation: what a try fixed, what came back, what is new, and the time and
// money of its own steps only.

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 22, 12, 0, seconds));
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const cycle = (
  ordinal: number,
  blocking: readonly string[],
  reason: string,
  failedChecks = 0,
): TryCycle => ({
  id: `cycle-${ordinal}`,
  ordinal,
  createdAt: at(100 * (ordinal + 1)),
  blockingCount: blocking.length,
  blocking,
  decision: {
    decision: reason === "clean"
      ? "proceed"
      : reason === "repair_selected"
      ? "repair"
      : "stop",
    reason,
    failedChecks,
  },
});

const step = (
  stepKey: string,
  seconds: number | null,
  costUsd: string | null,
  iteration = 0,
): TryStep => ({
  stepKey,
  iteration,
  startedAt: seconds === null ? null : at(seconds),
  costUsd,
});

Deno.test("the first review is not a try; each later review judges the repair before it", () => {
  const tries = deriveRepairTries([
    cycle(0, [A, B], "repair_selected"),
    cycle(1, [B], "repair_selected"),
    cycle(2, [], "clean"),
  ], []);
  assertEquals(tries.map((t) => [t.number, t.id]), [
    [1, "cycle-1"],
    [2, "cycle-2"],
  ]);
});

Deno.test("fixed, came back and new are matched by fingerprint against the review before", () => {
  const [first, second] = deriveRepairTries([
    cycle(0, [A, B], "repair_selected"),
    cycle(1, [B, C], "repair_selected"),
    cycle(2, [C], "repair_cycles_exhausted"),
  ], []);
  assertEquals(
    [
      first.fixedFindings,
      first.cameBackFindings,
      first.newFindings,
      first.blockingFindings,
    ],
    [1, 1, 1, 2],
  );
  assertEquals(
    [
      second.fixedFindings,
      second.cameBackFindings,
      second.newFindings,
      second.blockingFindings,
    ],
    [1, 1, 0, 1],
  );
  assertEquals([second.decision, second.reason], [
    "stop",
    "repair_cycles_exhausted",
  ]);
});

Deno.test("a try's checks pass only when no required check was failing", () => {
  const [passed, failed] = deriveRepairTries([
    cycle(0, [A], "repair_selected"),
    cycle(1, [A], "repair_selected", 0),
    cycle(2, [A], "repeated_blocker", 2),
  ], []);
  assertEquals([passed.checksPassed, failed.checksPassed], [true, false]);
});

Deno.test("time and cost are those of the try's own steps, summed exactly", () => {
  const tries = deriveRepairTries([
    cycle(0, [A], "repair_selected"),
    cycle(1, [A], "repair_selected"),
    cycle(2, [], "clean"),
  ], [
    step("implement", 10, "9.5"),
    step("review", 50, "1"),
    step("repair@1.repair_implement", 110, "0.1"),
    step("repair@1.repair_check", 150, null),
    step("repair@1.repair_review", 170, "0.2"),
    step("repair@2.repair_implement", 210, "0.000001"),
    step("repair@2.repair_review", 250, null),
  ]);
  assertEquals(tries[0].startedAt, at(110));
  assertEquals(tries[0].durationMs, (200 - 110) * 1000);
  assertEquals(tries[0].costUsd, "0.3");
  assertEquals(tries[1].startedAt, at(210));
  assertEquals(tries[1].durationMs, (300 - 210) * 1000);
  assertEquals(tries[1].costUsd, "0.000001");
});

Deno.test("a try with no recorded start or usage says so instead of inventing a number", () => {
  const [only] = deriveRepairTries([
    cycle(0, [A], "repair_selected"),
    cycle(1, [], "clean"),
  ], [step("repair@1.repair_implement", null, null)]);
  assertEquals([only.startedAt, only.durationMs, only.costUsd], [
    null,
    null,
    null,
  ]);
});

Deno.test("a flat run's iteration is its try number", () => {
  assertEquals(tryOfStep({ stepKey: "repair", iteration: 2 }), 2);
  assertEquals(
    tryOfStep({ stepKey: "repair@3.repair_check", iteration: 0 }),
    3,
  );
  assertEquals(tryOfStep({ stepKey: "implement", iteration: 0 }), 0);
});
