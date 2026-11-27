import type { PgTransactionClient } from "../../../platform/database.ts";

/**
 * A run in one of these statuses no longer occupies its automation. `blocked`
 * is not among them: a blocked run is waiting to be unblocked, so it still
 * holds its automation.
 */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "canceled",
  "needs_human",
] as const;

/**
 * Whether a run of the automation is still active, from any of its firings and
 * through any of its versions (a newer version does not free the automation of
 * an older version's run). The caller holds the automation's definition lock,
 * so the answer cannot change under it.
 */
export async function hasActiveRun(
  transaction: PgTransactionClient,
  organizationId: string,
  automationId: string,
): Promise<boolean> {
  const active = await transaction.query(
    `select 1
       from bakery.automation_firings firing
       join bakery.automation_versions version
         on version.organization_id = firing.organization_id
        and version.id = firing.automation_version_id
       join bakery.workflow_runs run
         on run.organization_id = firing.organization_id
        and run.id = firing.run_id
      where firing.organization_id = $1
        and version.automation_id = $2
        and run.status <> all($3::text[])
      limit 1`,
    [organizationId, automationId, TERMINAL_RUN_STATUSES],
  );
  return active.rows.length > 0;
}

/**
 * What holds the automation: a run that has not ended, and a queued firing
 * that is admitted and waiting for its run to start. Read under the
 * definition's lock (or the claim of the tick), so neither can change under it.
 */
export async function occupancyOf(
  transaction: PgTransactionClient,
  organizationId: string,
  automationId: string,
): Promise<{ running: boolean; waiting: boolean }> {
  const waiting = await transaction.query(
    `select 1
       from bakery.automation_firings firing
       join bakery.automation_versions version
         on version.organization_id = firing.organization_id
        and version.id = firing.automation_version_id
      where firing.organization_id = $1
        and version.automation_id = $2
        and firing.status = 'queued' and firing.pending
      limit 1`,
    [organizationId, automationId],
  );
  return {
    running: await hasActiveRun(transaction, organizationId, automationId),
    waiting: waiting.rows.length > 0,
  };
}
