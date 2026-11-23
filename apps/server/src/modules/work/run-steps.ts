import type { PgTransactionClient } from "../../platform/database.ts";
import {
  DELIVERY_GATE_STEP_KEY,
  isReviewLoopSpec,
  REVIEW_LOOP_LIMITS,
} from "@bakery/contracts/review-evidence";
import {
  isEngineProjectionAction,
  WORKFLOW_ACTION_METADATA,
} from "@bakery/contracts/workflow-action-registry";
import { DELIVERY_STEP_OUTPUT_REFERENCES } from "@bakery/contracts/workflow-presets";
import { isAgentVersionSelector } from "@bakery/persistence";
import type { ReviewLoopLimits } from "@bakery/persistence/repository-admission";
import {
  deriveWorkspaceRequirement,
  WorkspaceDeclarationError,
  type WorkspaceRequirement,
} from "@bakery/contracts/scope-profiles";

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
  /**
   * The bounded repeat this step sits in, when a preset's compiled plan puts it
   * in one: the repeat node's id and its most iterations. Only a preset's plan
   * reports it, so a library page can draw the repair loop as one block.
   */
  repeat?: { id: string; max: number };
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

/**
 * A compiler-grammar version whose plan has container nodes (sequence, branch,
 * repeat, parallel, forEach, wait). It is valid and publishable, but the fixed executor
 * runs a flat list of actions and cannot run it until plans execute.
 */
export class WorkflowNotExecutableError extends Error {
  constructor() {
    super("WORKFLOW_NOT_EXECUTABLE");
    this.name = "WorkflowNotExecutableError";
  }
}
/** Keys that make a compiler-grammar node a container rather than an action. */
const CONTAINER_NODE_KEYS: readonly string[] = [
  "steps",
  "branch",
  "repeat",
  "parallel",
  "forEach",
  "wait",
];

function isContainerNode(node: unknown): boolean {
  return isRecord(node) && !Object.hasOwn(node, "uses") &&
    CONTAINER_NODE_KEYS.some((key) => Object.hasOwn(node, key));
}

const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const STEP_ID_SEGMENT = "[a-z][a-z0-9_]{1,63}";
const REPOSITORY_ID_REFERENCE = new RegExp(
  `^\\$(?:(?:input|task)\\.repositoryId|step\\.${STEP_ID_SEGMENT}` +
    `(?:\\.${STEP_ID_SEGMENT})*\\.repositoryId|` +
    `repeat\\.currentCandidate\\.repositoryId|` +
    `each\\.[a-z][A-Za-z0-9]{0,63}\\.repositoryId)(?:$|\\.)`,
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

function assertStepSequence(value: unknown): void {
  if (!Array.isArray(value)) throw invalidWorkflowVersion();
  for (const step of value) {
    if (!isRecord(step)) throw invalidWorkflowVersion();
  }
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

function repeatSeedNeedsRepository(repeat: RecordValue): boolean {
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
  assertStepSequence(seed.steps);
  if (!Object.hasOwn(seed, "outputs") || !isRecord(seed.outputs)) {
    throw invalidWorkflowVersion();
  }
  return typedSeedReferencesRepository(seed) ||
    typedSeedReferencesRepository(seed.outputs);
}

function containerNamesRepository(value: RecordValue): boolean {
  return Object.hasOwn(value, "repository") ||
    Object.hasOwn(value, "repositoryId") ||
    inputReferencesRepository(value.with) ||
    inputReferencesRepository(value.input);
}

function parallelNeedsRepository(parallel: RecordValue): boolean {
  const branches = parallel.branches;
  if (!Array.isArray(branches) || branches.length === 0) {
    throw invalidWorkflowVersion();
  }
  let repositoryRequired = containerNamesRepository(parallel);
  for (const lane of branches) {
    if (!isRecord(lane)) {
      throw invalidWorkflowVersion();
    }
    if (containerNamesRepository(lane)) repositoryRequired = true;
    assertStepSequence(lane.steps);
  }
  return repositoryRequired;
}

/**
 * The software-delivery pack's answer for one step: true when its action
 * declares the `git` capability, it requires `git`, names a repository, or
 * reads a repository id from its inputs, a repeat seed, a forEach's items or a
 * parallel lane. It
 * also refuses container shapes the producer would never emit. The kernel's
 * `deriveWorkspaceRequirement` walks the nesting and calls this once per step,
 * so admission has one derivation of what a run needs.
 */
function stepNeedsRepository(value: RecordValue): boolean {
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
    if (repeatSeedNeedsRepository(repeat)) repositoryRequired = true;
    assertStepSequence(repeat.steps);
  }
  if (Object.hasOwn(value, "forEach")) {
    const loop = value.forEach;
    if (!isRecord(loop)) {
      throw invalidWorkflowVersion();
    }
    if (inputReferencesRepository(loop.items)) repositoryRequired = true;
    assertStepSequence(loop.steps);
  }
  if (Object.hasOwn(value, "parallel")) {
    const parallel = value.parallel;
    if (!isRecord(parallel)) {
      throw invalidWorkflowVersion();
    }
    if (parallelNeedsRepository(parallel)) repositoryRequired = true;
  }
  if (Object.hasOwn(value, "branch")) {
    const branch = value.branch;
    if (!isRecord(branch)) {
      throw invalidWorkflowVersion();
    }
    assertStepSequence(branch.then);
    if (Object.hasOwn(branch, "else")) assertStepSequence(branch.else);
  }
  if (Object.hasOwn(value, "steps")) assertStepSequence(value.steps);
  return repositoryRequired;
}

/**
 * The workspaces a workflow version's steps need (O23), derived once for
 * admission, automations and validation alike. A run whose steps need no
 * repository runs without one.
 */
export function deriveRunWorkspaceRequirement(
  normalizedSpec: unknown,
): WorkspaceRequirement {
  if (!isRecord(normalizedSpec)) {
    throw invalidWorkflowVersion();
  }
  const steps = Array.isArray(normalizedSpec.steps) ? normalizedSpec.steps : [];
  try {
    return deriveWorkspaceRequirement(steps, {
      stepRequiresWorkspace: stepNeedsRepository,
    });
  } catch (error) {
    if (error instanceof WorkspaceDeclarationError) {
      throw invalidWorkflowVersion(error);
    }
    throw error;
  }
}

export function workflowRequiresRepository(normalizedSpec: unknown): boolean {
  return deriveRunWorkspaceRequirement(normalizedSpec).required;
}

/**
 * Extracts the stable, top-level nodes used by the fixed workflow executor.
 * The normalized producer owns all semantic validation; admission still
 * validates the immutable boundary so malformed fixtures cannot create steps.
 */
function namesProjection(step: unknown): boolean {
  return isRecord(step) && typeof step.uses === "string" &&
    isEngineProjectionAction(step.uses);
}

export function extractFixedWorkflowSteps(
  normalizedSpec: unknown,
  profileWorkflowKind?: unknown,
): readonly FixedWorkflowStep[] {
  if (!isRecord(normalizedSpec)) {
    throw invalidWorkflowVersion();
  }
  deriveRunWorkspaceRequirement(normalizedSpec);
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
  // A compiler-grammar version may carry container nodes. They validate and
  // publish, but this executor runs a flat list of actions, so name that limit
  // instead of failing as a corrupt version. A document without apiVersion
  // never has them: the flat validator refuses them at publish.
  // The same holds for a step whose action the engine completes itself (a
  // projection): there is no job for the fixed executor to run.
  if (
    Object.hasOwn(normalizedSpec, "apiVersion") &&
    steps.some((step) => isContainerNode(step) || namesProjection(step))
  ) {
    throw new WorkflowNotExecutableError();
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
    // A projection has no worker, and the fixed executor only runs jobs. A
    // compiler-grammar document that names one never gets here (it is routed to
    // the engine above); a legacy flat spec cannot name one.
    if (isEngineProjectionAction(action)) throw invalidWorkflowVersion();
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
