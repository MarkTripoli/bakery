import type { Inngest } from "inngest";
import type { PgDatabase } from "../../platform/database.ts";
import { UPLOAD_SESSION_TTL_MS } from "./blobs.ts";

/**
 * Reclaims the parts of upload sessions that were never completed.
 *
 * A session names a digest and a size and then waits for parts. Completion is
 * the only path that removes them, so a client that gives up - which is the
 * common case, not the exceptional one - leaves its parts in Postgres forever.
 * Each part is a `bytea` of up to 49 KiB and a session may hold thousands, so
 * an abandoned upload is an unbounded write-only store that nothing reads.
 *
 * A session is reapable on either of two conditions, and the ordering between
 * them is the whole safety argument:
 *
 * - it is past `expires_at`; or
 * - nothing has been written to it for the abandonment window.
 *
 * The deadline is absolute: set when the session opens, never extended, and
 * `lockUploadSession` already refuses a part or a completion past it, so a
 * session past its deadline is dead by contract. The abandonment window exists
 * because an operator may want a longer quiet period before reclaiming, and it
 * is REFUSED when it is shorter than the session lifetime. That refusal is the
 * point: a client can legitimately resume right up to the deadline, so a window
 * under the lifetime would reap a resumable upload and turn a resumable upload
 * into a race against its own reaper. With the default window equal to the
 * lifetime the second condition can never decide anything the first would not,
 * which is exactly right - it is only ever allowed to make the sweep more
 * conservative, never less.
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

/**
 * How long a session may go without a written part before it is reclaimed on
 * that ground alone.
 *
 * Defaults to the session lifetime, which makes the brand-new-session case and
 * the expiry case the same instant. It may be raised by whoever runs the sweep
 * to demand a longer quiet period; it may not be lowered below the lifetime,
 * because a client can resume until its deadline and a shorter window would
 * reclaim an upload the client is still entitled to finish.
 */
export const BLOB_UPLOAD_ABANDONMENT_MS = UPLOAD_SESSION_TTL_MS;

/** What one reaper run reclaimed. */
export type BlobUploadReapResult = {
  /** Sessions moved from `pending` to `expired`. */
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
 * `abandonmentMs` is how long a session may sit without a written part before
 * that alone makes it reclaimable. It may be raised and may not be lowered
 * below the session lifetime; a caller that asks for less is refused rather
 * than clamped, because a silent clamp would hide a configuration that would
 * otherwise reclaim uploads clients can still resume.
 *
 * Each batch is one statement. The sessions are locked with `for update skip
 * locked`, so two reapers, or a reaper and a client completing, never wait on
 * each other's rows: a session being completed is skipped by this run and
 * reaped by a later one if it is still pending. The parts are deleted and the
 * session is flipped in the same statement, so a batch that fails keeps
 * nothing and holds nothing - the batches before it stay reclaimed and the
 * error reaches the caller.
 *
 * It is idempotent: a session already `expired` is not `pending`, so a second
 * run over the same rows reclaims nothing and reports zero. It returns counts
 * only, because it is a system sweep across organizations and nothing it
 * handles is a person's request.
 */
export async function reapAbandonedBlobUploads(
  database: Pick<PgDatabase, "query">,
  limit = BLOB_UPLOAD_REAP_BATCH,
  maxBatches = BLOB_UPLOAD_REAP_MAX_BATCHES,
  abandonmentMs = BLOB_UPLOAD_ABANDONMENT_MS,
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
  if (!Number.isSafeInteger(abandonmentMs) || abandonmentMs < 0) {
    throw new Error("BLOB_UPLOAD_REAP_WINDOW_INVALID");
  }
  if (abandonmentMs < UPLOAD_SESSION_TTL_MS) {
    // Not clamped: a window shorter than the session lifetime would reclaim an
    // upload a client is still entitled to finish, and doing that quietly is
    // how a resumable upload becomes a race against its own reaper.
    throw new Error("BLOB_UPLOAD_REAP_WINDOW_TOO_SHORT");
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
            and (
              session.expires_at <= now()
              or coalesce(
                   (select max(part.created_at)
                      from bakery.blob_upload_parts as part
                     where part.organization_id = session.organization_id
                       and part.session_id = session.id),
                   session.created_at
                 ) <= now() - make_interval(secs => $2::double precision)
            )
          order by session.expires_at, session.id
          limit $1
            for update of session skip locked
       ),
       -- Both keys are matched even though the session id alone is already
       -- exact: it is a uuid primary key, so today the organization adds
       -- nothing a test could detect, and the test therefore does not claim to.
       -- It stays because this is the one delete no caller's organization
       -- scopes, and the column is present for exactly this reason - so that a
       -- later change that broadens the predicate cannot widen its reach.
       removed as (
         delete from bakery.blob_upload_parts as part
          using doomed
          where part.organization_id = doomed.organization_id
            and part.session_id = doomed.id
         returning 1
       ),
       flipped as (
         update bakery.blob_upload_sessions as session
            set state = 'expired', updated_at = now()
           from doomed
          where session.organization_id = doomed.organization_id
            and session.id = doomed.id
         returning 1
       )
       select (select count(*) from flipped)::int as abandoned,
              (select count(*) from removed)::int as parts_deleted`,
      [limit, abandonmentMs / 1000],
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
