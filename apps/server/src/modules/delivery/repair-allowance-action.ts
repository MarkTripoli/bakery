import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  DELIVERY_DECISION_COLUMNS,
  type DeliveryDecisionRow,
  toDeliveryDecision,
} from "./postgres.ts";
import { allowMoreRepairTries } from "./repair-allowance.ts";

/**
 * `runRepairAllowances.create`: a person allows a run whose loop ran out of tries
 * to try more (issue #62). Only an organization administrator, or a member whose
 * role holds `review:accept`, and never an agent: a decision that overrules a
 * stopped loop is a person's, as accepting a review is. The response is the
 * repair decision the allowance bought, which is the durable answer to the stop;
 * asking again for the same stop returns that same decision.
 */
export async function createRepairAllowance(
  context: ActionContext,
  input: z.output<typeof contractSchemas.RepairAllowanceCreate>,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  if (context.agentSession !== undefined) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const allowance = await allowMoreRepairTries(transaction, {
    organizationId,
    principalId,
    runId,
    tries: input.tries,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  const decision = await transaction.query<DeliveryDecisionRow>(
    `select ${DELIVERY_DECISION_COLUMNS}
       from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2 and ordinal = $3`,
    [organizationId, runId, allowance.decisionOrdinal],
  );
  return toDeliveryDecision(decision.rows[0]!);
}
