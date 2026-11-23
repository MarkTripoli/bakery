import { appendDomainEvent } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";

// Kept apart from the dispatcher so the projection, which engine and execution
// code import, can ask for it without importing the run admission it starts.

/**
 * Asks for the dispatcher through the outbox, in the caller's transaction, so
 * the request commits exactly when the state that makes a lane startable does.
 * It bumps the plan's version first, so each request is its own event and a
 * lane that becomes ready after another ended is never swallowed as a repeat of
 * the earlier request. Nothing is asked for a plan that is not materialized or
 * whose lanes none names what it runs. Returns whether a request was written.
 */
export async function requestLaneDispatch(
  transaction: PgTransactionClient,
  input: { organizationId: string; planId: string; traceId: string },
): Promise<boolean> {
  const eventType = "coordination.lanes_dispatch_requested";
  const plan = await transaction.query<
    { spec: unknown; application_id: string; parent_task_id: string }
  >(
    `select spec, application_id, parent_task_id from bakery.coordination_plans
      where organization_id = $1 and id = $2 and status = 'materialized'`,
    [input.organizationId, input.planId],
  );
  const row = plan.rows[0];
  if (!row) return false;
  // Only whether some lane names what it runs is asked here, so a plan stored
  // with a spec this does not read is simply not one the engine starts.
  const lanes = (row.spec as { lanes?: unknown } | null)?.lanes;
  const names = Array.isArray(lanes) &&
    lanes.some((lane) =>
      lane !== null && typeof lane === "object" &&
      (lane as { run?: unknown }).run !== undefined
    );
  if (!names) return false;
  const bumped = await transaction.query<{ version: number }>(
    `update bakery.coordination_plans
        set updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning version`,
    [input.organizationId, input.planId],
  );
  const version = bumped.rows[0]!.version;
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: row.application_id,
    repositoryId: null,
    taskId: row.parent_task_id,
    conversationId: null,
    eventType,
    aggregateId: input.planId,
    aggregateVersion: version,
    payload: { planId: input.planId },
    traceId: input.traceId,
    outboxDeliveryKey:
      `coordination-plan:${input.planId}:lane-dispatch:${version}`,
  });
  return true;
}
