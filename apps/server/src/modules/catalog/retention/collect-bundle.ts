import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import { type SkillObjectStore } from "../storage-port.ts";
import { hasProtectedPluginBundleReference } from "./bundle-references.ts";
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
  store: Pick<SkillObjectStore, "delete">,
  versionId: string,
  policy = "retention-v1",
): Promise<boolean> {
  if (!policy.trim() || policy.length > 100) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  const subject = await withPgTransaction(
    ownerDatabase,
    async (transaction) => {
      const version = await transaction.query<
        {
          organization_id: string;
          bundle_object_ref: string;
          bundle_purged_at: Date | null;
          published_at: Date | null;
          listing_status: string;
        }
      >(
        `select version.organization_id, version.bundle_object_ref,
              version.bundle_purged_at, version.published_at,
              package.listing_status
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
      return {
        organizationId: row.organization_id,
        objectRef: row.bundle_object_ref,
      };
    },
  );
  if (subject === null) return false;
  // The bytes go first, outside the transaction: an object store cannot join a
  // PostgreSQL transaction, and deleting after a commit that later failed would
  // leave a row claiming bytes it no longer has. Deleting first means a crash
  // between the two leaves a version whose archive is gone but whose tombstone
  // is not yet written - and the second attempt deletes nothing, records the
  // tombstone and finishes, which is why `delete` answers false for an absent
  // key instead of throwing.
  const removed = await store.delete(subject.objectRef);
  await withPgTransaction(ownerDatabase, async (transaction) => {
    await transaction.query(
      `update bakery.plugin_versions
          set bundle_purged_at = now(), purge_policy = $2
        where organization_id = $1 and id = $3 and bundle_purged_at is null`,
      [subject.organizationId, policy, versionId],
    );
    await appendAudit(transaction, {
      organizationId: subject.organizationId,
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
  }).catch((error: unknown) => {
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
  return true;
}
