import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";
import {
  ensureOrganizationTree,
  projectArtifactEntry,
  type StorageQuery,
} from "../../storage-tree.ts";

/**
 * Projects every existing artifact as an entry under its work item (#444).
 *
 * It writes `bakery.storage_entries` rows only: no artifact, version or blob
 * row is read for update, so no data moves. A batch takes artifacts that have
 * no entry yet, so a re-run, or a run after new artifacts arrived, picks up
 * exactly what is missing and changes nothing else.
 */
export const storageEntriesBackfill: DataMigration = {
  version: "0232_storage_entries",
  source: new URL(import.meta.url),
  async run(connection, options) {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const count = await runDataMigrationBatch(
        connection,
        async (transaction) => {
          const db: StorageQuery = {
            query: async <Row>(sql: string, params: unknown[] = []) => {
              const rows = await transaction.unsafe(
                sql,
                params as Parameters<typeof transaction.unsafe>[1],
              );
              return { rows: rows as unknown as Row[] };
            },
          };
          const organizations = await transaction<{ id: string }[]>`
            select organization_id as id from bakery.artifacts
             group by organization_id`;
          for (const organization of organizations) {
            await ensureOrganizationTree(db, organization.id);
          }
          const rows = await transaction<
            { id: string; organization_id: string }[]
          >`
            select artifact.id, artifact.organization_id
              from bakery.artifacts artifact
             where not exists (
               select 1 from bakery.storage_entries entry
                where entry.organization_id = artifact.organization_id
                  and entry.artifact_id = artifact.id)
             order by artifact.id
             limit 500`;
          for (const row of rows) {
            await projectArtifactEntry(db, {
              organizationId: row.organization_id,
              artifactId: row.id,
            });
          }
          return rows.length;
        },
      );
      if (count === 0) return true;
    }
    return false;
  },
};
