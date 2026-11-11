import type { PgTransactionClient } from "./database.ts";

/**
 * Allocates the next per-organization event sequence from `bakery.event_clock`,
 * seeding it from the current `domain_events` high-water mark on first use.
 * Shared by every module that appends domain events so the sequence stays a
 * single monotonic stream regardless of which module wrote the event.
 */
export async function nextOrganizationSequence(
  transaction: PgTransactionClient,
  organizationId: string,
): Promise<string> {
  const clock = await transaction.query<{ sequence: string }>(
    `insert into bakery.event_clock (
       organization_id, stream, next_seq
     )
     select $1, 'domain_events', coalesce(max(organization_sequence), 0) + 2
     from bakery.domain_events
     where organization_id = $1
     on conflict (organization_id, stream) do update
       set next_seq = bakery.event_clock.next_seq + 1
     returning (next_seq - 1)::text as sequence`,
    [organizationId],
  );
  const sequence = clock.rows[0]?.sequence;
  if (!sequence) throw new Error("EVENT_CLOCK_UNAVAILABLE");
  return sequence;
}
