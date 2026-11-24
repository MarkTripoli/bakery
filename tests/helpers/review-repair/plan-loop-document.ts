/**
 * The reviewed coding workflow as a compiled plan (#397): the same brief,
 * implement, check and review of the `fixed-coding-reviewed` preset, with the
 * repair as a `repeat` the plan itself runs and bounds. The step inputs read
 * `$delivery.*` exactly as the preset's do, so a flat run and a plan run name
 * the same evidence in the same words.
 *
 * Step keys of a run of this plan: `brief`, `implement`, `check`, `review`,
 * then, per repair round N, `repair@N.repair_implement`,
 * `repair@N.repair_check`, `repair@N.repair_review` and
 * `repair@N.candidate_evidence` (a projection the engine completes itself);
 * every row is stored at iteration 0.
 */

/** The stored key of a loop step in a plan run, for the flat world's names. */
export function planStepKey(
  logical: "brief" | "implement" | "repair" | "check" | "review",
  iteration: number,
): string {
  if (iteration === 0 && logical !== "repair") return logical;
  const inner = {
    brief: "brief",
    implement: "implement",
    repair: "repair_implement",
    check: "repair_check",
    review: "repair_review",
  }[logical];
  return `repair@${iteration}.${inner}`;
}

/** The document, bound to one agent per model action, repairing at most `repairs` times. */
export function reviewedPlanDocument(options: {
  readonly name: string;
  readonly agents: Readonly<Record<string, string>>;
  readonly repairs: number;
  /** Workflow-level limits the plan declares, as an author would write them. */
  readonly limits?: { readonly wallClock?: string };
}) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: options.name,
    description: "The reviewed coding workflow as a compiled plan.",
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    agents: options.agents,
    inputs: {
      repositoryId: { type: "uuid", required: true },
      brief: { type: "TaskBrief", required: true },
      instructions: { type: "string", required: true },
    },
    steps: [
      {
        id: "brief",
        uses: "task.brief",
        with: { brief: "$input.brief", repositoryId: "$input.repositoryId" },
      },
      {
        id: "implement",
        needs: ["brief"],
        uses: "harness.implement",
        with: {
          repositoryId: "$input.repositoryId",
          planArtifact: "$step.brief.artifact.versionId",
          instructions: "$input.instructions",
        },
      },
      {
        id: "check",
        needs: ["implement"],
        uses: "quality.check",
        with: {
          repositoryId: "$input.repositoryId",
          revision: "$delivery.headSha",
          checks: "$delivery.checkIds",
        },
      },
      {
        id: "review",
        needs: ["check"],
        uses: "review.independent",
        with: {
          repositoryId: "$input.repositoryId",
          revision: "$delivery.headSha",
          evidence: "$step.check.checkRunIds",
        },
      },
      {
        id: "repair",
        needs: ["review"],
        repeat: {
          max: options.repairs,
          seed: {
            currentCandidate: {
              headSha: "$step.implement.headSha",
              baseSha: "$step.check.baseSha",
              policyDigest: "$step.check.policyDigest",
              checksPassed: "$step.check.allRequired",
              blockingFindings: "$step.review.blockingFindings",
              reviewId: "$step.review.reviewId",
              findings: "$step.review.findings",
              checkRunIds: "$step.check.checkRunIds",
              failedCheckIds: "$step.check.failedCheckIds",
            },
          },
          until:
            "$repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
          steps: [
            {
              id: "repair_implement",
              uses: "harness.repair",
              with: {
                repositoryId: "$input.repositoryId",
                revision: "$delivery.headSha",
                findings: "$delivery.blockingFindings",
                failedChecks: "$delivery.failedChecks",
              },
            },
            {
              id: "repair_check",
              needs: ["repair_implement"],
              uses: "quality.check",
              with: {
                repositoryId: "$input.repositoryId",
                revision: "$delivery.headSha",
                checks: "$delivery.checkIds",
              },
            },
            {
              id: "repair_review",
              needs: ["repair_check"],
              uses: "review.independent",
              with: {
                repositoryId: "$input.repositoryId",
                revision: "$delivery.headSha",
                evidence: "$step.repair.repair_check.checkRunIds",
              },
            },
            {
              id: "candidate_evidence",
              needs: ["repair_review"],
              uses: "delivery.candidate_evidence",
              with: {
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
          ],
          outputs: { currentCandidate: "$step.repair.candidate_evidence" },
        },
      },
    ],
  };
}
