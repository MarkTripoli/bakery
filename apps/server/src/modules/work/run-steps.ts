import type { PgTransactionClient } from "../../platform/database.ts";
import {
  DELIVERY_GATE_STEP_KEY,
  isReviewLoopSpec,
  REVIEW_LOOP_LIMITS,
} from "@bakery/contracts/review-evidence";
import { WORKFLOW_ACTION_METADATA } from "@bakery/contracts/workflow-action-registry";
import { DELIVERY_STEP_OUTPUT_REFERENCES } from "@bakery/contracts/workflow-presets";
import { isAgentVersionSelector } from "@bakery/persistence";
import type { ReviewLoopLimits } from "@bakery/persistence/repository-admission";

export type FixedWorkflowStep = {
  key: string;
  action: string;
  input: unknown;
  position: number;
  workflowAgentVersionId: string | null;
  stepAgentVersionId: string | null;
  requires?: readonly string[];
  /** The step's `if` expression: present means it may be skipped. */
  condition?: unknown;
  /**
   * True for a step that has no row at admission and exists only when a later
   * decision appends it: the `harness.repair` step of a review and repair
   * loop. It still keeps its spec position, agent binding and budget check.
   */
  onDemand?: boolean;
};

type RecordValue = Record<string, unknown>;

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const MAX_AGENT_BINDINGS = 17;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidWorkflowVersion(cause?: unknown): Error {
  return new Error("WORKFLOW_VERSION_INVALID", { cause });
}

export class WorkflowNotFixedError extends Error {
  constructor() {
    super("WORKFLOW_NOT_FIXED");
    this.name = "WorkflowNotFixedError";
  }
}
const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const STEP_ID_SEGMENT = "[a-z][a-z0-9_]{1,63}";
const REPOSITORY_ID_REFERENCE = new RegExp(
  `^\\$(?:(?:input|task)\\.repositoryId|step\\.${STEP_ID_SEGMENT}` +
    `(?:\\.${STEP_ID_SEGMENT})*\\.repositoryId|` +
    `repeat\\.currentCandidate\\.repositoryId)(?:$|\\.)`,
);

function inputReferencesRepository(
  value: unknown,
  visited = new Set<RecordValue>(),
): boolean {
  if (typeof value === "string") return REPOSITORY_ID_REFERENCE.test(value);
  if (Array.isArray(value)) {
    return value.some((item) => inputReferencesRepository(item, visited));
  }
  if (!isRecord(value) || visited.has(value)) return false;
  visited.add(value);
  if (Object.hasOwn(value, "repositoryId")) return true;
  return Object.values(value).some((child) =>
    inputReferencesRepository(child, visited)
  );
}

function inspectParallel(
  parallel: RecordValue,
  path: readonly (string | number)[],
): boolean {
  const branches = parallel.branches;
  if (!Array.isArray(branches) || branches.length === 0) {
    throw invalidWorkflowVersion();
  }
  let repositoryRequired = Object.hasOwn(parallel, "repository") ||
    Object.hasOwn(parallel, "repositoryId") ||
    inputReferencesRepository(parallel.with) ||
    inputReferencesRepository(parallel.input);
  for (const [index, lane] of branches.entries()) {
    const lanePath = [...path, "branches", index];
    if (!isRecord(lane)) {
      throw invalidWorkflowVersion();
    }
    if (
      Object.hasOwn(lane, "repository") ||
      Object.hasOwn(lane, "repositoryId") ||
      inputReferencesRepository(lane.with) ||
      inputReferencesRepository(lane.input)
    ) {
      repositoryRequired = true;
    }
    if (inspectNodeSequence(lane.steps, [...lanePath, "steps"])) {
      repositoryRequired = true;
    }
  }
  return repositoryRequired;
}

function inspectNodeSequence(
  value: unknown,
  path: readonly (string | number)[],
): boolean {
  if (!Array.isArray(value)) {
    throw invalidWorkflowVersion();
  }
  let repositoryRequired = false;
  for (const [index, step] of value.entries()) {
    const stepPath = [...path, index];
    if (!isRecord(step)) {
      throw invalidWorkflowVersion();
    }
    if (stepRequiresRepository(step, stepPath)) {
      repositoryRequired = true;
    }
  }
  return repositoryRequired;
}

/**
 * Repeat seeds are execution state, not opaque metadata: any own
 * repositoryId field requires repository scope, matching with/input handling.
 */
function typedSeedReferencesRepository(value: unknown): boolean {
  if (typeof value === "string") return REPOSITORY_ID_REFERENCE.test(value);
  if (Array.isArray(value)) {
    return value.some((item) => typedSeedReferencesRepository(item));
  }
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "repositoryId")) return true;
  return Object.values(value).some((child) =>
    typedSeedReferencesRepository(child)
  );
}

function repeatSeedRequiresRepository(
  repeat: RecordValue,
  path: readonly (string | number)[],
): boolean {
  if (!Object.hasOwn(repeat, "seed")) return false;
  if (!isRecord(repeat.seed)) {
    throw invalidWorkflowVersion();
  }
  const seed = repeat.seed;
  if (!Object.hasOwn(seed, "steps")) {
    return typedSeedReferencesRepository(seed);
  }
  if (!Array.isArray(seed.steps) || seed.steps.length === 0) {
    throw invalidWorkflowVersion();
  }
  if (!Object.hasOwn(seed, "outputs") || !isRecord(seed.outputs)) {
    throw invalidWorkflowVersion();
  }
  let repositoryRequired = typedSeedReferencesRepository(seed);
  if (
    inspectNodeSequence(seed.steps, [...path, "repeat", "seed", "steps"])
  ) {
    repositoryRequired = true;
  }
  if (typedSeedReferencesRepository(seed.outputs)) {
    repositoryRequired = true;
  }
  return repositoryRequired;
}

function stepRequiresRepository(
  value: unknown,
  path: readonly (string | number)[],
): boolean {
  if (!isRecord(value)) return false;
  const registration = Object.entries(WORKFLOW_ACTION_METADATA).find(([name]) =>
    name === value.uses
  )?.[1];
  let repositoryRequired = registration?.capabilities.includes("git") ?? false;
  if (Object.hasOwn(value, "requires")) {
    const requires = value.requires;
    if (!Array.isArray(requires)) {
      throw invalidWorkflowVersion();
    }
    for (const requirement of requires) {
      if (typeof requirement !== "string" || requirement.trim() === "") {
        throw invalidWorkflowVersion();
      }
      if (requirement.trim() === "git") repositoryRequired = true;
    }
  }
  if (Object.hasOwn(value, "repository")) repositoryRequired = true;
  if (
    inputReferencesRepository(value.with) ||
    inputReferencesRepository(value.input)
  ) {
    repositoryRequired = true;
  }

  if (Object.hasOwn(value, "repeat")) {
    const repeat = value.repeat;
    if (!isRecord(repeat)) {
      throw invalidWorkflowVersion();
    }
    if (repeatSeedRequiresRepository(repeat, path)) {
      repositoryRequired = true;
    }
    if (
      inspectNodeSequence(
        repeat.steps,
        [...path, "repeat", "steps"],
      )
    ) {
      repositoryRequired = true;
    }
  }

  if (Object.hasOwn(value, "parallel")) {
    const parallel = value.parallel;
    if (!isRecord(parallel)) {
      throw invalidWorkflowVersion();
    }
    if (
      inspectParallel(
        parallel,
        [...path, "parallel"],
      )
    ) {
      repositoryRequired = true;
    }
  }

  if (Object.hasOwn(value, "branch")) {
    const branch = value.branch;
    if (!isRecord(branch)) {
      throw invalidWorkflowVersion();
    }
    if (
      inspectNodeSequence(
        branch.then,
        [...path, "branch", "then"],
      )
    ) {
      repositoryRequired = true;
    }
    if (Object.hasOwn(branch, "else")) {
      if (
        inspectNodeSequence(
          branch.else,
          [...path, "branch", "else"],
        )
      ) {
        repositoryRequired = true;
      }
    }
  }

  if (Object.hasOwn(value, "steps")) {
    if (inspectNodeSequence(value.steps, [...path, "steps"])) {
      repositoryRequired = true;
    }
  }
  return repositoryRequired;
}

function inspectWorkflowRequirements(normalizedSpec: unknown): boolean {
  if (!isRecord(normalizedSpec)) {
    throw invalidWorkflowVersion();
  }
  if (!Array.isArray(normalizedSpec.steps)) return false;
  let repositoryRequired = false;
  for (const [index, step] of normalizedSpec.steps.entries()) {
    if (stepRequiresRepository(step, ["steps", index])) {
      repositoryRequired = true;
    }
  }
  return repositoryRequired;
}

export function workflowRequiresRepository(normalizedSpec: unknown): boolean {
  return inspectWorkflowRequirements(normalizedSpec);
}

/**
 * Extracts the stable, top-level nodes used by the fixed workflow executor.
 * The normalized producer owns all semantic validation; admission still
 * validates the immutable boundary so malformed fixtures cannot create steps.
 */
export function extractFixedWorkflowSteps(
  normalizedSpec: unknown,
  profileWorkflowKind?: unknown,
): readonly FixedWorkflowStep[] {
  if (!isRecord(normalizedSpec)) {
    throw invalidWorkflowVersion();
  }
  inspectWorkflowRequirements(normalizedSpec);
  const workflow = normalizedSpec.workflow;
  if (workflow !== undefined && !isRecord(workflow)) {
    throw invalidWorkflowVersion();
  }
  const workflowKind = isRecord(workflow) ? workflow.kind : undefined;
  const documentKind = normalizedSpec.kind;
  const explicitExecutionKinds = [
    workflowKind,
    documentKind !== undefined && documentKind !== "workflow"
      ? documentKind
      : undefined,
  ].filter((kind): kind is unknown => kind !== undefined);
  if (
    explicitExecutionKinds.some((kind) => typeof kind !== "string") ||
    (profileWorkflowKind !== undefined &&
      typeof profileWorkflowKind !== "string")
  ) {
    throw invalidWorkflowVersion();
  }
  if (
    explicitExecutionKinds.some((kind) => kind !== "fixed") ||
    (profileWorkflowKind !== undefined && profileWorkflowKind !== "fixed")
  ) {
    throw new WorkflowNotFixedError();
  }
  const fixed = documentKind === "workflow"
    ? profileWorkflowKind === undefined || profileWorkflowKind === "fixed"
    : explicitExecutionKinds.includes("fixed");
  if (!fixed) {
    throw invalidWorkflowVersion();
  }
  const steps = normalizedSpec.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 100) {
    throw invalidWorkflowVersion();
  }
  const workflowAgentsValue = normalizedSpec.agents;
  if (
    workflowAgentsValue !== undefined && !isRecord(workflowAgentsValue)
  ) {
    throw invalidWorkflowVersion();
  }
  const workflowAgents = workflowAgentsValue as RecordValue | undefined;
  if (
    workflowAgents && Object.keys(workflowAgents).length > MAX_AGENT_BINDINGS
  ) {
    throw invalidWorkflowVersion();
  }
  for (const [action, agentVersionId] of Object.entries(workflowAgents ?? {})) {
    if (
      !ACTION_NAME_PATTERN.test(action) ||
      !isAgentVersionSelector(agentVersionId)
    ) {
      throw invalidWorkflowVersion();
    }
  }

  const reviewLoop = isReviewLoopSpec(normalizedSpec);
  const seen = new Set<string>();
  const extracted: FixedWorkflowStep[] = [];
  for (const [index, candidate] of steps.entries()) {
    if (!isRecord(candidate)) {
      throw invalidWorkflowVersion();
    }
    const id = candidate.id;
    const action = candidate.uses;
    if (
      typeof id !== "string" || !STEP_ID_PATTERN.test(id) ||
      typeof action !== "string" || !ACTION_NAME_PATTERN.test(action) ||
      (Object.hasOwn(candidate, "agentVersionId") &&
        !isAgentVersionSelector(candidate.agentVersionId))
    ) {
      throw invalidWorkflowVersion();
    }
    // The pre-failed gate step that records a stopped loop owns this key.
    if (seen.has(id) || id === DELIVERY_GATE_STEP_KEY) {
      throw invalidWorkflowVersion();
    }
    seen.add(id);
    if (
      candidate.requires !== undefined &&
      (!Array.isArray(candidate.requires) ||
        candidate.requires.some((value) => typeof value !== "string"))
    ) throw invalidWorkflowVersion();
    const input = candidate.with ?? candidate.input ?? {};
    extracted.push({
      ...(candidate.requires === undefined
        ? {}
        : { requires: candidate.requires }),
      ...(candidate.if === undefined ? {} : { condition: candidate.if }),
      ...(reviewLoop && action === "harness.repair" ? { onDemand: true } : {}),
      key: id,
      action,
      input,
      position: index,
      workflowAgentVersionId: typeof workflowAgents?.[action] === "string"
        ? workflowAgents[action]
        : null,
      stepAgentVersionId: isAgentVersionSelector(candidate.agentVersionId)
        ? candidate.agentVersionId
        : null,
    });
  }
  return extracted;
}

/**
 * True when the step input reads a value that does not exist before an earlier
 * step has recorded its output: a `$step.` reference, or a `$delivery.`
 * reference that reads step outputs. Strict preset admission resolves every
 * step with no outputs and measures such a step from its literal input plus an
 * allowance instead of failing. `$delivery.checkIds` is absent on purpose: the
 * pinned profile resolves it with no outputs at all. A misspelled `$delivery.`
 * name matches nothing here, so it still fails admission loudly.
 */
export function stepReferencesEarlierOutput(
  step: Pick<FixedWorkflowStep, "input">,
): boolean {
  const encoded = JSON.stringify(step.input ?? null);
  return encoded.includes('"$step.') ||
    DELIVERY_STEP_OUTPUT_REFERENCES.some((reference) =>
      encoded.includes(`"${reference}"`)
    );
}

/**
 * The review and repair bounds to freeze into a run snapshot, or `null` when
 * the spec has no such loop. The server default applies unless the workflow
 * sets `limits.maxRepairCycles`, which may lower or choose the count within
 * the contract ceiling; a value outside that range invalidates the workflow.
 */
export function reviewLoopLimitsFor(
  normalizedSpec: unknown,
): ReviewLoopLimits | null {
  if (!isReviewLoopSpec(normalizedSpec)) return null;
  const limits = isRecord(normalizedSpec) && isRecord(normalizedSpec.limits)
    ? normalizedSpec.limits
    : undefined;
  let maxRepairCycles: number = REVIEW_LOOP_LIMITS.maxRepairCycles;
  if (limits !== undefined && Object.hasOwn(limits, "maxRepairCycles")) {
    const requested = limits.maxRepairCycles;
    if (
      typeof requested !== "number" || !Number.isInteger(requested) ||
      requested < 0 || requested > REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling
    ) throw invalidWorkflowVersion();
    maxRepairCycles = requested;
  }
  return {
    maxRepairCycles,
    maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
    maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
  };
}

export async function insertRunSteps(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    runId: string;
    steps: readonly FixedWorkflowStep[];
  },
): Promise<void> {
  const parameters: unknown[] = [options.organizationId, options.runId];
  const values: string[] = [];
  // An on-demand step has no row until a decision appends it, but its spec
  // position is the array index, so the rows that exist keep their order.
  for (const step of options.steps) {
    if (step.onDemand === true) continue;
    let encodedInput: string;
    try {
      encodedInput = JSON.stringify(step.input);
    } catch (error) {
      throw invalidWorkflowVersion(error);
    }
    if (encodedInput === undefined) {
      throw invalidWorkflowVersion();
    }
    parameters.push(step.key);
    const keyParameter = parameters.length;
    parameters.push(step.position);
    const positionParameter = parameters.length;
    parameters.push(encodedInput);
    const inputParameter = parameters.length;
    values.push(
      `($1, $2, $${keyParameter}, $${positionParameter}, 0, 'pending', ` +
        `$${inputParameter}::jsonb)`,
    );
  }
  if (values.length === 0) return;
  await transaction.query(
    `insert into bakery.run_steps (
       organization_id, run_id, step_key, position, iteration, status, input
     ) values ${values.join(", ")}`,
    parameters,
  );
}
