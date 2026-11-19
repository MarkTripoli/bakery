import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import type { SkillObjectStore } from "../catalog/storage-port.ts";
import { blobObjectKey } from "../catalog/storage-port.ts";
import { blobKeyLock } from "../../platform/blob-key-lock.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import {
  blobReferenceKinds,
  collectableBlobQuery,
  hasLiveBlobReference,
} from "./blob-references.ts";

/**
 * Removes one blob row, and its bytes, when no registered table holds them.
 *
 * The order is row first, then bytes, and it is the opposite of the
 * plugin-bundle collector's for a reason that is not stylistic. A blob can be
 * named by foreign keys this collector does not own - `storage_file_versions`
 * has one `on delete restrict` - and those keys only get a say when the row is
 * deleted. Deleting the bytes first and then failing the row delete would leave
 * a live row pointing at bytes that are gone, which is data loss; deleting the
 * row first turns the same race into a refused delete with nothing touched.
 *
 * The object store cannot join a PostgreSQL transaction, so the bytes are still
 * written outside it: a crash between the two leaves an orphan object with no
 * row. That is a leak, and a leak is the failure to prefer over a loss.
 *
 * The blob-key advisory lock is held across both writes, and it is the same lock
 * the plugin-bundle collector takes for the same organization and digest. Two
 * collectors can therefore never reclaim one object concurrently, and - the
 * reason this matters - a bundle whose digest coincides with an artifact blob's
 * cannot be deleted while the artifact's row is being read.
 *
 * A blob is only collectable when no registered table holds it. That includes
 * upload sessions: a pending one is assembling the very object the row names,
 * and a completed one names the blob before the version that will use it is
 * published, so it counts until its own `expires_at`.
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

      // The row goes before the bytes: every foreign key to bakery.blobs gets
      // its say here, and a reference that arrived since the check above makes
      // this delete fail with nothing deleted rather than the other way round.
      await transaction.query(
        `delete from bakery.blobs where organization_id = $1 and id = $2`,
        [input.organizationId, input.blobId],
      );

      const objectKey = blobObjectKey(input.organizationId, row.sha256);
      const held = await store.stat(objectKey);
      const removed = held === null ? false : await store.delete(objectKey);
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
 * Candidates come from `collectableBlobQuery`, which asks every registered
 * table at once, and `collectBlob` decides again under the row lock, so a blob
 * that gains a reference between the scan and the delete is kept. The scan is a
 * convenience, never the authority.
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
  >(collectableBlobQuery(blobReferenceKinds), [limit]);
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
