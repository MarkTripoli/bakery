// #399. The two code-owned presets become ordinary compiled definitions: each
// holds a container, so the engine decides its steps (a plan run), and each is
// written in the same grammar a customer publishes. This file pins the shape
// while the definitions move from here into workflow-presets.ts.
import { assert, assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  FIXED_CODING_DEFINITION,
  FIXED_CODING_PRESET,
  type WorkflowPresetDocument,
} from "../../packages/contracts/src/workflow-presets.ts";
import {
  extractFixedWorkflowSteps,
  WorkflowNotExecutableError,
} from "../../apps/server/src/modules/work/run-steps.ts";

const INPUTS = {
  brief: { type: "TaskBrief", required: true },
  instructions: { type: "string", required: true },
};

const briefStep = () => ({
  id: "brief",
  uses: "task.brief",
  with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
});

const implementStep = (prefix: string) => ({
  id: "implement",
  needs: ["brief"],
  uses: "harness.implement",
  with: {
    repositoryId: "$task.repositoryId",
    planArtifact: `$step.${prefix}brief.artifact.versionId`,
    instructions: "$input.instructions",
  },
});

const FIXED_CODING: WorkflowPresetDocument = FIXED_CODING_DEFINITION;

const FIXED_CODING_REVIEWED = {
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "fixed-coding-reviewed",
  description: "The fixed coding workflow with review and bounded repair.",
  inputs: INPUTS,
  steps: [
    {
      id: "flow",
      steps: [
        briefStep(),
        implementStep("flow."),
        {
          id: "check",
          needs: ["implement"],
          uses: "quality.check",
          with: {
            repositoryId: "$task.repositoryId",
            revision: "$step.flow.implement.headSha",
            checks: "$delivery.checkIds",
          },
        },
        {
          id: "review",
          needs: ["check"],
          uses: "review.independent",
          with: {
            repositoryId: "$task.repositoryId",
            revision: "$step.flow.implement.headSha",
            evidence: "$step.flow.check.checkRunIds",
          },
        },
      ],
    },
    {
      id: "repair",
      needs: ["flow"],
      repeat: {
        max: 2,
        seed: {
          currentCandidate: {
            headSha: "$step.flow.implement.headSha",
            baseSha: "$step.flow.check.baseSha",
            policyDigest: "$step.flow.check.policyDigest",
            checksPassed: "$step.flow.check.allRequired",
            blockingFindings: "$step.flow.review.blockingFindings",
            reviewId: "$step.flow.review.reviewId",
            findings: "$step.flow.review.findings",
            checkRunIds: "$step.flow.check.checkRunIds",
            failedCheckIds: "$step.flow.check.failedCheckIds",
          },
        },
        until:
          "$repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
        steps: [
          {
            id: "repair_implement",
            uses: "harness.repair",
            with: {
              repositoryId: "$task.repositoryId",
              revision: "$repeat.currentCandidate.headSha",
              findings: "$repeat.currentCandidate.findings",
              failedChecks: "$repeat.currentCandidate.failedCheckIds",
            },
          },
          {
            id: "repair_check",
            needs: ["repair_implement"],
            uses: "quality.check",
            with: {
              repositoryId: "$task.repositoryId",
              revision: "$step.repair.repair_implement.headSha",
              checks: "$delivery.checkIds",
            },
          },
          {
            id: "repair_review",
            needs: ["repair_check"],
            uses: "review.independent",
            with: {
              repositoryId: "$task.repositoryId",
              revision: "$step.repair.repair_implement.headSha",
              evidence: "$step.repair.repair_check.checkRunIds",
            },
          },
        ],
        outputs: {
          currentCandidate: {
            headSha: "$step.repair.repair_implement.headSha",
            baseSha: "$step.repair.repair_check.baseSha",
            policyDigest: "$step.repair.repair_check.policyDigest",
            checksPassed: "$step.repair.repair_check.allRequired",
            blockingFindings: "$step.repair.repair_review.blockingFindings",
            reviewId: "$step.repair.repair_review.reviewId",
            findings: "$step.repair.repair_review.findings",
            checkRunIds: "$step.repair.repair_check.checkRunIds",
            failedCheckIds: "$step.repair.repair_check.failedCheckIds",
          },
        },
      },
    },
  ],
};

for (
  const [name, definition] of [
    ["fixed-coding", FIXED_CODING],
    ["fixed-coding-reviewed", FIXED_CODING_REVIEWED],
  ] as const
) {
  Deno.test(`${name} compiles as an ordinary definition and is a plan`, async () => {
    const { result } = await compileWorkflowDocumentDetailed(definition);
    assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
    assertEquals(result.document.steps.length, definition.steps.length);
    let thrown: unknown;
    try {
      extractFixedWorkflowSteps(definition, "fixed");
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof WorkflowNotExecutableError, String(thrown));
  });
}

Deno.test("fixed-coding runs the same actions in the same order as the flat preset it replaces", async () => {
  const flat = extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec);
  const { result, actionSites } = await compileWorkflowDocumentDetailed(
    FIXED_CODING,
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  // The compiled definition is the flat preset's list wrapped in one sequence:
  // same actions, same order, only the step keys gain the container's prefix.
  assertEquals(
    actionSites.map((site) => site.action),
    flat.map((step) => step.action),
  );
  assertEquals(
    actionSites.map((site) => site.qualifiedId.split(".").at(-1)),
    flat.map((step) => step.key.split(".").at(-1)),
  );
});
