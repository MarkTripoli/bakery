import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The one service principal that stands for Bakery itself when Bakery, not a
 * person, writes a record: the skills it installs into an organization are
 * created by it. It is a `service` principal, so it has no sign-in, belongs to
 * no organization and appears in no member list.
 */
export const BAKERY_PRINCIPAL_ID = "b4ae7000-0000-4000-8000-000000000001";

/** Makes sure the Bakery principal exists; safe to call any number of times. */
export async function ensureBakeryPrincipal(
  transaction: PgTransactionClient,
): Promise<void> {
  await transaction.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Bakery', 'service')
     on conflict (id) do nothing`,
    [BAKERY_PRINCIPAL_ID],
  );
}
