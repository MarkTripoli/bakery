import { assertEquals } from "@std/assert";
import {
  isPlanRunSnapshot,
  planDeliveryFrom,
  planNextCycleReservation,
  planRunView,
} from "../../apps/server/src/modules/delivery/plan-run-view.ts";
import {
  candidateHeadSha,
  candidateProducer,
  harnessStepKeys,
} from "../../packages/persistence/src/repository-admission.ts";
import { compiled } from "../helpers/workflow-interpreter.ts";

// #397. The review loop reads a flat run through its frozen spec. A plan run has
// none, so the loop reads it through the steps the run dispatched, in order,
// and the same helpers answer: one definition of the candidate, the implementing
// steps and each `$delivery` reference for both kinds of run.

const H0 = "1".repeat(40);
const H1 = "3".repeat(40);
const OWN = "00000000-0000-4000-8000-0000000000a1";
const FALLBACK = "00000000-0000-4000-8000-0000000000a2";

const steps = [
  { stepKey: "brief", action: "task.brief" },
  { stepKey: "implement", action: "harness.implement" },
  { stepKey: "check", action: "quality.check" },
  { stepKey: "review", action: "review.independent" },
  { stepKey: "repair@1.repair_implement", action: "harness.repair" },
  { stepKey: "repair@1.repair_check", action: "quality.check" },
] as const;

const snapshot = (extra: Record<string, unknown> = {}) => ({
  runtime: { pin: "p", document: {} },
  workflow: { id: "w" },
  stepActions: {},
  repositoryProfile: {
    config: {
      fixedPolicy: { commands: [{ id: "magic.numbers" }, { id: "lint" }] },
    },
  },
  ...extra,
});

Deno.test("a plan snapshot is recognized by its runtime section, a flat one is not", () => {
  assertEquals(isPlanRunSnapshot(snapshot()), true);
  assertEquals(isPlanRunSnapshot({ workflow: {}, stepActions: {} }), false);
  assertEquals(isPlanRunSnapshot(null), false);
});

Deno.test("the candidate of a plan run is the head of the latest harness step, in dispatch order", () => {
  const outputs = {
    implement: { headSha: H0 },
    "repair@1.repair_implement": { headSha: H1 },
  };
  const view = planRunView(snapshot(), steps);
  assertEquals(candidateHeadSha(view, outputs), H1);
  assertEquals(candidateProducer(view, outputs), {
    stepKey: "repair@1.repair_implement",
    headSha: H1,
  });
  // Before the repair reported a head, the implement step's head stands.
  assertEquals(
    candidateHeadSha(view, { implement: { headSha: H0 } }),
    H0,
  );
  assertEquals(harnessStepKeys(view), [
    "implement",
    "repair@1.repair_implement",
  ]);
});

Deno.test("the view keeps every other section as frozen and reads outputs from the registry", () => {
  const frozen = snapshot({ reviewLoop: { maxRepairCycles: 2 } });
  const view = planRunView(frozen, steps) as Record<string, unknown>;
  assertEquals(view.reviewLoop, { maxRepairCycles: 2 });
  assertEquals(view.runtime, frozen.runtime);
  assertEquals(view.stepActions, {});
  assertEquals(
    (view.workflow as { normalizedSpec: { steps: unknown[] } }).normalizedSpec
      .steps.length,
    steps.length,
  );
});

Deno.test("$delivery is absent until the run has a candidate, then holds what the evidence answers", () => {
  const view = planRunView(snapshot(), steps);
  assertEquals(planDeliveryFrom(view, {}), undefined);
  assertEquals(planDeliveryFrom(view, { brief: { artifact: {} } }), undefined);

  const delivery = planDeliveryFrom(view, { implement: { headSha: H0 } });
  // The head and the profile's check ids resolve; the evidence of a check and a
  // review that have not run does not, so those fields are absent, not guessed.
  assertEquals(delivery, { headSha: H0, checkIds: ["magic.numbers", "lint"] });
});

Deno.test("the next cycle reserves the repair and review agents; a step's own agent wins over the fallback", async () => {
  const document = await compiled([
    {
      id: "repair",
      uses: "harness.repair",
      with: {
        repositoryId: "$input.repo",
        revision: "$delivery.headSha",
        findings: "$delivery.blockingFindings",
        failedChecks: "$delivery.failedChecks",
      },
    },
    {
      id: "review",
      needs: ["repair"],
      uses: "review.independent",
      agentVersionId: OWN,
      with: {
        repositoryId: "$input.repo",
        revision: "$delivery.headSha",
        evidence: "$step.repair.checkRunIds",
      },
    },
  ], { repo: { type: "uuid", required: true } });
  const agent = (usd: string) => ({
    config: { billing: { maxUsdReservation: usd } },
  });
  const frozen = snapshot({
    runtime: { pin: "p", document },
    planActionAgents: { "harness.repair": FALLBACK },
    planAgents: {
      [FALLBACK]: agent("1.50"),
      [OWN]: agent("0.25"),
    },
  });
  assertEquals(planNextCycleReservation(frozen), 1_750_000n);
  // An unbilled agent, or an action the plan does not use, reserves nothing.
  assertEquals(
    planNextCycleReservation(snapshot({ runtime: { pin: "p", document } })),
    0n,
  );
});

Deno.test("the next cycle reserves the steps a repeat body runs, not the ones that ran before the loop", async () => {
  // The reviewed shape: implement, a round-0 review, then a repeat whose body
  // repairs twice, checks and reviews. A cycle runs the body, so the top-level
  // review's agent must not stand in for the body's review agent, and both
  // repairs count.
  const roundZeroReview = "00000000-0000-4000-8000-0000000000d1";
  const bodyRepair = "00000000-0000-4000-8000-0000000000d2";
  const bodyFixup = "00000000-0000-4000-8000-0000000000d3";
  const bodyReview = "00000000-0000-4000-8000-0000000000d4";
  const document = await compiled([
    {
      id: "implement",
      uses: "harness.implement",
      with: {
        repositoryId: "$input.repo",
        planArtifact: "00000000-0000-4000-8000-0000000000b1",
      },
    },
    {
      id: "test",
      needs: ["implement"],
      uses: "quality.check",
      with: {
        repositoryId: "$input.repo",
        revision: "$step.implement.headSha",
      },
      checks: ["lint"],
    },
    {
      id: "review",
      needs: ["test"],
      uses: "review.independent",
      agentVersionId: roundZeroReview,
      with: {
        repositoryId: "$input.repo",
        revision: "$step.implement.headSha",
        evidence: "$step.test.checkRunIds",
      },
    },
    {
      id: "repair",
      needs: ["review"],
      repeat: {
        max: 2,
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
            agentVersionId: bodyRepair,
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
            id: "repair_lint",
            needs: ["repair_test"],
            uses: "harness.repair",
            agentVersionId: bodyFixup,
            with: {
              repositoryId: "$input.repo",
              revision: "$step.repair.repair_implement.headSha",
              findings: "$repeat.currentCandidate.findings",
              failedChecks: "$step.repair.repair_test.failedCheckIds",
            },
          },
          {
            id: "repair_review",
            needs: ["repair_lint"],
            uses: "review.independent",
            agentVersionId: bodyReview,
            with: {
              repositoryId: "$input.repo",
              revision: "$step.repair.repair_lint.headSha",
              evidence: "$step.repair.repair_test.checkRunIds",
            },
          },
        ],
        outputs: {
          currentCandidate: {
            headSha: "$step.repair.repair_lint.headSha",
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
    },
  ], { repo: { type: "uuid", required: true } });
  const agent = (usd: string) => ({
    config: { billing: { maxUsdReservation: usd } },
  });
  const frozen = snapshot({
    runtime: { pin: "p", document },
    planActionAgents: { "harness.repair": FALLBACK },
    planAgents: {
      [FALLBACK]: agent("9.00"),
      [roundZeroReview]: agent("0.25"),
      [bodyRepair]: agent("2.00"),
      [bodyFixup]: agent("0.75"),
      [bodyReview]: agent("0.50"),
    },
  });
  // 2.00 + 0.75 + 0.50: the two body repairs and the body review. Reading the
  // first step of each action instead answers 0.25 + 2.00, under-reserving the
  // cycle the run is about to execute.
  assertEquals(planNextCycleReservation(frozen), 3_250_000n);
});
