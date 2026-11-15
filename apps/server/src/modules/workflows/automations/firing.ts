import type { PgTransactionClient } from "../../../platform/database.ts";
import { AUTOMATION_ROUTE_PURPOSE } from "../../integrations/intake-events.ts";

/** What a firing is created from. */
export type FiringInsert = Readonly<{
  organizationId: string;
  automationVersionId: string;
  /** The UTC instant that names the firing: one per version and instant. */
  scheduledAt: Date;
  status: "queued" | "skipped";
  pending: boolean;
  skippedCount: number;
  /**
   * The inbound event that triggered it, for an event trigger. Absent for a
   * schedule.
   */
  triggerEventId?: string | undefined;
}>;

/**
 * What came of creating a firing:
 *   - `inserted`: a new row.
 *   - `duplicate`: the version already has a firing for that instant, or for
 *     that event; nothing changed.
 *   - `event_not_routed`: the event was never routed to this organization (or
 *     does not exist); nothing was written.
 */
export type FiringInsertResult = "inserted" | "duplicate" | "event_not_routed";

/**
 * The one place a firing is created.
 *
 * An inbound event is a provider-wide receipt: `inbound_events` has no
 * organization, so the database cannot tie `trigger_event_id` to the
 * automation's organization by a foreign key. The organization's own record of
 * having received an event is a route (`inbound_event_routes`, one per event,
 * connection and purpose, carrying the organization). A firing may therefore
 * name an event only if that event is routed to the firing's organization for
 * an automation (the `automation` purpose, which the receipt creates only for
 * an event an enabled automation is bound to hear);
 * otherwise an automation of one organization could be made to fire, and to
 * record, an event that belongs to another. Every writer of firings goes
 * through here (the clock, and the event matcher that comes next).
 */
export async function insertFiring(
  transaction: PgTransactionClient,
  firing: FiringInsert,
): Promise<FiringInsertResult> {
  if (firing.triggerEventId !== undefined) {
    // The route of this consumer's own purpose: a route the integration
    // processor holds for the event (a fact refresh, a discovery) says the
    // organization received it, not that an automation was meant to hear it.
    const routed = await transaction.query(
      `select 1
         from bakery.inbound_event_routes route
        where route.inbound_event_id = $1 and route.organization_id = $2
          and route.purpose = $3
        limit 1`,
      [firing.triggerEventId, firing.organizationId, AUTOMATION_ROUTE_PURPOSE],
    );
    if (routed.rows.length === 0) return "event_not_routed";
  }
  const inserted = await transaction.query(
    `insert into bakery.automation_firings (
       organization_id, automation_version_id, scheduled_at, trigger_event_id,
       status, pending, skipped_count
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict do nothing`,
    [
      firing.organizationId,
      firing.automationVersionId,
      firing.scheduledAt.toISOString(),
      firing.triggerEventId ?? null,
      firing.status,
      firing.pending,
      firing.skippedCount,
    ],
  );
  return (inserted.rowCount ?? 0) > 0 ? "inserted" : "duplicate";
}
