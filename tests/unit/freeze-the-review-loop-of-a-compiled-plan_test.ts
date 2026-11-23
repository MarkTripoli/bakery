import { assertEquals } from "@std/assert";
import { REVIEW_LOOP_LIMITS } from "../../packages/contracts/src/review-evidence.ts";
import {
  planReviewLoopLimits,
  planReviewRepeatKey,
} from "../../apps/server/src/modules/review-loop/limits.ts";
import { compiled } from "../helpers/workflow-interpreter.ts";

// #397. A compiled plan freezes the review loop's bounds at admission when it
// holds a `review.independent` step: the repair count is the plan's own
// `repeat.max` (capped at the contract ceiling), the other bounds are the
// server defaults, and a plan with no review freezes nothing.

const INPUTS = { repo: { type: "uuid", required: true } };
const implement = {
  id: "implement",
  uses: "harness.implement",
  with: {
    repositoryId: "$input.repo",
    planArtifact: "00000000-0000-4000-8000-0000000000b1",
  },
};
const test = {
  id: "test",
  needs: ["implement"],
  uses: "quality.check",
  with: {
    repositoryId: "$input.repo",
    revision: "$step.implement.headSha",
  },
  checks: ["lint"],
};
const review = {
  id: "review",
  needs: ["test"],
  uses: "review.independent",
  with: {
    repositoryId: "$input.repo",
    revision: "$step.implement.headSha",
    evidence: "$step.test.checkRunIds",
  },
};

/** The repair loop of chapter 6: repair, check and review until nothing blocks. */
const repairLoop = (max: number) => ({
  id: "repair",
  needs: ["review"],
  repeat: {
    max,
    seed: {
      currentCandidate: {
        headSha: "$step.implement.headSha",
        baseSha: "$step.test.baseSha",
        policyDigest: "$step.test.policyDigest",
        checksPassed: "$step.test.allRequired",
        blockingFindings: "$step.review.blockingFindings",
        reviewId: "$step.review.reviewId",
        findings: "$step.review.findings",
        checkRunIds: "$step.test.checkRunIds",
        failedCheckIds: "$step.test.failedCheckIds",
      },
    },
    until:
      "$repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
    steps: [
      {
        id: "repair_implement",
        uses: "harness.repair",
        with: {
          repositoryId: "$input.repo",
          revision: "$repeat.currentCandidate.headSha",
          findings: "$repeat.currentCandidate.findings",
          failedChecks: "$repeat.currentCandidate.failedCheckIds",
        },
      },
      {
        id: "repair_test",
        needs: ["repair_implement"],
        uses: "quality.check",
        with: {
          repositoryId: "$input.repo",
          revision: "$step.repair.repair_implement.headSha",
        },
        checks: ["lint"],
      },
      {
        id: "repair_review",
        needs: ["repair_test"],
        uses: "review.independent",
        with: {
          repositoryId: "$input.repo",
          revision: "$step.repair.repair_implement.headSha",
          evidence: "$step.repair.repair_test.checkRunIds",
        },
      },
    ],
    outputs: {
      currentCandidate: {
        headSha: "$step.repair.repair_implement.headSha",
        baseSha: "$step.repair.repair_test.baseSha",
        policyDigest: "$step.repair.repair_test.policyDigest",
        checksPassed: "$step.repair.repair_test.allRequired",
        blockingFindings: "$step.repair.repair_review.blockingFindings",
        reviewId: "$step.repair.repair_review.reviewId",
        findings: "$step.repair.repair_review.findings",
        checkRunIds: "$step.repair.repair_test.checkRunIds",
        failedCheckIds: "$step.repair.repair_test.failedCheckIds",
      },
    },
  },
});

Deno.test("a plan without a review step freezes no loop", async () => {
  const document = await compiled([implement, test], INPUTS);
  assertEquals(planReviewLoopLimits(document), null);
});

Deno.test("a plan with a review and no repeat freezes a loop that allows no repair", async () => {
  const document = await compiled([implement, test, review], INPUTS);
  assertEquals(planReviewLoopLimits(document), {
    maxRepairCycles: 0,
    maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
    maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
  });
});

Deno.test("the repair count is the plan's own repeat bound, capped at the ceiling", async () => {
  for (const [max, expected] of [[1, 1], [2, 2], [8, 8]] as const) {
    const document = await compiled(
      [implement, test, review, repairLoop(max)],
      INPUTS,
    );
    assertEquals(planReviewLoopLimits(document)?.maxRepairCycles, expected);
  }
});
Deno.test("a review inside a forEach is not in a repair loop: the list's bound is not a cycle bound (#417)", async () => {
  const document = await compiled([
    implement,
    test,
    {
      id: "phases",
      needs: ["test"],
      forEach: {
        items: "$step.test.checkRunIds",
        max: 6,
        as: "phase",
        steps: [{ ...review, needs: [] }],
      },
    },
  ], INPUTS);
  assertEquals(planReviewLoopLimits(document)?.maxRepairCycles, 0);
  assertEquals(planReviewRepeatKey(document), null);
});
