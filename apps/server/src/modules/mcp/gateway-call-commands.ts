import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { ToolGatewayCallImplementedAction } from "@bakery/contracts/implemented-actions";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * Settling a tool gateway call (#436, 25-one-engine.md 15.5). The gateway
 * records every call before it sends it; a write whose outcome never came back
 * stays `sent` and is never sent again, so a replay of its key cannot double
 * the effect. A person who has checked the outside system records what
 * happened here: completed or failed. Only a `sent` call can be settled, and
 * only once.
 */

type GatewayCall = z.output<typeof contractSchemas.ToolGatewayCall>;
type Settle = z.output<typeof contractSchemas.ToolGatewayCallSettle>;

type Row = {
  id: string;
  attempt_id: string;
  mcp_connection_id: string;
  tool_name: string;
  read_only: boolean;
  status: GatewayCall["status"];
  failure_code: string | null;
  created_at: Date;
  settled_at: Date | null;
};

const COLUMNS = `id, attempt_id, mcp_connection_id, tool_name, read_only,
  status, failure_code, created_at, settled_at`;

/** The failure code a failed settlement records when the Admin gives none. */
export const SETTLED_FAILED_CODE = "settled_failed";

function toCall(row: Row): GatewayCall {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    mcpConnectionId: row.mcp_connection_id,
    toolName: row.tool_name,
    readOnly: row.read_only,
    status: row.status,
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

/** `toolGatewayCalls.settle`: an Admin records a sent call's real outcome. */
export async function settleToolGatewayCall(
  context: ActionContext,
  input: Settle,
): Promise<GatewayCall> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (input.status === "completed" && input.failureCode != null) {
    throw unprocessable(["failureCode"], "settle_failure_code_on_completed");
  }
  // Another organization's call is as absent as an unknown id.
  const found = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.tool_gateway_calls
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, id],
  )).rows[0];
  if (!found) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (found.status !== "sent") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "tool_gateway_call_settled" },
    });
  }
  const failureCode = input.status === "failed"
    ? input.failureCode ?? SETTLED_FAILED_CODE
    : null;
  const settled = (await transaction.query<Row>(
    `update bakery.tool_gateway_calls
        set status = $3, failure_code = $4, settled_at = now()
      where organization_id = $1 and id = $2 and status = 'sent'
      returning ${COLUMNS}`,
    [organizationId, id, input.status, failureCode],
  )).rows[0]!;
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: ToolGatewayCallImplementedAction.ToolGatewayCallsSettle,
    resourceType: "tool_gateway_call",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      attemptId: found.attempt_id,
      mcpConnectionId: found.mcp_connection_id,
      toolName: found.tool_name,
      status: input.status,
      failureCode,
    },
  });
  return toCall(settled);
}
