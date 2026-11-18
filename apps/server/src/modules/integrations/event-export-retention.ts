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
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rowCount: number | null }>;
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
 * Every statement is scoped by organization as well as connection. That is not
 * decoration: a connection id alone is a bare identifier, and an administrative
 * sweep is exactly the code that should not be able to remove another tenant's
 * history if it is ever handed a wrong id. The values are bound, never
 * interpolated - building SQL from an id is how a sweep becomes an injection
 * point even when the id is validated first.
 */
export async function deleteEventExportHistory(
  database: RetentionDatabase,
  input: { readonly organizationId: string; readonly connectionId: string },
): Promise<{
  readonly deliveries: number;
  readonly subscriptions: number;
  readonly destinations: number;
}> {
  if (!UUID.test(input.organizationId) || !UUID.test(input.connectionId)) {
    throw new TypeError("invalid_identifier");
  }

  const scope = [input.organizationId, input.connectionId] as const;

  const deliveries = await database.query(
    `delete from bakery.integration_deliveries
       where organization_id = $1
         and subscription_id in (
           select id from bakery.integration_event_subscriptions
            where organization_id = $1 and connection_id = $2
         )`,
    scope,
  );
  const subscriptions = await database.query(
    `delete from bakery.integration_event_subscriptions
       where organization_id = $1 and connection_id = $2`,
    scope,
  );
  const destinations = await database.query(
    `delete from bakery.integration_destinations
       where organization_id = $1 and connection_id = $2`,
    scope,
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
