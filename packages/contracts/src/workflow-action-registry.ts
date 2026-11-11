export const WORKFLOW_ACTION_REGISTRY_VERSION = 1 as const;

export const WORKFLOW_ACTION_NAMES = Object.freeze(
  [
    "rpi.research",
    "rpi.design",
    "rpi.plan",
    "harness.implement",
    "harness.repair",
    "quality.check",
    "review.independent",
    "integration.action",
    "delivery.candidate_evidence",
    "delivery.prepare",
    "delivery.merge",
    "delivery.deploy",
    "delivery.health",
    "agent.freeform",
    "workflow.noop",
    "artifact.publish",
    "memory.promote",
    "evaluation.sample",
    "task.brief",
  ] as const,
);

export type WorkflowActionName = typeof WORKFLOW_ACTION_NAMES[number];
export type WorkflowActionCapability =
  | "model"
  | "web"
  | "paper"
  | "git"
  | "shell"
  | "browser"
  | "reviewer"
  | "integration"
  | "delivery"
  | "storage";
export type WorkflowActionCancellation =
  | "immediate"
  | "cooperative"
  | "cooperative_fenced";
export type WorkflowActionRetryFault =
  | "DEPENDENCY_TIMEOUT"
  | "DEPENDENCY_UNAVAILABLE"
  | "WORKER_UNAVAILABLE"
  | "REVIEWER_UNAVAILABLE";
export type WorkflowActionEffectPolicy =
  | "artifact_only"
  | "repository_revision"
  | "evidence_only"
  | "review_evidence"
  | "external_effect_keyed_reconcile"
  | "projection_only"
  | "external_prepare"
  | "external_effect_keyed"
  | "none"
  | "memory_write"
  | "evaluation_write";

export interface WorkflowActionMetadata {
  readonly input: string;
  readonly output: string;
  readonly capabilities: readonly WorkflowActionCapability[];
  readonly cancel: WorkflowActionCancellation;
  readonly retry: Readonly<{
    maxAttempts: number;
    backoff: "0s" | "30s" | "1m";
    faults: readonly WorkflowActionRetryFault[];
  }>;
  readonly effectPolicy: WorkflowActionEffectPolicy;
}

function metadata(
  value: WorkflowActionMetadata,
): WorkflowActionMetadata {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    retry: Object.freeze({
      ...value.retry,
      faults: Object.freeze([...value.retry.faults]),
    }),
  });
}

export const WORKFLOW_ACTION_METADATA = Object.freeze(
  {
    "rpi.research": metadata({
      input: "ResearchInput",
      output: "ResearchOutput",
      capabilities: ["model", "web"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 2,
        backoff: "30s",
        faults: ["DEPENDENCY_TIMEOUT", "DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "artifact_only",
    }),
    "rpi.design": metadata({
      input: "DesignInput",
      output: "ArtifactOutput",
      capabilities: ["model", "paper"],
      cancel: "cooperative",
      retry: { maxAttempts: 2, backoff: "30s", faults: ["DEPENDENCY_TIMEOUT"] },
      effectPolicy: "artifact_only",
    }),
    "rpi.plan": metadata({
      input: "PlanInput",
      output: "ArtifactOutput",
      capabilities: ["model"],
      cancel: "cooperative",
      retry: { maxAttempts: 2, backoff: "30s", faults: ["DEPENDENCY_TIMEOUT"] },
      effectPolicy: "artifact_only",
    }),
    "harness.implement": metadata({
      input: "ImplementInput",
      output: "HarnessOutput",
      capabilities: ["git", "shell", "web", "model"],
      cancel: "cooperative_fenced",
      retry: { maxAttempts: 1, backoff: "0s", faults: ["WORKER_UNAVAILABLE"] },
      effectPolicy: "repository_revision",
    }),
    "harness.repair": metadata({
      input: "RepairInput",
      output: "HarnessOutput",
      capabilities: ["git", "shell", "model"],
      cancel: "cooperative_fenced",
      retry: { maxAttempts: 1, backoff: "0s", faults: ["WORKER_UNAVAILABLE"] },
      effectPolicy: "repository_revision",
    }),
    "quality.check": metadata({
      input: "CheckInput",
      output: "CheckOutput",
      capabilities: ["git", "shell", "browser"],
      cancel: "cooperative_fenced",
      retry: {
        maxAttempts: 2,
        backoff: "30s",
        faults: ["WORKER_UNAVAILABLE", "DEPENDENCY_TIMEOUT"],
      },
      effectPolicy: "evidence_only",
    }),
    "review.independent": metadata({
      input: "ReviewInput",
      output: "ReviewOutput",
      capabilities: ["model", "reviewer"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["REVIEWER_UNAVAILABLE"],
      },
      effectPolicy: "review_evidence",
    }),
    "integration.action": metadata({
      input: "IntegrationActionInput",
      output: "IntegrationActionOutput",
      capabilities: ["integration"],
      cancel: "cooperative_fenced",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "external_effect_keyed_reconcile",
    }),
    "delivery.candidate_evidence": metadata({
      input: "CandidateEvidence",
      output: "CandidateEvidence",
      capabilities: [],
      cancel: "immediate",
      retry: { maxAttempts: 1, backoff: "0s", faults: [] },
      effectPolicy: "projection_only",
    }),
    "delivery.prepare": metadata({
      input: "PrepareInput",
      output: "PrepareOutput",
      capabilities: ["delivery"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "external_prepare",
    }),
    "delivery.merge": metadata({
      input: "MergeInput",
      output: "MergeOutput",
      capabilities: ["delivery"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "external_effect_keyed",
    }),
    "delivery.deploy": metadata({
      input: "DeployInput",
      output: "DeployOutput",
      capabilities: ["delivery"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "external_effect_keyed_reconcile",
    }),
    "delivery.health": metadata({
      input: "HealthInput",
      output: "HealthOutput",
      capabilities: ["delivery"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 3,
        backoff: "1m",
        faults: ["DEPENDENCY_TIMEOUT", "DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "evidence_only",
    }),
    "agent.freeform": metadata({
      input: "FreeformInput",
      output: "FreeformOutput",
      capabilities: ["model"],
      cancel: "cooperative_fenced",
      retry: { maxAttempts: 1, backoff: "0s", faults: ["WORKER_UNAVAILABLE"] },
      effectPolicy: "artifact_only",
    }),
    "workflow.noop": metadata({
      input: "EmptyInput",
      output: "EmptyOutput",
      capabilities: [],
      cancel: "immediate",
      retry: { maxAttempts: 1, backoff: "0s", faults: [] },
      effectPolicy: "none",
    }),
    "artifact.publish": metadata({
      input: "ArtifactPublishInput",
      output: "ArtifactOutput",
      capabilities: ["storage"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 2,
        backoff: "30s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "artifact_only",
    }),
    "memory.promote": metadata({
      input: "MemoryPromoteInput",
      output: "MemoryOutput",
      capabilities: ["storage"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "memory_write",
    }),
    "evaluation.sample": metadata({
      input: "EvaluationInput",
      output: "EvaluationOutput",
      capabilities: ["model", "storage"],
      cancel: "cooperative",
      retry: {
        maxAttempts: 1,
        backoff: "0s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "evaluation_write",
    }),
    "task.brief": metadata({
      input: "TaskBriefInput",
      output: "ArtifactOutput",
      capabilities: [],
      cancel: "immediate",
      retry: {
        maxAttempts: 3,
        backoff: "30s",
        faults: ["DEPENDENCY_UNAVAILABLE"],
      },
      effectPolicy: "artifact_only",
    }),
  } satisfies Record<WorkflowActionName, WorkflowActionMetadata>,
);

export type WorkflowActionHandler = (
  input: unknown,
) => unknown | Promise<unknown>;

export interface WorkflowActionHandlerDeclaration {
  readonly action: WorkflowActionName;
  readonly version: typeof WORKFLOW_ACTION_REGISTRY_VERSION;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly handle: WorkflowActionHandler;
}

export interface WorkflowActionRegistration {
  readonly action: WorkflowActionName;
  readonly version: typeof WORKFLOW_ACTION_REGISTRY_VERSION;
  readonly metadata: WorkflowActionMetadata;
  readonly handler: WorkflowActionHandlerDeclaration;
}

export interface RegisteredWorkflowAction extends WorkflowActionRegistration {
  readonly metadata: WorkflowActionMetadata;
  readonly handler: Readonly<WorkflowActionHandlerDeclaration>;
}

export class WorkflowActionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowActionRegistryError";
  }
}

const registrationKeys = Object.freeze([
  "action",
  "handler",
  "metadata",
  "version",
]);
const handlerKeys = Object.freeze([
  "action",
  "handle",
  "inputSchema",
  "outputSchema",
  "version",
]);
const metadataKeys = Object.freeze([
  "cancel",
  "capabilities",
  "effectPolicy",
  "input",
  "output",
  "retry",
]);
const retryKeys = Object.freeze(["backoff", "faults", "maxAttempts"]);
const workflowActionNames = new Set<string>(WORKFLOW_ACTION_NAMES);

/** Existing worker implementations must agree with published action contracts. */
export function assertWorkflowWorkerContract(
  action: string,
  contract: Readonly<{
    inputSchema?: unknown;
    outputSchema?: unknown;
    capabilities?: unknown;
  }>,
): void {
  const published = Object.entries(WORKFLOW_ACTION_METADATA).find(([name]) =>
    name === action
  )?.[1];
  // Worker-only control actions have their own typed transport contracts.
  if (!published) return;
  if (
    contract.inputSchema !== published.input ||
    contract.outputSchema !== published.output ||
    !equalArray(contract.capabilities, published.capabilities)
  ) {
    throw new WorkflowActionRegistryError(
      "Worker contract does not match published action metadata",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

function equalArray(left: unknown, right: readonly unknown[]): boolean {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function metadataMatches(
  value: unknown,
  expected: WorkflowActionMetadata,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, metadataKeys)) return false;
  const retry = value.retry;
  return value.input === expected.input && value.output === expected.output &&
    value.cancel === expected.cancel &&
    value.effectPolicy === expected.effectPolicy &&
    equalArray(value.capabilities, expected.capabilities) && isRecord(retry) &&
    hasExactKeys(retry, retryKeys) &&
    retry.maxAttempts === expected.retry.maxAttempts &&
    retry.backoff === expected.retry.backoff &&
    equalArray(retry.faults, expected.retry.faults);
}

export class WorkflowActionRegistry {
  readonly #registrations = new Map<
    WorkflowActionName,
    RegisteredWorkflowAction
  >();

  register(registration: WorkflowActionRegistration): this {
    if (
      !isRecord(registration) || !hasExactKeys(registration, registrationKeys)
    ) {
      throw new WorkflowActionRegistryError(
        "workflow action registration has unknown or missing fields",
      );
    }
    const action = registration.action;
    if (typeof action !== "string" || !workflowActionNames.has(action)) {
      throw new WorkflowActionRegistryError(
        `unknown workflow action: ${String(action)}`,
      );
    }
    const name = action as WorkflowActionName;
    if (this.#registrations.has(name)) {
      throw new WorkflowActionRegistryError(
        `duplicate workflow action registration: ${name}`,
      );
    }
    if (registration.version !== WORKFLOW_ACTION_REGISTRY_VERSION) {
      throw new WorkflowActionRegistryError(
        `workflow action ${name} registry version mismatch`,
      );
    }
    const expected = WORKFLOW_ACTION_METADATA[name];
    if (!metadataMatches(registration.metadata, expected)) {
      throw new WorkflowActionRegistryError(
        `workflow action ${name} metadata mismatch`,
      );
    }
    const handler = registration.handler;
    if (
      !isRecord(handler) || !hasExactKeys(handler, handlerKeys) ||
      handler.action !== name || handler.version !== registration.version ||
      handler.inputSchema !== expected.input ||
      handler.outputSchema !== expected.output ||
      typeof handler.handle !== "function"
    ) {
      throw new WorkflowActionRegistryError(
        `workflow action ${name} handler declaration mismatch`,
      );
    }
    const registered = Object.freeze({
      action: name,
      version: WORKFLOW_ACTION_REGISTRY_VERSION,
      metadata: expected,
      handler: Object.freeze({ ...handler }),
    });
    this.#registrations.set(name, registered);
    return this;
  }

  get(name: string): RegisteredWorkflowAction {
    const registration = this.#registrations.get(name as WorkflowActionName);
    if (!registration) {
      throw new WorkflowActionRegistryError(
        `workflow action is unavailable: ${name}`,
      );
    }
    return registration;
  }

  list(): readonly RegisteredWorkflowAction[] {
    return Object.freeze([...this.#registrations.values()]);
  }
}
