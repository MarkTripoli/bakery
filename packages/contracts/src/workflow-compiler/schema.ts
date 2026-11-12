import { z } from "zod";
import { WorkflowCompilerDiagnosticSchema } from "./diagnostics.ts";
import type { WorkflowJsonValue } from "./json-value.ts";

const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const FIELD_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function described<T extends z.ZodType>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

const identifierSchema = z.string().regex(IDENTIFIER).describe(
  "Node or lane identifier matching [a-z][a-z0-9_]{1,63}, unique within its container.",
);
const nameSchema = z.string().regex(FIELD_SEGMENT).describe(
  "Declared input, output or field name matching [A-Za-z][A-Za-z0-9_]{0,63}.",
);
const needsSchema = z.array(identifierSchema).max(64).describe(
  "Sorted, duplicate-free sibling identifiers that must complete before this node starts.",
);
const durationMsSchema = z.number().int().min(0).max(86_400_000).describe(
  "Duration normalized to integer milliseconds, at most 24 hours.",
);

/** Any JSON value; used for tagged literals and `json`-typed content. */
export const WorkflowJsonValueSchema: z.ZodType<WorkflowJsonValue> = z.lazy(
  () =>
    described(
      z.union([
        described(z.null(), "JSON null."),
        described(z.boolean(), "JSON boolean."),
        described(z.number(), "JSON finite number."),
        described(z.string(), "JSON string."),
        described(z.array(WorkflowJsonValueSchema), "JSON array of values."),
        described(
          z.record(
            described(z.string(), "Object member name."),
            WorkflowJsonValueSchema,
          ),
          "JSON object keyed by member name.",
        ),
      ]),
      "JSON value of any kind.",
    ),
).describe(
  "Inert JSON value copied by the workflow compiler snapshot: null, boolean, finite number, string, array or object.",
);

export const WORKFLOW_REFERENCE_ROOTS = Object.freeze(
  ["input", "task", "step", "repeat", "delivery"] as const,
);

const referenceRootSchema = z.enum(WORKFLOW_REFERENCE_ROOTS).describe(
  "Namespace a reference reads: workflow input, task, completed step, enclosing repeat or the run's delivery state.",
);

const referencePathSchema = z.array(
  described(
    z.string().regex(FIELD_SEGMENT),
    "One field segment of a reference path.",
  ),
).min(1)
  .max(32).describe(
    "Ordered field segments after the root; step references begin with a qualified node identifier path.",
  );

export type WorkflowReferenceNode = {
  kind: "ref";
  root: (typeof WORKFLOW_REFERENCE_ROOTS)[number];
  path: string[];
};

const referenceNodeSchema: z.ZodType<WorkflowReferenceNode> = z.object({
  kind: z.literal("ref").describe("Tag marking a typed reference."),
  root: referenceRootSchema,
  path: referencePathSchema,
}).strict().describe(
  "Typed reference to a workflow input, task field, completed step output or repeat candidate.",
);

export const WorkflowReferenceNodeSchema = referenceNodeSchema;

export type WorkflowValueNode =
  | { kind: "literal"; value: WorkflowJsonValue }
  | WorkflowReferenceNode
  | { kind: "object"; fields: Record<string, WorkflowValueNode> }
  | { kind: "list"; items: WorkflowValueNode[] };

/** Tagged value position: literal, reference, object of values or list of values. */
export const WorkflowValueNodeSchema: z.ZodType<WorkflowValueNode> = z.lazy(
  () =>
    described(
      z.union([
        z.object({
          kind: z.literal("literal").describe("Tag marking an inert literal."),
          value: WorkflowJsonValueSchema,
        }).strict().describe(
          "Inert literal JSON value; its content is never parsed for references.",
        ),
        referenceNodeSchema,
        z.object({
          kind: z.literal("object").describe(
            "Tag marking an object that contains references.",
          ),
          fields: z.record(nameSchema, WorkflowValueNodeSchema).describe(
            "Field name to value node, keyed by declared field names.",
          ),
        }).strict().describe(
          "Object value that holds at least one reference among its fields.",
        ),
        z.object({
          kind: z.literal("list").describe(
            "Tag marking a list that contains references.",
          ),
          items: z.array(WorkflowValueNodeSchema).max(1000).describe(
            "Ordered item value nodes.",
          ),
        }).strict().describe(
          "List value that holds at least one reference among its items.",
        ),
      ]),
      "Literal, reference, object or list value node.",
    ),
).describe(
  "Tagged value position compiled from authored data: literal, reference, object or list.",
);

export const WORKFLOW_COMPARE_OPERATORS = Object.freeze(
  ["eq", "ne", "lt", "le", "gt", "ge", "in"] as const,
);

export type WorkflowExpressionNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "list"; items: WorkflowExpressionNode[] }
  | WorkflowReferenceNode
  | { kind: "not"; operand: WorkflowExpressionNode }
  | {
    kind: "logical";
    op: "and" | "or";
    left: WorkflowExpressionNode;
    right: WorkflowExpressionNode;
  }
  | {
    kind: "compare";
    op: (typeof WORKFLOW_COMPARE_OPERATORS)[number];
    left: WorkflowExpressionNode;
    right: WorkflowExpressionNode;
  };

/** Restricted expression grammar compiled to typed data nodes. */
export const WorkflowExpressionNodeSchema: z.ZodType<WorkflowExpressionNode> = z
  .lazy(() =>
    described(
      z.union([
        z.object({
          kind: z.literal("literal").describe("Tag marking a scalar literal."),
          value: described(
            z.union([
              described(z.string(), "String literal."),
              described(z.number(), "Finite number literal."),
              described(z.boolean(), "Boolean literal."),
              described(z.null(), "Null literal."),
            ]),
            "String, finite number, boolean or null literal.",
          ),
        }).strict().describe("Scalar literal operand of an expression."),
        z.object({
          kind: z.literal("list").describe("Tag marking a literal list."),
          items: z.array(WorkflowExpressionNodeSchema).max(32).describe(
            "Ordered literal items, at most 32.",
          ),
        }).strict().describe("Bounded list operand used with the in operator."),
        referenceNodeSchema,
        z.object({
          kind: z.literal("not").describe("Tag marking logical negation."),
          operand: WorkflowExpressionNodeSchema,
        }).strict().describe("Logical negation of a boolean operand."),
        z.object({
          kind: z.literal("logical").describe(
            "Tag marking a logical connective.",
          ),
          op: z.enum(["and", "or"]).describe("Logical connective."),
          left: WorkflowExpressionNodeSchema,
          right: WorkflowExpressionNodeSchema,
        }).strict().describe("Logical connective over two boolean operands."),
        z.object({
          kind: z.literal("compare").describe("Tag marking a comparison."),
          op: z.enum(WORKFLOW_COMPARE_OPERATORS).describe(
            "Comparison operator: equality, ordering or list membership.",
          ),
          left: WorkflowExpressionNodeSchema,
          right: WorkflowExpressionNodeSchema,
        }).strict().describe(
          "Non-coercing comparison of two operands of the same type family.",
        ),
      ]),
      "Scalar, list, reference, negation, logical or comparison node.",
    )
  ).describe(
    "Expression compiled from the restricted grammar into typed data nodes.",
  );

const effectKeyPartSchema = z.union([
  z.object({
    kind: z.literal("literal").describe("Tag marking a literal key part."),
    value: z.string().regex(/^[a-z0-9_-]{1,64}$/).describe(
      "Literal key segment matching [a-z0-9_-]{1,64}.",
    ),
  }).strict().describe("Constant segment of an effect key."),
  referenceNodeSchema,
]).describe(
  "One effect key part: a constant segment or a run-derived reference.",
);

export type WorkflowEffectKey = {
  kind: "effect_key";
  parts: (
    | { kind: "literal"; value: string }
    | WorkflowReferenceNode
  )[];
};

export const WorkflowEffectKeySchema = z.object({
  kind: z.literal("effect_key").describe("Tag marking an effect key."),
  parts: z.array(effectKeyPartSchema).min(1).max(8).describe(
    "Ordered key parts joined with a colon at runtime; at least one is a reference.",
  ),
}).strict().describe(
  "Effect key built from literal segments and run-derived references, never from string interpolation.",
);

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(1000).describe(
    "Total attempts including the first, bounded by the registry.",
  ),
  backoffMs: durationMsSchema.max(3_600_000).describe(
    "Delay between attempts in milliseconds, at most one hour.",
  ),
  on: z.array(
    described(
      z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      "Retryable fault code.",
    ),
  ).max(32).describe(
    "Sorted retryable fault codes, a subset of the registry faults.",
  ),
}).strict().describe(
  "Finite retry policy with bounded backoff and named faults.",
);

const actionLimitsSchema = z.object({
  maxDurationMs: durationMsSchema.optional(),
  maxCostUsd: z.number().min(0).max(10_000).optional().describe(
    "Action-local spend ceiling in US dollars.",
  ),
  maxFindings: z.number().int().min(0).max(1000).optional().describe(
    "Action-local ceiling on reported findings.",
  ),
}).strict().describe("Typed action-local ceilings.");

const baseNodeShape = {
  id: identifierSchema,
  needs: needsSchema,
  if: z.lazy(() => WorkflowExpressionNodeSchema).optional().describe(
    "Optional boolean condition; the node is skipped when it is false.",
  ),
};

export type WorkflowActionNode = {
  kind: "action";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  action: string;
  with: WorkflowValueNode;
  /** Agent version this step runs, for actions with the `model` capability. */
  agentVersionId?: string | undefined;
  requires: string[];
  checks?: string[] | undefined;
  effectKey?: z.infer<typeof WorkflowEffectKeySchema> | undefined;
  limits?: z.infer<typeof actionLimitsSchema> | undefined;
  timeoutMs: number;
  retry: z.infer<typeof retrySchema>;
};
export type WorkflowSequenceNode = {
  kind: "sequence";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  steps: WorkflowNode[];
};
export type WorkflowBranchNode = {
  kind: "branch";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  when: WorkflowExpressionNode;
  then: WorkflowNode[];
  else: WorkflowNode[];
  outputs: Record<
    string,
    { then?: WorkflowValueNode; else?: WorkflowValueNode }
  >;
};
export type WorkflowRepeatSeed =
  | { form: "mapping"; currentCandidate: WorkflowValueNode }
  | {
    form: "sequence";
    steps: WorkflowNode[];
    currentCandidate: WorkflowValueNode;
  };
export type WorkflowRepeatNode = {
  kind: "repeat";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  max: number;
  seed: WorkflowRepeatSeed;
  until: WorkflowExpressionNode;
  steps: WorkflowNode[];
  currentCandidate: WorkflowValueNode;
};
export type WorkflowWaitNode = {
  kind: "wait";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  wait:
    | { kind: "duration"; durationMs: number }
    | { kind: "event"; event: string; timeoutMs: number };
};
export type WorkflowLane = {
  id: string;
  needs: string[];
  repository: string;
  steps: WorkflowNode[];
};
export type WorkflowParallelNode = {
  kind: "parallel";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  maxConcurrency: number;
  join: "all-required";
  failurePolicy: "stop-dependent";
  lanes: WorkflowLane[];
  outputs: Record<string, Record<string, WorkflowValueNode>>;
};
export type WorkflowNode =
  | WorkflowActionNode
  | WorkflowSequenceNode
  | WorkflowBranchNode
  | WorkflowRepeatNode
  | WorkflowWaitNode
  | WorkflowParallelNode;

const stepsSchema = (): z.ZodType<WorkflowNode[]> =>
  z.array(described(z.lazy(() => WorkflowNodeSchema), "Child workflow node."))
    .max(200).describe(
      "Ordered child nodes; authored order is execution order and is never sorted.",
    );

const actionNodeSchema = z.object({
  kind: z.literal("action").describe("Tag marking an action step."),
  ...baseNodeShape,
  action: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/).describe(
    "Registered workflow action name resolved from the action registry.",
  ),
  with: z.lazy(() => WorkflowValueNodeSchema).describe(
    "Tagged action input value; checks and effect key stay separate node fields that the executor injects.",
  ),
  agentVersionId: z.string().regex(UUID).optional().describe(
    "Lower-case immutable agent version this step runs, an override of the workflow agents map; only actions with the model capability take one.",
  ),
  requires: z.array(described(z.string().max(64), "Capability name.")).max(32)
    .describe(
      "Sorted union of declared and registry capabilities.",
    ),
  checks: z.array(described(z.string().max(64), "Registered check name.")).max(
    32,
  ).optional().describe(
    "Sorted registered check names for check actions.",
  ),
  effectKey: WorkflowEffectKeySchema.optional(),
  limits: actionLimitsSchema.optional(),
  timeoutMs: durationMsSchema.min(1000).describe(
    "Finite action timeout in milliseconds; the default applies when none is authored.",
  ),
  retry: retrySchema,
}).strict().describe("Normalized action step bound to a registered action.");

const sequenceNodeSchema = z.object({
  kind: z.literal("sequence").describe("Tag marking a sequence."),
  ...baseNodeShape,
  steps: stepsSchema(),
}).strict().describe("Ordered group of child nodes.");

const branchOutputSchema = z.object({
  then: z.lazy(() => WorkflowValueNodeSchema).optional().describe(
    "Value exported when the then arm is selected.",
  ),
  else: z.lazy(() => WorkflowValueNodeSchema).optional().describe(
    "Value exported when the else arm is selected.",
  ),
}).strict().describe("Per-arm export of one branch output name.");

const branchNodeSchema = z.object({
  kind: z.literal("branch").describe("Tag marking a conditional branch."),
  ...baseNodeShape,
  when: z.lazy(() => WorkflowExpressionNodeSchema).describe(
    "Boolean condition selecting the then or else arm.",
  ),
  then: stepsSchema(),
  else: stepsSchema(),
  outputs: z.record(nameSchema, branchOutputSchema).describe(
    "Named branch exports; an arm without a value yields null.",
  ),
}).strict().describe("Two-armed conditional node with optional typed outputs.");

const repeatSeedSchema = z.union([
  z.object({
    form: z.literal("mapping").describe("Tag for the mapping seed form."),
    currentCandidate: z.lazy(() => WorkflowValueNodeSchema).describe(
      "Initial candidate value.",
    ),
  }).strict().describe("Seed given as a single candidate mapping."),
  z.object({
    form: z.literal("sequence").describe("Tag for the sequence seed form."),
    steps: stepsSchema(),
    currentCandidate: z.lazy(() => WorkflowValueNodeSchema).describe(
      "Initial candidate value exported from the seed steps.",
    ),
  }).strict().describe(
    "Seed given as steps with an explicit candidate output.",
  ),
]).describe("Exactly one of the two authoring forms of a repeat seed.");

const repeatNodeSchema = z.object({
  kind: z.literal("repeat").describe("Tag marking a bounded repeat."),
  ...baseNodeShape,
  max: z.number().int().min(1).max(8).describe(
    "Maximum iteration count, bounded by the repair-cycle policy.",
  ),
  seed: repeatSeedSchema,
  until: z.lazy(() => WorkflowExpressionNodeSchema).describe(
    "Boolean exit condition checked before the first and after every iteration.",
  ),
  steps: stepsSchema(),
  currentCandidate: z.lazy(() => WorkflowValueNodeSchema).describe(
    "Candidate value carried to the next iteration.",
  ),
}).strict().describe("Bounded loop with a seed, a body and an exit condition.");

const waitNodeSchema = z.object({
  kind: z.literal("wait").describe("Tag marking a wait."),
  ...baseNodeShape,
  wait: z.union([
    z.object({
      kind: z.literal("duration").describe("Tag for a timed wait."),
      durationMs: durationMsSchema.min(1000),
    }).strict().describe("Wait that releases compute for a fixed duration."),
    z.object({
      kind: z.literal("event").describe("Tag for an event wait."),
      event: z.string().regex(/^[a-z][A-Za-z0-9_.]{0,63}$/).describe(
        "Named event the wait subscribes to.",
      ),
      timeoutMs: durationMsSchema.min(1000),
    }).strict().describe("Wait for a named event with a finite timeout."),
  ]).describe("Duration wait or event wait."),
}).strict().describe("Wait node that never blocks indefinitely.");

const laneSchema: z.ZodType<WorkflowLane> = z.object({
  id: identifierSchema,
  needs: needsSchema,
  repository: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).describe(
    "Repository alias the lane runs against.",
  ),
  steps: stepsSchema(),
}).strict().describe("Named parallel lane with sequential steps.");

const parallelNodeSchema = z.object({
  kind: z.literal("parallel").describe("Tag marking a bounded parallel group."),
  ...baseNodeShape,
  maxConcurrency: z.number().int().min(1).max(8).describe(
    "Maximum lanes running at once.",
  ),
  join: z.literal("all-required").describe(
    "Join policy: every lane must succeed.",
  ),
  failurePolicy: z.literal("stop-dependent").describe(
    "Failure policy: stop lanes that depend on a failed lane.",
  ),
  lanes: z.array(laneSchema).min(1).max(8).describe(
    "Lanes in authored order.",
  ),
  outputs: z.record(
    identifierSchema,
    z.record(
      nameSchema,
      described(z.lazy(() => WorkflowValueNodeSchema), "Exported value node."),
    ).describe(
      "Exported values for one lane keyed by export name.",
    ),
  ).describe("Typed exports keyed by lane identifier."),
}).strict().describe("Bounded parallel group of named lanes.");

/** Normalized workflow node of any kind. */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  described(
    z.union([
      actionNodeSchema,
      sequenceNodeSchema,
      branchNodeSchema,
      repeatNodeSchema,
      waitNodeSchema,
      parallelNodeSchema,
    ]),
    "Any normalized workflow node.",
  )
).describe(
  "Normalized workflow node: action, sequence, branch, repeat, wait or parallel.",
);

/**
 * Structured run-input types, each a registered contract the catalog resolves.
 * The set is closed: a new entry is a compiler change and a version bump.
 */
export const WORKFLOW_STRUCTURED_INPUT_TYPES = Object.freeze(
  ["TaskBrief"] as const,
);

const inputSchema = z.object({
  type: z.enum([
    "uuid",
    "string",
    "integer",
    "number",
    "boolean",
    ...WORKFLOW_STRUCTURED_INPUT_TYPES,
  ]).describe(
    "Workflow input type: a scalar from the supported subset or a structured contract type.",
  ),
  required: z.boolean().describe("Whether the run must supply this input."),
  enum: z.array(described(z.string(), "One allowed enumeration value."))
    .max(64).optional().describe(
      "Sorted, duplicate-free allowed values; only string inputs may be enumerations.",
    ),
}).strict().describe("Declared workflow input.");

export const WorkflowSemanticDocumentSchema = z.object({
  compilerVersion: z.literal(2).describe(
    "Compiler semantics version; changing it changes every digest.",
  ),
  registryVersion: z.number().int().min(1).describe(
    "Workflow action registry version the document was resolved against.",
  ),
  apiVersion: z.literal("bakery.dev/v1").describe("Workflow API version."),
  kind: z.literal("workflow").describe("Document kind."),
  inputs: z.record(nameSchema, inputSchema).describe(
    "Declared workflow inputs by name.",
  ),
  limits: z.object({
    wallClockMs: durationMsSchema.min(1000),
    maxCostUsd: z.number().min(0).max(10_000).optional().describe(
      "Workflow spend ceiling in US dollars.",
    ),
    maxAttempts: z.number().int().min(1).max(1000).describe(
      "Workflow worst-case attempt ceiling.",
    ),
    maxRepairCycles: z.number().int().min(0).max(8).optional().describe(
      "Repair-cycle policy bounding repeat.max.",
    ),
  }).strict().describe("Workflow-level limits with defaults applied."),
  agents: z.record(
    described(
      z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
      "Registered action name.",
    ),
    described(z.string().regex(UUID), "Agent version identifier."),
  ).describe(
    "Agent version bindings by registered action name; digest-affecting.",
  ),
  cancel: z.enum(["stop-started-actions"]).optional().describe(
    "Cancellation policy for started actions.",
  ),
  steps: z.array(
    described(z.lazy(() => WorkflowNodeSchema), "Top-level workflow node."),
  ).max(200).describe(
    "Top-level nodes in authored execution order.",
  ),
}).strict().describe(
  "Layout-free normalized workflow document whose canonical JSON is the digest input.",
);

export type WorkflowSemanticDocument = z.infer<
  typeof WorkflowSemanticDocumentSchema
>;

export const WorkflowPlanStepSchema = z.object({
  qualifiedId: z.string().max(2048).describe(
    "Node identifiers joined with dots from the workflow root.",
  ),
  kind: z.enum(["action", "wait"]).describe(
    "Executable step kind; container nodes are not steps.",
  ),
  keyTemplate: z.string().max(2048).describe(
    "Step key with @n markers for every enclosing repeat iteration.",
  ),
  parent: z.string().max(2048).nullable().describe(
    "Qualified identifier of the enclosing container, or null at the root.",
  ),
  position: z.number().int().min(0).describe(
    "Authored position among the parent's children.",
  ),
  action: z.string().max(64).optional().describe(
    "Registered action name for action steps.",
  ),
  agentVersionId: z.string().regex(UUID).optional().describe(
    "Agent version the step selects for itself, when it selects one.",
  ),
  timeoutMs: durationMsSchema.describe("Timeout applied to each attempt."),
  retry: retrySchema,
  loops: z.array(
    z.object({
      repeat: z.string().max(2048).describe(
        "Qualified identifier of the enclosing repeat.",
      ),
      max: z.number().int().min(1).max(8).describe(
        "Iteration ceiling of the enclosing repeat.",
      ),
      seed: z.boolean().describe(
        "True for a seed step, whose only iteration is 0; body steps run 1..max.",
      ),
    }).strict().describe("One enclosing repeat, outermost first."),
  ).max(8).describe(
    "Enclosing repeats from the outermost, one @n marker each in the key template.",
  ),
}).strict().describe("One executable step of the bounded execution plan.");

export type WorkflowPlanStep = z.infer<typeof WorkflowPlanStepSchema>;

export const WorkflowWorstCaseSchema = z.object({
  steps: z.number().int().min(0).describe("Expanded executable step count."),
  attempts: z.number().int().min(0).describe("Worst-case attempt count."),
  timeMs: z.number().int().min(0).describe(
    "Worst-case duration in milliseconds.",
  ),
  costUsd: z.number().min(0).describe(
    "Worst-case declared spend in US dollars.",
  ),
}).strict().describe(
  "Worst-case expansion totals compared against workflow limits.",
);

export const WorkflowExecutionPlanSchema = z.object({
  steps: z.array(WorkflowPlanStepSchema).max(1000).describe(
    "Flattened executable steps in authored order.",
  ),
  worstCase: WorkflowWorstCaseSchema,
}).strict().describe(
  "Bounded execution plan derived from the semantic document.",
);

export const WorkflowCompileResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true).describe("Compilation succeeded."),
    document: WorkflowSemanticDocumentSchema,
    plan: WorkflowExecutionPlanSchema,
    digest: z.string().regex(SHA256).describe(
      "Lowercase SHA-256 of the canonical semantic document.",
    ),
    diagnostics: z.array(WorkflowCompilerDiagnosticSchema).max(0).describe(
      "Always empty on success.",
    ),
  }).strict().describe(
    "Successful compilation with document, plan and digest.",
  ),
  z.object({
    ok: z.literal(false).describe("Compilation failed."),
    diagnostics: z.array(WorkflowCompilerDiagnosticSchema).min(1).max(101)
      .describe(
        "Ordered findings, ending with a truncation marker when capped.",
      ),
  }).strict().describe("Failed compilation carrying only diagnostics."),
]).describe("Result of compiling one workflow definition.");

export type WorkflowCompileResult = z.infer<typeof WorkflowCompileResultSchema>;
