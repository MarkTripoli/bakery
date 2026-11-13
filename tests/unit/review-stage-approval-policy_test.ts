import { assertEquals, assertThrows } from "@std/assert";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import {
  approvalPolicyDigest,
  effectiveApprovalPolicy,
  parseApprovalPolicy,
} from "../../apps/server/src/modules/work/stage-policy.ts";

// #37 with #57 slice 2: the review stage may wait for a person.

Deno.test("the review stage is policy-selectable in the fixed workflow", () => {
  const review = FIXED_CODING_PRESET.stages.find((stage) =>
    stage.id === "review"
  );
  assertEquals(review?.policySelectable, true);
  assertEquals(review?.waits, "automatic");
});

Deno.test("a task policy may set review to human_approval, and only the two waits", () => {
  assertEquals(
    parseApprovalPolicy({ plan: "automatic", review: "human_approval" }),
    { plan: "automatic", review: "human_approval" },
  );
  assertEquals(
    effectiveApprovalPolicy({ plan: "automatic", review: "human_approval" })
      .review,
    "human_approval",
  );
  assertThrows(() =>
    parseApprovalPolicy({ plan: "automatic", review: "later" })
  );
  assertThrows(() => parseApprovalPolicy({ plan: "automatic", merge: "x" }));
});

Deno.test("a plan-only policy keeps its digest and reads review as automatic", async () => {
  const planOnly = { plan: "human_approval" as const };
  assertEquals(
    await approvalPolicyDigest(parseApprovalPolicy(planOnly)),
    await approvalPolicyDigest(planOnly),
  );
  assertEquals(effectiveApprovalPolicy(planOnly).review, undefined);
  assertEquals(effectiveApprovalPolicy(null).review, undefined);
});
