import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";
import {
  type ActionAttribution,
  attributeAction,
} from "./action-attribution.ts";

/**
 * The definition kinds an agent can author, and the one publish guard they
 * share (chapter 25 sections 11 and 18.2, O50 to O52, issue #421).
 *
 * An agent authors drafts by default. Publishing a version and "Use this
 * version" are off by default for agents and granted per definition or per
 * seat (O52). A person is never asked for a grant here: the person's role and
 * the action's catalog permission already decided that. Each kind's publish
 * and activate handlers call {@link assertMayPublishDefinition} with their own
 * kind, so a kind added to {@link DefinitionKind} inherits the same guard and
 * the parity table in the tests covers it.
 */
export const DefinitionKind = Object.freeze(
  {
    Workflow: "workflow",
    Agent: "agent",
    ArtifactKind: "artifactKind",
    Skill: "skill",
  } as const,
);
export type DefinitionKind = typeof DefinitionKind[keyof typeof DefinitionKind];

export const DEFINITION_KINDS: readonly DefinitionKind[] = Object.freeze(
  Object.values(DefinitionKind),
);

/**
 * Per kind: the operations the publish guard protects, and whether the kind
 * has a draft model an agent can author. Agents, artifact kinds and skills
 * publish versions directly today (no draft row), so only workflows have
 * agent-authored drafts and definition proposals.
 */
export const DEFINITION_PUBLISH_SURFACE: Readonly<
  Record<
    DefinitionKind,
    Readonly<{ operations: readonly string[]; drafts: boolean }>
  >
> = Object.freeze({
  workflow: Object.freeze({
    operations: Object.freeze([
      "workflowVersions.publish",
      "workflowActivations.create",
    ]),
    drafts: true,
  }),
  agent: Object.freeze({
    operations: Object.freeze([
      "agentVersions.create",
      "agents.activateVersion",
    ]),
    drafts: false,
  }),
  artifactKind: Object.freeze({
    operations: Object.freeze(["artifactKindVersions.create"]),
    drafts: false,
  }),
  skill: Object.freeze({
    operations: Object.freeze(["skillVersions.create"]),
    drafts: false,
  }),
});

export function isDefinitionKind(value: unknown): value is DefinitionKind {
  return typeof value === "string" &&
    (DEFINITION_KINDS as readonly string[]).includes(value);
}

/** The refusal an agent without a publish grant receives, on every kind. */
export const DEFINITION_PUBLISH_REQUIRES_GRANT =
  "definition_publish_requires_grant";

/**
 * Whether a live grant lets this agent publish the definition: a grant for
 * this definition with no seat, or a grant for this seat that names this
 * definition or every definition of the kind. An agent without an access
 * token (a service or worker principal) can only hold a definition grant.
 */
export async function agentHoldsPublishGrant(
  transaction: PgTransactionClient,
  scope: Readonly<{
    organizationId: string;
    kind: DefinitionKind;
    /**
     * The immutable id of the definition (for an artifact kind, its row id,
     * never its key); null when it does not exist yet, which only a seat grant
     * on every definition of the kind covers.
     */
    definitionId: string | null;
    accessTokenId: string | null;
  }>,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1 from bakery.definition_publish_grants
      where organization_id = $1 and definition_kind = $2
        and (definition_id = $3::uuid
             or (definition_id is null and access_token_id is not null))
        and (access_token_id is null or access_token_id = $4::uuid)
      limit 1`,
    [
      scope.organizationId,
      scope.kind,
      scope.definitionId,
      scope.accessTokenId,
    ],
  );
  return found.rows.length === 1;
}

/**
 * Refuses an agent's publish or "Use this version" of one definition unless
 * a grant covers it, and returns the attribution to record (O50: the action
 * is labelled as an agent's). Call it after the definition row is locked and
 * before anything is written, so a refusal writes nothing.
 */
export async function assertMayPublishDefinition(
  transaction: PgTransactionClient,
  context: Pick<ActionContext, "principal" | "accessToken">,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    kind: DefinitionKind;
    /**
     * The immutable id of the definition (for an artifact kind, its row id,
     * never its key); null when it does not exist yet, which only a seat grant
     * on every definition of the kind covers.
     */
    definitionId: string | null;
  }>,
): Promise<ActionAttribution> {
  const attribution = attributeAction(context, scope.principalId);
  if (attribution.actorKind === "person") return attribution;
  if (
    await agentHoldsPublishGrant(transaction, {
      organizationId: scope.organizationId,
      kind: scope.kind,
      definitionId: scope.definitionId,
      accessTokenId: attribution.accessTokenId,
    })
  ) return attribution;
  throw new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: DEFINITION_PUBLISH_REQUIRES_GRANT },
  });
}
