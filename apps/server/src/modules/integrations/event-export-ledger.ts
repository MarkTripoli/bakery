import type { PgDatabase } from "../../platform/database.ts";
import type { DeliveryLedger } from "./event-export-dispatch.ts";

/**
 * The production delivery ledger (#21).
 *
 * The dispatch path decides; this only writes what it decided. Recording and
 * settling are separate statements because they are separate facts: the row
 * exists from the moment an attempt is prepared, and what the receiver did is
 * known only afterwards. A single upsert would lose the window in which an
 * attempt is in flight, which is exactly the window a recovery sweep reads.
 */
export function createPostgresDeliveryLedger(
  database: PgDatabase,
): DeliveryLedger {
  return {
    async record(input) {
      const result = await database.query<{ id: string }>(
        `insert into bakery.integration_deliveries
           (id, organization_id, subscription_id, destination_id,
            source_event_id, event_kind, attempt, delivery_identity,
            payload_digest, status, acknowledgement_state, attempted_at,
            created_at, updated_at, version)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8,
                 'pending', 'uncertain', now(), now(), now(), 1)
         returning id`,
        [
          input.organizationId,
          input.subscriptionId,
          input.destinationId,
          input.sourceEventId,
          input.eventKind,
          input.attempt,
          input.deliveryIdentity,
          input.payloadDigest,
        ],
      );
      const id = result.rows[0]?.id;
      if (typeof id !== "string") {
        throw new Error("INTEGRATION_DELIVERY_NOT_RECORDED");
      }
      return { deliveryId: id };
    },

    async settle(input) {
      // `not_before` is what the recovery sweep reads to decide when a retry is
      // due, so it is written with the outcome rather than computed later from
      // the attempt time: a bounded backoff is a property of the outcome.
      await database.query(
        `update bakery.integration_deliveries
            set status = $2,
                acknowledgement_state = $3,
                response_status = $4,
                outcome_code = $5,
                not_before = $6,
                settled_at = now(),
                updated_at = now(),
                version = version + 1
          where id = $1`,
        [
          input.deliveryId,
          input.status,
          input.acknowledgementState,
          input.responseStatus,
          input.outcomeCode,
          input.notBefore,
        ],
      );
    },
  };
}
