import { StandardError } from "@bakery/contracts/http";
import { closePgDatabase, openPgDatabase } from "./database.ts";
import {
  completeStoragePurgeRequests,
  type StorageRecordPurgeResult,
} from "../modules/knowledge/storage-record-purge.ts";

/**
 * The bakery-server "storage-purges" task: completes queued Admin purges of
 * record-area files (chapter 25 section 17.5, #447) as the database owner.
 * tasks.ts passes DATABASE_URL; the collector refuses any other role.
 *
 * It is the only implementation. The compose stack runs it every 600 seconds
 * (the storage-purges service in infra/compose.yaml), the server image runs it
 * once with "server-entrypoint.sh storage-purges", and an operator can run it
 * by hand with "pnpm --filter @bakery/server storage-purges".
 */
export async function runStoragePurgesTask(
  ownerDatabaseUrl: string,
): Promise<StorageRecordPurgeResult> {
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  try {
    return await completeStoragePurgeRequests(database);
  } catch (error) {
    // A backup or a restore holds the installation: skip this round quietly.
    // The timer runs again in ten minutes and a failed exit here would only
    // raise an alarm.
    if (
      error instanceof StandardError &&
      (error.code === "INSTALLATION_QUIESCED" ||
        error.code === "INSTALLATION_RESTORING")
    ) return { completed: 0, versionsPurged: 0 };
    throw error;
  } finally {
    await closePgDatabase(database);
  }
}
