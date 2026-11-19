import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import { type SkillObjectStore } from "../storage-port.ts";
import { hasProtectedPluginBundleReference } from "./bundle-references.ts";
import { blobKeyLock } from "../../../platform/blob-key-lock.ts";
import { postgresErrorCode } from "../../../platform/postgres-errors.ts";

/**
 * Removes one plugin version's archive when nothing may install it again.
 *
 * The rules, in the order they are checked:
 *
 * 1. The version exists, still has bytes and has not already been collected.
 * 2. It cannot be installed: its package is withdrawn, or the version was never
 *    published. A published version of a live package stays, because install
 *    can still reach it.
 * 3. No install names it, in any status. A disabled install is deliberately
 *    still an install — re-enabling must not find the archive gone.
 *
 * Returns whether the version is now recorded as collected, which is not the
 * same as whether bytes were deleted. A retry after a crash deleted nothing
 * because the archive was already gone, and it still finishes the job: an
 * answer of `false` there would make a sweep report the version as kept when
 * in fact it has just been collected.
 *
 * Refusals answer `false` rather than throwing, because "not collectable now"
 * is the normal answer for most versions and a caller sweeping a package needs
 * to move on rather than handle an error per row.
 */
export async function collectPluginBundle(
  ownerDatabase: PgDatabase,
  store: Pick<SkillObjectStore, "delete" | "stat">,
  versionId: string,
  policy = "retention-v1",
): Promise<boolean> {
  if (!policy.trim() || policy.length > 100) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  // One transaction decides everything and holds the blob key's lock across
  // the delete, so a version published with the same bytes cannot slip between
  // the decision and the deletion. The bytes are still written outside the
  // PostgreSQL transaction - an object store cannot join one - so the ordering
  // stays bytes-first: a crash between the delete and the commit leaves an
  // archive gone and a tombstone missing, and the retry finishes the job.
  const collected = await withPgTransaction(
    ownerDatabase,
    async (transaction) => {
      const version = await transaction.query<
        {
          organization_id: string;
          bundle_object_ref: string;
          bundle_digest: string;
          bundle_purged_at: Date | null;
          published_at: Date | null;
          listing_status: string;
        }
      >(
        `select version.organization_id, version.bundle_object_ref,
              version.bundle_digest, version.bundle_purged_at,
              version.published_at, package.listing_status
         from bakery.plugin_versions version
         join bakery.plugin_packages package
           on package.organization_id = version.organization_id
          and package.id = version.plugin_package_id
        where version.id = $1
        for update of version`,
        [versionId],
      );
      const row = version.rows[0];
      if (!row || row.bundle_purged_at !== null) return null;

      // Nothing else that writes a version or an artifact blob takes this lock
      // yet, but taking it here means the day one does, the window is closed by
      // that change and not by this one.
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [blobKeyLock(row.organization_id, row.bundle_object_ref)],
      );

      const withdrawn = row.listing_status === "withdrawn";
      const unpublished = row.published_at === null;
      if (!withdrawn && !unpublished) return null;
      if (
        await hasProtectedPluginBundleReference(
          transaction,
          row.organization_id,
          versionId,
        )
      ) return null;
      // The object key is the organization and the digest, while the digest is
      // unique only per package, so two packages publishing identical archives
      // share one object. Only a version that could still serve an install
      // needs the bytes back; one that is itself collectable does not, so two
      // dead versions do not keep each other's archive alive forever.
      const shared = await transaction.query(
        `select 1
         from bakery.plugin_versions other
         join bakery.plugin_packages package
           on package.organization_id = other.organization_id
          and package.id = other.plugin_package_id
        where other.organization_id = $1
          and other.bundle_object_ref = $2
          and other.id <> $3
          and other.bundle_purged_at is null
          and (
            (package.listing_status <> 'withdrawn' and other.published_at is not null)
            or exists (
              select 1 from bakery.plugin_installs install
               where install.organization_id = other.organization_id
                 and install.plugin_version_id = other.id
                 and install.status <> 'uninstalled'
            )
          )
        limit 1`,
        [row.organization_id, row.bundle_object_ref, versionId],
      );
      if (shared.rows.length > 0) return null;
      // Artifact and upload bytes share this organization-and-digest identity,
      // so an object the blob registry knows is never a plugin bundle's to
      // delete. Kept conservative on purpose: this guard is on a delete path,
      // and being wrong in the other direction destroys bytes a live version
      // needs. It is no longer an unbounded pin: `collectBlob` reclaims a blob
      // row once no registered table holds it, so the row this guard consults
      // disappears on its own and the bundle becomes collectable then. This
      // collector does not call `hasLiveBlobReference` - it has a bundle key,
      // not a blob row, and the registry answers about blob rows.
      const registry = await transaction.query(
        `select 1 from bakery.blobs
        where organization_id = $1 and sha256 = $2
        limit 1`,
        [row.organization_id, row.bundle_digest],
      );
      if (registry.rows.length > 0) return null;

      // Bytes first, tombstone second, both while the blob key's lock is held.
      // A crash between them leaves an archive gone with no tombstone, and the
      // retry finishes the job because a delete of an absent key answers false
      // rather than throwing.
      // Re-stat under the lock: between deciding and deleting, the object can be
      // gone already (a previous attempt deleted it and failed to write the
      // tombstone) or replaced. Deleting without looking would be a write against
      // a key nobody re-checked.
      const held = await store.stat(row.bundle_object_ref);
      const removed = held === null
        ? false
        : await store.delete(row.bundle_object_ref);
      await transaction.query(
        `update bakery.plugin_versions
          set bundle_purged_at = now(), purge_policy = $2
        where organization_id = $1 and id = $3 and bundle_purged_at is null`,
        [row.organization_id, policy, versionId],
      );
      await appendAudit(transaction, {
        organizationId: row.organization_id,
        principalId: null,
        operation: "pluginVersions.collect",
        resourceType: "plugin_version",
        resourceId: versionId,
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        // The store's own answer is recorded but not returned: it says whether
        // bytes existed, and the caller needs to know whether the row now reads
        // as collected.
        details: { policy, objectRemoved: removed },
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
