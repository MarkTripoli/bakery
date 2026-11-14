import type {
  AgentDefinitionResponse,
  AgentVersionResponse,
  WorkflowVersionResponse,
} from "../../api/client.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** What a version of a workflow is, for the Versions card. */
export type VersionState = "draft" | "inUse" | "published" | "retired";

/**
 * Draft and retired are the version's own status; of the published ones, the
 * one the workflow points at is in use. Anything the server adds later is
 * shown as published rather than guessed at.
 */
export function versionState(
  version: Pick<WorkflowVersionResponse, "id" | "status">,
  activeVersionId: string | null,
): VersionState {
  if (version.status === "draft") return "draft";
  if (version.status === "retired") return "retired";
  return version.id === activeVersionId ? "inUse" : "published";
}

/** The versions newest first (highest revision), so the one just made leads. */
export function newestFirst(
  versions: readonly WorkflowVersionResponse[],
): WorkflowVersionResponse[] {
  return [...versions].sort((a, b) =>
    b.revision - a.revision || b.id.localeCompare(a.id)
  );
}

/** The version a page shows by default: the one in use, else the newest published, else the newest. */
export function defaultVersion(
  versions: readonly WorkflowVersionResponse[],
  activeVersionId: string | null,
): WorkflowVersionResponse | null {
  const ordered = newestFirst(versions);
  return ordered.find((version) => version.id === activeVersionId) ??
    ordered.find((version) => version.status === "published") ??
    ordered[0] ?? null;
}

/** A published version that is not the one in use can be made the one in use. */
export function canUse(
  version: Pick<WorkflowVersionResponse, "id" | "status">,
  activeVersionId: string | null,
): boolean {
  return versionState(version, activeVersionId) === "published";
}

/** One step of a version, as the stored specification says it. */
export type StepView = {
  readonly id: string;
  /** The action the step runs, as registered (for example `task.brief`). */
  readonly uses: string;
  /** The agent version the step is bound to: its own, else the workflow's binding for its action. */
  readonly agentVersionId: string | null;
};

/** The steps of a version's normalized specification, in order; nothing is guessed when it is not shaped as expected. */
export function stepsOf(
  version: Pick<WorkflowVersionResponse, "normalizedSpec">,
): StepView[] {
  const spec = record(version.normalizedSpec);
  const bindings = record(spec.agents);
  const steps = Array.isArray(spec.steps) ? spec.steps : [];
  return steps.flatMap((raw) => {
    const step = record(raw);
    const id = text(step.id);
    const uses = text(step.uses);
    if (id === "" || uses === "") return [];
    const own = text(step.agentVersionId);
    const bound = text(bindings[uses]);
    return [{
      id,
      uses,
      agentVersionId: own !== "" ? own : bound !== "" ? bound : null,
    }];
  });
}

/** An agent version resolved to the agent it belongs to. */
export type AgentBinding = {
  readonly agentName: string;
  readonly revision: number;
};

/** Index agent versions by their id, with the agent's name, so a step can say "Agent: name, version n". */
export function agentBindings(
  agents: readonly AgentDefinitionResponse[],
  versionsByAgent: ReadonlyMap<string, readonly AgentVersionResponse[]>,
): Map<string, AgentBinding> {
  const found = new Map<string, AgentBinding>();
  for (const agent of agents) {
    for (const version of versionsByAgent.get(agent.id) ?? []) {
      found.set(version.id, {
        agentName: agent.name,
        revision: version.revision,
      });
    }
  }
  return found;
}

/** A file name for an exported version: the workflow's slug and the version's number. */
export function exportFileName(slug: string, revision: number): string {
  const safe = slug.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe === "" ? "workflow" : safe}-v${revision}.yaml`;
}
