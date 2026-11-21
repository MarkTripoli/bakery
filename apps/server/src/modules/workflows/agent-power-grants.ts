import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  type AgentPower,
  isAgentPower,
} from "../auth/application/agent-power-grants.ts";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Agent power grants (chapter 25 O52, issue #414). A person grants an agent one
 * off-by-default power (deciding, controlling a run, starting one) for one
 * workflow, for one seat (access token), or for one seat on every workflow.
 * Only a person grants or revokes: delegating authority is never an agent's act
 * (O51). The guard that reads grants is assertAgentMayExercise.
 */

type GrantRow = {
  id: string;
  power: string;
  workflow_id: string | null;
  access_token_id: string | null;
  granted_by: string;
  created_at: Date | string;
  version: number;
};

const GRANT_COLUMNS =
  "id, power, workflow_id, access_token_id, granted_by, created_at, version";

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    power: row.power as AgentPower,
    workflowId: row.workflow_id,
    accessTokenId: row.access_token_id,
    grantedBy: row.granted_by,
    createdAt:
      (row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at)).toISOString(),
    version: row.version,
  };
}

function assertPerson(context: ActionContext, principalId: string) {
  if (attributeAction(context, principalId).actorKind === "person") return;
  throw new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: "agent_power_grant_requires_person" },
  });
}

function unprocessable(path: string[], code: string, message: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path, code, message }] },
  });
}

export async function createAgentPowerGrant(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPerson(context, principalId);
  const value = input as {
    power: string;
    workflowId?: string | null;
    accessTokenId?: string | null;
  };
  if (!isAgentPower(value.power)) {
    unprocessable(
      ["power"],
      "agent_power_unknown",
      "power must be decide, run_control, run_start, steer, steer_reviewer, comment, edit_work or draft_connection",
    );
  }
  const power = value.power;
  const workflowId = value.workflowId ?? null;
  const tokenId = value.accessTokenId ?? null;
  if (workflowId === null && tokenId === null) {
    unprocessable(
      ["accessTokenId"],
      "agent_power_grant_too_wide",
      "A grant for every workflow must name one seat (accessTokenId)",
    );
  }
  // An unknown or foreign workflow and an unknown or foreign token answer the
  // same not found, so the refusal does not say which one was wrong.
  if (workflowId !== null) {
    const found = await transaction.query(
      `select 1 from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [organizationId, workflowId],
    );
    if (found.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
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
    `select id from bakery.agent_power_grants
      where organization_id = $1 and power = $2
        and workflow_id is not distinct from $3::uuid
        and access_token_id is not distinct from $4::uuid`,
    [organizationId, power, workflowId, tokenId],
  );
  if (existing.rows[0]) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: "agent_power_grant_exists",
        existingResourceId: existing.rows[0].id,
      },
    });
  }
  const row = (await transaction.query<GrantRow>(
    `insert into bakery.agent_power_grants (
       organization_id, power, workflow_id, access_token_id, granted_by
     ) values ($1, $2, $3, $4, $5)
     returning ${GRANT_COLUMNS}`,
    [organizationId, power, workflowId, tokenId, principalId],
  )).rows[0];
  if (!row) throw new Error("AGENT_POWER_GRANT_INSERT_FAILED");
  await appendGrantFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "agentPowerGrants.create",
    eventType: "agentPowerGrant.created",
    row,
  });
  return toGrant(row);
}

export async function deleteAgentPowerGrant(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPerson(context, principalId);
  const grantId = context.params.id;
  if (!grantId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // One compare-and-delete: bakery_app has no UPDATE on grants (they are never
  // edited), so the row is not locked for update first.
  const current = (await transaction.query<GrantRow>(
    `delete from bakery.agent_power_grants
      where organization_id = $1 and id = $2 and version = $3
      returning ${GRANT_COLUMNS}`,
    [organizationId, grantId, expectedVersion],
  )).rows[0];
  if (!current) {
    const exists = await transaction.query(
      `select 1 from bakery.agent_power_grants
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
    operation: "agentPowerGrants.delete",
    eventType: "agentPowerGrant.deleted",
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
    resourceType: "agent_power_grant",
    resourceId: facts.row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      power: facts.row.power,
      workflowId: facts.row.workflow_id,
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
