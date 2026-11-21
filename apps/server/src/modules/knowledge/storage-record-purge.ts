import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import { appendMemorySourceChanged } from "./memory-source-state.ts";
import { assertNotQuiesced } from "../../platform/maintenance.ts";

/**
 * Completes queued Admin purges of record-area files (chapter 25 section
 * 17.5, #447). purgeStorageEntry records a request in
 * bakery.storage_purge_requests as the runtime role; this job, connected as
 * the database OWNER, clears the bytes the runtime role may not touch.
 *
 * Purge is for leaked secrets and legal demands, so it overrides retention and
 * pins: a pinned artifact, an unexpired version or a version a run or memory
 * still cites is purged all the same. That is the difference from retention
 * collection (retention/collector.ts), which skips all of those. Memories
 * citing a purged version are told (memory.source_changed).
 *
 * Each request is completed in its own transaction, locked with skip locked,
 * so two runs never purge the same request and a failure keeps every purge
 * before it. It runs as the bakery-server task "storage-purges"
 * (apps/server/src/platform/storage-purges-task.ts), which connects with
 * DATABASE_URL as the owner; a connection as any other role is refused before
 * anything is read, so it never falls back to the runtime role.
 */

/** The purge_policy a purged version carries. */
export const ADMIN_PURGE_POLICY = "admin-purge";

/** Requests one run completes at most; the next run takes the rest. */
export const STORAGE_PURGE_MAX_REQUESTS = 100;

export type StorageRecordPurgeResult = {
  /** Requests completed. */
  completed: number;
  /** Artifact versions whose bytes were cleared. */
  versionsPurged: number;
};

/** Checks a requested batch size, so a bad value cannot become an unbounded run. */
export function validPurgeBatchSize(maxRequests: number): boolean {
  return Number.isSafeInteger(maxRequests) && maxRequests >= 1 &&
    maxRequests <= 10_000;
}

async function requireOwner(transaction: PgTransactionClient): Promise<void> {
  const role = await transaction.query<{ allowed: boolean }>(
    `select session_user='bakery' and current_user='bakery'
      and (select datdba::regrole::text from pg_database where datname=current_database())='bakery' as allowed`,
  );
  if (role.rows[0]?.allowed !== true) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

async function completeRequest(
  transaction: PgTransactionClient,
  requestId: string,
): Promise<number | undefined> {
  await requireOwner(transaction);
  const locked = await transaction.query<{
    organization_id: string;
    entry_id: string;
    artifact_id: string;
    requested_by_id: string;
  }>(
    "select organization_id, entry_id, artifact_id, requested_by_id" +
      " from bakery.storage_purge_requests" +
      " where id = $1 and completed_at is null for update skip locked",
    [requestId],
  );
  const request = locked.rows[0];
  if (!request) return undefined;
  // Lock the artifact first, like live writers, then its versions.
  await transaction.query(
    "select id from bakery.artifacts where organization_id = $1 and id = $2" +
      " for update",
    [request.organization_id, request.artifact_id],
  );
  // No pinned_at, expires_at or reference check: purge overrides them.
  const purged = await transaction.query<{ id: string; size_bytes: string }>(
    "update bakery.artifact_versions" +
      " set content = null, blob_id = null, purged_at = now()," +
      " purge_policy = $3" +
      " where organization_id = $1 and artifact_id = $2 and purged_at is null" +
      " returning id, size_bytes::text",
    [request.organization_id, request.artifact_id, ADMIN_PURGE_POLICY],
  );
  const traceId = crypto.randomUUID();
  for (const version of purged.rows) {
    await appendMemorySourceChanged(transaction, {
      organizationId: request.organization_id,
      versionId: version.id,
      traceId,
    });
  }
  await transaction.query(
    "update bakery.storage_entries set purged_at = now()" +
      " where organization_id = $1 and id = $2 and purged_at is null",
    [request.organization_id, request.entry_id],
  );
  await transaction.query(
    "update bakery.storage_purge_requests set completed_at = now()" +
      " where id = $1",
    [requestId],
  );
  await appendAudit(transaction, {
    organizationId: request.organization_id,
    principalId: request.requested_by_id,
    operation: "storageEntries.purge",
    resourceType: "storage_entry",
    resourceId: request.entry_id,
    requestId: crypto.randomUUID(),
    traceId,
    details: {
      completed: true,
      purgeRequestId: requestId,
      artifactId: request.artifact_id,
      policy: ADMIN_PURGE_POLICY,
      versionsPurged: purged.rows.length,
      bytesPurged: purged.rows.reduce(
        (sum, row) => sum + Number(row.size_bytes),
        0,
      ),
    },
  });
  return purged.rows.length;
}

/** Completes up to maxRequests pending purge requests, as the owner role. */
export async function completeStoragePurgeRequests(
  ownerDatabase: PgDatabase,
  maxRequests = STORAGE_PURGE_MAX_REQUESTS,
): Promise<StorageRecordPurgeResult> {
  if (!validPurgeBatchSize(maxRequests)) {
    throw new Error("STORAGE_PURGE_LIMIT_INVALID");
  }
  const pending = await withPgTransaction(ownerDatabase, async (tx) => {
    // A backup holds the installation: nothing is purged until it lets go.
    await assertNotQuiesced(tx, "dispatch");
    // Fail closed before reading anything as a role that is not the owner.
    await requireOwner(tx);
    return (await tx.query<{ id: string }>(
      "select id from bakery.storage_purge_requests" +
        " where completed_at is null order by requested_at, id limit $1",
      [maxRequests],
    )).rows;
  });
  const result: StorageRecordPurgeResult = { completed: 0, versionsPurged: 0 };
  for (const { id } of pending) {
    const versions = await withPgTransaction(
      ownerDatabase,
      async (tx) => {
        // The hold may begin between requests: each one checks again.
        await assertNotQuiesced(tx, "dispatch");
        return await completeRequest(tx, id);
      },
    );
    if (versions === undefined) continue;
    result.completed += 1;
    result.versionsPurged += versions;
  }
  return result;
}
