import {
  type AgentVersionCreateConfig,
  AgentVersionCreateConfigSchema,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  assertActionAgentPolicy,
  selectStepAgentVersion,
  workflowActionCapabilities,
} from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { resolveAgentSkillBindings } from "../catalog/agent-skill-bindings.ts";
import type { FixedWorkflowStep } from "./run-steps.ts";

export type FrozenStepAgent = Readonly<{
  agentVersionId: string;
  revision: number;
  digest: string;
  config: AgentVersionCreateConfig;
  skillRefs: readonly Readonly<{ versionId: string; digest: string }>[];
}>;

export type FrozenStepAgents = Readonly<Record<string, FrozenStepAgent>>;

type AgentVersionAdmissionRow = Readonly<{
  id: string;
  revision: number;
  config: unknown;
  digest: string;
  agent_enabled: boolean;
}>;

function unavailable(reason: string): never {
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: { reason },
  });
}

/**
 * Resolves every immutable selector once while the surrounding run transaction
 * holds the selected agent and skill authority locks.
 */
export async function resolveFrozenStepAgents(
  transaction: PgTransactionClient,
  organizationId: string,
  steps: readonly FixedWorkflowStep[],
  profileAgentBindings: Readonly<Record<string, string>> | undefined,
): Promise<FrozenStepAgents> {
  const selections = steps.flatMap((step) => {
    const { agentVersionId } = selectStepAgentVersion({
      action: step.action,
      stepAgentVersionId: step.stepAgentVersionId,
      workflowAgents: step.workflowAgentVersionId === null
        ? undefined
        : { [step.action]: step.workflowAgentVersionId },
      profileAgentBindings,
    });
    const required = workflowActionCapabilities(step.action, step.requires);
    if (agentVersionId === null) {
      assertActionAgentPolicy(required, null);
      return [];
    }
    return [{ stepKey: step.key, agentVersionId, required }];
  });
  return await resolveAgentVersionSelections(
    transaction,
    organizationId,
    selections,
  );
}

export type AgentVersionSelection = Readonly<{
  stepKey: string;
  agentVersionId: string;
  required: readonly string[];
}>;

/**
 * Resolves every immutable selector once while the surrounding transaction
 * holds the selected agent and skill authority locks. Shared by run admission
 * and workflow validation so a publishable binding cannot fail admission.
 */
export async function resolveAgentVersionSelections(
  transaction: PgTransactionClient,
  organizationId: string,
  selections: readonly AgentVersionSelection[],
): Promise<FrozenStepAgents> {
  if (selections.length === 0) return Object.freeze({});

  const selectedIds = [
    ...new Set(
      selections.map((selection) => selection.agentVersionId),
    ),
  ].sort();
  const result = await transaction.query<AgentVersionAdmissionRow>(
    `select version.id, version.revision, version.config, version.digest,
            definition.enabled as agent_enabled
       from bakery.agent_versions version
       join bakery.agent_definitions definition
         on definition.organization_id = version.organization_id
        and definition.id = version.agent_id
      where version.organization_id = $1
        and version.id = any($2::uuid[])
      order by version.id
      for share of definition`,
    [organizationId, selectedIds],
  );
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  const resolved = new Map<string, FrozenStepAgent>();

  for (const agentVersionId of selectedIds) {
    const row = rows.get(agentVersionId);
    if (!row || !row.agent_enabled) unavailable("agent_version_unavailable");
    const config = AgentVersionCreateConfigSchema.safeParse(row.config);
    if (
      !config.success || !Number.isSafeInteger(row.revision) ||
      row.revision < 1 || !/^[0-9a-f]{64}$/.test(row.digest) ||
      await sha256Hex(canonicalJson(config.data)) !== row.digest
    ) {
      unavailable("agent_version_invalid");
    }
    const skillRefs = await resolveAgentSkillBindings(
      transaction,
      organizationId,
      config.data.skillBindings,
    );
    resolved.set(
      agentVersionId,
      Object.freeze({
        agentVersionId,
        revision: row.revision,
        digest: row.digest,
        config: Object.freeze(config.data),
        skillRefs: Object.freeze(
          skillRefs.map((ref) => Object.freeze({ ...ref })),
        ),
      }),
    );
  }

  return Object.freeze(Object.fromEntries(selections.map((selection) => {
    const agent = resolved.get(selection.agentVersionId);
    if (!agent) unavailable("agent_version_unavailable");
    assertActionAgentPolicy(selection.required, agent.config);
    return [selection.stepKey, agent];
  })));
}
