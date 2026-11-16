import {
  type AgentVersionCreateConfig,
  contractSchemas,
  registeredWorkerActionInputSchema,
  UnknownWorkerActionError,
  workerActionCapabilities,
  workerActionCapabilityNames,
  WorkerActionContractError,
  workerContractFaultCode,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  isEngineProjectionAction,
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
  if (isEngineProjectionAction(action)) {
    // No host runs it: the engine completes it, so it needs no capability and
    // takes no declared one.
    registered = WORKFLOW_ACTION_METADATA[
      action as keyof typeof WORKFLOW_ACTION_METADATA
    ].capabilities;
    if (
      Array.isArray(declared) ? declared.length > 0 : declared !== undefined
    ) {
      return unavailable("workflow_action_requirements_invalid");
    }
  } else {
    try {
      registered = workerActionCapabilities(action);
    } catch (error) {
      if (error instanceof UnknownWorkerActionError) {
        return unavailable("workflow_action_unavailable");
      }
      // A contract defect is not "unavailable": nothing will fix it by retrying.
      if (error instanceof WorkerActionContractError) {
        throw new StandardError({
          code: workerContractFaultCode(error.defect),
        });
      }
      throw error;
    }
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

/**
 * The output the engine records for a projection action: its input, once it
 * validates as the action's own input and output shape. Any other action has no
 * projection, and an input that is not the action's shape is refused, so the
 * engine never writes an output nobody checked.
 */
export function projectionOutputOf(action: string, input: unknown): unknown {
  if (!isEngineProjectionAction(action)) {
    return unavailable("workflow_action_unavailable");
  }
  const { input: inputName, output: outputName } = WORKFLOW_ACTION_METADATA[
    action as keyof typeof WORKFLOW_ACTION_METADATA
  ];
  const schemas = contractSchemas as unknown as Record<
    string,
    { safeParse(value: unknown): { success: boolean } } | undefined
  >;
  const inputSchema = schemas[inputName];
  const outputSchema = schemas[outputName];
  if (inputSchema === undefined || outputSchema === undefined) {
    return unavailable("workflow_action_unavailable");
  }
  if (!inputSchema.safeParse(input).success) {
    return unavailable("workflow_action_input_invalid");
  }
  if (!outputSchema.safeParse(input).success) {
    return unavailable("workflow_action_input_invalid");
  }
  return input;
}

/** Validate resolved action input before server context is attached or a hold is acquired. */
export function assertActionInput(action: string, input: unknown): void {
  executionActionCapabilities(action);
  if (!registeredWorkerActionInputSchema(action).safeParse(input).success) {
    unavailable("workflow_action_input_invalid");
  }
}
