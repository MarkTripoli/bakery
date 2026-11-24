import type { MessageKey } from "@bakery/i18n";
import type {
  BackupDrill,
  BackupRun,
  BackupSchedule,
  BackupStatus,
} from "../../api/client.ts";

export const BACKUPS_GUIDE_HREF =
  "https://github.com/MarkTripoli/bakery/blob/main/docs/runbooks/backups.md";
export const BACKUPS_RUNNER_GUIDE_HREF =
  `${BACKUPS_GUIDE_HREF}#set-up-the-runner`;
export const BACKUPS_RESTORE_GUIDE_HREF =
  `${BACKUPS_GUIDE_HREF}#restore-in-place-replacing-the-installation-from-a-set`;
export const BACKUPS_DRILL_GUIDE_HREF =
  `${BACKUPS_GUIDE_HREF}#the-restore-drill-proof-that-a-backup-restores`;

export const RUNNER_QUIET_AFTER_MS = 60 * 60 * 1000;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type SpanUnit = "second" | "minute" | "hour" | "day";
export type Span = { readonly unit: SpanUnit; readonly value: number };

export function spanOfMilliseconds(milliseconds: number): Span {
  const elapsed = Math.max(0, milliseconds);
  if (elapsed >= DAY_MS) {
    return { unit: "day", value: Math.floor(elapsed / DAY_MS) };
  }
  if (elapsed >= HOUR_MS) {
    return { unit: "hour", value: Math.floor(elapsed / HOUR_MS) };
  }
  if (elapsed >= MINUTE_MS) {
    return { unit: "minute", value: Math.floor(elapsed / MINUTE_MS) };
  }
  return { unit: "second", value: Math.floor(elapsed / SECOND_MS) };
}

export function spanSince(iso: string, nowMs: number): Span {
  return spanOfMilliseconds(nowMs - Date.parse(iso));
}

export function spanOfSeconds(seconds: number): Span {
  return spanOfMilliseconds(seconds * SECOND_MS);
}

export function isQuiet(iso: string | null, nowMs: number): boolean {
  return iso !== null && nowMs - Date.parse(iso) > RUNNER_QUIET_AFTER_MS;
}

export type FailureCode = NonNullable<BackupRun["failureCode"]>;

export const CAUSE_KEYS: Readonly<
  Record<
    FailureCode,
    { cause: MessageKey; short: MessageKey; fix: MessageKey | null }
  >
> = {
  disk_full: {
    cause: "installation.backups.cause.disk_full",
    short: "installation.backups.causeShort.disk_full",
    fix: "installation.backups.fix.disk_full",
  },
  destination_refused: {
    cause: "installation.backups.cause.destination_refused",
    short: "installation.backups.causeShort.destination_refused",
    fix: "installation.backups.fix.destination_refused",
  },
  destination_unreachable: {
    cause: "installation.backups.cause.destination_unreachable",
    short: "installation.backups.causeShort.destination_unreachable",
    fix: "installation.backups.fix.destination_unreachable",
  },
  key_missing: {
    cause: "installation.backups.cause.key_missing",
    short: "installation.backups.causeShort.key_missing",
    fix: "installation.backups.fix.key_missing",
  },
  incomplete_set: {
    cause: "installation.backups.cause.incomplete_set",
    short: "installation.backups.causeShort.incomplete_set",
    fix: "installation.backups.fix.incomplete_set",
  },
  drain_timeout: {
    cause: "installation.backups.cause.drain_timeout",
    short: "installation.backups.causeShort.drain_timeout",
    fix: "installation.backups.fix.drain_timeout",
  },
  runner_error: {
    cause: "installation.backups.cause.runner_error",
    short: "installation.backups.causeShort.runner_error",
    fix: null,
  },
};

export type PhraseValues = {
  readonly ago?: Span;
  readonly age?: Span;
  readonly time?: string;
  readonly percent?: number;
  readonly cause?: MessageKey;
  readonly fix?: MessageKey;
};

export type Phrase = {
  readonly key: MessageKey;
  readonly values: PhraseValues;
};

export type NoticeTone = "error" | "success" | "information" | "warning";

export type Notice = {
  readonly id:
    | "never"
    | "waiting"
    | "protected"
    | "running"
    | "not_copied"
    | "stale"
    | "failed";
  readonly tone: NoticeTone;
  readonly title: Phrase;
  readonly lines: readonly Phrase[];
  readonly holdingWork: boolean;
};

export type NoticeInput = {
  readonly status: BackupStatus;
  readonly latest: BackupRun | null;
  readonly offsiteConfigured: boolean | null;
  readonly nowMs: number;
};

function failureLine(
  latest: BackupRun | null,
  keys: {
    readonly full: MessageKey;
    readonly causeOnly: MessageKey;
    readonly unknown: MessageKey;
  },
): Phrase {
  const code = latest?.failureCode ?? null;
  if (code === null) return { key: keys.unknown, values: {} };
  const { cause, fix } = CAUSE_KEYS[code];
  return fix === null
    ? { key: keys.causeOnly, values: { cause } }
    : { key: keys.full, values: { cause, fix } };
}

const FAILED_KEYS = {
  full: "installation.backups.notice.failed.cause",
  causeOnly: "installation.backups.notice.failed.causeOnly",
  unknown: "installation.backups.notice.failed.unknown",
} as const;

const OFFSITE_KEYS = {
  full: "installation.backups.notice.notCopied.cause",
  causeOnly: "installation.backups.notice.notCopied.causeOnly",
  unknown: "installation.backups.notice.notCopied.unknown",
} as const;

const STALE_KEYS = {
  full: "installation.backups.notice.stale.cause",
  causeOnly: "installation.backups.notice.stale.causeOnly",
  unknown: "installation.backups.notice.stale.unknown",
} as const;

function latestFailed(latest: BackupRun | null): BackupRun | null {
  return latest !== null && latest.status === "failed" ? latest : null;
}

export function backupNotice(input: NoticeInput): Notice {
  const { status, latest, nowMs } = input;
  const holdingWork = status.maintenanceState !== "off";
  const lastGood = status.lastGoodBackupAt;
  const waiting = status.waitingRunId !== null;
  if (status.state === "running" || waiting) {
    const percent = status.runningProgressPercent;
    const line: Phrase = status.state !== "running"
      ? { key: "installation.backups.notice.running.waiting", values: {} }
      : percent === null
      ? { key: "installation.backups.notice.running.started", values: {} }
      : {
        key: "installation.backups.notice.running.percent",
        values: { percent },
      };
    return {
      id: status.state === "running" ? "running" : "waiting",
      tone: "information",
      title: {
        key: status.state === "running"
          ? "installation.backups.notice.running.title"
          : "installation.backups.notice.waiting.title",
        values: {},
      },
      lines: status.state === "running" ? [line] : [
        line,
        {
          key: "installation.backups.notice.waiting.starts",
          values: {},
        },
      ],
      holdingWork,
    };
  }
  if (lastGood === null) {
    const failed = latestFailed(latest);
    return {
      id: "never",
      tone: "error",
      title: { key: "installation.backups.notice.never.title", values: {} },
      lines: [
        { key: "installation.backups.notice.never.body", values: {} },
        ...(failed === null ? [] : [failureLine(failed, FAILED_KEYS)]),
      ],
      holdingWork,
    };
  }
  if (status.state === "protected") {
    return {
      id: "protected",
      tone: "success",
      title: { key: "installation.backups.notice.protected.title", values: {} },
      lines: [{
        key: input.offsiteConfigured === false
          ? "installation.backups.notice.protected.hostOnly"
          : "installation.backups.notice.protected.offsite",
        values: { ago: spanSince(lastGood, nowMs) },
      }],
      holdingWork,
    };
  }
  if (status.state === "not_copied") {
    return {
      id: "not_copied",
      tone: "warning",
      title: {
        key: "installation.backups.notice.notCopied.title",
        values: {},
      },
      lines: [
        failureLine(latest, OFFSITE_KEYS),
        { key: "installation.backups.notice.notCopied.hostGood", values: {} },
      ],
      holdingWork,
    };
  }
  if (status.state === "stale") {
    const failed = latestFailed(latest);
    return {
      id: "stale",
      tone: "warning",
      title: {
        key: "installation.backups.notice.stale.title",
        values: { age: spanSince(lastGood, nowMs) },
      },
      lines: [
        {
          key: "installation.backups.notice.stale.since",
          values: { time: lastGood },
        },
        ...(failed === null ? [] : [failureLine(failed, STALE_KEYS)]),
      ],
      holdingWork,
    };
  }
  const since = status.lastAttemptAt ?? lastGood;
  return {
    id: "failed",
    tone: "error",
    title: {
      key: "installation.backups.notice.failed.title",
      values: { time: since },
    },
    lines: [failureLine(latest, FAILED_KEYS)],
    holdingWork,
  };
}

export function isBackingUp(status: BackupStatus): boolean {
  return status.state === "running" || status.waitingRunId !== null;
}

export type NextBackup =
  | { readonly kind: "off" }
  | { readonly kind: "at"; readonly iso: string };

export function nextBackup(
  schedule: Pick<BackupSchedule, "enabled" | "interval" | "timeOfDayUtc">,
  nowMs: number,
): NextBackup {
  if (!schedule.enabled) return { kind: "off" };
  const [hourText = "0", minuteText = "0"] = schedule.timeOfDayUtc.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const now = new Date(nowMs);
  if (schedule.interval === "hourly") {
    const slot = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      minute,
    );
    return {
      kind: "at",
      iso: new Date(slot > nowMs ? slot : slot + HOUR_MS).toISOString(),
    };
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
  );
  if (schedule.interval === "daily") {
    return {
      kind: "at",
      iso: new Date(today > nowMs ? today : today + DAY_MS).toISOString(),
    };
  }
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = today - sinceMonday * DAY_MS;
  return {
    kind: "at",
    iso: new Date(monday > nowMs ? monday : monday + 7 * DAY_MS).toISOString(),
  };
}

export type RestoreCheckFact =
  | { readonly kind: "never" }
  | {
    readonly kind: "recorded";
    readonly passed: boolean;
    readonly recordedAt: string;
    readonly restoredIn: Span;
  };

export function restoreCheckFact(
  latest: BackupDrill | null,
): RestoreCheckFact {
  if (latest === null) return { kind: "never" };
  return {
    kind: "recorded",
    passed: latest.outcome === "passed",
    recordedAt: latest.recordedAt,
    restoredIn: spanOfSeconds(latest.rtoSeconds),
  };
}

export function startedByKey(run: Pick<BackupRun, "triggerKind">): MessageKey {
  return run.triggerKind === "scheduled"
    ? "installation.backups.startedBy.scheduled"
    : "installation.backups.startedBy.person";
}

export function keptInKey(
  locations: readonly string[],
): MessageKey | null {
  if (locations.includes("off-site")) {
    return "installation.backups.keptIn.hostAndOffsite";
  }
  if (locations.includes("server-host")) {
    return "installation.backups.keptIn.host";
  }
  return null;
}

export type RunResult = {
  readonly key: MessageKey;
  readonly tone: "success" | "warning" | "danger" | "information" | "neutral";
  readonly cause: Phrase | null;
};

export function runResult(run: BackupRun): RunResult {
  const code = run.failureCode;
  const offsiteCause: Phrase | null = code === null ? null : {
    key: CAUSE_KEYS[code].fix === null
      ? "installation.backups.notice.notCopied.causeOnly"
      : "installation.backups.notice.notCopied.cause",
    values: {
      cause: CAUSE_KEYS[code].cause,
      ...(CAUSE_KEYS[code].fix === null ? {} : { fix: CAUSE_KEYS[code].fix }),
    },
  };
  const cause: Phrase | null = code === null ? null : {
    key: CAUSE_KEYS[code].short,
    values: {},
  };
  switch (run.status) {
    case "completed":
      return code === null
        ? {
          key: "installation.backups.result.completed",
          tone: "success",
          cause: null,
        }
        : {
          key: "installation.backups.result.notCopied",
          tone: "warning",
          cause: offsiteCause,
        };
    case "failed":
      return {
        key: "installation.backups.result.failed",
        tone: "danger",
        cause,
      };
    case "requested":
      return {
        key: "installation.backups.result.waiting",
        tone: "neutral",
        cause: null,
      };
    case "claimed":
    case "running":
      return {
        key: "installation.backups.result.running",
        tone: "information",
        cause: null,
      };
  }
}

export function takenAt(run: BackupRun): string {
  return run.finishedAt ?? run.startedAt ?? run.requestedAt;
}

export type SizeParts = {
  readonly unit: "byte" | "kilobyte" | "megabyte" | "gigabyte" | "terabyte";
  readonly value: number;
};

export function sizeOf(sizeBytes: string | null): SizeParts | null {
  if (sizeBytes === null) return null;
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const steps = [
    "byte",
    "kilobyte",
    "megabyte",
    "gigabyte",
    "terabyte",
  ] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < steps.length - 1) {
    value /= 1000;
    index += 1;
  }
  return { unit: steps[index]!, value };
}

export type DrillResult = {
  readonly passed: boolean;
  readonly cause: MessageKey | null;
  readonly fix: MessageKey | null;
  readonly failedChecks: readonly string[];
};

const DRILL_CAUSE_KEYS: Readonly<
  Record<NonNullable<BackupDrill["failureCode"]>, MessageKey>
> = {
  set_incomplete: "installation.backups.drillCause.set_incomplete",
  key_mismatch: "installation.backups.drillCause.key_mismatch",
  migration_unsupported:
    "installation.backups.drillCause.migration_unsupported",
  cutoff_mismatch: "installation.backups.drillCause.cutoff_mismatch",
  restore_failed: "installation.backups.drillCause.restore_failed",
  references_missing: "installation.backups.drillCause.references_missing",
  drill_error: "installation.backups.drillCause.drill_error",
};

const DRILL_FIX_KEYS: Readonly<
  Record<NonNullable<BackupDrill["failureCode"]>, MessageKey>
> = {
  set_incomplete: "installation.backups.drillFix.set_incomplete",
  key_mismatch: "installation.backups.drillFix.key_mismatch",
  migration_unsupported: "installation.backups.drillFix.migration_unsupported",
  cutoff_mismatch: "installation.backups.drillFix.cutoff_mismatch",
  restore_failed: "installation.backups.drillFix.restore_failed",
  references_missing: "installation.backups.drillFix.references_missing",
  drill_error: "installation.backups.drillFix.drill_error",
};

export function drillResult(drill: BackupDrill): DrillResult {
  const passed = drill.outcome === "passed";
  const code = drill.failureCode;
  const known = code !== null && code in DRILL_CAUSE_KEYS;
  return {
    passed,
    cause: passed
      ? null
      : known
      ? DRILL_CAUSE_KEYS[code]
      : "installation.backups.drillCause.unknown",
    fix: passed
      ? null
      : known
      ? DRILL_FIX_KEYS[code]
      : "installation.backups.drillFix.unknown",
    failedChecks: passed ? [] : drill.checksFailed,
  };
}

export type SettingsWord = {
  readonly key: MessageKey;
  readonly values: { readonly time?: string; readonly interval?: MessageKey };
};

export function scheduleWords(
  schedule: Pick<BackupSchedule, "enabled" | "interval" | "timeOfDayUtc">,
): SettingsWord {
  if (!schedule.enabled) {
    return { key: "installation.backups.settings.schedule.off", values: {} };
  }
  const interval: MessageKey = schedule.interval === "hourly"
    ? "installation.backups.interval.hourly"
    : schedule.interval === "daily"
    ? "installation.backups.interval.daily"
    : "installation.backups.interval.weekly";
  return {
    key: "installation.backups.settings.schedule.on",
    values: { interval, time: schedule.timeOfDayUtc },
  };
}

export function offsiteWords(configured: boolean): MessageKey {
  return configured
    ? "installation.backups.settings.offsite.on"
    : "installation.backups.settings.offsite.off";
}

export function pointInTimeWords(
  enabled: boolean,
  reported: boolean,
): MessageKey {
  if (!enabled) return "installation.backups.settings.pitr.off";
  return reported
    ? "installation.backups.settings.pitr.on"
    : "installation.backups.settings.pitr.waiting";
}
