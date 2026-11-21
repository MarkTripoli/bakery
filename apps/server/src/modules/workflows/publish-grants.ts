import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  type DefinitionKind,
  isDefinitionKind,
} from "../auth/application/definition-publish-grants.ts";

function assertPersonGrants(context: ActionContext, principalId: string) {
  if (attributeAction(context, principalId).actorKind === "person") return;
  throw new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: "publish_grant_requires_person" },
  });
}

/**
 * Agent publish grants (chapter 25 O52, issue #421). A person grants an agent
 * the power to publish and to "Use this version" for one definition, for one
 * seat (access token), or for one seat on every definition of a kind. Only a
 * person grants or revokes: delegating authority is never an agent's act
 * (O51). The guard that reads grants is assertMayPublishDefinition.
 */

type GrantRow = {
  id: string;
  definition_kind: string;
  definition_id: string | null;
  access_token_id: string | null;
  granted_by: string;
  created_at: Date | string;
  version: number;
};

const GRANT_COLUMNS =
  "id, definition_kind, definition_id, access_token_id, granted_by, created_at, version";

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    definitionKind: row.definition_kind as DefinitionKind,
    definitionId: row.definition_id,
    accessTokenId: row.access_token_id,
    grantedBy: row.granted_by,
    createdAt:
      (row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at)).toISOString(),
    version: row.version,
  };
}

/** Each kind's definition table, looked up by the immutable row id a grant names. */
const DEFINITION_LOOKUP: Readonly<Record<DefinitionKind, string>> = {
  workflow:
    "select 1 from bakery.workflow_definitions where organization_id = $1 and id = $2",
  agent:
    "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2",
  skill:
    "select 1 from bakery.skills where organization_id = $1 and id = $2 and scope <> 'personal'",
  // The kind's row id, not its key: a kind recreated under a reused key is a
  // different kind and does not inherit the grant.
  artifactKind:
    "select 1 from bakery.artifact_kinds where organization_id = $1 and id = $2",
};

async function requireDefinition(
  transaction: PgTransactionClient,
  organizationId: string,
  kind: DefinitionKind,
  definitionId: string,
): Promise<void> {
  const found = await transaction.query(DEFINITION_LOOKUP[kind], [
    organizationId,
    definitionId,
  ]);
  if (found.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

function unprocessable(path: string[], code: string, message: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path, code, message }] },
  });
}

export async function createDefinitionPublishGrant(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPersonGrants(context, principalId);
  const value = input as {
    definitionKind: string;
    definitionId?: string | null;
    accessTokenId?: string | null;
  };
  if (!isDefinitionKind(value.definitionKind)) {
    unprocessable(
      ["definitionKind"],
      "definition_kind_unknown",
      "definitionKind must be workflow, agent, artifactKind or skill",
    );
  }
  const kind = value.definitionKind;
  const ref = value.definitionId ?? null;
  const tokenId = value.accessTokenId ?? null;
  if (ref === null && tokenId === null) {
    unprocessable(
      ["accessTokenId"],
      "publish_grant_too_wide",
      "A grant for every definition of a kind must name one seat (accessTokenId)",
    );
  }
  // An unknown or foreign definition and an unknown or foreign token answer
  // the same not found, so the refusal does not say which one was wrong.
  if (ref !== null) {
    await requireDefinition(transaction, organizationId, kind, ref);
  }
  if (tokenId !== null) {
    const token = await transaction.query(
      `select 1 from bakery.access_tokens
        where organization_id = $1 and id = $2 and revoked_at is null`,
      [organizationId, tokenId],
    );
    if (token.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
  const existing = await transaction.query<{ id: string }>(
    `select id from bakery.definition_publish_grants
      where organization_id = $1 and definition_kind = $2
        and definition_id is not distinct from $3::uuid
        and access_token_id is not distinct from $4::uuid`,
    [organizationId, kind, ref, tokenId],
  );
  if (existing.rows[0]) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: "publish_grant_exists",
        existingResourceId: existing.rows[0].id,
      },
    });
  }
  const row = (await transaction.query<GrantRow>(
    `insert into bakery.definition_publish_grants (
       organization_id, definition_kind, definition_id, access_token_id,
       granted_by
     ) values ($1, $2, $3, $4, $5)
     returning ${GRANT_COLUMNS}`,
    [organizationId, kind, ref, tokenId, principalId],
  )).rows[0];
  if (!row) throw new Error("DEFINITION_PUBLISH_GRANT_INSERT_FAILED");
  await appendGrantFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "definitionPublishGrants.create",
    eventType: "definitionPublishGrant.created",
    row,
  });
  return toGrant(row);
}

export async function deleteDefinitionPublishGrant(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPersonGrants(context, principalId);
  const grantId = context.params.id;
  if (!grantId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // One compare-and-delete: bakery_app has no UPDATE on grants (they are
  // never edited), so the row is not locked for update first.
  const current = (await transaction.query<GrantRow>(
    `delete from bakery.definition_publish_grants
      where organization_id = $1 and id = $2 and version = $3
      returning ${GRANT_COLUMNS}`,
    [organizationId, grantId, expectedVersion],
  )).rows[0];
  if (!current) {
    const exists = await transaction.query(
      `select 1 from bakery.definition_publish_grants
        where organization_id = $1 and id = $2`,
      [organizationId, grantId],
    );
    throw new StandardError({
      code: exists.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await appendGrantFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "definitionPublishGrants.delete",
    eventType: "definitionPublishGrant.deleted",
    row: { ...current, version: current.version + 1 },
  });
  return null;
}

async function appendGrantFacts(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    operation: string;
    eventType: string;
    row: GrantRow;
  }>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: facts.operation,
    resourceType: "definition_publish_grant",
    resourceId: facts.row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      definitionKind: facts.row.definition_kind,
      definitionId: facts.row.definition_id,
      accessTokenId: facts.row.access_token_id,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    eventType: facts.eventType,
    aggregateId: facts.row.id,
    aggregateVersion: facts.row.version,
    payload: { resourceId: facts.row.id, resourceVersion: facts.row.version },
    traceId: context.traceId,
  });
}
