import { StandardError } from "@bakery/contracts/http";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import {
  type BudgetPolicy,
  finishToolCall,
  reserveToolCall,
  type ToolCallReservation,
} from "../work/budget.ts";

/**
 * What the tool.call runner asks of the budget for a step that names a per-call
 * cost ceiling (#439; docs/technical-design/25-one-engine.md 15.4). The ceiling
 * is held on the run's and the installation's accounts before anything is sent,
 * the way a model step's reservation is, and ended once the call is known:
 * settled at the ceiling when the call may have run (a tool reports no cost, so
 * it is never charged less), released when nothing was sent.
 */
export type ToolCallCosts = Readonly<{
  /** Holds the ceiling; refuses with `budget_cap_exceeded` when either account cannot cover it. A replay finds its own hold. */
  reserve(
    call: Readonly<{
      organizationId: string;
      runId: string;
      runStepId: string;
      callId: string;
      ceilingUsd: string;
    }>,
  ): Promise<ToolCallReservation>;
  /** Ends the hold; a no-op when there is none or it already ended. */
  finish(
    call: Readonly<{
      organizationId: string;
      runStepId: string;
      callId: string;
      outcome: "settle" | "release";
    }>,
  ): Promise<void>;
}>;

/** The refusal reason of a hold that did not fit, or null for any other error. */
export function budgetRefusalReason(error: unknown): string | null {
  if (!(error instanceof StandardError) || error.code !== "STATE_CONFLICT") {
    return null;
  }
  const reason = error.params?.reason;
  return typeof reason === "string" ? reason : null;
}

export function createPostgresToolCallCosts(
  database: PgDatabase,
  policy: BudgetPolicy | undefined,
): ToolCallCosts {
  return {
    reserve: (call) =>
      withPgTransaction(
        database,
        (transaction) => reserveToolCall(transaction, { ...call, policy }),
      ),
    finish: async (call) => {
      await withPgTransaction(
        database,
        (transaction) => finishToolCall(transaction, call),
      );
    },
  };
}
