import {
  type AgentVersionCreateConfig,
  registeredWorkerActionInputSchema,
  workerActionCapabilities,
  workerActionCapabilityNames,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_REGISTRY_VERSION,
  type WorkflowActionMetadata,
} from "@bakery/contracts/workflow-action-registry";

const capabilities = new Set(workerActionCapabilityNames);

/** Immutable agent version selector shape: a UUID with version nibble 1-8. */
export const AGENT_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True only for a string that is a well-formed agent version selector. */
export function isAgentVersionSelector(value: unknown): value is string {
  return typeof value === "string" && AGENT_VERSION_ID_PATTERN.test(value);
}

/** Level that supplied a step's agent version; `none` means no level did. */
export type AgentBindingSource = "step" | "workflow" | "profile" | "none";

/**
 * The single binding precedence: step selector, then workflow `agents[action]`,
 * then repository profile `agentBindings[action]`. Pure; callers validate shape.
 */
export function selectStepAgentVersion(
  input: Readonly<{
    action: string;
    stepAgentVersionId: string | null | undefined;
    workflowAgents: Readonly<Record<string, string>> | undefined;
    profileAgentBindings: Readonly<Record<string, string>> | undefined;
  }>,
): Readonly<{ source: AgentBindingSource; agentVersionId: string | null }> {
  if (typeof input.stepAgentVersionId === "string") {
    return { source: "step", agentVersionId: input.stepAgentVersionId };
  }
  const workflow = input.workflowAgents !== undefined &&
      Object.hasOwn(input.workflowAgents, input.action)
    ? input.workflowAgents[input.action]
    : undefined;
  if (workflow !== undefined) {
    return { source: "workflow", agentVersionId: workflow };
  }
  const profile = input.profileAgentBindings !== undefined &&
      Object.hasOwn(input.profileAgentBindings, input.action)
    ? input.profileAgentBindings[input.action]
    : undefined;
  if (profile !== undefined) {
    return { source: "profile", agentVersionId: profile };
  }
  return { source: "none", agentVersionId: null };
}

function unavailable(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/** Declared requirements may add bounded capabilities, never remove registry ones. */
export function executionActionCapabilities(
  action: string,
  declared: unknown = undefined,
): readonly string[] {
  let registered: readonly string[];
  try {
    registered = workerActionCapabilities(action);
  } catch {
    return unavailable("workflow_action_unavailable");
  }
  const additional = declared ?? [];
  if (
    declared === null || !Array.isArray(additional) ||
    additional.length > 100 ||
    additional.some((value) =>
      typeof value !== "string" || !capabilities.has(value)
    ) ||
    new Set(additional).size !== additional.length
  ) unavailable("workflow_action_requirements_invalid");
  return Object.freeze([...new Set([...registered, ...additional])]);
}

/** Only existing registered operations; published workflow entries also enforce metadata identity. */
export function workflowActionCapabilities(
  action: string,
  declared?: unknown,
): readonly string[] {
  return executionActionCapabilities(action, declared);
}

export type FrozenActionBinding = Readonly<{
  action: string;
  registryVersion: number | null;
  metadata: WorkflowActionMetadata | null;
  capabilities: readonly string[];
}>;

/** Snapshot exact published metadata; existing transport-only builtins have no public registry version. */
export function workflowActionBinding(
  action: string,
  declared?: unknown,
): FrozenActionBinding {
  const required = workflowActionCapabilities(action, declared);
  const metadata =
    Object.entries(WORKFLOW_ACTION_METADATA).find(([name]) => name === action)
      ?.[1] ?? null;
  return Object.freeze({
    action,
    registryVersion: metadata === null
      ? null
      : WORKFLOW_ACTION_REGISTRY_VERSION,
    metadata,
    capabilities: required,
  });
}

/** Optional non-model agents remain supported; explicit permissions only narrow. */
export function assertActionAgentPolicy(
  required: readonly string[],
  config: AgentVersionCreateConfig | null,
): void {
  if (required.includes("model")) {
    if (config === null) unavailable("model_agent_required");
    if (config.billing === undefined) unavailable("model_billing_required");
  }
  const permissions = config?.allowedCapabilities === undefined
    ? null
    : new Set<string>(config.allowedCapabilities);
  if (
    permissions !== null &&
    required.some((capability) => !permissions.has(capability))
  ) {
    unavailable("agent_action_capability_denied");
  }
}

/** Validate resolved action input before server context is attached or a hold is acquired. */
export function assertActionInput(action: string, input: unknown): void {
  executionActionCapabilities(action);
  if (!registeredWorkerActionInputSchema(action).safeParse(input).success) {
    unavailable("workflow_action_input_invalid");
  }
}
