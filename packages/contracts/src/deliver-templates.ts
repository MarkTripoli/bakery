import type { WorkflowPresetDocument } from "./workflow-presets.ts";

type Json = Readonly<Record<string, unknown>>;

export const DELIVER_TEMPLATE_IDS = Object.freeze(
  [
    "deliver-oneshot",
    "deliver-lean",
    "deliver-full",
    "deliver-prd",
  ] as const,
);
export type DeliverTemplateId = typeof DELIVER_TEMPLATE_IDS[number];

export const DELIVER_TEMPLATE_AUDIT_GAPS: readonly Readonly<
  { construct: string; design: string; stand_in: string }
>[] = Object.freeze([
  {
    construct: "artifact kinds with validators and facts on a step's output",
    design: "A1/A2",
    stand_in:
      "an output slot names a role (plan, review); no kind validator or typed fact is bound",
  },
  {
    construct: "forEach over the validated phase list of a plan",
    design: "A3",
    stand_in:
      "one build loop covers the whole plan; the plan lists its phases in prose",
  },
  {
    construct:
      "engine-enforced review isolation and per-phase review checkpoints",
    design: "A4/A6",
    stand_in:
      "the reviewer is a separate step with the reviewer role and its own inputs; rounds are not counted per checkpoint",
  },
  {
    construct: "run-level decisions record read by later steps",
    design: "A8",
    stand_in: "approvals record their decision in the decisions ledger only",
  },
  {
    construct: "repeat.allow soft cap raised by a limit decision",
    design: "A8",
    stand_in: "repeat.max is the one bound",
  },
  {
    construct: "active-time limit over 24 hours",
    design: "A9",
    stand_in:
      "no wall-clock limit is declared; each step carries its own timeout",
  },
  {
    construct: "a stop outcome chosen from the review decision",
    design: "A7/A10",
    stand_in:
      "the repair loop ends the run through the interpreter's own rules",
  },
  {
    construct: "a pull-request step",
    design: "G4",
    stand_in:
      "the template ends at a verified, reviewed candidate with outcome done",
  },
  {
    construct: "call of a shared workflow",
    design: "G14",
    stand_in: "the shared build and finish steps are inlined into each variant",
  },
]);

const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "glob"]);

function writer(
  id: string,
  needs: readonly string[],
  prompt: string,
  from: readonly (readonly [name: string, ref: string])[],
  output: string,
  budget: { maxTurns: number; timeout: string; maxCostUsd: number },
  role: "writer" | "reviewer" = "writer",
): Json {
  return Object.freeze({
    id,
    needs: Object.freeze([...needs]),
    uses: "agent.freeform",
    role,
    inputs: Object.freeze(
      from.map(([name, ref]) => Object.freeze({ name, from: ref })),
    ),
    outputs: Object.freeze([Object.freeze({ name: output, kind: output })]),
    with: Object.freeze({
      prompt,
      ...budget,
      allowedTools: READ_ONLY_TOOLS,
    }),
  });
}

const BRIEF_REF = "$step.brief.artifact.versionId";
const artifactOf = (id: string) => `$step.${id}.outputs.${id}`;

function signoff(id: string, needs: readonly string[], prompt: string): Json {
  return Object.freeze({
    id,
    needs: Object.freeze([...needs]),
    branch: Object.freeze({
      when: '$input.gates == "plan"',
      then: Object.freeze([
        Object.freeze({
          id: "approve",
          uses: "human.approval",
          with: Object.freeze({ prompt }),
        }),
      ]),
      else: Object.freeze([]),
    }),
  });
}

const PLAN_BUDGET = { maxTurns: 40, timeout: "30m", maxCostUsd: 4 } as const;
const RESEARCH_BUDGET = {
  maxTurns: 60,
  timeout: "45m",
  maxCostUsd: 5,
} as const;
const REVIEW_BUDGET = { maxTurns: 40, timeout: "30m", maxCostUsd: 4 } as const;

function prefix(id: DeliverTemplateId): { steps: Json[]; plan: string } {
  const questions = writer(
    "questions",
    ["brief"],
    "Draft neutral research questions about the change; do not describe the change itself.",
    [["brief", BRIEF_REF]],
    "questions",
    { maxTurns: 30, timeout: "20m", maxCostUsd: 2 },
  );
  const research = (needs: string, from: string) =>
    writer(
      "research",
      [needs],
      "Answer the research questions about the current code, with file and line citations.",
      [["questions", from]],
      "research",
      RESEARCH_BUDGET,
    );
  switch (id) {
    case "deliver-oneshot":
      return {
        plan: "plan",
        steps: [
          writer(
            "plan",
            ["brief"],
            "Turn the brief's acceptance criteria into an implementation plan with exactly one phase. If the change needs more than one phase, say so plainly at the top and stop.",
            [["brief", BRIEF_REF]],
            "plan",
            PLAN_BUDGET,
          ),
          signoff(
            "plan_signoff",
            ["plan"],
            "Approve the plan before the build starts.",
          ),
        ],
      };
    case "deliver-lean":
      return {
        plan: "outline",
        steps: [
          questions,
          research("questions", artifactOf("questions")),
          writer(
            "outline",
            ["research"],
            "Write a phased structure outline for the change from the brief and the research.",
            [["brief", BRIEF_REF], ["research", artifactOf("research")]],
            "outline",
            PLAN_BUDGET,
          ),
          writer(
            "outline_review",
            ["outline"],
            "Review the outline against the brief. List every blocking finding.",
            [["brief", BRIEF_REF], ["outline", artifactOf("outline")]],
            "review",
            REVIEW_BUDGET,
            "reviewer",
          ),
          signoff(
            "plan_signoff",
            ["outline_review"],
            "Approve the outline before the build starts.",
          ),
        ],
      };
    case "deliver-full":
      return {
        plan: "plan",
        steps: [
          questions,
          research("questions", artifactOf("questions")),
          writer(
            "design",
            ["research"],
            "Write the design discussion: current behavior, desired behavior, options and a recommendation.",
            [["brief", BRIEF_REF], ["research", artifactOf("research")]],
            "design",
            PLAN_BUDGET,
          ),
          signoff(
            "design_signoff",
            ["design"],
            "Approve the design before it is planned.",
          ),
          writer(
            "outline",
            ["design_signoff"],
            "Write the phased structure outline from the approved design.",
            [["brief", BRIEF_REF], ["design", artifactOf("design")]],
            "outline",
            PLAN_BUDGET,
          ),
          writer(
            "plan",
            ["outline"],
            "Write the phased implementation plan with the files and checks of each phase.",
            [["brief", BRIEF_REF], ["outline", artifactOf("outline")], [
              "design",
              artifactOf("design"),
            ]],
            "plan",
            RESEARCH_BUDGET,
          ),
          writer(
            "plan_review",
            ["plan"],
            "Review the plan against the brief. List every blocking finding.",
            [["brief", BRIEF_REF], ["plan", artifactOf("plan")]],
            "review",
            REVIEW_BUDGET,
            "reviewer",
          ),
          signoff(
            "plan_signoff",
            ["plan_review"],
            "Approve the plan before the build starts.",
          ),
        ],
      };
    case "deliver-prd":
      return {
        plan: "plan",
        steps: [
          writer(
            "research",
            ["brief"],
            "Research the current code the requirements will touch, with file and line citations.",
            [["brief", BRIEF_REF]],
            "research",
            RESEARCH_BUDGET,
          ),
          writer(
            "prd",
            ["research"],
            "Write the requirements: the problem, success measures, behavior statements and what is out of scope.",
            [["brief", BRIEF_REF], ["research", artifactOf("research")]],
            "prd",
            PLAN_BUDGET,
          ),
          signoff(
            "prd_signoff",
            ["prd"],
            "Approve the requirements before the technical design.",
          ),
          writer(
            "tdd",
            ["prd_signoff"],
            "Write the technical design from the approved requirements.",
            [["prd", artifactOf("prd")], ["research", artifactOf("research")]],
            "tdd",
            PLAN_BUDGET,
          ),
          signoff(
            "tdd_signoff",
            ["tdd"],
            "Approve the technical design before it is planned.",
          ),
          writer(
            "plan",
            ["tdd_signoff"],
            "Write the phased implementation plan from the technical design.",
            [["prd", artifactOf("prd")], ["tdd", artifactOf("tdd")]],
            "plan",
            RESEARCH_BUDGET,
          ),
          writer(
            "plan_review",
            ["plan"],
            "Review the plan against the requirements. List every blocking finding.",
            [["prd", artifactOf("prd")], ["plan", artifactOf("plan")]],
            "review",
            REVIEW_BUDGET,
            "reviewer",
          ),
          signoff(
            "plan_signoff",
            ["plan_review"],
            "Approve the plan before the build starts.",
          ),
        ],
      };
  }
}

function tail(planStep: string, afterSignoff: string): Json[] {
  return [
    Object.freeze({
      id: "build",
      needs: Object.freeze([afterSignoff]),
      steps: Object.freeze([
        Object.freeze({
          id: "implement",
          uses: "harness.implement",
          with: Object.freeze({
            repositoryId: "$input.repositoryId",
            planArtifact: BRIEF_REF,
          }),
        }),
        Object.freeze({
          id: "check",
          needs: Object.freeze(["implement"]),
          uses: "quality.check",
          with: Object.freeze({
            repositoryId: "$input.repositoryId",
            revision: "$step.build.implement.headSha",
            checks: "$delivery.checkIds",
          }),
        }),
        Object.freeze({
          id: "review",
          needs: Object.freeze(["check"]),
          uses: "review.independent",
          with: Object.freeze({
            repositoryId: "$input.repositoryId",
            revision: "$step.build.implement.headSha",
            evidence: "$step.build.check.checkRunIds",
          }),
        }),
      ]),
    }),
    Object.freeze({
      id: "repair",
      needs: Object.freeze(["build"]),
      repeat: Object.freeze({
        max: 3,
        seed: Object.freeze({
          currentCandidate: Object.freeze({
            headSha: "$step.build.implement.headSha",
            baseSha: "$step.build.check.baseSha",
            policyDigest: "$step.build.check.policyDigest",
            checksPassed: "$step.build.check.allRequired",
            blockingFindings: "$step.build.review.blockingFindings",
            reviewId: "$step.build.review.reviewId",
            findings: "$step.build.review.findings",
            checkRunIds: "$step.build.check.checkRunIds",
            failedCheckIds: "$step.build.check.failedCheckIds",
          }),
        }),
        until:
          "$repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
        steps: Object.freeze([
          Object.freeze({
            id: "repair_implement",
            uses: "harness.repair",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              revision: "$repeat.currentCandidate.headSha",
              findings: "$delivery.blockingFindings",
              failedChecks: "$delivery.failedChecks",
            }),
          }),
          Object.freeze({
            id: "repair_check",
            needs: Object.freeze(["repair_implement"]),
            uses: "quality.check",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              revision: "$step.repair.repair_implement.headSha",
              checks: "$delivery.checkIds",
            }),
          }),
          Object.freeze({
            id: "repair_review",
            needs: Object.freeze(["repair_check"]),
            uses: "review.independent",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              revision: "$step.repair.repair_implement.headSha",
              evidence: "$step.repair.repair_check.checkRunIds",
            }),
          }),
        ]),
        outputs: Object.freeze({
          currentCandidate: Object.freeze({
            headSha: "$step.repair.repair_implement.headSha",
            baseSha: "$step.repair.repair_check.baseSha",
            policyDigest: "$step.repair.repair_check.policyDigest",
            checksPassed: "$step.repair.repair_check.allRequired",
            blockingFindings: "$step.repair.repair_review.blockingFindings",
            reviewId: "$step.repair.repair_review.reviewId",
            findings: "$step.repair.repair_review.findings",
            checkRunIds: "$step.repair.repair_check.checkRunIds",
            failedCheckIds: "$step.repair.repair_check.failedCheckIds",
          }),
        }),
      }),
    }),
    writer(
      "verification",
      ["repair"],
      "Re-run every check and acceptance item from the brief against the candidate and record the observed output next to each expected result.",
      [["brief", BRIEF_REF], ["plan", artifactOf(planStep)]],
      "verification",
      { maxTurns: 50, timeout: "60m", maxCostUsd: 6 },
      "reviewer",
    ),
    Object.freeze({
      id: "done",
      needs: Object.freeze(["verification"]),
      uses: "workflow.stop",
      with: Object.freeze({ outcome: "done" }),
    }),
  ];
}

export const DELIVER_TEMPLATE_DESCRIPTIONS: Readonly<
  Record<DeliverTemplateId, string>
> = Object.freeze({
  "deliver-oneshot":
    "Plan the change as one phase, then build, check and review it, fixing it a limited number of times, and verify the result.",
  "deliver-lean":
    "Research and outline the change, then build, check and review it, fixing it a limited number of times, and verify the result.",
  "deliver-full":
    "Research, design and plan the change, then build, check and review it, fixing it a limited number of times, and verify the result.",
  "deliver-prd":
    "Write requirements, a technical design and a plan, then build, check and review the change, fixing it a limited number of times, and verify the result.",
});

const STEP_WORDS: Readonly<Record<string, readonly [string, string]>> = Object
  .freeze({
    questions: [
      "List the research questions",
      "Writes the questions the research must answer about the code, without suggesting a change.",
    ],
    research: [
      "Research the code",
      "Answers the research questions from the code and writes what it found, with file references.",
    ],
    design: [
      "Compare the design options",
      "Sets out the ways to make the change, recommends one, and lists the questions still open.",
    ],
    outline: [
      "Outline the change",
      "Lists the files and parts the change touches, in the order to build them.",
    ],
    outline_review: [
      "Review the outline",
      "Reads the outline against the task and lists what is missing, wrong or risky.",
    ],
    plan: [
      "Write the plan",
      "Splits the change into phases, each with the checks that prove it is done.",
    ],
    plan_review: [
      "Review the plan",
      "Reads the plan against the task and lists what is missing, wrong or risky.",
    ],
    prd: [
      "Write the requirements",
      "Writes the problem, how success is measured, what the change must do and what is out of scope.",
    ],
    tdd: [
      "Write the technical design",
      "Writes how the change will be built, from the approved requirements.",
    ],
    verification: [
      "Verify the build",
      "Runs the checks the plan promises against the built change and records what passed and failed.",
    ],
  });

const VARIANT_WORDS: Readonly<
  Record<string, Readonly<Record<string, readonly [string, string]>>>
> = Object.freeze({
  "deliver-prd": {
    research: [
      "Research the code",
      "Reads the code the requirements will touch and writes what it found, with file references.",
    ],
  },
  "deliver-oneshot": {
    plan: [
      "Write the plan",
      "Turns the task's acceptance criteria into a plan with one phase.",
    ],
  },
});

const SIGNOFF_SUBJECT: Readonly<Record<string, string>> = Object.freeze({
  plan_signoff: "the plan",
  design_signoff: "the design",
  prd_signoff: "the requirements",
  tdd_signoff: "the technical design",
});

function present(
  template: DeliverTemplateId,
  steps: readonly Json[],
  signoff?: string,
): Json[] {
  return steps.map((step) => {
    const id = step.id as string;
    if (step.uses === "agent.freeform") {
      const words = VARIANT_WORDS[template]?.[id] ?? STEP_WORDS[id];
      return words === undefined
        ? step
        : Object.freeze({ ...step, name: words[0], description: words[1] });
    }
    if (step.branch !== undefined) {
      const branch = step.branch as Json;
      const subject = id === "plan_signoff" && template === "deliver-lean"
        ? "the outline"
        : SIGNOFF_SUBJECT[id];
      return Object.freeze({
        ...step,
        branch: Object.freeze({
          ...branch,
          then: Object.freeze(
            present(template, branch.then as Json[], subject),
          ),
        }),
      });
    }
    if (step.uses === "human.approval" && signoff !== undefined) {
      return Object.freeze({
        ...step,
        name: `Approve ${signoff}`,
        description:
          `Waits for a person to approve ${signoff} on the task page. Skipped if the run was started without waiting for approval.`,
      });
    }
    return step;
  });
}

export function deliverTemplateDefinition(
  id: DeliverTemplateId,
): WorkflowPresetDocument {
  const { steps, plan } = prefix(id);
  const last = steps[steps.length - 1].id as string;
  return Object.freeze({
    apiVersion: "bakery.dev/v1" as const,
    kind: "workflow" as const,
    name: id,
    description: DELIVER_TEMPLATE_DESCRIPTIONS[id],
    inputs: Object.freeze({
      repositoryId: Object.freeze({ type: "uuid", required: true }),
      brief: Object.freeze({ type: "TaskBrief", required: true }),
      gates: Object.freeze({
        type: "string",
        enum: Object.freeze(["plan", "none"]),
        required: true,
      }),
    }),
    steps: Object.freeze([
      Object.freeze({
        id: "brief",
        uses: "task.brief",
        with: Object.freeze({
          brief: "$input.brief",
          repositoryId: "$input.repositoryId",
        }),
      }),
      ...present(id, steps),
      ...present(id, tail(plan, last)),
    ]),
  }) as unknown as WorkflowPresetDocument;
}
