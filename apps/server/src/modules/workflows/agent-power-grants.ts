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
  expires_at: Date | string | null;
  role_key: string | null;
  group_id: string | null;
  version: number;
};

const GRANT_COLUMNS =
  "id, power, workflow_id, access_token_id, granted_by, created_at, expires_at, role_key, group_id, version";

/** The built-in roles an ask grant may name; a custom role is named by its key. */
const ASKABLE_SYSTEM_ROLES = ["admin", "developer"];

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    power: row.power as AgentPower,
    workflowId: row.workflow_id,
    accessTokenId: row.access_token_id,
    grantedBy: row.granted_by,
    createdAt: iso(row.created_at),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    roleKey: row.role_key,
    groupId: row.group_id,
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
    expiresAt?: string | null;
    roleKey?: string | null;
    groupId?: string | null;
  };
  if (!isAgentPower(value.power)) {
    unprocessable(
      ["power"],
      "agent_power_unknown",
      "power must be decide, run_control, run_start, steer, steer_reviewer, comment, edit_work, draft_connection or ask",
    );
  }
  const power = value.power;
  const workflowId = value.workflowId ?? null;
  const tokenId = value.accessTokenId ?? null;
  const roleKey = value.roleKey ?? null;
  const groupId = value.groupId ?? null;
  const expiresAt = value.expiresAt == null ? null : new Date(value.expiresAt);
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    unprocessable(
      ["expiresAt"],
      "agent_power_grant_expiry_invalid",
      "Not a date",
    );
  }
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    unprocessable(
      ["expiresAt"],
      "agent_power_grant_expiry_past",
      "A grant must expire in the future, or not at all",
    );
  }
  // An ask grant names exactly who may be asked: one role or one group. No
  // other power names an audience.
  if (power === "ask" && (roleKey === null) === (groupId === null)) {
    unprocessable(
      ["roleKey"],
      "agent_power_grant_audience_required",
      "An ask grant names one role (roleKey) or one group (groupId)",
    );
  }
  if (power !== "ask" && (roleKey !== null || groupId !== null)) {
    unprocessable(
      ["roleKey"],
      "agent_power_grant_audience_unexpected",
      "Only an ask grant names a role or a group",
    );
  }
  if (roleKey !== null && !ASKABLE_SYSTEM_ROLES.includes(roleKey)) {
    const custom = await transaction.query(
      `select 1 from bakery.organization_roles
        where organization_id = $1 and key = $2`,
      [organizationId, roleKey],
    );
    if (custom.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
  if (groupId !== null) {
    const group = await transaction.query(
      `select 1 from bakery.organization_groups
        where organization_id = $1 and id = $2`,
      [organizationId, groupId],
    );
    if (group.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
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
        and access_token_id is not distinct from $4::uuid
        and role_key is not distinct from $5
        and group_id is not distinct from $6::uuid`,
    [organizationId, power, workflowId, tokenId, roleKey, groupId],
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
       organization_id, power, workflow_id, access_token_id, granted_by,
       expires_at, role_key, group_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${GRANT_COLUMNS}`,
    [
      organizationId,
      power,
      workflowId,
      tokenId,
      principalId,
      expiresAt,
      roleKey,
      groupId,
    ],
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
      expiresAt: facts.row.expires_at === null
        ? null
        : iso(facts.row.expires_at),
      roleKey: facts.row.role_key,
      groupId: facts.row.group_id,
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
