import { assertEquals } from "@std/assert";
import { releaseStepOf } from "../../apps/server/src/modules/workflow-adapter/release-step.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";

const inputs = { repo: { type: "uuid", required: true } };

const mergeStep = {
  id: "ship",
  uses: "delivery.merge",
  with: { repositoryId: "$input.repo", candidate: "$step.seed.candidate" },
  effectKey: ["merge", "$input.repo"],
};

const deployStep = {
  id: "release",
  uses: "delivery.deploy",
  with: { releaseId: "$step.seed.releaseId", environment: "production" },
  effectKey: ["deploy", "$input.repo"],
};

const planSnapshot = async (steps: readonly object[]) => ({
  schemaVersion: 1,
  runtime: { document: await compiled(steps as never, inputs) },
});

Deno.test("a plan that releases after its merge reads as yes", async () => {
  const snapshot = await planSnapshot([noop("seed"), mergeStep, deployStep]);
  assertEquals(releaseStepOf(snapshot), "yes");
});

Deno.test("a plan that merges and stops reads as no", async () => {
  const snapshot = await planSnapshot([noop("seed"), mergeStep]);
  assertEquals(releaseStepOf(snapshot), "no");
});

Deno.test("a plan with no merge step reads as no", async () => {
  const snapshot = await planSnapshot([noop("seed"), noop("after")]);
  assertEquals(releaseStepOf(snapshot), "no");
});

Deno.test("a flat run reads yes or no from the steps it froze", () => {
  const flat = (uses: readonly string[]) => ({
    schemaVersion: 1,
    workflow: {
      normalizedSpec: {
        steps: uses.map((use, index) => ({ id: `step_${index}`, uses: use })),
      },
    },
  });
  assertEquals(
    releaseStepOf(flat(["workflow.noop", "delivery.merge", "delivery.deploy"])),
    "yes",
  );
  assertEquals(releaseStepOf(flat(["delivery.merge", "workflow.noop"])), "no");
});

Deno.test("a snapshot that holds no readable plan reads as unknown", () => {
  assertEquals(releaseStepOf(undefined), "unknown");
  assertEquals(releaseStepOf(null), "unknown");
  assertEquals(releaseStepOf({}), "unknown");
  assertEquals(
    releaseStepOf({ runtime: { document: { steps: "nope" } } }),
    "unknown",
  );
});
