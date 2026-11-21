import { contractSchemas } from "@bakery/contracts/contracts";
import { unprocessable } from "@bakery/contracts/http";
import { BackupImplementedAction } from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { drillProblems } from "./drill-rules.ts";
import { audit, conflict, type MaintenanceActor } from "./maintenance.ts";

/**
 * backupRunner.drill and backups.drills.list (issue #64 slice D, also #49).
 *
 * A restore drill restores a backup set into an isolated, throwaway database on
 * the host and checks it there. The runner reports the result here so that an
 * administrator can see that a backup was proved restorable, when, how old the
 * backup was (RPO) and how long the restore took (RTO). The server never sees
 * the drill, only its report, so it refuses a report that contradicts itself
 * (see drill-rules.ts) and keeps what it accepts, once, as history.
 */

type Report = z.output<typeof contractSchemas.BackupDrillReport>;
type View = z.output<typeof contractSchemas.BackupDrill>;

export const DRILL_OPERATION = "backupRunner.drill";

type StoredRow = {
  id: string;
  backupName: string;
  outcome: string;
  failureCode: string | null;
  detail: string | null;
  cutoffAt: Date | null;
  rpoSeconds: number | null;
  rtoSeconds: number;
  checks: { passed: string[]; failed: string[] };
  startedAt: Date;
  recordedAt: Date;
};

const COLUMNS = `id, backup_name as "backupName", outcome,
  failure_code as "failureCode", detail, cutoff_at as "cutoffAt",
  rpo_seconds as "rpoSeconds", rto_seconds as "rtoSeconds", checks,
  started_at as "startedAt", recorded_at as "recordedAt"`;

function view(row: StoredRow): View {
  return contractSchemas.BackupDrill.parse({
    id: row.id,
    backupName: row.backupName,
    startedAt: row.startedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    outcome: row.outcome,
    failureCode: row.failureCode,
    detail: row.detail,
    cutoffAt: row.cutoffAt === null ? null : row.cutoffAt.toISOString(),
    rpoSeconds: row.rpoSeconds,
    rtoSeconds: row.rtoSeconds,
    checksPassed: row.checks.passed,
    checksFailed: row.checks.failed,
  });
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether a stored drill says exactly what a report says (timestamps to the millisecond). */
function sameDrill(stored: StoredRow, report: Report): boolean {
  const at = (value: string | null | undefined) =>
    value == null ? null : new Date(value).getTime();
  return stored.backupName === report.backupName &&
    stored.outcome === report.outcome &&
    (stored.failureCode ?? null) === (report.failureCode ?? null) &&
    (stored.detail ?? null) === (report.detail ?? null) &&
    (stored.cutoffAt?.getTime() ?? null) === at(report.cutoffAt) &&
    (stored.rpoSeconds ?? null) === (report.rpoSeconds ?? null) &&
    stored.rtoSeconds === report.rtoSeconds &&
    stored.startedAt.getTime() === at(report.startedAt) &&
    sameStrings(stored.checks.passed, report.checksPassed) &&
    sameStrings(stored.checks.failed, report.checksFailed);
}

/**
 * Records one reported drill. The first report of an id is stored; the same
 * report again returns the stored record; the same id with different content
 * answers 409 and changes nothing, because a drill's result never changes.
 */
export async function recordDrill(
  transaction: PgTransactionClient,
  report: Report,
  actor: MaintenanceActor,
): Promise<View> {
  const problem = drillProblems(report)[0];
  if (problem !== undefined) {
    throw unprocessable([problem.field], problem.reason);
  }
  const inserted = await transaction.query<StoredRow>(
    `insert into bakery.backup_drills (
       id, backup_name, outcome, failure_code, detail, cutoff_at, rpo_seconds,
       rto_seconds, checks, started_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     on conflict (id) do nothing
     returning ${COLUMNS}`,
    [
      report.drillId,
      report.backupName,
      report.outcome,
      report.failureCode ?? null,
      report.detail ?? null,
      report.cutoffAt ?? null,
      report.rpoSeconds ?? null,
      report.rtoSeconds,
      JSON.stringify({
        passed: report.checksPassed,
        failed: report.checksFailed,
      }),
      report.startedAt,
    ],
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    const stored = (await transaction.query<StoredRow>(
      `select ${COLUMNS} from bakery.backup_drills where id = $1`,
      [report.drillId],
    )).rows[0];
    if (stored === undefined) throw conflict("drill_unavailable");
    if (!sameDrill(stored, report)) throw conflict("drill_id_reused");
    return view(stored);
  }
  // Names, words and numbers only: never a path, a key or restored data.
  await audit(transaction, actor, DRILL_OPERATION, null, {
    drillId: created.id,
    outcome: created.outcome,
    failureCode: created.failureCode,
    rpoSeconds: created.rpoSeconds,
    rtoSeconds: created.rtoSeconds,
  });
  return view(created);
}

/** backups.drills.list: the drills reported so far, newest report first. */
export async function listBackupDrills(
  transaction: PgTransactionClient,
  principalId: string,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const binding: CursorBinding = {
    action: BackupImplementedAction.BackupsDrillsList,
    principalId,
    ordering: "createdAt:desc,id:desc",
    filters: "all",
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<
    StoredRow & { cursorRecordedAt: string }
  >(
    `select ${COLUMNS},
            to_char(recorded_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorRecordedAt"
       from bakery.backup_drills
      where $1::timestamptz is null
         or (recorded_at, id) < ($1::timestamptz, $2::uuid)
      order by recorded_at desc, id desc limit $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return contractSchemas["Page<BackupDrill>"].parse({
    items: page.map(view),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursorRecordedAt,
        id: last.id,
      })
      : null,
  });
}
