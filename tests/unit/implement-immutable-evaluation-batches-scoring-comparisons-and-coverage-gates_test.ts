/**
 * #44 on the pure core: result states, coverage, the gate and comparison.
 * AC2: error / unscored results keep the gate from passing. AC3: incompatible
 * batches are refused, missing matches are unpaired, no fabricated delta.
 * AC4: every required case and scorer needs a measured result to pass.
 */

import { assertEquals } from "@std/assert";
import {
  BatchState,
  compareBatches,
  compatibility,
  coverage,
  judgeGate,
  type ResultFact,
  type ResultState,
  settledState,
} from "../../apps/server/src/modules/evaluations/domain.ts";

function r(
  caseId: string,
  state: ResultState,
  over: Partial<ResultFact> = {},
): ResultFact {
  return {
    role: "candidate",
    caseId,
    caseRevision: 1,
    scorerId: "s",
    scorerRevision: 1,
    repetition: 1,
    state,
    score: state === "passed" ? 1 : state === "failed" ? 0 : null,
    required: true,
    ...over,
  };
}
const all = { requireAllPassed: true, minPassRate: null };

Deno.test("AC4: a complete compatible suite passes only when every required result is measured", () => {
  const done = [r("a", "passed"), r("b", "passed")];
  assertEquals(settledState(done, false), BatchState.Completed);
  assertEquals(judgeGate(done, all, BatchState.Completed).decision, "met");
  const failed = [r("a", "passed"), r("b", "failed")];
  const gate = judgeGate(failed, all, BatchState.Completed);
  assertEquals(gate.decision, "not_met");
  assertEquals(gate.blockers, [{
    caseId: "b",
    scorerId: "s",
    state: "failed",
  }]);
  assertEquals(
    judgeGate(
      failed,
      { requireAllPassed: false, minPassRate: 0.5 },
      BatchState.Completed,
    )
      .decision,
    "met",
  );
});

Deno.test("AC2: error, unscored, canceled, skipped and missing keep the gate from passing", () => {
  for (
    const state of [
      "error",
      "unscored",
      "canceled",
      "skipped",
      "missing",
    ] as const
  ) {
    const results = [r("a", "passed"), r("b", state)];
    assertEquals(
      settledState(results, false),
      BatchState.CompletedWithErrors,
      state,
    );
    const gate = judgeGate(results, all, settledState(results, false));
    assertEquals(gate.decision, "cannot_be_judged", state);
    assertEquals(gate.blockers.map((b) => b.state), [state]);
  }
  // A minimum rate cannot average an error away either.
  assertEquals(
    judgeGate(
      [r("a", "passed"), r("b", "error")],
      { requireAllPassed: false, minPassRate: 0.1 },
      BatchState.CompletedWithErrors,
    ).decision,
    "cannot_be_judged",
  );
});

Deno.test("an empty, running or canceled batch cannot pass", () => {
  assertEquals(
    judgeGate([], all, BatchState.Completed).decision,
    "cannot_be_judged",
  );
  assertEquals(settledState([], false), BatchState.Failed);
  const done = [r("a", "passed")];
  for (
    const state of [BatchState.Running, BatchState.Queued, BatchState.Canceled]
  ) {
    assertEquals(judgeGate(done, all, state).decision, "cannot_be_judged");
  }
  assertEquals(settledState(done, true), BatchState.Canceled);
});

Deno.test("coverage counts every state and measured of required, baseline apart", () => {
  const c = coverage([
    r("a", "passed"),
    r("b", "error"),
    r("c", "missing"),
    r("d", "passed", { required: false }),
    r("a", "failed", { role: "baseline" }),
  ]);
  assertEquals([c.required, c.measured], [3, 1]);
  assertEquals([
    c.counts.passed,
    c.counts.error,
    c.counts.missing,
    c.counts.failed,
  ], [1, 1, 1, 0]);
});

const pins = (over: Record<string, unknown> = {}) => ({
  datasetId: "d",
  datasetDigest: "x",
  cases: [{ caseId: "a", caseRevision: 1 }, { caseId: "b", caseRevision: 1 }],
  scorers: [{ scorerId: "s", scorerRevision: 1 }],
  ...over,
});

Deno.test("AC3: incompatible batches are refused with one reason", () => {
  assertEquals(compatibility(pins(), pins()), { compatible: true });
  assertEquals(
    compatibility(
      pins(),
      pins({ datasetId: "e", cases: [{ caseId: "z", caseRevision: 1 }] }),
    ),
    {
      compatible: false,
      reason: "different_dataset",
    },
  );
  assertEquals(
    compatibility(
      pins(),
      pins({ datasetDigest: "y", cases: [{ caseId: "a", caseRevision: 2 }] }),
    ),
    { compatible: false, reason: "different_case_revision" },
  );
  assertEquals(
    compatibility(
      pins(),
      pins({ scorers: [{ scorerId: "s", scorerRevision: 2 }] }),
    ),
    { compatible: false, reason: "different_scorer_version" },
  );
});

Deno.test("AC3: a compatible comparison never fabricates a change, and lists unpaired cases", () => {
  const left = [r("a", "passed"), r("b", "failed"), r("c", "passed")];
  const right = [r("a", "passed"), r("b", "passed"), r("d", "passed")];
  const out = compareBatches(left, right);
  assertEquals(out.measures, [{
    scorerId: "s",
    left: { passRate: 2 / 3, cases: 3 },
    right: { passRate: 1, cases: 3 },
    change: 1 - 2 / 3,
  }]);
  assertEquals(out.unpaired, {
    onlyLeft: [{ caseId: "c", scorerId: "s" }],
    onlyRight: [{ caseId: "d", scorerId: "s" }],
  });
  const none = compareBatches([r("a", "error")], [r("a", "passed")]);
  assertEquals(none.measures[0].change, null);
  assertEquals(none.measures[0].left, { passRate: null, cases: 0 });
  assertEquals(none.cases, [{
    caseId: "a",
    scorerId: "s",
    left: "error",
    right: "passed",
  }]);
});
