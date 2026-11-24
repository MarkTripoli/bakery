import type {
  AgentDefinitionResponse,
  AgentVersionResponse,
  WorkflowVersionResponse,
} from "../../api/client.ts";
import type { TreeStep } from "./workflow-tree.ts";

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

/**
 * The step types the editor's "Add a step" list offers, in the order the
 * design lists them (design-ux, #67). A type Bakery knows but this list does
 * not offer is drawn as its own card that opens a panel saying it is written
 * in code.
 */
export const PICKER_STEPS: readonly string[] = [
  "rpi.research",
  "rpi.design",
  "rpi.plan",
  "harness.implement",
  "harness.repair",
  "quality.check",
  "review.independent",
  "delivery.merge",
];

/**
 * The names of the actions a step can run: the workflow editor spec's, so the
 * Library and the editor say the same thing (design-ux, #432). An action with
 * no name here keeps showing its own identifier.
 */
export const ACTION_TITLES: Readonly<Record<string, string>> = {
  "task.brief": "library.workflow.action.taskBrief",
  "rpi.research": "library.workflow.action.rpiResearch",
  "rpi.design": "library.workflow.action.rpiDesign",
  "rpi.plan": "library.workflow.action.rpiPlan",
  "harness.implement": "library.workflow.action.harnessImplement",
  "harness.repair": "library.workflow.action.harnessRepair",
  "agent.review": "library.workflow.action.agentReview",
  "review.independent": "library.workflow.action.reviewIndependent",
  "agent.freeform": "library.workflow.action.agentFreeform",
  "human.approval": "library.workflow.action.humanApproval",
  "workflow.stop": "library.workflow.action.workflowStop",
  "quality.check": "library.workflow.action.qualityCheck",
  "delivery.merge": "library.workflow.action.deliveryMerge",
  "delivery.prepare": "library.workflow.action.deliveryPrepare",
  "delivery.deploy": "library.workflow.action.deliveryDeploy",
  "delivery.health": "library.workflow.action.deliveryHealth",
  "artifact.publish": "library.workflow.action.artifactPublish",
};

/** The spec's sentence under a step's name; the actions it has none for show only their name. */
/** The glyph each step type carries in the editor's diagram (design-ux, #67). */
export const ACTION_ICONS: Readonly<Record<string, string>> = {
  "task.brief": "lightning",
  "rpi.research": "search",
  "rpi.design": "document",
  "rpi.plan": "plan",
  "harness.implement": "terminal",
  "harness.repair": "refresh",
  "quality.check": "check",
  "agent.review": "shield",
  "review.independent": "shield",
  "delivery.merge": "integration",
  "agent.freeform": "document",
  "human.approval": "person",
  "workflow.stop": "close",
};

export const ACTION_LINES: Readonly<Record<string, string>> = {
  "task.brief": "library.workflow.actionLine.taskBrief",
  "rpi.research": "library.workflow.actionLine.rpiResearch",
  "rpi.design": "library.workflow.actionLine.rpiDesign",
  "rpi.plan": "library.workflow.actionLine.rpiPlan",
  "harness.implement": "library.workflow.actionLine.harnessImplement",
  "harness.repair": "library.workflow.actionLine.harnessRepair",
  "agent.review": "library.workflow.actionLine.agentReview",
  "review.independent": "library.workflow.actionLine.reviewIndependent",
  "agent.freeform": "library.workflow.actionLine.agentFreeform",
  "human.approval": "library.workflow.actionLine.humanApproval",
  "workflow.stop": "library.workflow.actionLine.workflowStop",
  "quality.check": "library.workflow.actionLine.qualityCheck",
  "delivery.merge": "library.workflow.actionLine.deliveryMerge",
};

/** The name a card carries, for a problem row that names it. */
export function stepName(
  step: TreeStep,
  translate: (key: never, values?: Record<string, string>) => string,
): string {
  if (step.problem === "unknown") {
    return translate("library.editor.card.unknown" as never);
  }
  if (step.problem === "unreadable") {
    return translate("library.editor.card.unreadable" as never);
  }
  if (step.name !== undefined) return step.name;
  const key = ACTION_TITLES[step.uses];
  return key === undefined ? step.uses : translate(key as never);
}

export function stepLine(
  step: TreeStep,
  translate: (key: never, values?: Record<string, string>) => string,
): string | undefined {
  if (step.description !== undefined) return step.description;
  const key = ACTION_LINES[step.uses];
  return key === undefined ? undefined : translate(key as never);
}

export function stepGlyph(step: TreeStep): string | undefined {
  if (step.uses === "agent.freeform" && step.role === "reviewer") {
    return "shield";
  }
  return ACTION_ICONS[step.uses];
}
