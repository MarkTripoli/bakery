import {
  createWorkflowCompilerCatalog,
  type WorkflowCompilerCatalog,
  type WorkflowLimitField,
} from "../../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "../../../packages/contracts/src/workflow-action-registry.ts";

/**
 * JSON Schema mirror of the IO types in docs/technical-design/
 * 06-workflows-delivery-and-acceptance.md ("The referenced schemas define
 * required fields, types, nullability, and bounds"). Every object is closed;
 * strings carry maxLength 65536 and arrays maxItems 1000 unless narrowed.
 */
type Schema = Record<string, unknown>;

export const uuid = (): Schema => ({
  type: "string",
  format: "uuid",
  pattern: "^[0-9a-f-]{36}$",
});
export const str = (extra: Schema = {}): Schema => ({
  type: "string",
  maxLength: 65536,
  ...extra,
});
export const nonEmpty = (extra: Schema = {}): Schema =>
  str({ minLength: 1, ...extra });
export const int = (extra: Schema = {}): Schema => ({
  type: "integer",
  ...extra,
});
export const num = (extra: Schema = {}): Schema => ({
  type: "number",
  ...extra,
});
export const bool = (): Schema => ({ type: "boolean" });
export const enumOf = (...values: string[]): Schema => ({
  type: "string",
  enum: values,
});
export const arr = (item: Schema, extra: Schema = {}): Schema => ({
  type: "array",
  items: item,
  maxItems: 1000,
  ...extra,
});
export const nullable = (inner: Schema): Schema => ({
  anyOf: [inner, { type: "null" }],
});
export const obj = (
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
/** The recursive JSON-value union contracts emit for opaque `json` fields. */
export const jsonValue = (): Schema => ({
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: { $ref: "#/$defs/json" } },
    {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { $ref: "#/$defs/json" },
    },
  ],
});

export const artifactRef = (): Schema =>
  obj({
    artifactId: uuid(),
    versionId: uuid(),
    sha256: str({ pattern: "^[0-9a-f]{64}$" }),
  });
export const finding = (): Schema =>
  obj({
    fingerprint: nonEmpty(),
    blocking: bool(),
    detail: nonEmpty(),
  });
export const candidateEvidence = (): Schema =>
  obj({
    headSha: nonEmpty(),
    baseSha: nonEmpty(),
    policyDigest: nonEmpty(),
    checksPassed: bool(),
    checkRunIds: arr(uuid(), { minItems: 1 }),
    failedCheckIds: arr(uuid()),
    blockingFindings: int({ minimum: 0 }),
    reviewId: uuid(),
    findings: arr(finding()),
  });

const repairInput = (minFindings: number, minFailed: number): Schema =>
  obj({
    repositoryId: uuid(),
    currentCandidate: candidateEvidence(),
    findings: arr(finding(), { minItems: minFindings }),
    failedCheckIds: arr(uuid(), { minItems: minFailed }),
  });

export const designSchemas: Readonly<Record<string, Schema>> = Object.freeze({
  ResearchInput: obj({ taskId: uuid(), repositoryId: uuid() }),
  ResearchOutput: obj({
    artifact: artifactRef(),
    repositoryRevision: nonEmpty(),
  }),
  DesignInput: obj({ researchArtifact: artifactRef() }),
  PlanInput: obj({ designArtifact: artifactRef() }),
  ArtifactOutput: obj({ artifact: artifactRef() }),
  ImplementInput: obj({
    repositoryId: uuid(),
    planArtifact: artifactRef(),
    instructions: nonEmpty({ maxLength: 4000 }),
  }, ["repositoryId", "planArtifact"]),
  RepairInput: { anyOf: [repairInput(1, 0), repairInput(0, 1)] },
  HarnessOutput: obj({
    headSha: nonEmpty(),
    baseSha: nonEmpty(),
    sessionId: uuid(),
    checkpoint: obj({ cursor: nonEmpty() }),
    piVersion: nullable(str()),
    codexVersion: nullable(str()),
    artifacts: arr(artifactRef()),
    claudeCodeVersion: nullable(str()),
    model: nullable(str()),
    capabilities: arr(str()),
    events: arr(jsonValue()),
    telemetry: jsonValue(),
  }, ["headSha", "baseSha", "sessionId", "artifacts"]),
  CheckInput: obj({
    repositoryId: uuid(),
    revision: nonEmpty(),
    checks: arr(str(), { minItems: 1 }),
  }),
  CheckOutput: obj({
    allRequired: bool(),
    checkRunIds: arr(uuid(), { minItems: 1 }),
    failedCheckIds: arr(uuid()),
    headSha: nonEmpty(),
    baseSha: nonEmpty(),
    policyDigest: nonEmpty(),
  }),
  ReviewInput: obj({
    revision: nonEmpty(),
    evidence: arr(uuid(), { minItems: 1 }),
  }),
  ReviewOutput: obj({
    reviewId: uuid(),
    headSha: nonEmpty(),
    baseSha: nonEmpty(),
    policyDigest: nonEmpty(),
    findings: arr(finding()),
    blockingFindings: int({ minimum: 0 }),
  }),
  IntegrationActionInput: obj({
    actionId: nonEmpty(),
    actionVersion: int({ minimum: 1 }),
    resourceId: uuid(),
    arguments: jsonValue(),
  }),
  IntegrationActionOutput: jsonValue(),
  CandidateEvidence: candidateEvidence(),
  PrepareInput: obj({
    repositoryId: uuid(),
    headSha: nonEmpty(),
    profileRevision: int({ minimum: 1 }),
  }),
  PrepareOutput: obj({
    releaseId: nonEmpty(),
    artifactDigest: nonEmpty(),
    environment: nonEmpty(),
    status: enumOf("prepared"),
  }),
  MergeInput: obj({
    repositoryId: uuid(),
    candidate: candidateEvidence(),
    effectKey: nonEmpty(),
  }),
  MergeOutput: obj({
    commitSha: nonEmpty(),
    providerEffectId: nonEmpty(),
    status: enumOf("confirmed"),
  }),
  DeployInput: obj({
    releaseId: nonEmpty(),
    environment: nonEmpty(),
    effectKey: nonEmpty(),
  }),
  DeployOutput: obj({
    deploymentId: uuid(),
    commitSha: nonEmpty(),
    status: enumOf("accepted", "queued", "deploying"),
    providerEffectId: nonEmpty(),
  }),
  HealthInput: obj({ deploymentId: uuid() }),
  HealthOutput: obj({
    deploymentId: uuid(),
    status: enumOf("healthy", "degraded", "failed"),
    checkedAt: str({ format: "date-time" }),
    evidenceArtifact: artifactRef(),
  }),
  FreeformInput: obj({
    prompt: nonEmpty(),
    maxTurns: int({ minimum: 1, maximum: 50 }),
    timeout: str(),
    maxCostUsd: num({ minimum: 0, maximum: 100 }),
    allowedTools: arr(str(), { maxItems: 20 }),
  }),
  FreeformOutput: obj({
    sessionId: uuid(),
    artifacts: arr(artifactRef()),
    status: enumOf("completed", "failed", "canceled", "timed_out"),
  }),
  EmptyInput: obj({}),
  EmptyOutput: obj({}),
  ArtifactPublishInput: obj({ artifact: artifactRef() }),
  MemoryPromoteInput: obj({
    artifact: artifactRef(),
    sourceRevision: nonEmpty(),
  }),
  MemoryOutput: obj({ memoryId: uuid(), status: enumOf("promoted") }),
  EvaluationInput: obj({
    runId: uuid(),
    sampleRate: num({ minimum: 0, maximum: 1 }),
  }),
  EvaluationOutput: obj({
    evaluationId: uuid(),
    status: enumOf("completed", "failed"),
    measured: bool(),
  }),
  TaskBriefInput: obj({ taskId: uuid() }),
});

/** Check names of the design set (doc 06 specimen `checks` lists). */
export const designCheckNames: ReadonlySet<string> = new Set([
  "lint",
  "typecheck",
  "test",
  "build",
  "test:rails",
  "test:e2e",
]);

/** Every action accepts duration and spend limits; review also bounds findings. */
export function designLimitFields(): Record<
  WorkflowActionName,
  readonly WorkflowLimitField[]
> {
  const table = {} as Record<WorkflowActionName, readonly WorkflowLimitField[]>;
  for (const name of WORKFLOW_ACTION_NAMES) {
    table[name] = name === "review.independent"
      ? ["maxDuration", "maxCostUsd", "maxFindings"]
      : ["maxDuration", "maxCostUsd"];
  }
  return table;
}

export const designEvents = Object.freeze({
  "question.answered": {
    payloadFields: { questionId: "uuid", runId: "uuid|null" },
  },
  "task.status": {
    payloadFields: {
      taskId: "uuid",
      status: "enum(completed|failed|canceled)",
    },
  },
});

export const designTaskSchema: Schema = obj({
  id: uuid(),
  title: str(),
  status: enumOf(
    "draft",
    "queued",
    "active",
    "waiting_input",
    "blocked",
    "completed",
    "failed",
    "canceled",
  ),
});

/** Injected catalog over the design schemas, check set and limit table. */
export function createDesignCatalog(
  overrides: {
    readonly schemas?: Readonly<Record<string, unknown>>;
    readonly checkNames?: ReadonlySet<string> | null;
  } = {},
): WorkflowCompilerCatalog {
  return createWorkflowCompilerCatalog({
    schemas: { ...designSchemas, ...overrides.schemas },
    events: designEvents,
    taskSchema: designTaskSchema,
    checkNames: overrides.checkNames === undefined
      ? designCheckNames
      : overrides.checkNames,
    actionLimitFields: designLimitFields(),
  });
}
