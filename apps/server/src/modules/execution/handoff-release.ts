import type { PgTransactionClient } from "../../platform/database.ts";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { NON_REPLAY_SAFE_EFFECT_STATES } from "./handoff-manifest.ts";

/** Parked continuations one coordinator pass releases at most. */
const RELEASE_BATCH = 50;

/**
 * Queues the jobs a handoff continuation parked in `awaiting_reconciliation`
 * once every external effect of their step is settled (confirmed or failed).
 *
 * A continuation with an uncertain effect retires its source and advances the
 * fence but does not queue the job: starting a model turn before the effect is
 * reconciled could repeat it. Reconciliation itself is the effects module's
 * work; this only reads its result. A job is released as a fresh session (its
 * checkpoints were cleared when it parked), at the fence it already holds, so
 * nothing the retired source still has can publish. Only a job parked by a
 * continuation is touched, never one another path put in that state.
 *
 * Rows are locked `skip locked`, so concurrent coordinators release each job
 * once, and one pass is bounded, so it cannot run long.
 */
export async function releaseReconciledHandoffs(
  transaction: PgTransactionClient,
): Promise<number> {
  const parked = await transaction.query<{
    organization_id: string;
    id: string;
    fence: string;
    continuation_id: string;
    source_attempt_id: string;
  }>(
    `select j.organization_id, j.id, j.current_fence::text as fence,
            c.id as continuation_id, c.source_attempt_id
       from bakery.jobs as j
       join bakery.handoff_continuations as c
         on c.organization_id = j.organization_id and c.job_id = j.id
        and c.new_fence = j.current_fence
      where j.status = 'awaiting_reconciliation'
        and not exists (
          select 1 from bakery.external_effects as e
           where e.organization_id = j.organization_id
             and e.run_step_id = j.run_step_id
             and e.status = any($1::text[]))
      order by j.updated_at, j.id
      limit $2
        for update of j skip locked`,
    [[...NON_REPLAY_SAFE_EFFECT_STATES], RELEASE_BATCH],
  );
  let released = 0;
  for (const job of parked.rows) {
    const queued = await transaction.query<{ version: number }>(
      `update bakery.jobs
          set status = 'queued', available_at = clock_timestamp(),
              updated_at = clock_timestamp(), version = version + 1
        where organization_id = $1 and id = $2
          and status = 'awaiting_reconciliation' and current_fence = $3::bigint
        returning version`,
      [job.organization_id, job.id, job.fence],
    );
    if (!queued.rows[0]) continue;
    released += 1;
    await appendDomainEvent(transaction, {
      organizationId: job.organization_id,
      applicationId: null,
      repositoryId: null,
      eventType: "job.updated",
      aggregateId: job.id,
      aggregateVersion: queued.rows[0].version,
      payload: {
        jobId: job.id,
        attemptId: job.source_attempt_id,
        version: queued.rows[0].version,
      },
      traceId: `handoff-release:${job.continuation_id}`,
    });
    await appendAudit(transaction, {
      organizationId: job.organization_id,
      principalId: null,
      operation: "handoffContinuations.released",
      resourceType: "handoff_continuation",
      resourceId: job.continuation_id,
      requestId: `handoff-release:${job.continuation_id}`,
      traceId: `handoff-release:${job.continuation_id}`,
      details: { jobId: job.id, fence: job.fence, reason: "effects_settled" },
    });
  }
  return released;
}
