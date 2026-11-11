import type { QueryResultRow } from "pg";
import { withPgTransaction } from "./database.ts";
import type {
  ClaimedOutboxRow,
  OutboxRepositoryOptions,
} from "./outbox-types.ts";
import {
  OutboxDeliveryStateSchema,
  OutboxDeliveryStatus,
} from "./outbox-state.ts";
import {
  type EngineEventId,
  EngineEventIdSchema,
  OutboxDeliveryError,
  OutboxDeliveryUncertainError,
} from "./inngest-event-client.ts";
import { outboxRetryDelaySeconds } from "./outbox-events.ts";
import { claimOutboxRows } from "./outbox-claim.ts";

export type OutboxDeliveryResult =
  | "delivered"
  | "failed"
  | "retried"
  | "stale";

export function createOutboxRepository(options: OutboxRepositoryOptions) {
  async function claim(limit: number): Promise<readonly ClaimedOutboxRow[]> {
    return await claimOutboxRows(options, limit);
  }

  async function recordSuccess(
    row: ClaimedOutboxRow,
    engineEventId: EngineEventId,
  ): Promise<OutboxDeliveryResult> {
    const parsedEngineEventId = EngineEventIdSchema.parse(engineEventId);
    return await withPgTransaction(options.database, async (transaction) => {
      const result = await transaction.query<QueryResultRow>(
        `
        update bakery.outbox
        set status = $3, lease_token = null, lease_until = null,
          delivered_at = now(), engine_event_id = $4, last_error = null,
          updated_at = now()
        where id = $1 and lease_token = $2 and status = $5
        returning status, lease_token as "leaseToken", lease_until as "leaseUntil",
          delivered_at as "deliveredAt", engine_event_id as "engineEventId",
          last_error as "lastError"
      `,
        [
          row.id,
          row.leaseToken,
          OutboxDeliveryStatus.Delivered,
          parsedEngineEventId,
          OutboxDeliveryStatus.Sending,
        ],
      );
      if (result.rowCount !== 1) return "stale";
      const state = OutboxDeliveryStateSchema.parse(result.rows[0]);
      if (state.status !== OutboxDeliveryStatus.Delivered) {
        throw new Error("OUTBOX_SUCCESS_STATE_INVALID");
      }
      return "delivered";
    });
  }

  async function recordFailure(
    row: ClaimedOutboxRow,
    error: OutboxDeliveryError,
  ): Promise<OutboxDeliveryResult> {
    const terminal = !error.retryable ||
      row.attemptCount >= options.maxAttempts;
    const delay = outboxRetryDelaySeconds(row.attemptCount);
    const diagnostic = JSON.stringify({
      code: terminal && error instanceof OutboxDeliveryUncertainError
        ? "OUTBOX_RECONCILIATION_REQUIRED"
        : error.code,
      status: error.status,
    });
    return await withPgTransaction(options.database, async (transaction) => {
      const result = await transaction.query<QueryResultRow>(
        `
        update bakery.outbox
        set status = case when $3 then $4 else $5 end,
          lease_token = null, lease_until = null,
          next_attempt_at = case when $3 then next_attempt_at
            else now() + ($6 * interval '1 second') end,
          last_error = $7::jsonb, updated_at = now()
        where id = $1 and lease_token = $2 and status = $8
        returning status, lease_token as "leaseToken", lease_until as "leaseUntil",
          delivered_at as "deliveredAt", engine_event_id as "engineEventId",
          last_error as "lastError"
      `,
        [
          row.id,
          row.leaseToken,
          terminal,
          OutboxDeliveryStatus.Failed,
          OutboxDeliveryStatus.Pending,
          delay,
          diagnostic,
          OutboxDeliveryStatus.Sending,
        ],
      );
      if (result.rowCount !== 1) return "stale";
      const state = OutboxDeliveryStateSchema.parse(result.rows[0]);
      if (
        state.status !== OutboxDeliveryStatus.Failed &&
        state.status !== OutboxDeliveryStatus.Pending
      ) throw new Error("OUTBOX_FAILURE_STATE_INVALID");
      return terminal ? "failed" : "retried";
    });
  }

  return { claim, recordSuccess, recordFailure };
}
