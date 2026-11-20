import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  connectionId,
  loadVisible,
  requireMayChange,
} from "./connection-commands.ts";

/**
 * Use grants for personal MCP connections (#434, O27).
 *
 * A personal connection acts as its owner. Someone else's run may use it only
 * through the owner's explicit grant to one workflow, which the owner can revoke at
 * any time. Only the owner grants and revokes: an Admin has no say over a member's
 * personal connection, which to an Admin is as absent as an unknown id. Revoking
 * stamps the row, so what was once granted stays on record.
 */

type Grant = z.output<typeof contractSchemas.McpUseGrant>;
type GrantCreate = z.output<typeof contractSchemas.McpUseGrantCreate>;

type Row = {
  id: string;
  connection_id: string;
  workflow_id: string;
  granted_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
};

const COLUMNS =
  "id, connection_id, workflow_id, granted_by, created_at, revoked_at, revoked_by";

function toGrant(row: Row): Grant {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workflowId: row.workflow_id,
    grantedBy: row.granted_by,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
  } as Grant;
}

/** `mcpUseGrants.list`: a personal connection's grants, newest first. */
export async function listMcpUseGrants(
  context: ActionContext,
): Promise<{ items: Grant[] }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const connection = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
  );
  // An organization connection is the organization's and needs no grant.
  if (connection.owner_principal_id === null) return { items: [] };
  const rows = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.mcp_use_grants
      where organization_id = $1 and connection_id = $2
      order by created_at desc, id desc limit 200`,
    [organizationId, connection.id],
  )).rows;
  return { items: rows.map(toGrant) };
}

/** `mcpUseGrants.create`: the owner lets one workflow use their personal connection. */
export async function createMcpUseGrant(
  context: ActionContext,
  input: GrantCreate,
): Promise<Grant> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const connection = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
    { lock: true },
  );
  requireMayChange(context, connection);
  if (connection.owner_principal_id === null) {
    throw unprocessable(["connection"], "connection_not_personal");
  }
  const workflow = await transaction.query(
    `select 1 from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, input.workflowId],
  );
  if (workflow.rows.length === 0) {
    throw unprocessable(["workflowId"], "workflow_not_found");
  }
  let row: Row;
  try {
    row = (await transaction.query<Row>(
      `insert into bakery.mcp_use_grants
         (organization_id, connection_id, workflow_id, granted_by)
       values ($1, $2, $3, $4)
       returning ${COLUMNS}`,
      [organizationId, connection.id, input.workflowId, principalId],
    )).rows[0]!;
  } catch (error) {
    // One live grant per connection and workflow.
    if (postgresErrorCode(error) === "23505") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "use_grant_exists" },
      });
    }
    throw error;
  }
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "mcpUseGrants.create",
    resourceType: "mcp_connection",
    resourceId: connection.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { grantId: row.id, workflowId: input.workflowId },
  });
  return toGrant(row);
}

/** `mcpUseGrants.revoke`: the owner withdraws a grant; it is stamped, not deleted. */
export async function revokeMcpUseGrant(
  context: ActionContext,
): Promise<Grant> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const connection = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
    { lock: true },
  );
  requireMayChange(context, connection);
  const grantId = context.params.grantId;
  if (!grantId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const found = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.mcp_use_grants
      where organization_id = $1 and connection_id = $2 and id = $3
        for update`,
    [organizationId, connection.id, grantId],
  )).rows[0];
  if (!found) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (found.revoked_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "use_grant_revoked" },
    });
  }
  const revoked = (await transaction.query<Row>(
    `update bakery.mcp_use_grants
        set revoked_at = now(), revoked_by = $4
      where organization_id = $1 and connection_id = $2 and id = $3
      returning ${COLUMNS}`,
    [organizationId, connection.id, grantId, principalId],
  )).rows[0]!;
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "mcpUseGrants.revoke",
    resourceType: "mcp_connection",
    resourceId: connection.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { grantId, workflowId: revoked.workflow_id },
  });
  return toGrant(revoked);
}
