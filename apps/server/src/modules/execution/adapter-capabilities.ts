/** Run control actions an operator may request. */
export type AdapterControlAction = "pause" | "resume" | "cancel" | "interrupt";

/** Message steering modes a session accepts. */
export type SteeringMode = "steer" | "follow_up";

/**
 * Whether the worker session's advertised adapter capabilities allow the
 * action. Cancel is always allowed: Bakery fences and ends the attempt itself.
 * Pause and interrupt need steer or interrupt; resume needs follow_up or resume.
 */
export function adapterSupportsControl(
  action: AdapterControlAction,
  capabilities: readonly string[],
): boolean {
  switch (action) {
    case "cancel":
      return true;
    case "pause":
    case "interrupt":
      return capabilities.includes("steer") ||
        capabilities.includes("interrupt");
    case "resume":
      return capabilities.includes("follow_up") ||
        capabilities.includes("resume");
  }
}

/** A steering message mode needs the matching advertised capability. */
export function adapterSupportsSteering(
  mode: SteeringMode,
  capabilities: readonly string[],
): boolean {
  return capabilities.includes(mode);
}

/** Normalizes the stored jsonb value into a string list. */
export function readAdapterCapabilities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
