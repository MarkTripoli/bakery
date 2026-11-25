import { z } from "zod";
import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

const BATCH_SIZE = 1_000;
const LegacyToolGatewayCallSchema = z.object({
  id: z.string().uuid().describe(
    "Tool gateway call identifier selected for effective-name repair.",
  ),
  toolName: z.string().trim().min(1).describe(
    "Original tool name retained by a call created before effective names.",
  ),
}).strict().describe(
  "Legacy tool gateway call requiring its persisted effective name.",
);

type LegacyToolGatewayCall = z.infer<typeof LegacyToolGatewayCallSchema>;

async function backfillBatch(
  connection: Parameters<DataMigration["run"]>[0],
  beforeCommit?: () => Promise<void>,
): Promise<number> {
  return await runDataMigrationBatch(
    connection,
    async (transaction) => {
      const rawRows = await transaction<LegacyToolGatewayCall[]>`
        select id, tool_name as "toolName"
        from bakery.tool_gateway_calls
        where effective_name is null
        order by id
        for update
        limit ${BATCH_SIZE}
      `;
      for (const rawRow of rawRows) {
        const row = LegacyToolGatewayCallSchema.parse(rawRow);
        await transaction`
          update bakery.tool_gateway_calls
          set effective_name = ${row.toolName}
          where id = ${row.id} and effective_name is null
        `;
      }
      return rawRows.length;
    },
    beforeCommit,
  );
}

export const sessionToolEffectiveNameBackfill: DataMigration = {
  version: "0369_session_tool_effective_names",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      if (await backfillBatch(connection, options.beforeCommit) === 0) {
        return true;
      }
    }
    return false;
  },
};
