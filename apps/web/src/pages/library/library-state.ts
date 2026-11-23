import type {
  AgentDefinitionResponse,
  WorkflowDefinitionResponse,
  WorkflowPresetResponse,
} from "../../api/client.ts";
import { treeOf } from "./workflow-tree.ts";

/** The lists the Library offers. */
export type LibraryTab =
  | "workflows"
  | "agents"
  | "skills"
  | "memory"
  | "evaluations";

/** The tab a `?tab=` value names; anything else is Workflows. */
export function libraryTab(value: unknown): LibraryTab {
  return value === "agents" || value === "skills" || value === "memory" ||
      value === "evaluations"
    ? value
    : "workflows";
}

/** What a workflow or agent of the organization is doing now, in one badge. */
export type DefinitionBadge = "inUse" | "turnedOff" | "noVersionInUse";

/**
 * Turned off wins over everything; with no version in use it cannot be chosen
 * for new tasks. The server serves exactly these two facts on the definition.
 */
export function definitionBadge(
  definition: { readonly enabled: boolean; readonly activeVersionId: unknown },
): DefinitionBadge {
  if (!definition.enabled) return "turnedOff";
  return definition.activeVersionId === null ||
      definition.activeVersionId === undefined
    ? "noVersionInUse"
    : "inUse";
}

/** The definitions in name order, so the list does not move when one is changed. */
export function byName<
  Row extends WorkflowDefinitionResponse | AgentDefinitionResponse,
>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

/** The built-in presets in the order the server gives them, with how many steps each runs. */
export function presetSteps(preset: WorkflowPresetResponse): number {
  // The count is what the built-in page draws, so the row and the page agree.
  return treeOf(preset.definition).stepCount;
}
