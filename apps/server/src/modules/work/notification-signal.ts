import {
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";

/**
 * Records that one recipient's inbox changed, in the transaction that changed
 * it. The event names only the recipient and the inbox's newest revision; it
 * carries no notification content. It has no application, task or
 * conversation scope, so the events stream delivers it only to that
 * principal's own inbox subscription, and the client re-reads its count and
 * list from the REST operations.
 */
export async function signalInboxChanged(
  transaction: PgTransactionClient,
  input: { organizationId: string; recipientId: string; traceId: string },
): Promise<void> {
  const revision = await transaction.query<{ revision: number | null }>(
    `select max(revision) as revision from bakery.notifications
     where organization_id = $1 and recipient_id = $2`,
    [input.organizationId, input.recipientId],
  );
  const version = Math.max(1, revision.rows[0]?.revision ?? 1);
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    recipientId: input.recipientId,
    eventType: "notifications.inbox_changed",
    aggregateId: input.recipientId,
    aggregateVersion: version,
    payload: { resourceId: input.recipientId, resourceVersion: version },
    traceId: input.traceId,
  });
}
