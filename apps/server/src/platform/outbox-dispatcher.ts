import type { PgDatabase } from "./database.ts";
import {
  DEFAULT_ENGINE_EVENT_TIMEOUT_MS,
  ENGINE_EVENT_CLOCK_SKEW_MARGIN_MS,
  type EngineEventClient,
  OutboxDeliveryError,
  OutboxDeliveryUncertainError,
} from "./inngest-event-client.ts";
import { toEngineEvent } from "./outbox-events.ts";
import {
  createOutboxRepository,
  type OutboxDeliveryResult,
} from "./outbox-repository.ts";
import type { ClaimedOutboxRow } from "./outbox-types.ts";

export type DispatchSummary = {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  readonly stale: number;
};

type OutboxDispatcherOptions = {
  readonly database: PgDatabase;
  readonly engine: EngineEventClient;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
};

export function createOutboxDispatcher(options: OutboxDispatcherOptions) {
  const leaseSeconds = options.leaseSeconds ?? 30;
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? Date.now;
  const replaySafetySeconds = Math.ceil(
    (
      (options.engine.timeoutMs ?? DEFAULT_ENGINE_EVENT_TIMEOUT_MS) +
      ENGINE_EVENT_CLOCK_SKEW_MARGIN_MS
    ) / 1_000,
  );
  const repository = createOutboxRepository({
    database: options.database,
    leaseSeconds,
    maxAttempts,
    replaySafetySeconds,
  });

  async function deliver(
    row: ClaimedOutboxRow,
    signal?: AbortSignal,
  ): Promise<OutboxDeliveryResult> {
    if (
      row.replayDeadlineAt !== null &&
      now() + replaySafetySeconds * 1_000 >= row.replayDeadlineAt.getTime()
    ) {
      return await repository.recordFailure(
        row,
        new OutboxDeliveryError("OUTBOX_RECONCILIATION_REQUIRED", false),
      );
    }
    try {
      const engineEventId = await options.engine.send(
        toEngineEvent(row),
        signal,
      );
      return await repository.recordSuccess(row, engineEventId);
    } catch (error) {
      const deliveryError = error instanceof OutboxDeliveryError
        ? error
        : new OutboxDeliveryUncertainError("DELIVERY_FAILED");
      return await repository.recordFailure(row, deliveryError);
    }
  }

  return {
    async dispatchBatch(
      limit = 25,
      signal?: AbortSignal,
    ): Promise<DispatchSummary> {
      const rows = await repository.claim(limit);
      const results = await Promise.all(
        rows.map((row) => deliver(row, signal)),
      );
      return {
        claimed: rows.length,
        delivered: results.filter((result) => result === "delivered").length,
        retried: results.filter((result) => result === "retried").length,
        failed: results.filter((result) => result === "failed").length,
        stale: results.filter((result) => result === "stale").length,
      };
    },
  };
}
