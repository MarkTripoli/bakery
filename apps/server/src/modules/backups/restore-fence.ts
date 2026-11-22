import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The restore fence (issue #64 slice E1, also #49).
 *
 * After the stores of a backup were restored in place, the database says what
 * was true at the backup. Everything that ran after it is gone from the
 * database but not from the world: an effect that was only `prepared` at the
 * backup may have been sent since, a worker may still hold an attempt the
 * database now shows as leased, and a worker's own journal on disk is newer
 * than the database. The fence closes those doors before any service starts:
 *
 *  - Every effect still `prepared` or `submitted` becomes `uncertain`. An
 *    uncertain effect is only ever reconciled (a read), never sent, so a
 *    restore cannot make the installation send anything twice.
 *  - Every attempt that was leased, running or canceling is quarantined and its
 *    job's fence moves, so an old holder is refused with LEASE_FENCED. The job
 *    itself is requeued by the coordinator, which does not run until an
 *    administrator re-enables dispatch.
 *  - Every worker host that was not revoked is revoked, so it must be enrolled
 *    again: a worker cannot carry a pre-restore session across a restore.
 *
 * Then it writes the restore record, which is what keeps the installation
 * closed (see installation_restores). All of it is one transaction: either the
 * whole fence is applied and the record exists, or nothing changed. It runs as
 * the database owner, from the `restore-fence` task, with every service
 * stopped. It reads nothing outside the database and sends nothing.
 */

export type RestoreFenceInput = {
  /** The directory name of the backup set that was restored. */
  readonly backupName: string;
  /** The set's database-clock cutoff, when it recorded one. */
  readonly cutoffAt: string | null;
};

export type RestoreFenceResult = {
  readonly restoreId: string;
  readonly effectsHeld: number;
  readonly attemptsQuarantined: number;
  readonly jobsAwaitingReconciliation: number;
  readonly workersRevoked: number;
};

export const RESTORE_OPERATION = "installation.restore";

/** The evidence a held effect carries: where the doubt came from, and no content. */
export const RESTORE_EVIDENCE_REASON = "outcome_unknown_after_restore";

export async function applyRestoreFence(
  transaction: PgTransactionClient,
  input: RestoreFenceInput,
): Promise<RestoreFenceResult> {
  const restoreId = crypto.randomUUID();
  const requestId = `restore:${restoreId}`;
  const traceId = restoreId;

  // 1. Effects. `uncertain` needs a dispatch generation of at least 1, so a
  // never-claimed `prepared` row moves to 1 and a submitted one moves on by one.
  const effects = await transaction.query<{ id: string }>(
    `update bakery.external_effects
        set status = 'uncertain',
            dispatch_generation = dispatch_generation + 1,
            lease_expires_at = null,
            next_retry_at = null,
            reconciliation_evidence = jsonb_build_object(
              'source', 'restore',
              'reason', '${RESTORE_EVIDENCE_REASON}',
              'previousStatus', status,
              'restoreId', $1::text
            ),
            updated_at = clock_timestamp(),
            version = version + 1
      where status in ('prepared', 'submitted')
      returning id`,
    [restoreId],
  );

  // 2. Attempts, then the jobs they belong to.
  const attempts = await transaction.query<{
    id: string;
    organizationId: string;
    jobId: string;
    fence: string;
  }>(
    `update bakery.job_attempts
        set status = 'quarantined',
            ended_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            version = version + 1
      where status in ('leased', 'running', 'canceling')
      returning id, organization_id as "organizationId", job_id as "jobId",
                fence::text as fence`,
  );
  let jobsAwaiting = 0;
  for (const attempt of attempts.rows) {
    const job = await transaction.query<{ version: number }>(
      `update bakery.jobs
          set status = 'awaiting_reconciliation',
              current_fence = current_fence + 1,
              updated_at = clock_timestamp(),
              version = version + 1
        where organization_id = $1 and id = $2
          and status in ('leased', 'running', 'awaiting_reconciliation')
          and current_fence = $3
        returning version`,
      [attempt.organizationId, attempt.jobId, attempt.fence],
    );
    if (job.rows[0] !== undefined) {
      jobsAwaiting += 1;
      await appendDomainEvent(transaction, {
        organizationId: attempt.organizationId,
        eventType: "job.updated",
        aggregateId: attempt.jobId,
        aggregateVersion: job.rows[0].version,
        payload: {
          jobId: attempt.jobId,
          attemptId: attempt.id,
          version: job.rows[0].version,
        },
        traceId,
      });
    }
    await appendAudit(transaction, {
      organizationId: attempt.organizationId,
      principalId: null,
      operation: "workers.attempt_quarantined",
      resourceType: "job_attempt",
      resourceId: attempt.id,
      requestId,
      traceId,
      details: { jobId: attempt.jobId, reason: "restore" },
    });
  }

  // 3. Worker hosts: terminal for the credential generation, as `workers.revoke`
  // is, so every worker is enrolled again.
  const workers = await transaction.query<{
    id: string;
    organizationId: string;
    version: number;
  }>(
    `update bakery.worker_hosts
        set status = 'revoked', desired_mode = 'revoked',
            credential_generation = credential_generation + 1,
            updated_at = current_timestamp, version = version + 1
      where status <> 'revoked'
      returning id, organization_id as "organizationId", version`,
  );
  for (const worker of workers.rows) {
    await appendDomainEvent(transaction, {
      organizationId: worker.organizationId,
      eventType: "worker.updated",
      aggregateId: worker.id,
      aggregateVersion: worker.version,
      workerHostId: worker.id,
      payload: { resourceId: worker.id, resourceVersion: worker.version },
      traceId,
    });
    await appendAudit(transaction, {
      organizationId: worker.organizationId,
      principalId: null,
      operation: "workers.revoke",
      resourceType: "worker_host",
      resourceId: worker.id,
      requestId,
      traceId,
      details: { reason: "restore" },
    });
  }

  // 4. The record, last: it exists only if the whole fence applied.
  await transaction.query(
    `insert into bakery.installation_restores (
       id, backup_name, cutoff_at, effects_held, attempts_quarantined,
       jobs_awaiting_reconciliation, workers_revoked
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      restoreId,
      input.backupName,
      input.cutoffAt,
      effects.rows.length,
      attempts.rows.length,
      jobsAwaiting,
      workers.rows.length,
    ],
  );
  // Counts and the set's name only: never an effect's target or arguments.
  await appendAudit(transaction, {
    organizationId: null,
    principalId: null,
    operation: RESTORE_OPERATION,
    resourceType: "installation_restore",
    resourceId: restoreId,
    requestId,
    traceId,
    details: {
      backupName: input.backupName,
      effectsHeld: effects.rows.length,
      attemptsQuarantined: attempts.rows.length,
      jobsAwaitingReconciliation: jobsAwaiting,
      workersRevoked: workers.rows.length,
    },
  });
  return {
    restoreId,
    effectsHeld: effects.rows.length,
    attemptsQuarantined: attempts.rows.length,
    jobsAwaitingReconciliation: jobsAwaiting,
    workersRevoked: workers.rows.length,
  };
}
