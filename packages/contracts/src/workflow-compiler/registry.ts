import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionCapability,
  type WorkflowActionMetadata,
  type WorkflowActionName,
} from "../workflow-action-registry.ts";

const CAPABILITY_TABLE: Readonly<Record<WorkflowActionCapability, true>> =
  Object.freeze({
    model: true,
    web: true,
    paper: true,
    git: true,
    shell: true,
    browser: true,
    reviewer: true,
    integration: true,
    delivery: true,
    storage: true,
  });

/** Capability names an action may declare in `requires`. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(
  Object.keys(CAPABILITY_TABLE),
);

/** Registered action names, read-only view of the action registry. */
export const REGISTERED_ACTION_NAMES: ReadonlySet<string> = new Set(
  WORKFLOW_ACTION_NAMES,
);

/** Returns the registry metadata for a name, or undefined when unregistered. */
export function registeredActionMetadata(
  name: unknown,
): WorkflowActionMetadata | undefined {
  if (typeof name !== "string" || !REGISTERED_ACTION_NAMES.has(name)) {
    return undefined;
  }
  return WORKFLOW_ACTION_METADATA[name as WorkflowActionName];
}
