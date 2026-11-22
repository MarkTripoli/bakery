import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";

/**
 * #50 AC3: what restore.sh's restore-fence step does, for the recovery
 * launcher's restore test. The launcher itself never runs Bakery code; this
 * stands in for the release's own fence task that restore.sh calls.
 *
 *   deno run -A tests/helpers/recovery-launcher-fence.ts <database url> <set name>
 */
const [url, backupName] = Deno.args;
const database = openPgDatabase(url, 1);
try {
  const result = await withPgTransaction(
    database,
    (transaction) =>
      applyRestoreFence(transaction, { backupName, cutoffAt: null }),
  );
  console.log(JSON.stringify(result));
} finally {
  await closePgDatabase(database);
}
