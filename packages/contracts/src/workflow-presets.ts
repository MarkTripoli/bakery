/**
 * Code-owned workflow presets. A preset is a fixed workflow specification the
 * server materializes, per organization, as a published and digest-verified
 * workflow version when a run starts with `presetId`.
 */

import {
  DELIVER_TEMPLATE_IDS,
  deliverTemplateDefinition,
  type DeliverTemplateId,
} from "./deliver-templates.ts";

export const WORKFLOW_PRESET_IDS = Object.freeze(
  [
    "fixed-coding",
    "fixed-coding-reviewed",
    "deliver-oneshot",
    "deliver-lean",
    "deliver-full",
    "deliver-prd",
  ] as const,
);

export type WorkflowPresetId = typeof WORKFLOW_PRESET_IDS[number];

/**
 * The presets a ticket source may run. The Deliver templates pause for a
 * sign-off a ticket start has no control for, so ticket admission stays on the
 * two fixed-coding presets (#429).
 */
export const TICKET_PRESET_IDS = Object.freeze(
  ["fixed-coding", "fixed-coding-reviewed"] as const,
);

/** A preset written as the flat fixed workflow the retired executor ran. */
export type FixedWorkflowPresetSpec = Readonly<{
  kind: "fixed";
  workflow: Readonly<{ kind: "fixed" }>;
  steps: readonly Readonly<{
    id: string;
    uses: string;
    with: Readonly<Record<string, string>>;
  }>[];
}>;

/**
 * A preset written as the ordinary workflow document a customer publishes (the
 * compiler grammar). A preset in this form is a plan: its stages sit in a
 * container, so the engine decides its steps and the flat executor refuses it.
 */
export type WorkflowPresetDocument = Readonly<{
  apiVersion: "bakery.dev/v1";
  kind: "workflow";
  name: string;
  description: string;
  inputs: Readonly<
    Record<
      string,
      Readonly<{ type: string; required: boolean; enum?: readonly string[] }>
    >
  >;
  steps: readonly Readonly<Record<string, unknown>>[];
}>;

/** The flat form, under the name every reader knows it by today. */
export type WorkflowPresetSpec = FixedWorkflowPresetSpec;

/**
 * Either grammar a preset can be published in; both compile to the same
 * actions. Readers narrow this explicitly, so the flip to a document is one
 * change per reader rather than a silent widening.
 */
export type WorkflowPresetSource =
  | WorkflowPresetSpec
  | WorkflowPresetDocument;

/**
 * Step input references the workflow runtime resolves from run state rather
 * than from the run inputs or one named step. Each is a pure function of the
 * run snapshot and the recorded step outputs, so admission and the claim-time
 * re-derivation of a job input always agree.
 */
export const DELIVERY_REFERENCES = Object.freeze(
  {
    /** Head commit of the run's current candidate revision. */
    headSha: "$delivery.headSha",
    /** Ids of every fixed policy command of the pinned repository profile. */
    checkIds: "$delivery.checkIds",
    /** Required checks that did not pass on the candidate, as repair evidence. */
    failedChecks: "$delivery.failedChecks",
    /** Blocking findings of the latest independent review, blocker first. */
    blockingFindings: "$delivery.blockingFindings",
  } as const,
);

/**
 * The references that read earlier step outputs. Strict preset admission
 * resolves each step before any output exists, so it measures a step that
 * carries one of these from its literal input; `checkIds` is absent because
 * the pinned profile alone resolves it.
 */
export const DELIVERY_STEP_OUTPUT_REFERENCES: readonly string[] = Object.freeze(
  [
    DELIVERY_REFERENCES.headSha,
    DELIVERY_REFERENCES.failedChecks,
    DELIVERY_REFERENCES.blockingFindings,
  ],
);

/** Stage ids of the fixed build workflow, in order. */
export const WORKFLOW_STAGE_IDS = Object.freeze(
  ["discuss", "plan", "implement", "review"] as const,
);
export type WorkflowStageId = typeof WORKFLOW_STAGE_IDS[number];

/** What a stage waits for before the next one may start. */
export type WorkflowStageWaits = "automatic" | "human_approval";

export type WorkflowStageDefinition = Readonly<{
  id: WorkflowStageId;
  /** Default wait; a task's approval policy may select `human_approval` for stages marked selectable. */
  waits: WorkflowStageWaits;
  /** Whether a task's approval policy may choose how this stage waits. */
  policySelectable: boolean;
}>;

export type WorkflowPresetDefinition = Readonly<{
  id: WorkflowPresetId;
  revision: number;
  /** Organization workflow-definition slug the preset is materialized under. */
  slug: string;
  nameKey: string;
  /** Run budget applied when the caller supplies none, in US dollars. */
  defaultBudgetLimitUsd: string;
  /** Lowercase SHA-256 of the canonical JSON of `spec`; verified by tests and at admission. */
  digest: string;
  /** Authored YAML source stored beside the normalized specification. */
  sourceYaml: string;
  spec: WorkflowPresetSource;
  /**
   * Stage policy surface. Stages are not part of `spec`, so the preset digest
   * and every already-materialized workflow version stay valid. Only the plan
   * stage can wait for a human today; the others run automatically.
   */
  stages: readonly WorkflowStageDefinition[];
}>;

/** Longest instruction text, in UTF-16 code units, the implement step accepts. */
export const IMPLEMENT_INSTRUCTIONS_MAX_LENGTH = 4000;

const INSTRUCTIONS_TRUNCATION_MARKER = "\n[truncated]";

/** Approved plan revision frozen into a run's brief. */
export type ApprovedPlanForInstructions = Readonly<{
  planRevisionId: string;
  revision: number;
  digest: string;
  title: string;
  steps: readonly Readonly<
    { id: string; title: string; detail: string; detailShortened?: boolean }
  >[];
}>;

/**
 * Deterministic implement-step instructions: the task title and description,
 * then the approved plan when one exists. Output never exceeds
 * `IMPLEMENT_INSTRUCTIONS_MAX_LENGTH` UTF-16 code units; a longer text is cut
 * on a code point boundary (never inside a surrogate pair) and ends with a
 * fixed marker.
 */
export function renderImplementInstructions(input: {
  title: string;
  description: string;
  approvedPlan?: ApprovedPlanForInstructions | null;
}): string {
  const lines = [`Task: ${input.title}`];
  if (input.description.length > 0) lines.push("", input.description);
  const plan = input.approvedPlan;
  if (plan) {
    lines.push(
      "",
      `Approved plan (revision ${plan.revision}): ${plan.title}`,
    );
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title}`);
      if (step.detail.length > 0) lines.push(`   ${step.detail}`);
    });
  }
  const text = lines.join("\n");
  if (text.length <= IMPLEMENT_INSTRUCTIONS_MAX_LENGTH) return text;
  let end = IMPLEMENT_INSTRUCTIONS_MAX_LENGTH -
    INSTRUCTIONS_TRUNCATION_MARKER.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + INSTRUCTIONS_TRUNCATION_MARKER;
}

/**
 * `fixed-coding` in the published grammar: the two stages inside one sequence.
 * The container is what makes a run of it a plan the engine decides, instead of
 * a flat list the preset executor runs; the actions and their order are the
 * flat preset's, only the step keys gain the sequence's prefix.
 */
export const FIXED_CODING_DEFINITION: WorkflowPresetDocument = Object.freeze({
  apiVersion: "bakery.dev/v1" as const,
  kind: "workflow" as const,
  name: "fixed-coding",
  description:
    "Freeze the task brief, then implement it as one bounded candidate.",
  inputs: Object.freeze({
    repositoryId: Object.freeze({ type: "uuid", required: true }),
    brief: Object.freeze({ type: "TaskBrief", required: true }),
    instructions: Object.freeze({ type: "string", required: true }),
  }),
  steps: Object.freeze([
    Object.freeze({
      id: "flow",
      steps: Object.freeze([
        Object.freeze({
          id: "brief",
          uses: "task.brief",
          with: Object.freeze({
            brief: "$input.brief",
            repositoryId: "$input.repositoryId",
          }),
        }),
        Object.freeze({
          id: "implement",
          needs: Object.freeze(["brief"]),
          uses: "harness.implement",
          with: Object.freeze({
            repositoryId: "$input.repositoryId",
            planArtifact: "$step.flow.brief.artifact.versionId",
            instructions: "$input.instructions",
          }),
        }),
      ]),
    }),
  ]),
});

/** The one fixed coding workflow: freeze the task brief, then implement it. */
export const FIXED_CODING_PRESET: WorkflowPresetDefinition = Object.freeze({
  id: "fixed-coding",
  revision: 3,
  slug: "preset:fixed-coding",
  nameKey: "workflowPresets.fixedCoding.name",
  defaultBudgetLimitUsd: "5.00",
  digest: "4a63e08a69d0d7f2aefaea23a85646302f886d65c21f0fb8601d8275c9e6e1be",
  sourceYaml: [
    "apiVersion: bakery.dev/v1",
    "kind: workflow",
    "name: fixed-coding",
    "description: Freeze the task brief, then implement it as one bounded candidate.",
    "inputs:",
    "  repositoryId: { type: uuid, required: true }",
    "  brief: { type: TaskBrief, required: true }",
    "  instructions: { type: string, required: true }",
    "steps:",
    "  - id: flow",
    "    steps:",
    "      - id: brief",
    "        uses: task.brief",
    "        with: { brief: $input.brief, repositoryId: $input.repositoryId }",
    "      - id: implement",
    "        needs: [brief]",
    "        uses: harness.implement",
    "        with: { repositoryId: $input.repositoryId, planArtifact: $step.flow.brief.artifact.versionId, instructions: $input.instructions }",
    "",
  ].join("\n"),
  spec: FIXED_CODING_DEFINITION,
  stages: Object.freeze(
    [
      Object.freeze({
        id: "discuss",
        waits: "automatic",
        policySelectable: false,
      }),
      Object.freeze({ id: "plan", waits: "automatic", policySelectable: true }),
      Object.freeze({
        id: "implement",
        waits: "automatic",
        policySelectable: false,
      }),
      Object.freeze({
        id: "review",
        waits: "automatic",
        // A task may require a person to approve a clean candidate before it
        // may merge (#37); the approval binds that exact candidate.
        policySelectable: true,
      }),
    ] as const,
  ),
});

const FIXED_CODING_STAGES = FIXED_CODING_PRESET.stages;

/**
 * The fixed coding spec extended with independent review and bounded repair.
 * Spec order is the order the rule guard reads, so `repair` sits before `check`:
 * the check then follows the last revision-producing step. `repair` is an
 * on-demand step that has no row at admission; the review result hook appends
 * a repair, check and review iteration when it decides to repair. Every
 * candidate revision, the checks, the findings and the failed checks are
 * `$delivery.*` references resolved from the frozen snapshot and the recorded
 * step outputs.
 */

/**
 * `fixed-coding-reviewed` in the published grammar: the same two stages, then a
 * check and an independent review, then the bounded repair loop of chapter 6 as
 * a repeat whose body repairs, checks and reviews again until the candidate is
 * clean. It reads the checks the pinned profile binds through `$delivery`, so a
 * run of it is a plan the engine decides, like `fixed-coding`.
 */
export const FIXED_CODING_REVIEWED_DEFINITION: WorkflowPresetDocument = Object
  .freeze({
    apiVersion: "bakery.dev/v1" as const,
    kind: "workflow" as const,
    name: "fixed-coding-reviewed",
    description:
      "Freeze the brief, implement it, then check, review and repair it a bounded number of times.",
    inputs: Object.freeze({
      repositoryId: Object.freeze({ type: "uuid", required: true }),
      brief: Object.freeze({ type: "TaskBrief", required: true }),
      instructions: Object.freeze({ type: "string", required: true }),
    }),
    steps: Object.freeze([
      Object.freeze({
        id: "flow",
        steps: Object.freeze([
          Object.freeze({
            id: "brief",
            uses: "task.brief",
            with: Object.freeze({
              brief: "$input.brief",
              repositoryId: "$input.repositoryId",
            }),
          }),
          Object.freeze({
            id: "implement",
            needs: Object.freeze(["brief"]),
            uses: "harness.implement",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              planArtifact: "$step.flow.brief.artifact.versionId",
              instructions: "$input.instructions",
            }),
          }),
          Object.freeze({
            id: "check",
            needs: Object.freeze(["implement"]),
            uses: "quality.check",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              revision: "$step.flow.implement.headSha",
              checks: "$delivery.checkIds",
            }),
          }),
          Object.freeze({
            id: "review",
            needs: Object.freeze(["check"]),
            uses: "review.independent",
            with: Object.freeze({
              repositoryId: "$input.repositoryId",
              revision: "$step.flow.implement.headSha",
              evidence: "$step.flow.check.checkRunIds",
            }),
          }),
        ]),
      }),
      Object.freeze({
        id: "repair",
        needs: Object.freeze(["flow"]),
        repeat: Object.freeze({
          max: 2,
          seed: Object.freeze({
            currentCandidate: Object.freeze({
              headSha: "$step.flow.implement.headSha",
              baseSha: "$step.flow.check.baseSha",
              policyDigest: "$step.flow.check.policyDigest",
              checksPassed: "$step.flow.check.allRequired",
              blockingFindings: "$step.flow.review.blockingFindings",
              reviewId: "$step.flow.review.reviewId",
              findings: "$step.flow.review.findings",
              checkRunIds: "$step.flow.check.checkRunIds",
              failedCheckIds: "$step.flow.check.failedCheckIds",
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
                // `$delivery` carries the repair input's own schemas, so the
                // read and the field it fills agree by construction.
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
    ]),
  });

/**
 * The fixed coding workflow with an independent review and a bounded repair
 * loop: brief, implement, then check and review the candidate, repairing it at
 * most a bounded number of times while required checks fail or the reviewer
 * reports blocking findings. `fixed-coding` is untouched beside it.
 */
export const FIXED_CODING_REVIEWED_PRESET: WorkflowPresetDefinition = Object
  .freeze({
    id: "fixed-coding-reviewed",
    revision: 2,
    slug: "preset:fixed-coding-reviewed",
    nameKey: "workflowPresets.fixedCodingReviewed.name",
    defaultBudgetLimitUsd: "12.00",
    digest: "4d58f2ae7bf98aa4fa7a51b2e087266e0e4c6985baa785eb2bdb985e4908b4b2",
    sourceYaml: [
      "apiVersion: bakery.dev/v1",
      "kind: workflow",
      "name: fixed-coding-reviewed",
      "description: Freeze the brief, implement it, then check, review and repair it a bounded number of times.",
      "inputs:",
      "  repositoryId: { type: uuid, required: true }",
      "  brief: { type: TaskBrief, required: true }",
      "  instructions: { type: string, required: true }",
      "steps:",
      "  - id: flow",
      "    steps:",
      "      - id: brief",
      "        uses: task.brief",
      "        with: { brief: $input.brief, repositoryId: $input.repositoryId }",
      "      - id: implement",
      "        needs: [brief]",
      "        uses: harness.implement",
      "        with: { repositoryId: $input.repositoryId, planArtifact: $step.flow.brief.artifact.versionId, instructions: $input.instructions }",
      "      - id: check",
      "        needs: [implement]",
      "        uses: quality.check",
      "        with: { repositoryId: $input.repositoryId, revision: $step.flow.implement.headSha, checks: $delivery.checkIds }",
      "      - id: review",
      "        needs: [check]",
      "        uses: review.independent",
      "        with: { repositoryId: $input.repositoryId, revision: $step.flow.implement.headSha, evidence: $step.flow.check.checkRunIds }",
      "  - id: repair",
      "    needs: [flow]",
      "    repeat:",
      "      max: 2",
      "      seed:",
      "        currentCandidate:",
      "          headSha: $step.flow.implement.headSha",
      "          baseSha: $step.flow.check.baseSha",
      "          policyDigest: $step.flow.check.policyDigest",
      "          checksPassed: $step.flow.check.allRequired",
      "          blockingFindings: $step.flow.review.blockingFindings",
      "          reviewId: $step.flow.review.reviewId",
      "          findings: $step.flow.review.findings",
      "          checkRunIds: $step.flow.check.checkRunIds",
      "          failedCheckIds: $step.flow.check.failedCheckIds",
      "      until: $repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
      "      steps:",
      "        - id: repair_implement",
      "          uses: harness.repair",
      "          with: { repositoryId: $input.repositoryId, revision: $repeat.currentCandidate.headSha, findings: $delivery.blockingFindings, failedChecks: $delivery.failedChecks }",
      "        - id: repair_check",
      "          needs: [repair_implement]",
      "          uses: quality.check",
      "          with: { repositoryId: $input.repositoryId, revision: $step.repair.repair_implement.headSha, checks: $delivery.checkIds }",
      "        - id: repair_review",
      "          needs: [repair_check]",
      "          uses: review.independent",
      "          with: { repositoryId: $input.repositoryId, revision: $step.repair.repair_implement.headSha, evidence: $step.repair.repair_check.checkRunIds }",
      "      outputs:",
      "        currentCandidate:",
      "          headSha: $step.repair.repair_implement.headSha",
      "          baseSha: $step.repair.repair_check.baseSha",
      "          policyDigest: $step.repair.repair_check.policyDigest",
      "          checksPassed: $step.repair.repair_check.allRequired",
      "          blockingFindings: $step.repair.repair_review.blockingFindings",
      "          reviewId: $step.repair.repair_review.reviewId",
      "          findings: $step.repair.repair_review.findings",
      "          checkRunIds: $step.repair.repair_check.checkRunIds",
      "          failedCheckIds: $step.repair.repair_check.failedCheckIds",
    ].join("\n"),
    spec: FIXED_CODING_REVIEWED_DEFINITION,
    stages: FIXED_CODING_STAGES,
  });

/**
 * Lowercase SHA-256 of the canonical JSON of each Deliver template's definition
 * (`deliverTemplateDefinition`); a test recomputes them, so changing a template
 * means changing its revision and digest together.
 */
const DELIVER_PRESET_DIGESTS: Readonly<Record<DeliverTemplateId, string>> =
  Object.freeze({
    "deliver-oneshot":
      "2c5eb61044fbc8f6663c5e1bc8b06c905dbc9d967f082f83fb0f8e523ecc0c5f",
    "deliver-lean":
      "b1ea62043e7b930af4f0464814b92397dff26548512bd39e59fb26299d9bb655",
    "deliver-full":
      "3c4d5f3122bace42a302ce39088c1cfcfa0cf336677b9f0f59e8abcb7dd5bab6",
    "deliver-prd":
      "bd2a8222aac2b6a4fac0e526295f3cc9d4883e0b852e982bdb262999725e0cc0",
  });

const DELIVER_NAME_KEYS: Readonly<Record<DeliverTemplateId, string>> = Object
  .freeze({
    "deliver-oneshot": "workflowPresets.deliverOneshot.name",
    "deliver-lean": "workflowPresets.deliverLean.name",
    "deliver-full": "workflowPresets.deliverFull.name",
    "deliver-prd": "workflowPresets.deliverPrd.name",
  });

/**
 * A Deliver template as a built-in workflow (#429). The source is the
 * definition as JSON, which is YAML: what a person copies is exactly the
 * document the digest covers. The plan approval is the template's own sign-off
 * step, so no stage waits here and the task approval policy does not apply.
 */
function deliverPreset(id: DeliverTemplateId): WorkflowPresetDefinition {
  const spec = deliverTemplateDefinition(id);
  return Object.freeze({
    id,
    revision: 1,
    slug: `preset:${id}`,
    nameKey: DELIVER_NAME_KEYS[id],
    defaultBudgetLimitUsd: "60.00",
    digest: DELIVER_PRESET_DIGESTS[id],
    sourceYaml: JSON.stringify(spec, null, 2),
    spec,
    stages: Object.freeze([]),
  });
}

/** Every preset in display order: `fixed-coding` stays first. */
export const WORKFLOW_PRESETS: readonly WorkflowPresetDefinition[] = Object
  .freeze([
    FIXED_CODING_PRESET,
    FIXED_CODING_REVIEWED_PRESET,
    ...DELIVER_TEMPLATE_IDS.map(deliverPreset),
  ]);

export function workflowPresetById(
  id: string,
): WorkflowPresetDefinition | undefined {
  return WORKFLOW_PRESETS.find((preset) => preset.id === id);
}
