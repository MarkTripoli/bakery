import { StandardError } from "@bakery/contracts/http";
import {
  compileWorkflowDocumentDetailed,
  type WorkflowActionSite,
  type WorkflowSemanticDocument,
} from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import {
  assertActionAgentPolicy,
  selectStepAgentVersion,
  workflowActionCapabilities,
} from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { planActionAgentBindings } from "../workflow-adapter/plan-admission.ts";
import {
  type AgentVersionSelection,
  type FrozenStepAgent,
  type FrozenStepAgents,
  resolveAgentVersionSelections,
} from "./agent-run-admission.ts";

/**
 * What admitting a compiled plan run reads from the organization before any
 * row is written: the plan itself, compiled again from the published
 * definition, and the agent every action step will run as, resolved and
 * policy-checked while the surrounding transaction holds the agent locks.
 *
 * A published definition was valid when it was published, but the compiler and
 * the registry move on; a version that no longer compiles is refused here
 * rather than half-started.
 */
export type PlanAdmission = Readonly<{
  document: WorkflowSemanticDocument;
  /** Every action step, in authored order, with the frozen agent it runs as. */
  sites: readonly WorkflowActionSite[];
  /** The frozen agents by step (`qualifiedId`), for the budget check. */
  stepAgents: FrozenStepAgents;
  /** The same agents by version id, as the run snapshot freezes them. */
  agents: Readonly<Record<string, FrozenStepAgent>>;
  /** The agent each action falls back to when a step names none. */
  actionAgents: Readonly<Record<string, string>>;
}>;

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

export async function resolvePlanAdmission(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    definition: unknown;
    profileAgentBindings: Readonly<Record<string, string>> | undefined;
  },
): Promise<PlanAdmission> {
  const { result, actionSites } = await compileWorkflowDocumentDetailed(
    options.definition,
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  if (!result.ok) conflict("workflow_plan_not_compilable");
  const document = result.document;
  const stepAgentVersion = new Map(
    result.plan.steps.flatMap((step) =>
      step.kind === "action" ? [[step.qualifiedId, step.agentVersionId]] : []
    ),
  );

  const selections: AgentVersionSelection[] = [];
  for (const site of actionSites) {
    const { agentVersionId } = selectStepAgentVersion({
      action: site.action,
      stepAgentVersionId: stepAgentVersion.get(site.qualifiedId),
      workflowAgents: document.agents,
      profileAgentBindings: options.profileAgentBindings,
    });
    const required = workflowActionCapabilities(site.action, site.requires);
    if (agentVersionId === null) {
      // An action that needs a model cannot run without an agent.
      assertActionAgentPolicy(required, null);
      continue;
    }
    selections.push({ stepKey: site.qualifiedId, agentVersionId, required });
  }
  const stepAgents = await resolveAgentVersionSelections(
    transaction,
    options.organizationId,
    selections,
  );
  const agents: Record<string, FrozenStepAgent> = {};
  for (const agent of Object.values(stepAgents)) {
    agents[agent.agentVersionId] = agent;
  }
  return Object.freeze({
    document,
    sites: actionSites,
    stepAgents,
    agents: Object.freeze(agents),
    actionAgents: Object.freeze(
      planActionAgentBindings(document, options.profileAgentBindings),
    ),
  });
}
