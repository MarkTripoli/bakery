import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The reason `runs.create` gives when the task's ticket request is suspended:
 * the request, not the task, decides whether implementation may start.
 */
export const TICKET_REQUEST_SUSPENDED_REASON = "ticket_request_suspended";

/**
 * Whether a suspended ticket request owns the task, so a run must not start.
 * Returns the refusal reason or null. A plain select with no row lock: the
 * ticket writers hold source, ticket and application locks before they touch
 * a task, and `runs.create` already holds the application, so a lock here
 * could only invert that order. A `runs.create` that read before a suspension
 * committed can still create a run; the recheck pauses such a run. This file
 * imports nothing from conversation or integrations.
 */
export async function ticketRequestBlocksRun(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<string | null> {
  const result = await transaction.query(
    `select 1
       from bakery.ticket_requests as request
       join bakery.ticket_task_links as link
         on link.organization_id = request.organization_id
        and link.id = request.ticket_task_link_id
      where request.organization_id = $1 and link.task_id = $2
        and request.disposition = 'suspended'
      limit 1`,
    [organizationId, taskId],
  );
  return result.rows.length === 0 ? null : TICKET_REQUEST_SUSPENDED_REASON;
}
