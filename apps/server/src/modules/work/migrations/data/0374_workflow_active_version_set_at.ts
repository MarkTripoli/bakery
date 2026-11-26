import { z } from "zod";
import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

const BATCH_SIZE = 1_000;
const UnstampedDefinitionSchema = z.object({
  id: z.string().uuid().describe(
    "Workflow definition with a version in use but no recorded time it was put in use.",
  ),
}).strict().describe(
  "Workflow definition whose active version predates active_version_set_at.",
);

type UnstampedDefinition = z.infer<typeof UnstampedDefinitionSchema>;

async function stampBatch(
  connection: Parameters<DataMigration["run"]>[0],
  beforeCommit?: () => Promise<void>,
): Promise<number> {
  return await runDataMigrationBatch(
    connection,
    async (transaction) => {
      const rawRows = await transaction<UnstampedDefinition[]>`
        select id
        from bakery.workflow_definitions
        where active_version_id is not null and active_version_set_at is null
        order by id
        for update
        limit ${BATCH_SIZE}
      `;
      for (const rawRow of rawRows) {
        const row = UnstampedDefinitionSchema.parse(rawRow);
        await transaction`
          update bakery.workflow_definitions
          set active_version_set_at = updated_at
          where id = ${row.id} and active_version_set_at is null
        `;
      }
      return rawRows.length;
    },
    beforeCommit,
  );
}

export const workflowActiveVersionSetAtBackfill: DataMigration = {
  version: "0374_workflow_start_tick_dedupe",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      if (await stampBatch(connection, options.beforeCommit) === 0) {
        return true;
      }
    }
    return false;
  },
};
