import type {
  BackupDrill,
  BackupOffsiteVerification,
  BackupRun,
  BackupSchedule,
  BackupStatus,
} from "../../api/client.ts";
export { timeAgo } from "../../pages/batches/batch-display.ts";

/**
 * What the Backups page (#64) shows, worked out from what the server answers.
 * Pure: no React, no clock of its own, so each rule is tested in tests/unit.
 */

export type BackupFailureCode = NonNullable<BackupRun["failureCode"]>;
export type BackupDrillFailureCode = NonNullable<BackupDrill["failureCode"]>;

/** Every cause the server can name, in the order the design lists them. */
export const BACKUP_FAILURE_CODES: readonly BackupFailureCode[] = [
  "disk_full",
  "destination_refused",
  "destination_unreachable",
  "key_missing",
  "incomplete_set",
  "drain_timeout",
  "runner_error",
];

/** The cause of a backup, never its raw code: the screen prints its sentence. */
export type BackupCause = {
  readonly code: BackupFailureCode;
  /** The backup service's own answer, quoted as it is. */
  readonly detail: string | null;
};

/** The one status line at the top of the page. */
export type BackupNotice =
  | { readonly kind: "never"; readonly cause: BackupCause | null }
  | {
    readonly kind: "protected";
    readonly finishedAt: string;
    /** False when no off-site copy is set up: the copy is on this server only. */
    readonly offsite: boolean;
  }
  | {
    readonly kind: "running";
    readonly percent: number | null;
    /** Asked for, but the backup service has not started it yet. */
    readonly waiting: boolean;
  }
  | { readonly kind: "notCopied"; readonly cause: BackupCause | null }
  | {
    readonly kind: "stale";
    readonly lastGoodAt: string;
    readonly cause: BackupCause | null;
  }
  | {
    readonly kind: "failed";
    readonly since: string;
    readonly lastGoodAt: string | null;
    readonly cause: BackupCause | null;
  };

export type BackupNoticeTone = "success" | "information" | "warning" | "error";

export function noticeTone(notice: BackupNotice): BackupNoticeTone {
  switch (notice.kind) {
    case "protected":
      return "success";
    case "running":
      return "information";
    case "notCopied":
    case "stale":
      return "warning";
    case "never":
    case "failed":
      return "error";
  }
}

function causeOf(run: BackupRun | null): BackupCause | null {
  if (run === null || run.failureCode === null) return null;
  return { code: run.failureCode, detail: run.failureDetail };
}

/**
 * The status line. `latest` is the newest backup in the list (it carries the
 * cause the status does not); `offsiteConfigured` says whether a copy is
 * sent off-site at all.
 */
export function backupNotice(
  status: BackupStatus,
  latest: BackupRun | null,
  offsiteConfigured: boolean,
): BackupNotice {
  if (
    status.state === "running" || status.runningRunId !== null ||
    status.waitingRunId !== null
  ) {
    return {
      kind: "running",
      percent: status.runningRunId === null
        ? null
        : status.runningProgressPercent,
      waiting: status.runningRunId === null,
    };
  }
  const failedCause = latest?.status === "failed" ? causeOf(latest) : null;
  if (status.lastGoodBackupAt === null) {
    return { kind: "never", cause: failedCause };
  }
  switch (status.state) {
    case "protected":
      return {
        kind: "protected",
        finishedAt: status.lastGoodBackupAt,
        offsite: offsiteConfigured,
      };
    case "not_copied":
      return {
        kind: "notCopied",
        cause: latest?.status === "completed" ? causeOf(latest) : null,
      };
    case "stale":
      return {
        kind: "stale",
        lastGoodAt: status.lastGoodBackupAt,
        cause: failedCause,
      };
    case "failed":
      return {
        kind: "failed",
        since: status.lastAttemptAt ?? latest?.finishedAt ??
          status.lastGoodBackupAt,
        lastGoodAt: status.lastGoodBackupAt,
        cause: failedCause,
      };
    default:
      return {
        kind: "failed",
        since: status.lastAttemptAt ?? status.lastGoodBackupAt,
        lastGoodAt: status.lastGoodBackupAt,
        cause: failedCause,
      };
  }
}

/** Whether a backup is asked for or running, so Back up now reads "Backing up…". */
export function backupBusy(status: BackupStatus): boolean {
  return status.state === "running" || status.runningRunId !== null ||
    status.waitingRunId !== null;
}

/** The backup takes its snapshot: new work waits for a moment. */
export function holdingWork(status: BackupStatus): boolean {
  return status.maintenanceState !== "off";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** True for `HH:MM` on a 24-hour clock, 00:00 to 23:59. */
export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

/**
 * When the next scheduled backup is due, as the server works it out
 * (apps/server/src/modules/backups/schedule.ts): every hour at minute MM, every
 * day at HH:MM, or every Monday at HH:MM, all in UTC. Null when the schedule is
 * off or its time cannot be read.
 */
export function nextBackupAt(
  schedule: Pick<BackupSchedule, "enabled" | "interval" | "timeOfDayUtc">,
  now: Date,
): Date | null {
  if (!schedule.enabled) return null;
  const match = TIME_OF_DAY.exec(schedule.timeOfDayUtc);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const t = now.getTime();
  if (schedule.interval === "hourly") {
    const slot = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      minute,
    );
    return new Date(slot > t ? slot : slot + HOUR_MS);
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
  );
  if (schedule.interval === "daily") {
    return new Date(today > t ? today : today + DAY_MS);
  }
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = today - sinceMonday * DAY_MS;
  return new Date(monday > t ? monday : monday + WEEK_MS);
}

/** The person's own clock time for a UTC `HH:MM` on the given day. */
export function localTimeOf(
  timeOfDayUtc: string,
  day: Date,
  locale: string,
  timeZone: string,
): string | null {
  const match = TIME_OF_DAY.exec(timeOfDayUtc);
  if (match === null) return null;
  const at = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
  );
  return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone })
    .format(new Date(at));
}

/** A span of time as one rounded unit, for "{n} days old" and "restored in". */
export type Span = {
  readonly unit: "second" | "minute" | "hour" | "day";
  readonly value: number;
};

export function spanOf(milliseconds: number): Span {
  const ms = Math.max(0, milliseconds);
  if (ms >= DAY_MS) return { unit: "day", value: Math.round(ms / DAY_MS) };
  if (ms >= HOUR_MS) return { unit: "hour", value: Math.round(ms / HOUR_MS) };
  if (ms >= MINUTE_MS) {
    return { unit: "minute", value: Math.round(ms / MINUTE_MS) };
  }
  return { unit: "second", value: Math.round(ms / 1000) };
}

/** "3 days", "1 hour", in the person's language. */
export function formatSpan(span: Span, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: span.unit,
    unitDisplay: "long",
  }).format(span.value);
}

/** Quiet for more than an hour: the backup service may have stopped. */
export const RUNNER_QUIET_AFTER_MS = HOUR_MS;

/** How long the backup service has been quiet, or null while it is heard from. */
export function runnerQuietFor(
  lastUsedAt: string | null,
  now: number,
): number | null {
  if (lastUsedAt === null) return null;
  const quiet = now - new Date(lastUsedAt).getTime();
  return quiet > RUNNER_QUIET_AFTER_MS ? quiet : null;
}

/** A size in bytes (a decimal string, possibly past 2^53) as "1.4 GB". */
export function formatSize(sizeBytes: string | null, locale: string): string {
  if (sizeBytes === null) return "";
  const bytes = Number(sizeBytes);
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
}

/** Where a finished backup is kept: on this server, and off-site when copied. */
export function keptIn(run: BackupRun): "server" | "serverAndOffsite" | null {
  if (run.locations.length === 0) return null;
  return run.locations.includes("off-site") ? "serverAndOffsite" : "server";
}

/** The result column of one backup. */
export type RunResult =
  | "finished"
  | "notCopied"
  | "failed"
  | "running"
  | "waiting";

export function runResult(run: BackupRun): RunResult {
  switch (run.status) {
    case "completed":
      return run.failureCode === null ? "finished" : "notCopied";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "requested":
    case "claimed":
      return "waiting";
  }
}

/** When a backup was taken: when it started, or when it was asked for. */
export function takenAt(run: BackupRun): string {
  return run.startedAt ?? run.requestedAt;
}

/** The newest backup across every loaded page, or null when there is none. */
export function newestRun(
  pages: readonly { readonly items: readonly BackupRun[] }[] | undefined,
): BackupRun | null {
  return pages?.[0]?.items[0] ?? null;
}

/** What a test send to the bucket answered, as the words the page shows. */
export function verificationTone(
  outcome: BackupOffsiteVerification["outcome"],
): "success" | "warning" | "error" {
  if (outcome === "verified") return "success";
  if (outcome === "not_configured") return "warning";
  return "error";
}

/** Field problems on the schedule form, by field, as message suffixes. */
export type ScheduleProblems = {
  readonly timeOfDayUtc?: "time";
  readonly daysToKeep?: "days";
};

export function scheduleProblems(
  draft: { readonly timeOfDayUtc: string; readonly daysToKeep: string },
): ScheduleProblems {
  const days = Number(draft.daysToKeep);
  return {
    ...(isTimeOfDay(draft.timeOfDayUtc) ? {} : { timeOfDayUtc: "time" }),
    ...(/^[0-9]+$/.test(draft.daysToKeep) && days >= 1 && days <= 3650
      ? {}
      : { daysToKeep: "days" }),
  };
}

/** Field problems on the off-site form. */
export type OffsiteProblems = {
  readonly endpoint?: "https";
  readonly region?: "required";
  readonly bucket?: "required";
  readonly keys?: "both";
};

export function offsiteProblems(
  draft: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  },
  keysSaved: boolean,
): OffsiteProblems {
  const id = draft.accessKeyId.trim() !== "";
  const secret = draft.secretAccessKey.trim() !== "";
  return {
    ...(/^https:\/\/[^\s/]+/.test(draft.endpoint.trim())
      ? {}
      : { endpoint: "https" }),
    ...(draft.region.trim() === "" ? { region: "required" } : {}),
    ...(draft.bucket.trim().length < 3 ? { bucket: "required" } : {}),
    // The two keys travel together; the first save needs both.
    ...(id !== secret || (!keysSaved && !id) ? { keys: "both" } : {}),
  };
}

export function hasProblems(problems: object): boolean {
  return Object.keys(problems).length > 0;
}
