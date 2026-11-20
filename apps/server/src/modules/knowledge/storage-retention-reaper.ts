import type { Inngest } from "inngest";
import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { DEFAULT_STORAGE_LIMITS } from "./storage-areas.ts";
import { deleteSubtree } from "./storage-working-areas.ts";

/**
 * Removes what the storage tree's retention classes say has expired (chapter
 * 25 sections 17.1 and 17.5, #447), the way #517's upload reaper reclaims
 * abandoned upload parts:
 *
 * - a trashed entry, with everything under it, once it has been in /trash for
 *   the organization's trash retention (30 days by default); and
 * - a scratch file once nothing has written it for the organization's scratch
 *   retention (30 days by default).
 *
 * Working-area files people keep ("kept") are never swept: they stay until
 * someone deletes them. Record areas keep today's artifact retention and are
 * not touched here.
 *
 * Each candidate is removed in its own transaction, locked with skip locked,
 * so a sweep never waits on a person restoring or writing the same entry and a
 * failure keeps every removal before it. Blobs the removed versions named are
 * left for blob collection, which owns removing objects. It returns counts
 * only: a system sweep across organizations handles no one's request.
 */

const STORAGE_RETENTION_REAPER_FUNCTION_ID =
  "bakery-knowledge-storage-retention-reaper";

/** Entries one run removes at most; the next run takes the rest. */
export const STORAGE_REAP_MAX_ENTRIES = 1000;

export type StorageReapResult = {
  /** Trashed entries removed with their subtrees. */
  trashed: number;
  /** Scratch files removed. */
  scratch: number;
  /** Entries removed in total, subtrees included. */
  entriesRemoved: number;
};

const CANDIDATES = "select entry.organization_id, entry.id," +
  " (entry.trashed_at is not null) as from_trash" +
  " from bakery.storage_entries entry" +
  " left join bakery.storage_settings settings" +
  " on settings.organization_id = entry.organization_id" +
  " where (" +
  " (entry.trashed_at is not null and entry.trashed_at <= now() -" +
  " make_interval(days => coalesce(settings.trash_retention_days, $1)))" +
  " or (entry.trashed_at is null and entry.kind = 'file'" +
  " and entry.policy = 'scratch' and entry.updated_at <= now() -" +
  " make_interval(days => coalesce(settings.scratch_retention_days, $2))))" +
  " order by entry.organization_id, entry.id limit $3";

/** Sweeps expired trash and scratch, up to maxEntries candidates. */
export async function reapExpiredStorage(
  database: PgDatabase,
  maxEntries = STORAGE_REAP_MAX_ENTRIES,
): Promise<StorageReapResult> {
  if (
    !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
    maxEntries > 100_000
  ) {
    throw new Error("STORAGE_REAP_LIMIT_INVALID");
  }
  const result: StorageReapResult = {
    trashed: 0,
    scratch: 0,
    entriesRemoved: 0,
  };
  const candidates = await database.query<
    { organization_id: string; id: string; from_trash: boolean }
  >(CANDIDATES, [
    DEFAULT_STORAGE_LIMITS.trashRetentionDays,
    DEFAULT_STORAGE_LIMITS.scratchRetentionDays,
    maxEntries,
  ]);
  for (const candidate of candidates.rows) {
    const removed = await withPgTransaction(database, async (tx) => {
      // Re-check under the lock: a restore or a new write since the scan
      // makes the entry live again, and it must survive this run.
      const locked = await tx.query<{ id: string }>(
        "select entry.id from bakery.storage_entries entry" +
          " left join bakery.storage_settings settings" +
          " on settings.organization_id = entry.organization_id" +
          " where entry.organization_id = $1 and entry.id = $2" +
          " and (" +
          " (entry.trashed_at is not null and entry.trashed_at <= now() -" +
          " make_interval(days => coalesce(settings.trash_retention_days, $3)))" +
          " or (entry.trashed_at is null and entry.kind = 'file'" +
          " and entry.policy = 'scratch' and entry.updated_at <= now() -" +
          " make_interval(days =>" +
          " coalesce(settings.scratch_retention_days, $4))))" +
          " for update of entry skip locked",
        [
          candidate.organization_id,
          candidate.id,
          DEFAULT_STORAGE_LIMITS.trashRetentionDays,
          DEFAULT_STORAGE_LIMITS.scratchRetentionDays,
        ],
      );
      if (!locked.rows[0]) return 0;
      return (await deleteSubtree(tx, candidate.organization_id, candidate.id))
        .entries;
    });
    if (removed === 0) continue;
    if (candidate.from_trash) result.trashed += 1;
    else result.scratch += 1;
    result.entriesRemoved += removed;
  }
  return result;
}

/**
 * Every hour, at minute 41, removes expired trash and scratch. Not minute 17
 * (intake retention) or 23 (the upload reaper), so bulk deletes do not start
 * together.
 */
export function createStorageRetentionReaper(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: STORAGE_RETENTION_REAPER_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "41 * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "reap-expired-storage",
        () => reapExpiredStorage(options.database),
      ),
  );
}
