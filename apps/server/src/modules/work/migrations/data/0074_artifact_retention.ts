import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

export const artifactRetentionBackfill: DataMigration = {
  version: "0074_artifact_retention",
  source: new URL(import.meta.url),
  async run(connection, options) {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const count = await runDataMigrationBatch(
        connection,
        async (transaction) => {
          const rows = await transaction<{ id: string; created_at: Date }[]>`
          select id, created_at from bakery.artifact_versions
          where expires_at is null order by id limit 1000 for update`;
          for (const row of rows) {
            const expiresAt = new Date(
              row.created_at.getTime() + 180 * 86400000,
            );
            await transaction`update bakery.artifact_versions
            set retention_class='evidence', expires_at=${expiresAt}
            where id=${row.id} and expires_at is null`;
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
