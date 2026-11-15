import type { AgentVersionResponse } from "../../api/client.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** What an agent version is configured to do, as the page lists it. */
export type AgentSummary = {
  /** The harness the agent runs on, as the server names it ("claude_code"). */
  readonly harness: string | null;
  /** The model the agent bills, when the version says one. */
  readonly model: string | null;
  /** Capabilities the agent may use, as named by the worker-action vocabulary. */
  readonly capabilities: readonly string[];
  /** Names of the prompts the version binds (the prompts' text is not served here). */
  readonly prompts: readonly string[];
  /** Names of the skills the version binds. */
  readonly skills: readonly string[];
};

/** Reads an agent version's configuration defensively: anything missing is empty. */
export function summaryOf(
  version: Pick<AgentVersionResponse, "config">,
): AgentSummary {
  const config = record(version.config);
  const billing = record(config.billing);
  return {
    harness: typeof config.harness === "string" ? config.harness : null,
    model: typeof billing.model === "string" && billing.model !== ""
      ? billing.model
      : null,
    capabilities: strings(config.allowedCapabilities),
    prompts: Object.keys(record(config.promptBindings)).sort(),
    skills: Object.keys(record(config.skillBindings)).sort(),
  };
}

/** The versions newest first (highest revision), so the one just made leads. */
export function newestFirst(
  versions: readonly AgentVersionResponse[],
): AgentVersionResponse[] {
  return [...versions].sort((a, b) =>
    b.revision - a.revision || b.id.localeCompare(a.id)
  );
}

/** The version a page shows by default: the one in use, else the newest. */
export function defaultVersion(
  versions: readonly AgentVersionResponse[],
  activeVersionId: string | null,
): AgentVersionResponse | null {
  return versions.find((version) => version.id === activeVersionId) ??
    versions[0] ?? null;
}
