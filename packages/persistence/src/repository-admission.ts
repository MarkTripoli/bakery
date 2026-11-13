import { StandardError } from "@bakery/contracts/http";
import {
  CHECK_OBSERVATION_MAX_ITEMS,
  CHECK_REVISION_PATTERN,
} from "@bakery/contracts/check-evidence";
import {
  fitFindingsToBudget,
  isBlockingSeverity,
  isReviewSeverity,
  REVIEW_LOOP_LIMITS,
  type ReviewSeverity,
  serializedBytes,
} from "@bakery/contracts/review-evidence";
import {
  isAgentVersionSelector,
  selectStepAgentVersion,
} from "./action-admission.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "@bakery/contracts/workflow-action-registry";
import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "@bakery/config";
import {
  type AgentVersionCreateConfig,
  AgentVersionCreateConfigSchema,
  type ContractOutput,
  contractSchemas,
} from "@bakery/contracts/contracts";
import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "@bakery/contracts/repository-profile-config";
import {
  EXECUTION_JOB_INPUT_BYTES_MAX,
  type PinnedRepositoryRules,
  verifyPinnedRepositoryRules,
} from "@bakery/contracts/repository-rules";
import {
  DELIVERY_REFERENCES,
  IMPLEMENT_INSTRUCTIONS_MAX_LENGTH,
  renderImplementInstructions,
} from "@bakery/contracts/workflow-presets";
import {
  RepositoryExecutionContextSchema,
  type RepositoryExecutionRequirements,
  RepositoryExecutionRequirementsSchema,
  type RepositoryInspectionJobInput,
  RepositoryInspectionJobInputSchema,
  type RepositoryInspectionReceipt,
  type RepositoryInspectionReport,
  RepositoryInspectionReportSchema,
  RepositoryProfileObservationPayloadSchema,
  type RepositoryVersionedProfileConfig,
  RepositoryVersionedProfileConfigSchema,
} from "@bakery/contracts/repository-inspection";
import {
  SecretIdentityReadInputSchema,
} from "@bakery/contracts/secret-identity";
import type { PgTransactionClient } from "./postgres.ts";
import {
  assertActionAgentPolicy,
  assertActionInput,
  executionActionCapabilities,
  workflowActionBinding,
  workflowActionCapabilities,
} from "./action-admission.ts";
import { hasHeldJobBudgetReservation } from "./budget-admission.ts";

export type RepositoryExecutionPins = {
  repositoryProfileId: string;
  repositoryProfileRevision: number;
  repositoryProfileDigest: string;
  observationId: string | null;
  observationDigest: string | null;
  baseSha: string | null;
};
export type RepositoryAdmissionScope = {
  organizationId: string;
  applicationId: string;
  repositoryId: string;
};
export type AdmittedRepositoryProfile = RepositoryExecutionPins & {
  config: RepositoryVersionedProfileConfig;
};

// Identical canonical JSON convention to profile/observation publication.
function canonical(value: unknown, omitRootKey?: string): string {
  const normalize = (entry: unknown): unknown => {
    if (
      entry === null || typeof entry === "string" || typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(entry).sort()) {
        if (entry === value && key === omitRootKey) continue;
        const child = (entry as Record<string, unknown>)[key];
        if (child !== undefined) sorted[key] = normalize(child);
      }
      return sorted;
    }
    throw new Error("REPOSITORY_PROFILE_INVALID");
  };
  return JSON.stringify(normalize(value));
}

type JsonRecord = Record<string, unknown>;

type FrozenStepAgent = Readonly<{
  agentVersionId: string;
  revision: number;
  digest: string;
  config: AgentVersionCreateConfig;
  skillRefs: readonly Readonly<{ versionId: string; digest: string }>[];
}>;

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const SKILL_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function pathValue(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const segment of path) {
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new Error("WORKFLOW_INPUT_UNRESOLVED");
    }
    value = (value as JsonRecord)[segment];
  }
  return value;
}

/** What a reference may read: the run inputs, earlier step outputs and the snapshot. */
type Resolution = {
  readonly inputs: unknown;
  readonly stepOutputs: unknown;
  readonly taskRepositoryId: string | null;
  readonly snapshot: JsonRecord;
};

function unresolved(): never {
  throw new Error("WORKFLOW_INPUT_UNRESOLVED");
}

function recordOf(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

type SpecStep = Readonly<{ id: string; uses: string }>;

/** The snapshot's frozen spec steps in spec order; anything malformed is unresolved. */
function specStepsOf(snapshot: JsonRecord): readonly SpecStep[] {
  const steps = recordOf(recordOf(snapshot.workflow)?.normalizedSpec)?.steps;
  if (!Array.isArray(steps)) return unresolved();
  return steps.map((step) => {
    const record = recordOf(step);
    if (typeof record?.id !== "string" || typeof record.uses !== "string") {
      return unresolved();
    }
    return { id: record.id, uses: record.uses };
  });
}

/** Output name of a step's action as frozen in the snapshot, else the registry. */
function frozenOutputName(snapshot: JsonRecord, step: SpecStep): string | null {
  const bindings = recordOf(snapshot.stepActions);
  if (bindings !== undefined && Object.hasOwn(bindings, step.id)) {
    const output = recordOf(recordOf(bindings[step.id])?.metadata)?.output;
    return typeof output === "string" ? output : null;
  }
  return Object.entries(WORKFLOW_ACTION_METADATA).find(([name]) =>
    name === step.uses
  )?.[1].output ?? null;
}

/** The latest recorded output of a step, or undefined while it has none. */
function recordedOutput(
  stepOutputs: unknown,
  stepId: string,
): JsonRecord | undefined {
  const outputs = recordOf(stepOutputs);
  if (outputs === undefined || !Object.hasOwn(outputs, stepId)) {
    return undefined;
  }
  return recordOf(outputs[stepId]);
}

/**
 * The latest output of the last spec step that runs `action` and has one. A
 * run holds one such step per loop, and later spec order is later in the run.
 */
function latestActionOutput(
  resolution: Resolution,
  action: string,
): JsonRecord {
  const output = specStepsOf(resolution.snapshot).filter((step) =>
    step.uses === action
  ).map((step) => recordedOutput(resolution.stepOutputs, step.id)).filter((
    recorded,
  ): recorded is JsonRecord => recorded !== undefined).at(-1);
  return output ?? unresolved();
}

/**
 * Head commit of the run's current candidate: the `headSha` reported by the
 * last spec step whose frozen action output is `HarnessOutput` and that has
 * recorded an output. A repair that has run therefore supersedes the implement
 * step it repaired, and the answer is a pure function of the frozen spec and
 * the recorded outputs, so admission and claim-time re-derivation agree.
 * Throws `WORKFLOW_INPUT_UNRESOLVED` while no harness step has reported one.
 */
export function candidateHeadSha(
  snapshot: unknown,
  stepOutputs: unknown,
): string {
  return candidateProducer(snapshot, stepOutputs).headSha;
}

/**
 * The step that produced the run's current candidate: the last spec step whose
 * frozen action output is `HarnessOutput` and that has recorded a `headSha`,
 * with that head. It is the one definition `candidateHeadSha` and a reviewer's
 * provenance both read, so the head a review judged and the implementing
 * session recorded beside it can never name different steps. Throws
 * `WORKFLOW_INPUT_UNRESOLVED` while no harness step has reported a head.
 */
export function candidateProducer(
  snapshot: unknown,
  stepOutputs: unknown,
): { readonly stepKey: string; readonly headSha: string } {
  const frozen = recordOf(snapshot);
  if (frozen === undefined) return unresolved();
  let producer: { stepKey: string; headSha: string } | undefined;
  for (const step of specStepsOf(frozen)) {
    if (frozenOutputName(frozen, step) !== "HarnessOutput") continue;
    const reported = recordedOutput(stepOutputs, step.id)?.headSha;
    if (typeof reported === "string") {
      producer = { stepKey: step.id, headSha: reported };
    }
  }
  return producer ?? unresolved();
}

/**
 * Step keys of every spec step whose frozen action output is `HarnessOutput`
 * (the implementing steps: implement and repair), in spec order. A run that
 * has used its repair step holds a session for each of these.
 */
export function harnessStepKeys(snapshot: unknown): readonly string[] {
  const frozen = recordOf(snapshot);
  if (frozen === undefined) return unresolved();
  return specStepsOf(frozen).filter((step) =>
    frozenOutputName(frozen, step) === "HarnessOutput"
  ).map((step) => step.id);
}

/** The review and repair loop bounds frozen into a run snapshot at admission. */
export type ReviewLoopLimits = ContractOutput<"DeliveryLoopLimits">;

/**
 * Reads the loop bounds a run froze at admission. `null` means the run has no
 * loop (an older run, or a workflow without the review and repair shape); a
 * present but malformed `reviewLoop` fails closed with a thrown error so no
 * caller can fall back to defaults the run never agreed to.
 */
export function reviewLoopFromSnapshot(
  snapshot: unknown,
): ReviewLoopLimits | null {
  const frozen = recordOf(snapshot);
  if (frozen === undefined || !Object.hasOwn(frozen, "reviewLoop")) {
    return null;
  }
  const raw = recordOf(frozen.reviewLoop);
  const parsed = contractSchemas.DeliveryLoopLimits.safeParse(
    frozen.reviewLoop,
  );
  if (!parsed.success || raw === undefined || Object.keys(raw).length !== 3) {
    throw new Error("RUN_SNAPSHOT_REVIEW_LOOP_INVALID");
  }
  return parsed.data;
}

/** Ids of every fixed policy command of the pinned profile, in policy order. */
function deliveryCheckIds(snapshot: JsonRecord): string[] {
  const policy = recordOf(
    recordOf(recordOf(snapshot.repositoryProfile)?.config)?.fixedPolicy,
  );
  const commands = policy?.commands;
  if (!Array.isArray(commands) || commands.length === 0) return unresolved();
  return commands.map((command) => {
    const id = recordOf(command)?.id;
    return typeof id === "string" ? id : unresolved();
  });
}

/**
 * Required checks that did not pass on the latest candidate, as repair input.
 * Only observations whose row id the check output lists in `failedCheckIds`
 * qualify: those are the server-verified required failures, so a `warn` or
 * `guide` command that failed never drives a repair.
 */
function deliveryFailedChecks(resolution: Resolution): JsonRecord[] {
  const output = latestActionOutput(resolution, "quality.check");
  const failed = output.failedCheckIds;
  const observations = output.observations;
  if (
    !Array.isArray(failed) || failed.some((id) => typeof id !== "string") ||
    !Array.isArray(observations) ||
    observations.length > CHECK_OBSERVATION_MAX_ITEMS
  ) return unresolved();
  const failedIds = new Set<string>(failed);
  const checks: JsonRecord[] = [];
  for (const observation of observations) {
    const row = recordOf(observation);
    if (
      row === undefined || typeof row.checkRunId !== "string" ||
      typeof row.checkId !== "string" || typeof row.result !== "string" ||
      typeof row.reason !== "string" ||
      (row.exitCode !== null && typeof row.exitCode !== "number")
    ) return unresolved();
    if (!failedIds.has(row.checkRunId) || row.result === "passed") continue;
    checks.push({
      checkRunId: row.checkRunId,
      checkId: row.checkId,
      result: row.result,
      reason: row.reason,
      exitCode: row.exitCode,
    });
  }
  return checks;
}

type StoredFinding = JsonRecord & { severity: ReviewSeverity; detail: string };

/**
 * Blocking findings of the latest independent review, blocker first and never
 * more than the review result byte budget. Whether a finding blocks comes from
 * its severity alone (`isBlockingSeverity`): the stored `blocking` flag is only
 * checked for shape, so a flag that disagrees with the severity can neither
 * hide a blocker from the repair nor hand a note to it, and the emitted row
 * always reads `blocking: true`. A verified report already fits the byte
 * budget, so the fit step only guards a stored output nobody verified; it never
 * drops a blocking finding, and an output it cannot fit is unresolved rather
 * than quietly shortened past recognition.
 */
function deliveryBlockingFindings(resolution: Resolution): JsonRecord[] {
  const findings = latestActionOutput(resolution, "review.independent")
    .findings;
  if (
    !Array.isArray(findings) ||
    findings.length > REVIEW_LOOP_LIMITS.maxFindings
  ) return unresolved();
  const blocking: StoredFinding[] = [];
  for (const finding of findings) {
    const row = recordOf(finding);
    if (
      row === undefined || !isReviewSeverity(row.severity) ||
      typeof row.detail !== "string" || typeof row.blocking !== "boolean"
    ) return unresolved();
    if (isBlockingSeverity(row.severity)) {
      blocking.push({
        ...row,
        severity: row.severity,
        detail: row.detail,
        blocking: true,
      });
    }
  }
  return fitFindingsToBudget(
    blocking,
    (candidate) =>
      serializedBytes(candidate) <= REVIEW_LOOP_LIMITS.resultByteBudget,
  ) ?? unresolved();
}

function resolveDeliveryReference(
  reference: string,
  resolution: Resolution,
): unknown {
  switch (reference) {
    case DELIVERY_REFERENCES.headSha:
      return candidateHeadSha(resolution.snapshot, resolution.stepOutputs);
    case DELIVERY_REFERENCES.checkIds:
      return deliveryCheckIds(resolution.snapshot);
    case DELIVERY_REFERENCES.failedChecks:
      return deliveryFailedChecks(resolution);
    case DELIVERY_REFERENCES.blockingFindings:
      return deliveryBlockingFindings(resolution);
    default:
      return unresolved();
  }
}

function resolveSnapshotValue(
  value: unknown,
  resolution: Resolution,
): unknown {
  if (typeof value === "string") {
    if (value === "$input") return resolution.inputs;
    if (value.startsWith("$input.")) {
      return pathValue(
        resolution.inputs,
        value.slice("$input.".length).split("."),
      );
    }
    if (value.startsWith("$step.")) {
      const [, stepKey, ...path] = value.split(".");
      const stepValue = pathValue(resolution.stepOutputs, [stepKey]);
      return pathValue(stepValue, path);
    }
    if (value === "$task.repositoryId") {
      if (resolution.taskRepositoryId === null) {
        throw new Error("WORKFLOW_INPUT_UNRESOLVED");
      }
      return resolution.taskRepositoryId;
    }
    if (value.startsWith("$delivery.")) {
      return resolveDeliveryReference(value, resolution);
    }
    if (value.startsWith("$")) {
      throw new Error("WORKFLOW_INPUT_UNRESOLVED");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSnapshotValue(item, resolution));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, child]) => [
      key,
      resolveSnapshotValue(child, resolution),
    ]),
  );
}

function agentBindings(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length > 17
  ) throw new Error("WORKFLOW_AGENT_BINDINGS_INVALID");
  const bindings: Record<string, string> = {};
  for (const [action, agentVersionId] of Object.entries(value)) {
    if (
      !ACTION_NAME_PATTERN.test(action) ||
      !isAgentVersionSelector(agentVersionId)
    ) throw new Error("WORKFLOW_AGENT_BINDINGS_INVALID");
    bindings[action] = agentVersionId;
  }
  return bindings;
}

function parseFrozenStepAgent(value: unknown): FrozenStepAgent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FROZEN_STEP_AGENT_INVALID");
  }
  const record = value as JsonRecord;
  if (
    Object.keys(record).sort().join(",") !==
      "agentVersionId,config,digest,revision,skillRefs" ||
    !isAgentVersionSelector(record.agentVersionId) ||
    !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
    typeof record.digest !== "string" || !DIGEST_PATTERN.test(record.digest) ||
    !Array.isArray(record.skillRefs) || record.skillRefs.length > 100
  ) throw new Error("FROZEN_STEP_AGENT_INVALID");
  const config = AgentVersionCreateConfigSchema.safeParse(record.config);
  if (!config.success) throw new Error("FROZEN_STEP_AGENT_INVALID");
  const seen = new Set<string>();
  const skillRefs = record.skillRefs.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("FROZEN_STEP_AGENT_INVALID");
    }
    const ref = value as JsonRecord;
    if (
      Object.keys(ref).sort().join(",") !== "digest,versionId" ||
      typeof ref.versionId !== "string" ||
      !SKILL_VERSION_ID_PATTERN.test(ref.versionId) ||
      typeof ref.digest !== "string" || !DIGEST_PATTERN.test(ref.digest) ||
      seen.has(ref.versionId)
    ) throw new Error("FROZEN_STEP_AGENT_INVALID");
    seen.add(ref.versionId);
    return { versionId: ref.versionId, digest: ref.digest };
  });
  return {
    agentVersionId: record.agentVersionId,
    revision: Number(record.revision),
    digest: record.digest,
    config: config.data,
    skillRefs,
  };
}

function frozenAgentFromSnapshot(
  snapshot: JsonRecord,
  spec: JsonRecord,
  candidate: JsonRecord,
  stepKey: string,
  action: string,
): FrozenStepAgent | null {
  const workflowBindings = agentBindings(spec.agents);
  const repositoryProfile = snapshot.repositoryProfile;
  const profileRecord = repositoryProfile !== null &&
      typeof repositoryProfile === "object" &&
      !Array.isArray(repositoryProfile)
    ? repositoryProfile as JsonRecord
    : undefined;
  const profileConfig = profileRecord?.config !== null &&
      typeof profileRecord?.config === "object" &&
      !Array.isArray(profileRecord.config)
    ? profileRecord.config as JsonRecord
    : undefined;
  const profileBindings = agentBindings(profileConfig?.agentBindings);
  if (
    Object.hasOwn(candidate, "agentVersionId") &&
    !isAgentVersionSelector(candidate.agentVersionId)
  ) {
    throw new Error("WORKFLOW_AGENT_SELECTOR_INVALID");
  }
  const selected = selectStepAgentVersion({
    action,
    stepAgentVersionId: isAgentVersionSelector(candidate.agentVersionId)
      ? candidate.agentVersionId
      : null,
    workflowAgents: workflowBindings,
    profileAgentBindings: profileBindings,
  }).agentVersionId ?? undefined;

  if (!Object.hasOwn(snapshot, "stepAgents")) {
    if (selected !== undefined) throw new Error("FROZEN_STEP_AGENT_MISSING");
    return null;
  }
  const value = snapshot.stepAgents;
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length > 100
  ) throw new Error("FROZEN_STEP_AGENTS_INVALID");
  const stepIds = new Set(
    Array.isArray(spec.steps)
      ? spec.steps.flatMap((step) =>
        step !== null && typeof step === "object" && !Array.isArray(step) &&
          typeof (step as JsonRecord).id === "string"
          ? [(step as JsonRecord).id as string]
          : []
      )
      : [],
  );
  const agents = new Map<string, FrozenStepAgent>();
  for (const [key, agent] of Object.entries(value)) {
    if (!stepIds.has(key)) throw new Error("FROZEN_STEP_AGENT_UNBOUND");
    agents.set(key, parseFrozenStepAgent(agent));
  }
  const frozen = agents.get(stepKey);
  if (selected === undefined) {
    if (frozen) throw new Error("FROZEN_STEP_AGENT_UNBOUND");
    return null;
  }
  if (!frozen || frozen.agentVersionId !== selected) {
    throw new Error("FROZEN_STEP_AGENT_MISMATCH");
  }
  return frozen;
}

/**
 * The worker cannot read the plan artifact bytes, so a harness implement step
 * would otherwise run with no task text. Resolve the frozen run inputs (server
 * built, never client supplied) into bounded `instructions` unless the step
 * already carries its own: the frozen rendered `instructions` first, else the
 * brief rendered by the same `renderImplementInstructions` the presets use, so
 * every path hands the harness one format.
 */
function withBriefInstructions(
  action: string,
  input: unknown,
  inputs: unknown,
): unknown {
  if (
    action !== "harness.implement" || input === null ||
    typeof input !== "object" || Array.isArray(input) ||
    Object.hasOwn(input, "instructions") || inputs === null ||
    typeof inputs !== "object" || Array.isArray(inputs)
  ) return input;
  const frozen = (inputs as JsonRecord).instructions;
  if (
    typeof frozen === "string" && frozen.trim().length > 0 &&
    frozen.length <= IMPLEMENT_INSTRUCTIONS_MAX_LENGTH && frozen.isWellFormed()
  ) return { ...input, instructions: frozen };
  const brief = (inputs as JsonRecord).brief;
  if (brief === null || typeof brief !== "object" || Array.isArray(brief)) {
    return input;
  }
  const { title, description } = brief as JsonRecord;
  const titleText = typeof title === "string" ? title.trim() : "";
  const descriptionText = typeof description === "string"
    ? description.trim()
    : "";
  if (titleText.length === 0 && descriptionText.length === 0) return input;
  return {
    ...input,
    instructions: renderImplementInstructions({
      title: titleText,
      description: descriptionText,
    }),
  };
}

/** The materializer and every revalidation resolve the same frozen authority. */
export function actionAndInputFromSnapshot(row: {
  runSnapshot: unknown;
  stepKey: string;
  stepOutputs: unknown;
  repositoryId: string | null;
  /** The dispatch recorded with a compiled-plan run's step row; null for a flat run's. */
  stepDispatch?: unknown;
}): {
  action: string;
  input: unknown;
  agent: FrozenStepAgent | null;
  requiredCapabilities: readonly string[];
} {
  if (
    row.runSnapshot !== null && typeof row.runSnapshot === "object" &&
    !Array.isArray(row.runSnapshot) &&
    Object.hasOwn(row.runSnapshot, "runtime")
  ) {
    return actionAndInputFromPlanDispatch({
      snapshot: row.runSnapshot,
      dispatch: planDispatchFromRow(row.stepDispatch),
    });
  }
  const snapshot = row.runSnapshot !== null &&
      typeof row.runSnapshot === "object" &&
      !Array.isArray(row.runSnapshot)
    ? row.runSnapshot as JsonRecord
    : undefined;
  const workflowValue = snapshot?.workflow;
  const workflow = workflowValue !== null &&
      typeof workflowValue === "object" &&
      !Array.isArray(workflowValue)
    ? workflowValue as JsonRecord
    : undefined;
  const specValue = workflow?.normalizedSpec;
  const spec = specValue !== null &&
      typeof specValue === "object" &&
      !Array.isArray(specValue)
    ? specValue as JsonRecord
    : undefined;
  const steps = spec?.steps;
  const candidate = Array.isArray(steps)
    ? steps.find((step) =>
      step !== null &&
      typeof step === "object" &&
      !Array.isArray(step) &&
      (step as JsonRecord).id === row.stepKey
    )
    : undefined;
  if (
    !snapshot || !spec || candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof (candidate as JsonRecord).uses !== "string"
  ) {
    throw new Error("WORKFLOW_STEP_ACTION_MISSING");
  }
  const candidateRecord = candidate as JsonRecord;
  const action = candidateRecord.uses as string;
  const inputs = snapshot.inputs ?? {};
  const rawInput = candidateRecord.with ?? candidateRecord.input ?? {};
  const requiredCapabilities = executionActionCapabilities(
    action,
    candidateRecord.requires,
  );
  const agent = frozenAgentFromSnapshot(
    snapshot,
    spec,
    candidateRecord,
    row.stepKey,
    action,
  );
  if (Object.hasOwn(snapshot, "stepActions")) {
    const bindings = snapshot.stepActions;
    if (
      bindings === null || typeof bindings !== "object" ||
      Array.isArray(bindings) ||
      !Object.hasOwn(bindings, row.stepKey) ||
      canonical((bindings as JsonRecord)[row.stepKey]) !==
        canonical(workflowActionBinding(action, candidateRecord.requires))
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_action_binding_mismatch" },
      });
    }
  } else if (
    Object.hasOwn(WORKFLOW_ACTION_METADATA, action) &&
    Number(WORKFLOW_ACTION_REGISTRY_VERSION) !== 1
  ) {
    // Pre-registry snapshots have an implicit v1 binding, not a mutable default.
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_action_version_unavailable" },
    });
  }
  return {
    action,
    input: withBriefInstructions(
      action,
      resolveSnapshotValue(rawInput, {
        inputs,
        stepOutputs: row.stepOutputs,
        taskRepositoryId: row.repositoryId,
        snapshot,
      }),
      inputs,
    ),
    agent,
    requiredCapabilities,
  };
}

/**
 * The frozen agent a compiled plan's step runs as. A plan names agents by
 * version id; admission freezes each one it references into `planAgents`,
 * keyed by that id, so a later edit of an agent cannot change an old run.
 * A step with no agent has none; a named agent that was not frozen, or whose
 * frozen record names another version, is refused.
 */
function planAgentFromSnapshot(
  snapshot: JsonRecord,
  agentVersionId: string | undefined,
): FrozenStepAgent | null {
  const value = snapshot.planAgents;
  const agents = new Map<string, FrozenStepAgent>();
  if (value !== undefined) {
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length > 100
    ) throw new Error("FROZEN_STEP_AGENTS_INVALID");
    for (const [key, agent] of Object.entries(value)) {
      const parsed = parseFrozenStepAgent(agent);
      if (parsed.agentVersionId !== key) {
        throw new Error("FROZEN_STEP_AGENT_INVALID");
      }
      agents.set(key, parsed);
    }
  }
  if (agentVersionId === undefined) return null;
  const frozen = agents.get(agentVersionId);
  if (!frozen) throw new Error("FROZEN_STEP_AGENT_MISSING");
  return frozen;
}

/** The dispatch the engine recorded for a plan step, as much as a job is built from. */
export type PlanDispatch = Readonly<{
  action: string;
  input: unknown;
  requires: readonly string[];
  agentVersionId?: string;
  retry: Readonly<{ maxAttempts: number }>;
}>;

/**
 * Reads the recorded dispatch of a plan step. A plan run's row without one
 * (or with one that is not a dispatch) is a state conflict, never a guess: the
 * job must be exactly what the engine decided.
 */
export function planDispatchFromRow(value: unknown): PlanDispatch {
  const invalid = () =>
    new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_plan_dispatch_invalid" },
    });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as JsonRecord;
  const retry = record.retry;
  if (
    typeof record.action !== "string" || record.action.length === 0 ||
    !Object.hasOwn(record, "input") || !Array.isArray(record.requires) ||
    record.requires.some((entry) => typeof entry !== "string") ||
    (record.agentVersionId !== undefined &&
      typeof record.agentVersionId !== "string") ||
    retry === null || typeof retry !== "object" || Array.isArray(retry) ||
    !Number.isSafeInteger((retry as JsonRecord).maxAttempts) ||
    Number((retry as JsonRecord).maxAttempts) < 1
  ) throw invalid();
  return {
    action: record.action,
    input: record.input,
    requires: record.requires as string[],
    ...(record.agentVersionId === undefined
      ? {}
      : { agentVersionId: record.agentVersionId as string }),
    retry: { maxAttempts: Number((retry as JsonRecord).maxAttempts) },
  };
}

/**
 * What a compiled plan's dispatch asks the worker to run, in the shape
 * `actionAndInputFromSnapshot` gives a flat step: the action, its input (the
 * interpreter already resolved every reference from the recorded state), the
 * capabilities it requires and the frozen agent. The dispatch is recomputed
 * from the frozen document and the stored rows by the caller, so nothing here
 * is read from a mutable place.
 */
export function actionAndInputFromPlanDispatch(options: {
  snapshot: unknown;
  dispatch: Readonly<{
    action: string;
    input: unknown;
    requires: readonly string[];
    agentVersionId?: string;
  }>;
}): {
  action: string;
  input: unknown;
  agent: FrozenStepAgent | null;
  requiredCapabilities: readonly string[];
} {
  const { snapshot, dispatch } = options;
  if (
    snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
  ) throw new Error("WORKFLOW_PLAN_SNAPSHOT_INVALID");
  const record = snapshot as JsonRecord;
  return {
    action: dispatch.action,
    input: withBriefInstructions(
      dispatch.action,
      dispatch.input,
      record.inputs ?? {},
    ),
    agent: planAgentFromSnapshot(record, dispatch.agentVersionId),
    requiredCapabilities: executionActionCapabilities(
      dispatch.action,
      dispatch.requires,
    ),
  };
}

/** Exclude only the injected server context, never any caller-owned field. */
export function executionJobInputMatchesSnapshot(
  row: Parameters<typeof actionAndInputFromSnapshot>[0],
  action: string,
  input: unknown,
): boolean {
  try {
    const authorized = actionAndInputFromSnapshot(row);
    return authorized.action === action &&
      authorized.input !== null && typeof authorized.input === "object" &&
      !Array.isArray(authorized.input) &&
      !Object.hasOwn(authorized.input, "repositoryProfile") &&
      canonical(input, "repositoryProfile") === canonical(authorized.input);
  } catch {
    return false;
  }
}

/** JobAssignment bounds the complete canonical input, including server context. */
export function executionJobInputFitsTransport(input: unknown): boolean {
  try {
    return input !== null && typeof input === "object" &&
      !Array.isArray(input) &&
      new TextEncoder().encode(canonical(input)).length <=
        EXECUTION_JOB_INPUT_BYTES_MAX;
  } catch {
    return false;
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalExecutionInputDigest(value: unknown): Promise<string> {
  return digest(value);
}

function secretIdentityAdmissionRequired(): never {
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "secret_identity_repository_admission_required" },
  });
}

export type SecretIdentityAdmission = {
  organizationId: string;
  action: string;
  executionMode: unknown;
  applicationId: string | null;
  repositoryId: string | null;
  repositoryProfile: unknown;
  requestedBy: string | null;
  runId: string;
  secretRef: string | null;
};

/** Durable requester U is the only principal evaluated against secret policy. */
export async function assertSecretIdentityRepositoryAdmission(
  transaction: PgTransactionClient,
  admission: SecretIdentityAdmission,
): Promise<void> {
  if (admission.action !== "secret.identity.read") return;
  const profile = RepositoryExecutionContextSchema.safeParse(
    admission.repositoryProfile,
  );
  const input = SecretIdentityReadInputSchema.safeParse({
    secretRef: admission.secretRef,
  });
  if (
    admission.executionMode !== "repository" ||
    admission.applicationId === null || admission.repositoryId === null ||
    admission.requestedBy === null || !profile.success || !input.success ||
    profile.data.organizationId !== admission.organizationId ||
    profile.data.applicationId !== admission.applicationId ||
    profile.data.repositoryId !== admission.repositoryId
  ) secretIdentityAdmissionRequired();
  const eligible = await transaction.query<{ requester_id: string }>(
    `select run.requested_by as requester_id
       from bakery.workflow_runs run
       join bakery.principals requester on requester.id = run.requested_by
       join bakery.organization_memberships membership
         on membership.organization_id = run.organization_id
        and membership.principal_id = run.requested_by
        and membership.status = 'active'
       join bakery.secrets secret
         on secret.organization_id = run.organization_id
        and secret.application_id = run.application_id
        and secret.id = $2
       join bakery.secret_versions version
         on version.organization_id = secret.organization_id
        and version.application_id = secret.application_id
        and version.secret_id = secret.id
        and version.id = secret.active_version_id
      where run.organization_id = $1 and run.id = $3
        and run.requested_by = $4 and requester.disabled_at is null
        and run.application_id = $5 and run.repository_id = $6
        and secret.provider = 'github' and secret.revoked_at is null
        and (secret.expires_at is null or secret.expires_at > clock_timestamp())
        and (version.expires_at is null or version.expires_at > clock_timestamp())
        and secret.allowed_principals @> jsonb_build_array(run.requested_by::text)
        and secret.allowed_actions @> '["identity.read"]'::jsonb`,
    [
      admission.organizationId,
      input.data.secretRef,
      admission.runId,
      admission.requestedBy,
      admission.applicationId,
      admission.repositoryId,
    ],
  );
  if (eligible.rows.length !== 1) secretIdentityAdmissionRequired();
}

function secretRefFromEffectiveInput(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const { repositoryProfile: _repositoryProfile, ...workflowInput } =
    input as Record<string, unknown>;
  const parsed = SecretIdentityReadInputSchema.safeParse(workflowInput);
  return parsed.success ? parsed.data.secretRef : null;
}

/** Shared finite evidence validation for live publication and immutable admission. */
export function inspectionEvidenceIsCoherent(
  input: RepositoryInspectionJobInput,
  receipt: RepositoryInspectionReceipt,
  report: RepositoryInspectionReport,
): boolean {
  const started = Date.parse(report.startedAt);
  const completed = Date.parse(report.completedAt);
  const expires = Date.parse(receipt.expiresAt);
  const policy = input.profile.config.checkPolicy;
  if (
    canonical(report.input) !== canonical(input) ||
    canonical(report.receipt) !== canonical(receipt) ||
    new TextEncoder().encode(canonical(report)).length > LIMITS.reportBytes ||
    started < expires - LIMITS.durationMs || completed < started ||
    completed > expires ||
    completed > Date.now() || completed - started > LIMITS.durationMs ||
    new Set(policy.tools.map((entry) => entry.tool)).size !==
      policy.tools.length ||
    new Set(policy.checks.map((entry) => entry.id)).size !==
      policy.checks.length ||
    report.host.tools.length !== policy.tools.length ||
    report.checks.length !== policy.checks.length ||
    new Set(report.host.tools.map((entry) => entry.tool)).size !==
      policy.tools.length ||
    new Set(report.checks.map((entry) => entry.id)).size !==
      policy.checks.length
  ) return false;
  for (const tool of policy.tools) {
    const observed = report.host.tools.find((entry) =>
      entry.tool === tool.tool
    );
    if (
      !observed ||
      (observed.status === "available"
        ? observed.version === null || observed.outputDigest === null
        : observed.version !== null || observed.outputDigest !== null)
    ) return false;
  }
  for (const check of policy.checks) {
    const result = report.checks.find((entry) => entry.id === check.id);
    const tool = report.host.tools.find((entry) => entry.tool === check.tool);
    if (
      !result || result.template !== check.template ||
      result.required !== check.required ||
      result.durationMs > LIMITS.commandMs ||
      result.durationMs > completed - started ||
      (check.tool !== null &&
        !policy.tools.some((entry) =>
          entry.tool === check.tool && (!check.required || entry.required)
        ))
    ) return false;
    if (check.template === "unsupported.v1") {
      if (
        check.tool !== null || result.status !== "unsupported" ||
        result.reason !== "unsupported_command" ||
        result.exitCode !== null || result.outputDigest !== null
      ) return false;
    } else if (check.template === "source.integrity.v1") {
      if (
        check.tool !== null || result.status !== "passed" ||
        result.reason !== "verified" ||
        result.exitCode !== null ||
        result.outputDigest !== input.source.manifestDigest
      ) return false;
    } else if (
      !tool || (check.template === "node.syntax.v1" && check.tool !== "node") ||
      (check.template === "deno.check.v1" && check.tool !== "deno")
    ) return false;
    else if (report.host.os !== policy.platform) {
      if (
        result.status !== "unsupported" ||
        result.reason !== "platform_mismatch" ||
        result.exitCode !== null || result.outputDigest !== null
      ) return false;
    } else if (tool.status === "missing") {
      if (
        result.status !== "missing" || result.reason !== "tool_missing" ||
        result.exitCode !== null || result.outputDigest !== null
      ) return false;
    } else if (result.status === "passed") {
      if (
        result.reason !== "verified" || result.exitCode !== 0 ||
        result.outputDigest === null ||
        (check.template === "tool.version.v1" &&
          result.outputDigest !== tool.outputDigest)
      ) return false;
    } else if (
      result.status !== "failed" || check.template === "tool.version.v1" ||
      !["exit_nonzero", "deadline", "output_limit"].includes(result.reason) ||
      result.outputDigest === null ||
      (result.reason === "exit_nonzero"
        ? result.exitCode === null || result.exitCode === 0
        : result.exitCode !== null)
    ) return false;
  }
  return true;
}

export function repositoryInspectionReadiness(
  input: RepositoryInspectionJobInput,
  report: RepositoryInspectionReport,
): "eligible" | "blocked" {
  const policy = input.profile.config.checkPolicy;
  return report.host.os === policy.platform &&
      policy.tools.every((tool) =>
        !tool.required ||
        report.host.tools.some((observed) =>
          observed.tool === tool.tool && observed.status === "available"
        )
      ) &&
      report.checks.every((check) =>
        !check.required || check.status === "passed"
      )
    ? "eligible"
    : "blocked";
}
function unavailable(): never {
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "configuration_profile_unavailable" },
  });
}

/** The only execution admission boundary for strict-v1 and observed-v2. */
export async function admitRepositoryProfile(
  transaction: PgTransactionClient,
  scope: RepositoryAdmissionScope,
  profile: { id: string; revision: number; digest: string; config: unknown },
  expected?: RepositoryExecutionPins,
): Promise<AdmittedRepositoryProfile> {
  const parsed = RepositoryVersionedProfileConfigSchema.safeParse(
    profile.config,
  );
  if (
    !parsed.success || await digest(parsed.data) !== profile.digest ||
    !Number.isSafeInteger(profile.revision) || profile.revision < 1 ||
    (expected && (expected.repositoryProfileId !== profile.id ||
      expected.repositoryProfileRevision !== profile.revision ||
      expected.repositoryProfileDigest !== profile.digest))
  ) unavailable();
  const pins = {
    repositoryProfileId: profile.id,
    repositoryProfileRevision: profile.revision,
    repositoryProfileDigest: profile.digest,
  };
  if (parsed.data.schemaVersion === 1) {
    if (
      parsed.data.fixedPolicy !== undefined ||
      (expected && (expected.observationId !== null ||
        expected.observationDigest !== null || expected.baseSha !== null))
    ) unavailable();
    return {
      ...pins,
      config: parsed.data,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    };
  }
  if (
    parsed.data.fixedPolicy !== undefined &&
    parsed.data.fixedPolicy.trustedChecker.configDigest !==
      await digest(parsed.data.checkPolicy)
  ) unavailable();
  if (
    expected && (expected.observationId === null ||
      expected.observationDigest === null || expected.baseSha === null)
  ) unavailable();
  const observations = await transaction.query<{
    id: string;
    observation_digest: string;
    base_sha: string;
    source_mapping_revision: string;
    source_mapping_digest: string;
    readiness: string;
    observed_at: Date | string;
    payload: unknown;
    input: unknown;
    input_digest: string;
    job_input: unknown;
    attempt_id: string;
    fence: string | number;
    worker_host_id: string;
    worker_session_id: string | null;
    worker_session_generation: string | number;
    attempt_created_at: Date | string;
    attempt_result: unknown;
  }>(
    `select o.id, o.observation_digest, o.base_sha, o.source_mapping_revision,
            o.source_mapping_digest, o.readiness, o.payload, o.observed_at,
            onboarding.input, onboarding.input_digest, job.input as job_input,
            attempt.id as attempt_id, attempt.fence, attempt.worker_host_id,
            attempt.worker_session_id, attempt.worker_session_generation,
            attempt.created_at as attempt_created_at, attempt.result->'result' as attempt_result
       from bakery.repository_profile_observations o
       join bakery.repository_onboardings onboarding
         on onboarding.organization_id = o.organization_id
        and onboarding.application_id = o.application_id
        and onboarding.repository_id = o.repository_id
        and onboarding.published_profile_id = o.profile_id
        and onboarding.observation_id = o.id
       join bakery.jobs job
         on job.organization_id = onboarding.organization_id
        and job.id = onboarding.job_id and job.action = 'repository.inspect'
        and job.status = 'completed'
        and job.run_step_id is null
        and job.application_id = o.application_id and job.repository_id = o.repository_id
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id and attempt.id = onboarding.source_attempt_id
        and attempt.status = 'completed'
        and attempt.result->>'status' = 'completed'
      where o.organization_id = $1 and o.application_id = $2 and o.repository_id = $3
        and o.profile_id = $4 and o.profile_revision = $5 and o.profile_digest = $6
        and ($7::uuid is null or o.id = $7)
      limit 2`,
    [
      scope.organizationId,
      scope.applicationId,
      scope.repositoryId,
      profile.id,
      profile.revision,
      profile.digest,
      expected?.observationId ?? null,
    ],
  );
  if (observations.rows.length !== 1) unavailable();
  const row = observations.rows[0]!;
  const observation = RepositoryProfileObservationPayloadSchema.safeParse(
    row.payload,
  );
  const input = RepositoryInspectionJobInputSchema.safeParse(row.input);
  const report = RepositoryInspectionReportSchema.safeParse(row.attempt_result);
  if (!observation.success || !input.success || !report.success) unavailable();
  const payload = observation.data;
  const receipt = payload.receipt;
  if (
    await digest(payload) !== row.observation_digest ||
    await digest(input.data) !== row.input_digest ||
    canonical(row.job_input) !== canonical(input.data) ||
    canonical(report.data.host) !== canonical(payload.host) ||
    canonical(report.data.checks) !== canonical(payload.checks) ||
    report.data.completedAt !== payload.observedAt ||
    Date.parse(receipt.expiresAt) !==
      new Date(row.attempt_created_at).getTime() + LIMITS.durationMs ||
    Date.parse(payload.observedAt) !== new Date(row.observed_at).getTime() ||
    canonical(input.data.profile) !==
      canonical({
        id: profile.id,
        revision: profile.revision,
        digest: profile.digest,
        config: parsed.data,
      }) ||
    payload.organizationId !== scope.organizationId ||
    payload.applicationId !== scope.applicationId ||
    payload.repositoryId !== scope.repositoryId ||
    payload.profileId !== profile.id ||
    payload.profileRevision !== profile.revision ||
    payload.profileDigest !== profile.digest ||
    input.data.organizationId !== scope.organizationId ||
    input.data.applicationId !== scope.applicationId ||
    input.data.repositoryId !== scope.repositoryId ||
    payload.inspectionId !== input.data.inspectionId ||
    payload.jobId !== input.data.jobId ||
    receipt.inspectionId !== payload.inspectionId ||
    receipt.jobId !== payload.jobId ||
    receipt.organizationId !== scope.organizationId ||
    receipt.applicationId !== scope.applicationId ||
    receipt.repositoryId !== scope.repositoryId ||
    receipt.inputDigest !== row.input_digest ||
    canonical(receipt.source) !== canonical(payload.source) ||
    canonical(payload.source) !== canonical(input.data.source) ||
    payload.source.baseSha !== row.base_sha ||
    payload.source.mappingRevision !== row.source_mapping_revision ||
    payload.source.mappingDigest !== row.source_mapping_digest ||
    receipt.attemptId !== row.attempt_id ||
    receipt.fence !== String(row.fence) ||
    receipt.workerHostId !== row.worker_host_id ||
    receipt.workerSessionId !== row.worker_session_id ||
    receipt.workerSessionGeneration !== String(row.worker_session_generation) ||
    payload.host.workerHostId !== row.worker_host_id ||
    row.readiness !== "eligible" || payload.readiness !== "eligible" ||
    (expected &&
      (expected.observationDigest !== row.observation_digest ||
        expected.baseSha !== row.base_sha))
  ) unavailable();
  if (
    !inspectionEvidenceIsCoherent(input.data, receipt, report.data) ||
    repositoryInspectionReadiness(input.data, report.data) !== "eligible"
  ) unavailable();
  return {
    ...pins,
    config: parsed.data,
    observationId: row.id,
    observationDigest: row.observation_digest,
    baseSha: row.base_sha,
  };
}

/**
 * False when the frozen effective rules no longer match their own digest.
 * Snapshots admitted before rule pinning carry none and stay admissible.
 */
export async function pinnedRepositoryRulesIntact(
  context: { readonly repositoryRules?: PinnedRepositoryRules },
): Promise<boolean> {
  return context.repositoryRules === undefined ||
    await verifyPinnedRepositoryRules(context.repositoryRules);
}

/** Loads immutable pins, never today's active pointer. Repository lifecycle still gates admission. */
export async function loadExecutableRepositoryProfile(
  transaction: PgTransactionClient,
  scope: RepositoryAdmissionScope,
  pins: RepositoryExecutionPins,
): Promise<AdmittedRepositoryProfile> {
  const result = await transaction.query<
    { id: string; revision: number; digest: string; config: unknown }
  >(
    `select p.id, p.revision, p.digest, p.config
       from bakery.repository_profiles p
       join bakery.repositories r on r.organization_id = p.organization_id
        and r.application_id = p.application_id and r.id = p.repository_id
       join bakery.applications a on a.organization_id = r.organization_id and a.id = r.application_id
      where p.organization_id = $1 and p.application_id = $2 and p.repository_id = $3
        and p.id = $4 and r.archived_at is null and a.archived_at is null
      for share of r, a`,
    [
      scope.organizationId,
      scope.applicationId,
      scope.repositoryId,
      pins.repositoryProfileId,
    ],
  );
  if (!result.rows[0]) unavailable();
  return await admitRepositoryProfile(transaction, scope, result.rows[0], pins);
}

export function enforceRepositoryFixedPolicy(
  profile: AdmittedRepositoryProfile | null,
  action: string,
  input: unknown,
): void {
  const policy = profile?.config.fixedPolicy;
  if (policy === undefined) return;
  const effect = REPOSITORY_FIXED_POLICY_ACTION_EFFECTS[
    action as keyof typeof REPOSITORY_FIXED_POLICY_ACTION_EFFECTS
  ];
  if (effect === undefined || !policy.allowedEffects.includes(effect)) {
    unavailable();
  }
  if (action !== "quality.check") return;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    unavailable();
  }
  const checks = (input as JsonRecord).checks;
  if (
    !Array.isArray(checks) ||
    checks.some((check) => typeof check !== "string")
  ) unavailable();
  const admittedChecks = new Set(checks as string[]);
  const fixedCommands = new Set(policy.commands.map((command) => command.id));
  if ((checks as string[]).some((commandId) => !fixedCommands.has(commandId))) {
    unavailable();
  }
  // A fixed-policy check is bound to one exact commit and reports one
  // observation per selected command: a ref or a repeated id could never
  // satisfy the server's exact-set verification. No count cap is needed here:
  // every selected id is a distinct command of the policy, and the policy
  // schema holds at most CHECK_OBSERVATION_MAX_ITEMS commands (a unit test
  // pins that bound), so a selection cannot outgrow a result.
  const revision = (input as JsonRecord).revision;
  if (
    typeof revision !== "string" || !CHECK_REVISION_PATTERN.test(revision) ||
    admittedChecks.size !== (checks as string[]).length
  ) unavailable();
  const required = policy.decisions.filter((decision) =>
    decision.mode === "require"
  ).map((decision) => decision.commandId);
  if (required.some((commandId) => !admittedChecks.has(commandId))) {
    unavailable();
  }
}

export function repositoryExecutionRequirements(
  profile: AdmittedRepositoryProfile | null,
  action: string,
  declared?: readonly string[],
): RepositoryExecutionRequirements {
  const observed = profile?.config.schemaVersion === 2
    ? profile.config.checkPolicy
    : null;
  let capabilities: readonly string[];
  try {
    capabilities = executionActionCapabilities(action, declared);
  } catch {
    unavailable();
  }
  return RepositoryExecutionRequirementsSchema.parse({
    capabilities: [
      ...new Set([
        ...capabilities,
        ...(observed?.tools.filter((tool) => tool.required).map((tool) =>
          tool.tool
        ) ?? []),
      ]),
    ],
    ...(observed ? { platform: observed.platform } : {}),
  });
}

/** Replays and claims must recheck the immutable job tuple, not trust arbitrary job JSON. */
export async function admitRepositoryExecutionJob(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
  options: { enqueue?: boolean } = {},
): Promise<{ capabilities: string[]; platform?: string }> {
  const result = await transaction.query<{
    run_id: string;
    requested_by: string | null;
    run_application_id: string | null;
    run_repository_id: string | null;
    application_id: string | null;
    repository_id: string | null;
    repository_profile_id: string | null;
    repository_profile_revision: number | null;
    repository_profile_digest: string | null;
    observation_id: string | null;
    observation_digest: string | null;
    base_sha: string | null;
    snapshot: {
      executionMode?: unknown;
      repositoryProfile?: unknown;
      stepAgents?: unknown;
    };
    task_type: string;
    step_key: string;
    step_dispatch: unknown;
    step_outputs: unknown;
    task_repository_id: string | null;
    action: string;
    input: unknown;
    requirements: unknown;
    agent_version_id: string | null;
    agent_config: unknown;
    skill_refs: unknown;
  }>(
    `select run.id as run_id, run.requested_by,
            run.application_id as run_application_id,
            run.repository_id as run_repository_id,
            job.application_id, job.repository_id, job.repository_profile_id,
            job.repository_profile_revision, job.repository_profile_digest,
            job.observation_id, job.observation_digest, job.base_sha,
            run.snapshot, task.task_type, task.repository_id as task_repository_id,
            step.step_key, step.dispatch as step_dispatch,
            coalesce(outputs.step_outputs, '{}'::jsonb) as step_outputs,
            job.action, job.input, job.requirements, job.agent_version_id,
            job.agent_config, job.skill_refs
       from bakery.jobs job
       join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
       join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
       join bakery.tasks task on task.organization_id = run.organization_id and task.id = run.task_id
       left join lateral (
         select jsonb_object_agg(previous.step_key, previous.output) as step_outputs
           from (
             select distinct on (previous.step_key)
                    previous.step_key, previous.output
               from bakery.run_steps previous
              where previous.organization_id = step.organization_id
                and previous.run_id = run.id
                and previous.output is not null
              order by previous.step_key, previous.iteration desc,
                       previous.position desc, previous.id desc
           ) previous
       ) outputs on true
      where job.organization_id = $1 and job.id = $2
        and job.application_id is not distinct from run.application_id
        and job.repository_id is not distinct from run.repository_id
        and job.repository_profile_id is not distinct from run.repository_profile_id
        and job.repository_profile_revision is not distinct from run.repository_profile_revision
        and job.repository_profile_digest is not distinct from run.repository_profile_digest
        and job.observation_id is not distinct from run.observation_id
        and job.observation_digest is not distinct from run.observation_digest
        and job.base_sha is not distinct from run.base_sha
        and (run.repository_profile_id is null or (
          run.application_id = task.application_id and run.repository_id = task.repository_id
          and run.repository_profile_id = task.repository_profile_id
          and run.repository_profile_revision = task.repository_profile_revision
          and run.repository_profile_digest = task.repository_profile_digest
          and run.observation_id is not distinct from task.observation_id
          and run.observation_digest is not distinct from task.observation_digest
          and run.base_sha is not distinct from task.base_sha))`,
    [organizationId, jobId],
  );
  const row = result.rows[0];
  if (!row || row.snapshot === null || typeof row.snapshot !== "object") {
    unavailable();
  }
  let profile: AdmittedRepositoryProfile | null = null;
  const input = row.input;
  if (
    input === null || typeof input !== "object" || Array.isArray(input) ||
    !executionJobInputFitsTransport(input)
  ) unavailable();
  let frozenAgent: FrozenStepAgent | null;
  let requiredCapabilities: readonly string[];
  try {
    const authorized = actionAndInputFromSnapshot({
      runSnapshot: row.snapshot,
      stepKey: row.step_key,
      stepDispatch: row.step_dispatch,
      stepOutputs: row.step_outputs,
      repositoryId: row.task_repository_id,
    });
    if (
      authorized.action !== row.action ||
      authorized.input === null || typeof authorized.input !== "object" ||
      Array.isArray(authorized.input) ||
      Object.hasOwn(authorized.input, "repositoryProfile") ||
      canonical(input, "repositoryProfile") !== canonical(authorized.input)
    ) unavailable();
    frozenAgent = authorized.agent;
    requiredCapabilities = authorized.requiredCapabilities;
    // Claim eligibility must leave malformed payloads to the claim-side durable
    // disposition guard, rather than silently skipping the queued row forever.
    if (options.enqueue) {
      workflowActionCapabilities(authorized.action, requiredCapabilities);
      assertActionInput(authorized.action, authorized.input);
    }
  } catch {
    unavailable();
  }
  if (
    row.agent_version_id !== (frozenAgent?.agentVersionId ?? null) ||
    canonical(row.agent_config) !== canonical(frozenAgent?.config ?? {}) ||
    canonical(row.skill_refs) !== canonical(frozenAgent?.skillRefs ?? []) ||
    (frozenAgent !== null &&
      await digest(frozenAgent.config) !== frozenAgent.digest)
  ) unavailable();
  if (row.snapshot.executionMode === "cloud_only") {
    if (
      row.task_type !== "maintenance" ||
      row.snapshot.repositoryProfile !== null ||
      row.application_id !== null || row.repository_id !== null ||
      row.repository_profile_id !== null ||
      row.repository_profile_revision !== null ||
      row.repository_profile_digest !== null ||
      row.observation_id !== null || row.observation_digest !== null ||
      row.base_sha !== null ||
      Object.hasOwn(input, "repositoryProfile") ||
      Object.hasOwn(input, "repositoryId")
    ) unavailable();
  } else {
    const context = RepositoryExecutionContextSchema.safeParse(
      row.snapshot.repositoryProfile,
    );
    if (
      row.snapshot.executionMode !== "repository" || !context.success ||
      context.data.organizationId !== organizationId ||
      context.data.applicationId !== row.application_id ||
      context.data.repositoryId !== row.repository_id ||
      context.data.id !== row.repository_profile_id ||
      context.data.revision !== row.repository_profile_revision ||
      context.data.digest !== row.repository_profile_digest ||
      context.data.observationId !== row.observation_id ||
      context.data.observationDigest !== row.observation_digest ||
      context.data.baseSha !== row.base_sha ||
      canonical(
          (input as Record<string, unknown>).repositoryProfile ?? null,
        ) !== canonical(context.data)
    ) unavailable();
    if (!(await pinnedRepositoryRulesIntact(context.data))) unavailable();
    if (
      context.data.config.fixedPolicy !== undefined &&
      context.data.fixedPolicyDigest !==
        await digest(context.data.config.fixedPolicy)
    ) unavailable();
    profile = await loadExecutableRepositoryProfile(transaction, context.data, {
      repositoryProfileId: context.data.id,
      repositoryProfileRevision: context.data.revision,
      repositoryProfileDigest: context.data.digest,
      observationId: context.data.observationId,
      observationDigest: context.data.observationDigest,
      baseSha: context.data.baseSha,
    });
    if (canonical(profile.config) !== canonical(context.data.config)) {
      unavailable();
    }
    if (
      Object.hasOwn(input, "repositoryId") &&
      (input as Record<string, unknown>).repositoryId !==
        context.data.repositoryId
    ) unavailable();
  }
  enforceRepositoryFixedPolicy(profile, row.action, input);
  await assertSecretIdentityRepositoryAdmission(transaction, {
    organizationId,
    action: row.action,
    executionMode: row.snapshot.executionMode,
    applicationId: row.run_application_id,
    repositoryId: row.run_repository_id,
    repositoryProfile: profile === null
      ? null
      : (row.input as Record<string, unknown>).repositoryProfile,
    requestedBy: row.requested_by,
    runId: row.run_id,
    secretRef: secretRefFromEffectiveInput(input),
  });
  const requirements = repositoryExecutionRequirements(
    profile,
    row.action,
    requiredCapabilities,
  );
  const stored = row.requirements;
  const persisted = RepositoryExecutionRequirementsSchema.safeParse(
    profile === null && stored !== null && typeof stored === "object" &&
      !Array.isArray(stored) &&
      !Object.hasOwn(stored, "capabilities")
      ? { ...stored, capabilities: [] }
      : stored,
  );
  if (
    !persisted.success ||
    (profile !== null &&
      requirements.capabilities.some((capability) =>
        !persisted.data.capabilities.includes(capability)
      )) ||
    (requirements.platform !== undefined &&
      persisted.data.platform !== requirements.platform)
  ) unavailable();
  assertActionAgentPolicy(
    requiredCapabilities,
    frozenAgent?.config ?? null,
  );
  if (
    options.enqueue && requiredCapabilities.includes("model") &&
    !await hasHeldJobBudgetReservation(transaction, organizationId, jobId)
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "model_funding_unavailable" },
    });
  }
  return {
    capabilities: [
      ...new Set([
        ...requirements.capabilities,
        ...persisted.data.capabilities,
      ]),
    ],
    ...((requirements.platform ?? persisted.data.platform) === undefined
      ? {}
      : { platform: requirements.platform ?? persisted.data.platform }),
  };
}
