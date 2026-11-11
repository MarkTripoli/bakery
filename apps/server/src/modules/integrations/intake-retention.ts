import type { Inngest } from "inngest";
import type { PgDatabase } from "../../platform/database.ts";
import { RouteStatus } from "./intake-receipts.ts";
import type { ReconcileDependencies } from "./reconcile.ts";

/**
 * Receipt retention.
 *
 * An hourly job deletes the receipts whose seven days are over, unless a route
 * of the receipt still has work to do. It belongs to the receipt store, not to
 * the route processor, and shares nothing with it but the route statuses.
 */

const INTAKE_RETENTION_FUNCTION_ID = "bakery-integration-intake-retention";

/** Receipts one retention batch deletes. */
export const RECEIPT_SWEEP_BATCH = 500;
/** Batches one retention run deletes at most; the next hourly run takes the rest. */
export const RECEIPT_SWEEP_MAX_BATCHES = 100;
/** Most receipts a caller may ask one retention batch to delete. */
export const RECEIPT_SWEEP_BATCH_CEILING = 5_000;
/** Most batches a caller may ask one retention run to make. */
export const RECEIPT_SWEEP_BATCHES_CEILING = 1_000;

/** What one retention run removed. */
export type ReceiptSweepResult = {
  /** Expired receipts deleted; their routes went with them. */
  deleted: number;
  /** Batches that deleted at least one receipt. */
  batches: number;
};

/** Routes that still have work to do; a receipt with one of these is not deleted. */
const ACTIVE_ROUTE_STATUSES: readonly RouteStatus[] = Object.freeze([
  RouteStatus.Pending,
  RouteStatus.Processing,
  RouteStatus.Deferred,
]);

/**
 * Deletes receipts whose `expires_at` has passed, `limit` at a time, until a
 * batch comes back short or `maxBatches` batches have run. Both are whole
 * numbers: `limit` from 1 to `RECEIPT_SWEEP_BATCH_CEILING`, `maxBatches` from
 * 1 to `RECEIPT_SWEEP_BATCHES_CEILING`, so a run is always finite.
 *
 * A receipt is kept while one of its routes is still `pending`, `processing`
 * or `deferred`: the route reads its receipt, and deleting the receipt would
 * cascade the route away under a worker that holds it, which then settles
 * nothing. Such a receipt leaves in the first run after its last route ends
 * `completed`, `ignored` or `failed`. The ten-attempt cap ends a route the
 * processor can claim; a route it cannot claim at all keeps its receipt, and
 * shows in the "Receipts held past their expiry" query of
 * operator-facing query. The check is part of the batch's own
 * query, so a receipt that is held back never uses up a slot of the batch.
 *
 * Each batch is one statement that locks its rows with `for update skip
 * locked`, so two sweeps, or a sweep and a route being settled, never wait on
 * each other's rows, and a batch that fails keeps nothing and holds nothing:
 * the batches before it stay deleted and the error reaches the caller. The
 * routes of a deleted receipt cascade with it. This is a system sweep across
 * organizations, because a receipt belongs to a registered App, not to an
 * organization, and it returns counts only: nothing it handles is logged.
 * Nothing else is touched: a redelivery of an expired delivery id is a new
 * receipt.
 */
export async function sweepExpiredReceipts(
  database: PgDatabase,
  limit = RECEIPT_SWEEP_BATCH,
  maxBatches = RECEIPT_SWEEP_MAX_BATCHES,
): Promise<ReceiptSweepResult> {
  if (
    !Number.isSafeInteger(limit) || limit < 1 ||
    limit > RECEIPT_SWEEP_BATCH_CEILING
  ) {
    throw new Error("INTEGRATION_INTAKE_RETENTION_LIMIT_INVALID");
  }
  if (
    !Number.isSafeInteger(maxBatches) || maxBatches < 1 ||
    maxBatches > RECEIPT_SWEEP_BATCHES_CEILING
  ) {
    throw new Error("INTEGRATION_INTAKE_RETENTION_BATCHES_INVALID");
  }
  const result: ReceiptSweepResult = { deleted: 0, batches: 0 };
  while (result.batches < maxBatches) {
    const removed = await database.query(
      `with doomed as materialized (
         select receipt.id from bakery.inbound_events as receipt
          where receipt.expires_at <= now()
            and not exists (
              select 1 from bakery.inbound_event_routes as route
               where route.inbound_event_id = receipt.id
                 and route.status = any($2::text[]))
          order by receipt.expires_at, receipt.id
          limit $1
            for update of receipt skip locked
       )
       delete from bakery.inbound_events receipt
        using doomed where receipt.id = doomed.id`,
      [limit, ACTIVE_ROUTE_STATUSES],
    );
    const count = removed.rowCount ?? 0;
    if (count === 0) break;
    result.deleted += count;
    result.batches += 1;
    if (count < limit) break;
  }
  return result;
}

/**
 * Every hour, at minute 17, deletes the receipts that expired seven days
 * after they arrived. Expiry is the only way a receipt leaves: the receiver
 * keeps no raw body, and a delivery id stays a duplicate for as long as its
 * receipt lives.
 */
export function createIntegrationIntakeRetention(
  options: Pick<ReconcileDependencies, "database"> & { client: Inngest },
) {
  return options.client.createFunction(
    {
      id: INTAKE_RETENTION_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "17 * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "sweep-expired-intake-receipts",
        () => sweepExpiredReceipts(options.database),
      ),
  );
}
