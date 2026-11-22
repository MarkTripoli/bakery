import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { BackupImplementedAction } from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { FAILURE_KINDS, MOVE_KINDS } from "../../platform/update-history.ts";

/**
 * What the Updates page reads (issue #59 server asks 12 and 14): which release
 * runs, whether it is healthy, the release the launcher keeps, the history of
 * updates, and the last update that did not go through until it is dismissed.
 *
 * The launcher writes the history as the database owner while it works (see
 * platform/update-history.ts), because Bakery may be the part that is broken.
 * These reads only show it. Words and release ids only: never a path, a secret
 * or a task title.
 */

type Event = z.output<typeof contractSchemas.InstallationUpdateEvent>;
type Status = z.output<typeof contractSchemas.InstallationUpdateStatus>;
type Page = z.output<typeof contractSchemas["Page<InstallationUpdateEvent>"]>;

type Row = {
  id: string;
  kind: string;
  at: Date;
  by: string | null;
  fromRelease: string | null;
  toRelease: string | null;
  detail: string | null;
  dismissedAt: Date | null;
};

const COLUMNS = `id, kind, occurred_at as "at", by_name as "by",
  from_release as "fromRelease", to_release as "toRelease", detail,
  dismissed_at as "dismissedAt"`;

function view(row: Row): Event {
  return contractSchemas.InstallationUpdateEvent.parse({
    id: row.id,
    kind: row.kind,
    at: row.at.toISOString(),
    by: row.by,
    fromRelease: row.fromRelease,
    toRelease: row.toRelease,
    detail: row.detail,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  });
}

type Query = Pick<PgTransactionClient, "query">;

/** When a release last became the running one, by the history. */
async function startedAt(
  transaction: Query,
  release: string,
  before?: Date,
): Promise<Date | null> {
  const result = await transaction.query<{ at: Date }>(
    `select occurred_at as "at" from bakery.installation_update_history
      where kind = any($1::text[]) and to_release = $2
        and ($3::timestamptz is null or occurred_at < $3::timestamptz)
      order by occurred_at desc, id desc limit 1`,
    [MOVE_KINDS, release, before ?? null],
  );
  return result.rows[0]?.at ?? null;
}

/**
 * installationUpdates.status. `release` is what this server runs and
 * `healthy` is its own health check; both come from the running process, the
 * rest from the history.
 */
export async function readUpdateStatus(
  transaction: Query,
  running: { readonly release: string; readonly healthy: boolean },
): Promise<Status> {
  const moved = await transaction.query<
    { at: Date; fromRelease: string | null; toRelease: string | null }
  >(
    `select occurred_at as "at", from_release as "fromRelease",
            to_release as "toRelease"
       from bakery.installation_update_history
      where kind = any($1::text[]) and to_release = $2
      order by occurred_at desc, id desc limit 1`,
    [MOVE_KINDS, running.release],
  );
  // The release the launcher keeps is the one the latest move into the running
  // release replaced. A later move somewhere else (an update that was left
  // unhealthy and then put back by `recover`) does not change that: the journal
  // keeps the same earlier release. No move into it means the history does not
  // cover it, and nothing is guessed.
  const kept = moved.rows[0]?.fromRelease ? moved.rows[0] : undefined;
  // One incident, one notice: only the newest failure counts, and if that one
  // was dismissed there is no notice, however many older ones were not. (A stay
  // that `recover` then put back is a decided_stay and an interrupted.)
  const failure = await transaction.query<Row>(
    `select ${COLUMNS} from bakery.installation_update_history failed
      where kind = any($1::text[])
        and not exists (
          select 1 from bakery.installation_update_history later
           where later.kind = 'updated'
             and (later.occurred_at, later.id) > (failed.occurred_at, failed.id)
        )
      order by occurred_at desc, id desc limit 1`,
    [FAILURE_KINDS],
  );
  return contractSchemas.InstallationUpdateStatus.parse({
    runningRelease: running.release,
    runningSince: (await startedAt(transaction, running.release))
      ?.toISOString() ?? null,
    healthy: running.healthy,
    previousRelease: kept?.fromRelease ?? null,
    previousRanFrom: kept?.fromRelease
      ? (await startedAt(transaction, kept.fromRelease, kept.at))
        ?.toISOString() ?? null
      : null,
    previousRanUntil: kept?.at.toISOString() ?? null,
    lastFailure: failure.rows[0] && failure.rows[0].dismissedAt === null
      ? view(failure.rows[0])
      : null,
  });
}

/** installationUpdates.list: the history, newest first. */
export async function listUpdateEvents(
  transaction: Query,
  principalId: string,
  input: { cursor?: string; limit?: number },
  secret: string,
): Promise<Page> {
  const binding: CursorBinding = {
    action: BackupImplementedAction.InstallationUpdatesList,
    principalId,
    // The shape the cursor knows: newest first, keyed by (time, id).
    ordering: "createdAt:desc,id:desc",
    filters: "all",
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<
    Row & { cursorAt: string }
  >(
    `select ${COLUMNS},
            to_char(occurred_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
       from bakery.installation_update_history
      where $1::timestamptz is null
         or (occurred_at, id) < ($1::timestamptz, $2::uuid)
      order by occurred_at desc, id desc limit $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return contractSchemas["Page<InstallationUpdateEvent>"].parse({
    items: page.map(view),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursorAt,
        id: last.id,
      })
      : null,
  });
}

/**
 * installationUpdates.dismiss: hides the notice about one failed update. The
 * event stays in the history. Dismissing again changes nothing and returns the
 * same event; an event that is not a notice, or that does not exist, is 404.
 */
export async function dismissUpdateEvent(
  transaction: Query,
  id: string,
  principalId: string,
): Promise<Event> {
  const result = await transaction.query<Row>(
    `update bakery.installation_update_history
        set dismissed_at = coalesce(dismissed_at, clock_timestamp()),
            dismissed_by_principal_id =
              case when dismissed_at is null then $3::uuid
                   else dismissed_by_principal_id end
      where id = $1::uuid and kind = any($2::text[])
      returning ${COLUMNS}`,
    [id, FAILURE_KINDS, principalId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return view(row);
}
