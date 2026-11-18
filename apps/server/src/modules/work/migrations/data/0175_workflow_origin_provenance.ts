import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

/**
 * 0175 added `origin_kind` with an `authored` default, so every row that
 * already existed - including the workflows the server installed from the
 * catalog before the columns existed - reads as authored. The read shape cannot
 * tell those apart, and the install path must not try: an upsert that "repairs"
 * an authored origin would also rewrite a genuine authored row that happens to
 * share the `preset:` slug shape, which is exactly the provenance confusion
 * this column exists to prevent.
 *
 * So the repair happens once, here, keyed to the schema migration that added
 * the columns, and the install path stays `on conflict do nothing`.
 *
 * Only rows the catalog itself names are touched: an `authored` default whose
 * slug carries the `preset:` prefix. The catalog key is the slug without that
 * prefix and the catalog version is the workflow's newest version revision,
 * which the install writes as the preset revision.
 */
export const workflowOriginProvenanceBackfill: DataMigration = {
  version: "0175_workflow_origin_provenance",
  source: new URL(import.meta.url),
  async run(connection, options) {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const count = await runDataMigrationBatch(
        connection,
        async (transaction) => {
          const rows = await transaction<
            { id: string; slug: string; revision: number | null }[]
          >`
          select d.id, d.slug,
                 (select v.revision from bakery.workflow_versions v
                   where v.workflow_id = d.id
                   order by v.revision desc
                   limit 1) as revision
          from bakery.workflow_definitions d
          where d.origin_kind = 'authored' and d.slug like 'preset:%'
          order by d.id
          limit 1000
          for update`;
          for (const row of rows) {
            await transaction`update bakery.workflow_definitions
            set origin_kind = 'catalog',
                origin_catalog_key = ${row.slug.replace(/^preset:/, "")},
                origin_catalog_version = ${row.revision ?? 1}
            where id = ${row.id} and origin_kind = 'authored'`;
          }
          return rows.length;
        },
        options.beforeCommit,
      );
      if (count === 0) return true;
    }
    return false;
  },
};
