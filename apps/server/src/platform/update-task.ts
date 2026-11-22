import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "./database.ts";
import {
  readUpdatePolicy,
  recordUpdateEvent,
  type UpdateEventInput,
  UpdateEventKind,
} from "./update-history.ts";
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
 *   update policy    print what to do when an update is not healthy
 *   update record   record one event for the update history (see parseUpdateArgs)
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

export type UpdateCommand =
  | {
    readonly name: "pause" | "resume" | "counts" | "unsure" | "policy";
  }
  | { readonly name: "record"; readonly event: UpdateEventInput };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELEASE = /^[a-f0-9]{40}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/;
// One printable line, no control characters: the launcher's first line for a refusal.
const DETAIL = {
  test: (value: string) =>
    value.length >= 1 && value.length <= 200 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    }),
};
const NONE = "-";
const KINDS: ReadonlySet<string> = new Set(Object.values(UpdateEventKind));

const optional = (
  value: string | undefined,
  pattern: { test: (value: string) => boolean },
): string | null => {
  if (value === undefined || !pattern.test(value) && value !== NONE) {
    throw new Error("UPDATE_ARGUMENT_INVALID");
  }
  return value === NONE ? null : value;
};

/**
 * `record` takes exactly: id, kind, the user (or -), an ISO time, the release
 * it came from (or -), the release it went to (or -), and a detail (or -).
 * Every value is checked here, before the database is opened.
 */
function parseEvent(values: readonly string[]): UpdateEventInput {
  const [id, kind, byName, at, fromRelease, toRelease, detail, ...extra] =
    values;
  const occurredAt = new Date(at ?? "");
  if (
    extra.length > 0 || id === undefined || !UUID.test(id) ||
    kind === undefined || !KINDS.has(kind) ||
    Number.isNaN(occurredAt.getTime()) || at !== occurredAt.toISOString()
  ) throw new Error("UPDATE_ARGUMENT_INVALID");
  return {
    id,
    kind: kind as UpdateEventKind,
    occurredAt,
    byName: optional(byName, USER),
    fromRelease: optional(fromRelease, RELEASE),
    toRelease: optional(toRelease, RELEASE),
    detail: optional(detail, DETAIL),
  };
}

export function parseUpdateArgs(args: readonly string[]): UpdateCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "record") {
    return { name: "record", event: parseEvent(rest) };
  }
  if (
    subcommand !== "pause" && subcommand !== "resume" &&
    subcommand !== "counts" && subcommand !== "unsure" &&
    subcommand !== "policy"
  ) throw new Error("UPDATE_SUBCOMMAND_INVALID");
  if (rest.length > 0) throw new Error("UPDATE_ARGUMENT_INVALID");
  return { name: subcommand };
}

export async function runUpdateTask(
  ownerDatabaseUrl: string,
  args: readonly string[],
): Promise<unknown> {
  const command = parseUpdateArgs(args);
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  const transact: Transact = (work) => withPgTransaction(database, work);
  try {
    switch (command.name) {
      case "pause":
        return await pauseForUpdate(transact);
      case "resume":
        return await resumeAfterUpdate(transact);
      case "unsure":
        return await readUnsureActions(transact);
      case "policy":
        return await transact(readUpdatePolicy);
      case "record":
        return await transact((transaction) =>
          recordUpdateEvent(transaction, command.event)
        );
      case "counts":
        return await readUpdateCounts(transact);
    }
  } finally {
    await closePgDatabase(database);
  }
}

export { UpdatePauseRefusal };
