import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "./database.ts";
import {
  applyRestoreFence,
  type RestoreFenceResult,
} from "../modules/backups/restore-fence.ts";

/**
 * The bakery-server "restore-fence" task (issue #64 slice E1): closes the doors
 * of an installation whose stores were just restored from a backup, as the
 * database owner, before any service starts. See restore-fence.ts for what it
 * does and why. tasks.ts passes DATABASE_URL.
 *
 *   restore-fence --backup-name <set directory name> [--cutoff-at <ISO time>]
 *
 * It prints one JSON line with the restore's id and the counts the fence acted
 * on. A bad argument is refused before the database is opened.
 */
const BACKUP_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function parseRestoreFenceArgs(
  args: readonly string[],
): { backupName: string; cutoffAt: string | null } {
  let backupName: string | undefined;
  let cutoffAt: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--backup-name" && value !== undefined) {
      backupName = value;
      index += 1;
    } else if (arg === "--cutoff-at" && value !== undefined) {
      cutoffAt = value;
      index += 1;
    } else {
      throw new Error("RESTORE_FENCE_ARGUMENT_INVALID");
    }
  }
  if (backupName === undefined || !BACKUP_NAME.test(backupName)) {
    throw new Error("RESTORE_FENCE_BACKUP_NAME_INVALID");
  }
  if (cutoffAt !== null && !ISO.test(cutoffAt)) {
    throw new Error("RESTORE_FENCE_CUTOFF_INVALID");
  }
  return { backupName, cutoffAt };
}

export async function runRestoreFenceTask(
  ownerDatabaseUrl: string,
  args: readonly string[],
): Promise<RestoreFenceResult> {
  const input = parseRestoreFenceArgs(args);
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  try {
    return await withPgTransaction(
      database,
      (transaction) => applyRestoreFence(transaction, input),
    );
  } finally {
    await closePgDatabase(database);
  }
}
