/**
 * Backup schedule rules, kept in TypeScript as small pure functions: the
 * PostgreSQL boundary allows no CHECK constraint, trigger or routine, and
 * there is no server-side scheduler. The runner's claim asks `isBackupDue`.
 */

export const BackupInterval = Object.freeze(
  { Hourly: "hourly", Daily: "daily", Weekly: "weekly" } as const,
);
export type BackupInterval =
  (typeof BackupInterval)[keyof typeof BackupInterval];
const INTERVALS: ReadonlySet<string> = new Set(Object.values(BackupInterval));

export function isBackupInterval(value: unknown): value is BackupInterval {
  return typeof value === "string" && INTERVALS.has(value);
}

export const MIN_DAYS_TO_KEEP = 1;
export const MAX_DAYS_TO_KEEP = 3650;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type BackupScheduleRule = {
  readonly enabled: boolean;
  readonly interval: BackupInterval;
  /** `HH:MM` in UTC. */
  readonly timeOfDayUtc: string;
};

const TIME_OF_DAY = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** True for `HH:MM` on a 24-hour UTC clock, `00:00` to `23:59`. */
export function isTimeOfDayUtc(value: unknown): value is string {
  return typeof value === "string" && TIME_OF_DAY.test(value);
}

function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const match = TIME_OF_DAY.exec(value);
  if (match === null) throw new RangeError("invalid timeOfDayUtc");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Length of one interval; the unit "twice the schedule interval" counts in. */
export function intervalMs(interval: BackupInterval): number {
  switch (interval) {
    case BackupInterval.Hourly:
      return HOUR_MS;
    case BackupInterval.Daily:
      return DAY_MS;
    case BackupInterval.Weekly:
      return WEEK_MS;
  }
}

/**
 * The most recent scheduled slot at or before `now`, in UTC:
 * - hourly: every hour at minute MM of `HH:MM` (the hour part is ignored);
 * - daily: every day at HH:MM;
 * - weekly: every Monday at HH:MM (the weekday is fixed, not chosen).
 */
export function latestSlotAtOrBefore(
  rule: Pick<BackupScheduleRule, "interval" | "timeOfDayUtc">,
  now: Date,
): Date {
  const { hour, minute } = parseTimeOfDay(rule.timeOfDayUtc);
  const t = now.getTime();
  if (rule.interval === BackupInterval.Hourly) {
    const slot = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      minute,
    );
    return new Date(slot <= t ? slot : slot - HOUR_MS);
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
  );
  if (rule.interval === BackupInterval.Daily) {
    return new Date(today <= t ? today : today - DAY_MS);
  }
  // Weekly: step back to Monday (getUTCDay: Sunday 0 ... Monday 1).
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = today - sinceMonday * DAY_MS;
  return new Date(monday <= t ? monday : monday - WEEK_MS);
}

/**
 * A scheduled backup is due when the schedule is on and no run of any kind or
 * outcome was requested since the latest slot. So:
 * - a manual backup taken after the slot covers it;
 * - a failed attempt after the slot also covers it: the next try is the next
 *   slot, never a retry storm;
 * - the first backup after the schedule is switched on is due at once, because
 *   nothing was requested since the latest slot;
 * - a run requested exactly at the slot instant is covered (strictly before is
 *   due).
 */
export function isBackupDue(
  rule: BackupScheduleRule,
  now: Date,
  newestRequestedAt: Date | null,
): boolean {
  if (!rule.enabled) return false;
  if (newestRequestedAt === null) return true;
  return newestRequestedAt.getTime() <
    latestSlotAtOrBefore(rule, now).getTime();
}

/** Without a schedule a backup goes stale after this long. */
export const NO_SCHEDULE_STALE_AFTER_MS = WEEK_MS;

/**
 * How old the newest good backup may be before the page turns amber: twice the
 * schedule interval, or seven days when no schedule is on.
 */
export function staleAfterMs(
  rule: Pick<BackupScheduleRule, "enabled" | "interval"> | null,
): number {
  return rule !== null && rule.enabled
    ? 2 * intervalMs(rule.interval)
    : NO_SCHEDULE_STALE_AFTER_MS;
}
