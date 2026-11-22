import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { BackupImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { recordAuthAudit } from "../auth/application/audit.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { installationActor } from "../integrations/postgres.ts";
import { BACKUP_SETTINGS_ID, type SettingsQueryable } from "./settings.ts";

/**
 * "Restore to any minute" (issue #80, point-in-time slice P1): the switch an
 * installation administrator sets, and the restorable window the host runner
 * reports from what it has copied off-site. The server never sees WAL bytes or
 * a key; it only keeps the bounds so the page can say which minutes can be
 * restored.
 */

type PointInTime = z.output<typeof contractSchemas.BackupPointInTime>;
type PointInTimePut = z.output<typeof contractSchemas.BackupPointInTimePut>;
type WalReport = z.output<typeof contractSchemas.BackupWalReport>;

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** WAL segment file names: 24 hex characters, optionally a .partial or .history suffix. */
const SEGMENT = /^[0-9A-F]{24}(\.partial)?$|^[0-9A-F]{8}\.history$/;

export type StoredPointInTime = {
  readonly enabled: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly earliestRestorableAt: string | null;
  readonly latestRestorableAt: string | null;
  readonly latestSegment: string | null;
  readonly reportedAt: string | null;
};

export async function readPointInTime(
  query: SettingsQueryable,
  options: { readonly lock?: boolean } = {},
): Promise<StoredPointInTime | null> {
  const result = await query.query<StoredPointInTime>(
    `select enabled, version,
            to_char(updated_at at time zone 'UTC', ${TIMESTAMP}) as "updatedAt",
            to_char(earliest_restorable_at at time zone 'UTC', ${TIMESTAMP})
              as "earliestRestorableAt",
            to_char(latest_restorable_at at time zone 'UTC', ${TIMESTAMP})
              as "latestRestorableAt",
            latest_segment as "latestSegment",
            to_char(reported_at at time zone 'UTC', ${TIMESTAMP}) as "reportedAt"
       from bakery.backup_point_in_time_settings where id = $1${
      options.lock ? " for update" : ""
    }`,
    [BACKUP_SETTINGS_ID],
  );
  return result.rows[0] ?? null;
}

/**
 * The window as the page shows it. Both bounds are known only when the switch
 * is on and the runner has reported both; otherwise they are null, never a
 * guess. A latest bound before the earliest one is no window at all.
 */
export function pointInTimeProjection(
  stored: StoredPointInTime | null,
): PointInTime {
  const enabled = stored?.enabled ?? false;
  const earliest = enabled ? stored?.earliestRestorableAt ?? null : null;
  const latest = enabled ? stored?.latestRestorableAt ?? null : null;
  const window = earliest !== null && latest !== null &&
    Date.parse(latest) >= Date.parse(earliest);
  return contractSchemas.BackupPointInTime.parse({
    enabled,
    earliestRestorableAt: window ? earliest : null,
    latestRestorableAt: window ? latest : null,
    reportedAt: stored?.reportedAt ?? null,
    updatedAt: stored?.updatedAt ?? null,
    version: stored?.version ?? 0,
  });
}

/** backupPointInTime.get */
export async function getPointInTime(
  context: ActionContext,
): Promise<PointInTime> {
  const { context: value } = installationActor(context);
  return pointInTimeProjection(await readPointInTime(value.transaction));
}

/** backupPointInTime.put: checks If-Match under the row lock, saves, audits. */
export async function putPointInTime(
  context: ActionContext,
  input: PointInTimePut,
): Promise<PointInTime> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readPointInTime(transaction, { lock: true });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expectedVersion !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const saved = stored === null
    ? await transaction.query(
      `insert into bakery.backup_point_in_time_settings
         (id, enabled, updated_by) values ($1, $2, $3)
       on conflict (id) do nothing returning id`,
      [BACKUP_SETTINGS_ID, input.enabled, principalId],
    )
    : await transaction.query(
      `update bakery.backup_point_in_time_settings
          set enabled = $3, updated_by = $4, updated_at = now(),
              version = version + 1,
              -- Turning it off forgets the window: archiving stops, and a
              -- window reported before must not be offered when it is on again.
              earliest_restorable_at = case when $3 then earliest_restorable_at end,
              latest_restorable_at = case when $3 then latest_restorable_at end,
              latest_segment = case when $3 then latest_segment end
        where id = $1 and version = $2 returning id`,
      [BACKUP_SETTINGS_ID, stored.version, input.enabled, principalId],
    );
  if (saved.rows.length !== 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const result = await readPointInTime(transaction);
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.BackupPointInTimePut,
    resourceType: "backup_point_in_time_settings",
    resourceId: BACKUP_SETTINGS_ID,
    details: { enabled: input.enabled, version: result?.version ?? null },
  });
  return pointInTimeProjection(result);
}

/**
 * The host runner's report of what it holds off-site: the start of the oldest
 * kept base backup and the newest WAL segment copied. Ignored while the switch
 * is off. Only a report at least as new as the stored one moves the bounds,
 * so a late or repeated report can neither shrink the window nor widen it back
 * to a base backup that has since been pruned.
 */
export async function recordWalReport(
  transaction: PgTransactionClient,
  report: WalReport,
  now: Date = new Date(),
): Promise<PointInTime> {
  if (!SEGMENT.test(report.latestSegment)) {
    throw unprocessable(["latestSegment"], "invalid_wal_segment");
  }
  const latest = Date.parse(report.latestArchivedAt);
  const earliest = Date.parse(report.earliestBaseBackupAt);
  if (latest > now.getTime() + 5 * 60_000) {
    throw unprocessable(["latestArchivedAt"], "in_the_future");
  }
  if (earliest > latest) {
    throw unprocessable(["earliestBaseBackupAt"], "after_latest");
  }
  const stored = await readPointInTime(transaction, { lock: true });
  if (stored === null || !stored.enabled) {
    return pointInTimeProjection(stored);
  }
  await transaction.query(
    `update bakery.backup_point_in_time_settings
        set earliest_restorable_at = case
              when latest_restorable_at is null or $3 >= latest_restorable_at
              then $2 else earliest_restorable_at end,
            latest_restorable_at = greatest(latest_restorable_at, $3),
            latest_segment = case
              when latest_restorable_at is null or $3 >= latest_restorable_at
              then $4 else latest_segment end,
            reported_at = $5
      where id = $1`,
    [
      BACKUP_SETTINGS_ID,
      report.earliestBaseBackupAt,
      report.latestArchivedAt,
      report.latestSegment,
      now,
    ],
  );
  return pointInTimeProjection(await readPointInTime(transaction));
}
