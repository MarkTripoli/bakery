import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { allowMoreRepairTries } from "./repair-allowance.ts";
import {
  allowMoreRepeatRounds,
  findRepeatLimitStop,
} from "./repeat-limit-decision.ts";

export async function createRepairAllowance(
  context: ActionContext,
  input: z.output<typeof contractSchemas.RepairAllowanceCreate>,
): Promise<z.output<typeof contractSchemas.TriesAllowance>> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  if (context.agentSession !== undefined) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const request = {
    organizationId,
    principalId,
    runId,
    tries: input.tries,
    requestId: context.requestId,
    traceId: context.traceId,
  };
  if (await findRepeatLimitStop(transaction, organizationId, runId)) {
    const limit = await allowMoreRepeatRounds(transaction, request);
    return {
      runId,
      kind: "repeat_limit",
      addedTries: limit.addedTries,
      decisionId: limit.decisionId,
      repeatKey: limit.repeatKey,
    };
  }
  const allowance = await allowMoreRepairTries(transaction, request);
  const decision = await transaction.query<{ id: string }>(
    `select id from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2 and ordinal = $3`,
    [organizationId, runId, allowance.decisionOrdinal],
  );
  return {
    runId,
    kind: "repair_loop",
    addedTries: allowance.addedTries,
    decisionId: decision.rows[0]!.id,
    repeatKey: null,
  };
}
