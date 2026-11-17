import type { Inngest } from "inngest";
import type { PgDatabase } from "../../platform/database.ts";

/**
 * Reclaims the parts of upload sessions that were never completed.
 *
 * A session names a digest and a size and then waits for parts. Completion is
 * the only path that removes them, so a client that gives up - which is the
 * common case, not the exceptional one - leaves its parts in Postgres forever.
 * Each part is a `bytea` of up to 49 KiB and a session may hold thousands, so
 * an abandoned upload is an unbounded write-only store that nothing reads.
 *
 * Expiry is the whole rule, and it is deliberately not a second window. A
 * session's deadline is absolute: it is set when the session opens and never
 * extended, and `lockUploadSession` already refuses a part or a completion past
 * it. So a session past `expires_at` is exactly the abandoned one, and a
 * shorter "no part for N hours" window would reap sessions a client can still
 * legitimately resume - it would turn a resumable upload into a race against
 * the reaper. The deadline is the contract; the reaper only enforces it.
 *
 * A reaped session is a state flip, not a row delete. The application role has
 * `delete` on the parts table and only `select, insert, update` on the sessions
 * table, which is the right shape: the parts are the storage being reclaimed,
 * while the session is a record of what was attempted and stays readable.
 */

const BLOB_UPLOAD_REAPER_FUNCTION_ID = "bakery-knowledge-blob-upload-reaper";

/** Sessions one reaper batch reclaims. */
export const BLOB_UPLOAD_REAP_BATCH = 200;
/** Batches one reaper run reclaims at most; the next hourly run takes the rest. */
export const BLOB_UPLOAD_REAP_MAX_BATCHES = 100;
/** Most sessions a caller may ask one batch to reclaim. */
export const BLOB_UPLOAD_REAP_BATCH_CEILING = 5_000;
/** Most batches a caller may ask one run to make. */
export const BLOB_UPLOAD_REAP_BATCHES_CEILING = 1_000;

/** What one reaper run reclaimed. */
export type BlobUploadReapResult = {
  /** Sessions moved from `pending` to `abandoned`. */
  abandoned: number;
  /** Parts deleted; the bytes that were actually reclaimed. */
  partsDeleted: number;
  /** Batches that reclaimed at least one session. */
  batches: number;
};

/**
 * Reclaims expired upload sessions, `limit` at a time, until a batch comes back
 * short or `maxBatches` batches have run. Both are whole numbers: `limit` from
 * 1 to `BLOB_UPLOAD_REAP_BATCH_CEILING`, `maxBatches` from 1 to
 * `BLOB_UPLOAD_REAP_BATCHES_CEILING`, so a run is always finite.
 *
 * Each batch is one statement. The sessions are locked with `for update skip
 * locked`, so two reapers, or a reaper and a client completing, never wait on
 * each other's rows: a session being completed is skipped by this run and
 * reaped by a later one if it is still pending. The parts are deleted and the
 * session is flipped in the same statement, so a batch that fails keeps
 * nothing and holds nothing - the batches before it stay reclaimed and the
 * error reaches the caller.
 *
 * It is idempotent: a session already `abandoned` is not `pending`, so a second
 * run over the same rows reclaims nothing and reports zero. It returns counts
 * only, because it is a system sweep across organizations and nothing it
 * handles is a person's request.
 */
export async function reapAbandonedBlobUploads(
  database: Pick<PgDatabase, "query">,
  limit = BLOB_UPLOAD_REAP_BATCH,
  maxBatches = BLOB_UPLOAD_REAP_MAX_BATCHES,
): Promise<BlobUploadReapResult> {
  if (
    !Number.isSafeInteger(limit) || limit < 1 ||
    limit > BLOB_UPLOAD_REAP_BATCH_CEILING
  ) {
    throw new Error("BLOB_UPLOAD_REAP_LIMIT_INVALID");
  }
  if (
    !Number.isSafeInteger(maxBatches) || maxBatches < 1 ||
    maxBatches > BLOB_UPLOAD_REAP_BATCHES_CEILING
  ) {
    throw new Error("BLOB_UPLOAD_REAP_BATCHES_INVALID");
  }
  const result: BlobUploadReapResult = {
    abandoned: 0,
    partsDeleted: 0,
    batches: 0,
  };
  while (result.batches < maxBatches) {
    const reclaimed = await database.query<{
      abandoned: number;
      parts_deleted: number;
    }>(
      `with doomed as materialized (
         select session.id, session.organization_id
           from bakery.blob_upload_sessions as session
          where session.state = 'pending'
            and session.expires_at <= now()
          order by session.expires_at, session.id
          limit $1
            for update of session skip locked
       ),
       removed as (
         delete from bakery.blob_upload_parts as part
          using doomed
          where part.organization_id = doomed.organization_id
            and part.session_id = doomed.id
         returning 1
       ),
       flipped as (
         update bakery.blob_upload_sessions as session
            set state = 'abandoned', updated_at = now()
           from doomed
          where session.organization_id = doomed.organization_id
            and session.id = doomed.id
         returning 1
       )
       select (select count(*) from flipped)::int as abandoned,
              (select count(*) from removed)::int as parts_deleted`,
      [limit],
    );
    const row = reclaimed.rows[0];
    const abandoned = row?.abandoned ?? 0;
    if (abandoned === 0) break;
    result.abandoned += abandoned;
    result.partsDeleted += row?.parts_deleted ?? 0;
    result.batches += 1;
    if (abandoned < limit) break;
  }
  return result;
}

/**
 * Every hour, at minute 23, reclaims the parts of upload sessions that passed
 * their deadline without completing.
 *
 * The minute is arbitrary but fixed, and it is not 17: the intake retention
 * sweep already runs then, and two sweeps that both delete in bulk should not
 * start together.
 */
export function createBlobUploadReaper(
  options: { database: Pick<PgDatabase, "query">; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: BLOB_UPLOAD_REAPER_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "23 * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "reap-abandoned-blob-uploads",
        () => reapAbandonedBlobUploads(options.database),
      ),
  );
}
