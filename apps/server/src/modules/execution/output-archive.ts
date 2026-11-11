import {
  closeOutputStreamWithoutAuthority,
  expireOutputHistory,
  loadFinalizationGrant,
  type PgDatabase,
  purgeFinalizationIntents,
  recordFinalizationFailure,
  TRANSCRIPT_LIMITS,
  withPgTransaction,
} from "@bakery/persistence";
import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import { finalizeOutputTranscript } from "./output-transcript.ts";

type GrantIdentity = Readonly<{ organizationId: string; grantId: string }>;

const SWEEP_GRANTS = 50;
const SWEEP_EXPIRY_PASSES = 8;

/**
 * Retries one stored finalization grant under the authority minted at close.
 * The sweep never mints authority: scope, author and payload all come from the
 * grant, and a revoked or re-assigned worker host cannot be published for.
 */
export async function retryOutputFinalization(
  database: PgDatabase,
  identity: GrantIdentity,
): Promise<void> {
  try {
    await withPgTransaction(database, async (transaction) => {
      const grant = await loadFinalizationGrant(
        transaction,
        identity.organizationId,
        identity.grantId,
      );
      if (!["pending", "retryable"].includes(grant.state)) return;
      if (!grant.payload_digest) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      const host = (await transaction.query<
        { status: string; principal_id: string }
      >(
        `select status, principal_id from bakery.worker_hosts
          where organization_id=$1 and id=$2`,
        [grant.organization_id, grant.worker_host_id],
      )).rows[0];
      if (
        !host || host.status === "revoked" ||
        host.principal_id !== grant.author_id
      ) throw new StandardError({ code: "PRECONDITION_FAILED" });
      await finalizeOutputTranscript(transaction, {
        organizationId: grant.organization_id,
        workerHostId: grant.worker_host_id,
        workerPrincipalId: grant.author_id,
        attemptId: grant.attempt_id,
      }, {
        grantId: grant.id,
        sessionId: grant.session_id,
        frozenHighwater: String(grant.frozen_highwater),
        payloadDigest: grant.payload_digest,
      });
    });
  } catch (error) {
    const terminal = error instanceof StandardError &&
      error.code === "PRECONDITION_FAILED";
    await withPgTransaction(database, async (transaction) => {
      await recordFinalizationFailure(
        transaction,
        identity.organizationId,
        identity.grantId,
        !terminal,
      );
    });
    throw error;
  }
}

/** Grants the close hook or worker could not publish, oldest attempt first. */
export async function pendingOutputFinalizations(
  database: PgDatabase,
): Promise<GrantIdentity[]> {
  return (await database.query<GrantIdentity>(
    `select organization_id as "organizationId", id as "grantId"
       from bakery.session_output_finalizations
      where state in ('pending','retryable') and payload_digest is not null
        and grant_expires_at > clock_timestamp() and attempt_count < $1
      order by updated_at, id limit $2`,
    [TRANSCRIPT_LIMITS.maxAttempts, SWEEP_GRANTS],
  )).rows;
}

/**
 * Streams closed before execution-owned finalization have no grant and can
 * never be published; record that explicitly instead of leaving them pending.
 */
export async function markUngrantedOutputStreams(
  database: PgDatabase,
): Promise<number> {
  const result = await database.query(
    `update bakery.session_output_streams
        set archive_state='failed', archive_failure='no_finalization_grant',
            archive_attempted_at=clock_timestamp(),
            history_expires_at=coalesce(history_expires_at,
              clock_timestamp()+interval '30 days')
      where (organization_id, id) in (
        select stream.organization_id, stream.id
          from bakery.session_output_streams stream
         where stream.closed
           and (stream.archive_state='pending'
             or (stream.archive_state='failed' and stream.history_expires_at is null))
           and not exists (
             select 1 from bakery.session_output_finalizations grant_row
              where grant_row.organization_id=stream.organization_id
                and grant_row.session_id=stream.id)
         limit $1)`,
    [SWEEP_GRANTS],
  );
  return result.rowCount ?? 0;
}

/**
 * Unpublished grants past their deadline can never be retried; record that
 * durably instead of leaving them reported as retryable.
 */
export async function failLapsedOutputFinalizations(
  database: PgDatabase,
): Promise<number> {
  return await withPgTransaction(database, async (transaction) => {
    const lapsed = await transaction.query<
      { organization_id: string; id: string }
    >(
      `update bakery.session_output_finalizations
          set state='failed',updated_at=clock_timestamp()
        where (organization_id, id) in (
          select organization_id, id from bakery.session_output_finalizations
           where state in ('assembling','pending','retryable')
             and grant_expires_at <= clock_timestamp()
           order by grant_expires_at, id limit $1
           for update)
        returning organization_id, id`,
      [SWEEP_GRANTS],
    );
    for (const grant of lapsed.rows) {
      await transaction.query(
        `update bakery.session_output_streams stream
            set archive_state='failed',archive_failure='archive_grant_expired',
                archive_attempted_at=clock_timestamp()
           from bakery.session_output_finalizations grant_row
          where grant_row.organization_id=$1 and grant_row.id=$2
            and stream.organization_id=grant_row.organization_id
            and stream.id=grant_row.session_id
            and stream.archive_state in ('pending','failed')`,
        [grant.organization_id, grant.id],
      );
      await purgeFinalizationIntents(
        transaction,
        grant.organization_id,
        grant.id,
      );
    }
    return lapsed.rowCount ?? 0;
  });
}

/**
 * Streams of terminal jobs that no worker closed (server termination,
 * cancellation, attempt exhaustion) close without transcript authority.
 */
export async function closeAbandonedOutputStreams(
  database: PgDatabase,
): Promise<number> {
  return await withPgTransaction(database, async (transaction) => {
    const open = await transaction.query<
      { organization_id: string; id: string }
    >(
      `select stream.organization_id, stream.id
         from bakery.session_output_streams stream
         join bakery.jobs job
           on job.organization_id=stream.organization_id and job.id=stream.job_id
        where not stream.closed
          and job.status in ('completed','failed','canceled')
        order by stream.organization_id, stream.id limit $1
        for update of stream skip locked`,
      [SWEEP_GRANTS],
    );
    for (const stream of open.rows) {
      await closeOutputStreamWithoutAuthority(
        transaction,
        stream.organization_id,
        stream.id,
      );
    }
    return open.rowCount ?? 0;
  });
}

/** Bounded expiry passes; each pass is its own short transaction. */
export async function sweepOutputHistory(
  database: PgDatabase,
  now = new Date(),
): Promise<number> {
  let deleted = 0;
  for (let pass = 0; pass < SWEEP_EXPIRY_PASSES; pass++) {
    const count = await withPgTransaction(
      database,
      (transaction) => expireOutputHistory(transaction, now),
    );
    deleted += count;
    if (count < TRANSCRIPT_LIMITS.cleanupBatches) break;
  }
  return deleted;
}

/** One full archive sweep: retry stored grants, then expire transient history. */
export async function sweepOutputTranscripts(
  database: PgDatabase,
): Promise<{ finalized: number; failed: number; expired: number }> {
  let finalized = 0;
  let failed = 0;
  for (const identity of await pendingOutputFinalizations(database)) {
    try {
      await retryOutputFinalization(database, identity);
      finalized++;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed++;
    }
  }
  await failLapsedOutputFinalizations(database);
  await closeAbandonedOutputStreams(database);
  await markUngrantedOutputStreams(database);
  return { finalized, failed, expired: await sweepOutputHistory(database) };
}

export function createOutputArchiveWorkflow(
  options: Readonly<{ client: Inngest; database: PgDatabase }>,
) {
  return options.client.createFunction(
    {
      id: "bakery-output-archive",
      retries: 3,
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const candidates = await step.run(
        "find-pending-finalizations",
        () => pendingOutputFinalizations(options.database),
      );
      for (const identity of candidates) {
        await step.run(
          `finalize-${identity.grantId}`,
          async () => {
            try {
              await retryOutputFinalization(options.database, identity);
              return { finalized: true };
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              // The durable retryable state is retried by the next sweep; one
              // unavailable grant must not prevent other streams progressing.
              return { finalized: false };
            }
          },
        );
      }
      await step.run(
        "fail-lapsed-finalizations",
        () => failLapsedOutputFinalizations(options.database),
      );
      await step.run(
        "close-abandoned-output",
        () => closeAbandonedOutputStreams(options.database),
      );
      await step.run(
        "mark-ungranted-output",
        () => markUngrantedOutputStreams(options.database),
      );
      return await step.run(
        "expire-output-history",
        () => sweepOutputHistory(options.database),
      );
    },
  );
}
