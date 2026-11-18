/**
 * Retiring an event-export connection (issue #21).
 *
 * The delivery keys are `ON DELETE RESTRICT`, which is the whole point: a
 * delivery records an attempt that may already have reached a receiver, so it
 * must not vanish because a subscription or destination was tidied away. But
 * RESTRICT has an honest consequence that is easy to state and easy to forget:
 * once a connection has delivered anything, deleting that connection fails.
 *
 * That failure is correct and must not be "fixed" by loosening the keys. What it
 * needs instead is a named order that removes the history first, deliberately,
 * so the only way to delete a connection is the way that accounts for what it
 * sent. This module is that order.
 *
 * It lives beside the migration rather than in an operations script because the
 * order is a property of the schema: if a table is added that references a
 * delivery, this list is wrong and should fail loudly rather than silently leave
 * rows behind.
 */

/** Minimal query surface, so this runs inside the caller's transaction. */
export type RetentionDatabase = {
  query(text: string): Promise<{ rowCount: number | null }>;
};

/**
 * Deletes one connection's export history in dependency order and returns what
 * was removed.
 *
 * Must run as an administrative role. `bakery_app` deliberately holds no DELETE
 * on `integration_deliveries`, so the serving role cannot erase what it sent;
 * the permission error that produces is the intended behaviour and a test
 * asserts it, rather than a grant to be widened.
 *
 * Deliveries go first because they reference everything else; subscriptions
 * before destinations and resources because a subscription names both. The
 * connection itself is not removed here - this module only makes that possible.
 */
export async function deleteEventExportHistory(
  database: RetentionDatabase,
  connectionId: string,
): Promise<{
  readonly deliveries: number;
  readonly subscriptions: number;
  readonly destinations: number;
}> {
  // Bound as a literal rather than a parameter because these tables are cleaned
  // by an administrative task, and a parameterised identity is a smaller change
  // than making every statement here happen to be safe. The identifier is
  // validated as a UUID below instead.
  if (!UUID.test(connectionId)) {
    throw new TypeError("invalid_connection_id");
  }

  const deliveries = await database.query(
    `delete from bakery.integration_deliveries
       where subscription_id in (
         select id from bakery.integration_event_subscriptions
          where connection_id = '${connectionId}'
       )`,
  );
  const subscriptions = await database.query(
    `delete from bakery.integration_event_subscriptions
       where connection_id = '${connectionId}'`,
  );
  const destinations = await database.query(
    `delete from bakery.integration_destinations
       where connection_id = '${connectionId}'`,
  );

  return {
    deliveries: deliveries.rowCount ?? 0,
    subscriptions: subscriptions.rowCount ?? 0,
    destinations: destinations.rowCount ?? 0,
  };
}

/** The order above, as data, so a test can assert it stays dependency-safe. */
export const RETENTION_ORDER = [
  "bakery.integration_deliveries",
  "bakery.integration_event_subscriptions",
  "bakery.integration_destinations",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
