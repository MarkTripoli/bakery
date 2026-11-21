import { assert, assertEquals } from "@std/assert";
import { normalizeEvaluationOutcome } from "../../apps/server/src/modules/evaluations/finalize-attempt.ts";

// #44 slice 2: the server re-validates every evaluation report and fails closed
// to unscored, so a malformed judge answer never counts as a measurement.

const UUID = "00000000-0000-4000-8000-0000000000a1";
const input = {
  evaluationResultId: UUID,
  outputArtifactVersionId: UUID,
  outputSchema: {
    type: "object",
    required: ["verdict"],
    properties: { verdict: { type: "string" } },
  },
};

Deno.test("a judge answer that matches the output schema is recorded as measured", () => {
  assertEquals(
    normalizeEvaluationOutcome("evaluation.score", {
      state: "passed",
      score: 0.8,
      reason: null,
      judgeOutput: { verdict: "good" },
    }, input),
    { state: "passed", score: 0.8, reason: null },
  );
});

Deno.test("malformed judge output becomes unscored with a reason", () => {
  for (
    const judgeOutput of [{ verdict: 3 }, {}, "good", [1], null]
  ) {
    const outcome = normalizeEvaluationOutcome("evaluation.score", {
      state: "passed",
      score: 1,
      reason: null,
      judgeOutput,
    }, input);
    assertEquals(outcome.state, "unscored", JSON.stringify(judgeOutput));
    assertEquals(outcome.score, null);
    assert(outcome.reason);
  }
});

Deno.test("a report that breaks the action output contract becomes unscored", () => {
  for (
    const payload of [
      { state: "passed", score: 1, reason: null },
      { state: "great", score: 1, reason: null, judgeOutput: null },
      "passed",
      null,
    ]
  ) {
    const outcome = normalizeEvaluationOutcome(
      "evaluation.score",
      payload,
      input,
    );
    assertEquals(outcome.state, "unscored", JSON.stringify(payload));
    assert(outcome.reason?.includes("evaluation.score output"));
  }
  assertEquals(
    normalizeEvaluationOutcome("evaluation.check", {
      state: "unscored",
      score: null,
      reason: "x",
    }, input).state,
    "unscored",
  );
});

Deno.test("a measured state needs a score in 0..1", () => {
  for (const score of [null, -0.1, 1.5]) {
    assertEquals(
      normalizeEvaluationOutcome("evaluation.check", {
        state: "failed",
        score,
        reason: "x",
      }, input).state,
      "unscored",
    );
  }
  assertEquals(
    normalizeEvaluationOutcome("evaluation.check", {
      state: "failed",
      score: 0,
      reason: "output is not valid JSON",
    }, input),
    { state: "failed", score: 0, reason: "output is not valid JSON" },
  );
});

Deno.test("an unmeasured report keeps its state, drops any score and always has a reason", () => {
  assertEquals(
    normalizeEvaluationOutcome("evaluation.score", {
      state: "unscored",
      score: null,
      reason: "model scoring not available yet",
      judgeOutput: null,
    }, input),
    {
      state: "unscored",
      score: null,
      reason: "model scoring not available yet",
    },
  );
  const error = normalizeEvaluationOutcome("evaluation.check", {
    state: "error",
    score: null,
    reason: null,
  }, input);
  assertEquals(error.state, "error");
  assert(error.reason);
});
