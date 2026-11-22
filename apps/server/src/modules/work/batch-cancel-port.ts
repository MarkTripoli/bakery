import type { OrganizationActor } from "../auth/application/authority.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { runControlAction } from "../execution/control.ts";

/**
 * The batch supervisor's way of cancelling a run (#58): the existing `runs.control`
 * action, called as the person who started the batch.
 *
 * It reuses that action's own handler, so a cancel reaches the worker, advances the
 * run and is audited exactly as if the person pressed Cancel. It is idempotent: the
 * command key is tied to the issue's request, so repeating it sends one command, and a
 * run that has already ended is the answer the supervisor wanted, not an error.
 */

export type BatchCancelPortDeps = {
  database: PgDatabase;
  /** Replaceable so a test can name the starter's authority without a database. */
  resolveCaller?: (
    database: PgDatabase,
    organizationId: string,
    principalId: string,
  ) => Promise<OrganizationActor>;
  /** Replaceable so a test can answer the control without an engine. */
  control?: typeof runControlAction;
};

export function createBatchCancelPort(deps: BatchCancelPortDeps) {
  const control = deps.control ?? runControlAction;
  const resolveCaller = deps.resolveCaller ??
    ((database, organizationId, principalId) =>
      withPgTransaction(database, (transaction) =>
        resolveOrganizationActor(
          transaction,
          principalId as never,
          organizationId as never,
        )));
  return async (
    transaction: PgTransactionClient,
    input: {
      organizationId: string;
      ticketRequestId: string;
      startedBy: string;
    },
  ): Promise<void> => {
    const request = await transaction.query<{ run_id: string | null }>(
      `select workflow_run_id as run_id from bakery.ticket_requests
        where organization_id = $1 and id = $2`,
      [input.organizationId, input.ticketRequestId],
    );
    const runId = request.rows[0]?.run_id ?? null;
    // No run yet: nothing to cancel. The request is not started work.
    if (runId === null) return;
    const authority = await resolveCaller(
      deps.database,
      input.organizationId,
      input.startedBy,
    );
    const key = `batch-cancel:${input.ticketRequestId}`;
    const context = {
      transaction,
      params: { id: runId },
      principal: { principalId: input.startedBy },
      authority,
      requestId: key,
      traceId: key,
      signal: new AbortController().signal,
      commandMetadata: {
        operation: "runs.control",
        idempotencyKey: key,
        target: runId,
      },
    } as unknown as ActionContext;
    try {
      await control(context, {
        action: "cancel",
        reason: "The batch was stopped.",
      } as never);
    } catch (error) {
      // Already over is what a cancel wants. Anything else is a real failure: the
      // tick counts it and tries again.
      if (error instanceof StandardError && error.code === "ALREADY_TERMINAL") {
        return;
      }
      throw error;
    }
  };
}
