import { closePgDatabase, openPgDatabase } from "./database.ts";
import {
  purgeSlackRequestReceipts,
  SLACK_RECEIPT_RETENTION_SECONDS,
} from "../modules/integrations/slack-request-receipts.ts";

/**
 * The bakery-server "slack-receipt-purges" task: keeps the receipts table bounded
 * (#415).
 *
 * A receipt exists only to make a retry of the same signed request recognisable,
 * and a request older than the freshness window is refused before it is claimed,
 * so a receipt past that window protects nothing. A sweep is enough: nothing waits
 * on these rows, and a coarse interval is cheaper than a delete on every insert.
 *
 * It is the only implementation. The compose stack runs it every 600 seconds (the
 * slack-receipt-purges service in infra/compose.yaml) and an operator can run it by
 * hand with "pnpm --filter @bakery/server slack-receipt-purges".
 */
export async function runSlackReceiptPurgesTask(
  databaseUrl: string,
): Promise<{ purged: number; retentionSeconds: number }> {
  const database = openPgDatabase(databaseUrl, 1);
  try {
    const purged = await purgeSlackRequestReceipts(database);
    return { purged, retentionSeconds: SLACK_RECEIPT_RETENTION_SECONDS };
  } finally {
    await closePgDatabase(database);
  }
}
