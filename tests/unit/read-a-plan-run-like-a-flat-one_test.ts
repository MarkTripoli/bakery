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
