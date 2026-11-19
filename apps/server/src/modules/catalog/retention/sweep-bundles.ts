import type { PgDatabase } from "@bakery/persistence";
import { type SkillObjectStore } from "../storage-port.ts";
import { collectPluginBundle } from "./collect-bundle.ts";

/**
 * Collects every plugin version that nothing may install again, newest last.
 *
 * This exists because the collector alone was a function nobody called: the
 * policy was written, tested and unenforced. It runs from the same maintenance
 * script as artifact collection, so there is one sweep and one place to look
 * when retention is wrong, rather than a second scheduler that would drift.
 *
 * A candidate is selected by the same three conditions the collector re-checks
 * under the row lock - no tombstone, withdrawn package or never published, no
 * install in a status that can reach the version. Selection is a convenience,
 * never the authority: `collectPluginBundle` decides again, so a version that
 * becomes installed between the scan and the delete is kept.
 */
export async function sweepCollectablePluginBundles(
  ownerDatabase: PgDatabase,
  store: Pick<SkillObjectStore, "delete" | "stat">,
  options: Readonly<{ limit?: number; policy?: string }> = {},
): Promise<{ scanned: number; collected: number; kept: number }> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new RangeError("SWEEP_LIMIT_OUT_OF_RANGE");
  }
  const candidates = await ownerDatabase.query<{ id: string }>(
    `select version.id
       from bakery.plugin_versions version
       join bakery.plugin_packages package
         on package.organization_id = version.organization_id
        and package.id = version.plugin_package_id
      where version.bundle_purged_at is null
        and (package.listing_status = 'withdrawn' or version.published_at is null)
        and not exists (
          select 1 from bakery.plugin_installs install
           where install.organization_id = version.organization_id
             and install.plugin_version_id = version.id
             and install.status <> 'uninstalled'
        )
      order by version.created_at
      limit $1`,
    [limit],
  );
  let collected = 0;
  for (const row of candidates.rows) {
    if (
      await collectPluginBundle(ownerDatabase, store, row.id, options.policy)
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
