import { assertEquals, assertThrows } from "@std/assert";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import {
  effectiveApprovalPolicy,
  parseApprovalPolicy,
} from "../../apps/server/src/modules/work/stage-policy.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

Deno.test("the fixed coding preset declares ordered stages and keeps its digest", async () => {
  assertEquals(FIXED_CODING_PRESET.stages.map((stage) => stage.id), [
    "discuss",
    "plan",
    "implement",
    "review",
  ]);
  assertEquals(
    FIXED_CODING_PRESET.stages.filter((stage) => stage.policySelectable)
      .map((stage) => stage.id),
    ["plan"],
  );
  assertEquals(
    await sha256Hex(canonicalJson(FIXED_CODING_PRESET.spec)),
    FIXED_CODING_PRESET.digest,
  );
});

Deno.test("a missing stored policy reads as the automatic legacy policy", () => {
  assertEquals(effectiveApprovalPolicy(null), { plan: "automatic" });
  assertEquals(parseApprovalPolicy({ plan: "human_approval" }), {
    plan: "human_approval",
  });
  assertThrows(() => parseApprovalPolicy({ plan: "sometimes" }));
  assertThrows(() => parseApprovalPolicy({ plan: "automatic", extra: true }));
});

Deno.test("the fixed coding preset is revision 2 and its digest covers instructions", async () => {
  assertEquals(FIXED_CODING_PRESET.revision, 2);
  const implement = FIXED_CODING_PRESET.spec.steps.find((step) =>
    step.id === "implement"
  );
  assertEquals(implement?.with.instructions, "$input.instructions");
  assertEquals(
    await sha256Hex(canonicalJson(FIXED_CODING_PRESET.spec)),
    FIXED_CODING_PRESET.digest,
  );
});
