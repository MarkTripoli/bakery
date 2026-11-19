import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import type { SkillObjectStore } from "../catalog/storage-port.ts";
import { blobObjectKey } from "../catalog/storage-port.ts";
import { blobKeyLock } from "../../platform/blob-key-lock.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { hasLiveBlobReference } from "./blob-references.ts";

/**
 * Removes one blob row, and its bytes, when no live artifact version names it.
 *
 * The order is the same one the plugin-bundle collector uses, for the same
 * reason: the object store cannot join a PostgreSQL transaction, so a crash
 * between the two writes leaves a state that a retry can finish. Bytes first,
 * row second - a blob row naming an object that is gone is a lie the read path
 * would have to defend against, while an object with no row is merely
 * unreferenced bytes that the next sweep reclaims.
 *
 * The blob-key advisory lock is held across both writes, and it is the same lock
 * the plugin-bundle collector takes for the same organization and digest. Two
 * collectors can therefore never reclaim one object concurrently, and - the
 * reason this matters - a bundle whose digest coincides with an artifact blob's
 * cannot be deleted while the artifact's row is being read.
 *
 * A blob is only collectable when nothing references it *and* its upload
 * session, if any, is closed. A pending session's parts are assembled into the
 * very object the row names, so reclaiming during an upload would delete bytes
 * a completing session is about to verify.
 */
export async function collectBlob(
  ownerDatabase: PgDatabase,
  store: Pick<SkillObjectStore, "delete" | "stat">,
  input: Readonly<{ organizationId: string; blobId: string }>,
  policy = "retention-v1",
): Promise<boolean> {
  if (!policy.trim() || policy.length > 100) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  const collected = await withPgTransaction(
    ownerDatabase,
    async (transaction) => {
      const found = await transaction.query<
        { sha256: string; size_bytes: string | number }
      >(
        `select sha256, size_bytes
           from bakery.blobs
          where organization_id = $1 and id = $2
          for update`,
        [input.organizationId, input.blobId],
      );
      const row = found.rows[0];
      if (!row) return null;

      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [blobKeyLock(input.organizationId, row.sha256)],
      );

      // Re-asked under the lock. The check before the lock would be a guess
      // about a moment that has already passed: a version can be published
      // against these very bytes between the scan and here.
      if (
        await hasLiveBlobReference(transaction, {
          organizationId: input.organizationId,
          blobId: input.blobId,
        })
      ) return null;

      // An upload in flight holds the bytes it is about to verify. Its session
      // names the digest, not the blob row, so the check is by digest.
      const open = await transaction.query(
        `select 1 from bakery.blob_upload_sessions
          where organization_id = $1 and sha256 = $2
            and state = 'pending'
          limit 1`,
        [input.organizationId, row.sha256],
      );
      if (open.rows.length > 0) return null;

      const objectKey = blobObjectKey(input.organizationId, row.sha256);
      const held = await store.stat(objectKey);
      const removed = held === null ? false : await store.delete(objectKey);
      await transaction.query(
        `delete from bakery.blobs where organization_id = $1 and id = $2`,
        [input.organizationId, input.blobId],
      );
      await appendAudit(transaction, {
        organizationId: input.organizationId,
        principalId: null,
        operation: "blobs.collect",
        resourceType: "blob",
        resourceId: input.blobId,
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        details: {
          policy,
          sha256: row.sha256,
          sizeBytes: Number(row.size_bytes),
          // Recorded, not returned: it says whether bytes existed, while the
          // caller needs to know whether the row is now gone.
          objectRemoved: removed,
        },
      });
      return "collected" as const;
    },
  ).catch((error: unknown) => {
    switch (postgresErrorCode(error)) {
      case "40P01":
      case "55P03":
        throw new StandardError({
          code: "DEPENDENCY_UNAVAILABLE",
          params: { retryAfterSeconds: 60 },
        });
      default:
        throw error;
    }
  });
  return collected === "collected";
}

/**
 * Collects every unreferenced blob in every organization, oldest first.
 *
 * Candidates are selected conservatively - a blob with no live version naming
 * it and no pending upload at its digest - and `collectBlob` decides again
 * under the row lock, so a blob that gains a reference between the scan and the
 * delete is kept. The scan is a convenience, never the authority.
 */
export async function sweepCollectableBlobs(
  ownerDatabase: PgDatabase,
  store: Pick<SkillObjectStore, "delete" | "stat">,
  options: Readonly<{ limit?: number; policy?: string }> = {},
): Promise<{ scanned: number; collected: number; kept: number }> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new RangeError("SWEEP_LIMIT_OUT_OF_RANGE");
  }
  const candidates = await ownerDatabase.query<
    { organization_id: string; id: string }
  >(
    `select blob.organization_id, blob.id
       from bakery.blobs blob
      where not exists (
          select 1 from bakery.artifact_versions version
           where version.organization_id = blob.organization_id
             and version.blob_id = blob.id
             and version.purged_at is null
        )
        and not exists (
          select 1 from bakery.blob_upload_sessions session
           where session.organization_id = blob.organization_id
             and session.sha256 = blob.sha256
             and session.state = 'pending'
        )
      order by blob.created_at
      limit $1`,
    [limit],
  );
  let collected = 0;
  for (const row of candidates.rows) {
    if (
      await collectBlob(
        ownerDatabase,
        store,
        { organizationId: row.organization_id, blobId: row.id },
        options.policy,
      )
    ) {
      collected++;
    }
  }
  return {
    scanned: candidates.rows.length,
    collected,
    kept: candidates.rows.length - collected,
  };
}
