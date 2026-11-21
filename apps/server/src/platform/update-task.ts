import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "./database.ts";
import {
  pauseForUpdate,
  readUnsureActions,
  readUpdateCounts,
  resumeAfterUpdate,
  type Transact,
  UpdatePauseRefusal,
  type UpdatePauseRefusalCode,
} from "./update-pause.ts";

/**
 * The bakery-server "update" task (issue #59): what the launcher asks of the
 * database around an update, as the database owner. See update-pause.ts.
 * tasks.ts passes DATABASE_URL.
 *
 *   update pause     hold the installation, wait until it is quiet, print what waited
 *   update resume    let go, print what was carried over
 *   update counts    print the same counts, change nothing
 *   update unsure    print the outside actions whose outcome is unknown, by kind
 *
 * It prints one JSON line. A refused pause exits with the code below instead,
 * so the launcher can tell a restore hold from a backup from a timeout without
 * reading text.
 */
export const UPDATE_REFUSAL_EXIT_CODES: Readonly<
  Record<UpdatePauseRefusalCode, number>
> = Object.freeze({
  DRAIN_TIMEOUT: 74,
  INSTALLATION_RESTORING: 75,
  MAINTENANCE_HELD: 76,
});

export type UpdateSubcommand = "pause" | "resume" | "counts" | "unsure";

export function parseUpdateArgs(args: readonly string[]): UpdateSubcommand {
  const [subcommand, ...rest] = args;
  if (rest.length > 0) throw new Error("UPDATE_ARGUMENT_INVALID");
  if (
    subcommand === "pause" || subcommand === "resume" ||
    subcommand === "counts" || subcommand === "unsure"
  ) return subcommand;
  throw new Error("UPDATE_SUBCOMMAND_INVALID");
}

export async function runUpdateTask(
  ownerDatabaseUrl: string,
  args: readonly string[],
): Promise<unknown> {
  const subcommand = parseUpdateArgs(args);
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  const transact: Transact = (work) => withPgTransaction(database, work);
  try {
    if (subcommand === "pause") return await pauseForUpdate(transact);
    if (subcommand === "resume") return await resumeAfterUpdate(transact);
    if (subcommand === "unsure") return await readUnsureActions(transact);
    return await readUpdateCounts(transact);
  } finally {
    await closePgDatabase(database);
  }
}

export { UpdatePauseRefusal };
