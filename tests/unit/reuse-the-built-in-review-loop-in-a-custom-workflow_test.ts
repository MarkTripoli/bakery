import { assert, assertEquals } from "@std/assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REVIEW_LOOP_LIMITS } from "../../packages/contracts/src/review-evidence.ts";
import {
  compileWorkflowDocumentDetailed,
  type WorkflowSemanticDocument,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import { FIXED_CODING_REVIEWED_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { planReviewLoopLimits } from "../../apps/server/src/modules/review-loop/limits.ts";
import { reviewedPlanDocument } from "../helpers/review-repair/plan-loop-document.ts";

// #62 acceptance 1. The built-in reviewed workflow is an ordinary compiled
// document, so a customer's own workflow that reviews and repairs reaches the
// same decision as the built-in one: it freezes the same loop bounds and is
// judged by the one decision function. These rails pin both halves.

async function document(source: unknown): Promise<WorkflowSemanticDocument> {
  const { result } = await compileWorkflowDocumentDetailed(source, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(result.ok, "the workflow should compile");
  return result.document;
}

Deno.test("a customer's own review and repair workflow freezes the bounds the built-in one does", async () => {
  const builtIn = planReviewLoopLimits(
    await document(FIXED_CODING_REVIEWED_PRESET.spec),
  );
  assertEquals(builtIn, {
    maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
    maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
    maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
  });
  // Differently authored: its own name, step ids and wording, the same repeat.
  const custom = planReviewLoopLimits(
    await document(reviewedPlanDocument({
      name: "my-own-review-and-repair",
      agents: {},
      repairs: REVIEW_LOOP_LIMITS.maxRepairCycles,
    })),
  );
  assertEquals(custom, builtIn);
});

Deno.test("a customer's own repeat bound is what the loop is held to, never more than the built-in ceiling", async () => {
  const bound = async (repairs: number) =>
    planReviewLoopLimits(
      await document(reviewedPlanDocument({
        name: "my-own-review-and-repair",
        agents: {},
        repairs,
      })),
    )?.maxRepairCycles;
  assertEquals(await bound(1), 1);
  assertEquals(await bound(REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling), 8);
});

const SERVER_SOURCE = new URL("../../apps/server/src", import.meta.url)
  .pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith("_test.ts") ? [path] : [];
  });
}

Deno.test("one function decides a review for every workflow: nothing but the review finalizer calls it", () => {
  const callers = sourceFiles(SERVER_SOURCE).filter((file) =>
    /\bdecideDelivery\s*\(/.test(readFileSync(file, "utf8"))
  ).map((file) => relative(SERVER_SOURCE, file).replaceAll("\\", "/")).sort();
  assertEquals(callers, [
    "modules/delivery/finalize-review.ts",
    "modules/review-loop/decision.ts",
  ]);
});
