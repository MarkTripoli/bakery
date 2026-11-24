import type { MessageKey } from "@bakery/i18n";
import type {
  BackupOffsite,
  BackupOffsitePut,
  BackupOffsiteVerification,
  BackupPointInTime,
  BackupSchedule,
  BackupSchedulePut,
} from "../../api/client.ts";

export type Interval = BackupSchedule["interval"];

export const DAYS_TO_KEEP_MIN = 1;
export const DAYS_TO_KEEP_MAX = 3650;
export const ENDPOINT_MIN = 8;
export const ENDPOINT_MAX = 512;
export const REGION_MAX = 63;
export const BUCKET_MIN = 3;
export const BUCKET_MAX = 63;
export const PREFIX_MAX = 256;
export const ACCESS_KEY_ID_MAX = 256;
export const SECRET_ACCESS_KEY_MAX = 1024;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTE = /^[0-5]?\d$/;
const WHOLE_NUMBER = /^\d{1,5}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const HTTPS_ORIGIN = /^https:\/\/[^\s/?#@]+$/i;

type ScheduleFields = Pick<
  BackupSchedule,
  "enabled" | "interval" | "timeOfDayUtc" | "daysToKeep"
>;

type OffsiteDestination = Pick<
  BackupOffsite,
  "configured" | "endpoint" | "region" | "bucket"
>;

export type ScheduleDraft = {
  readonly enabled: boolean;
  readonly interval: Interval;
  readonly time: string;
  readonly minute: string;
  readonly daysToKeep: string;
};

export type ScheduleProblems = {
  readonly time?: MessageKey;
  readonly minute?: MessageKey;
  readonly daysToKeep?: MessageKey;
};

export function scheduleDraftOf(schedule: ScheduleFields): ScheduleDraft {
  return {
    enabled: schedule.enabled,
    interval: schedule.interval,
    time: schedule.timeOfDayUtc,
    minute: schedule.timeOfDayUtc.slice(3),
    daysToKeep: String(schedule.daysToKeep),
  };
}

export function scheduleProblems(draft: ScheduleDraft): ScheduleProblems {
  const days = WHOLE_NUMBER.test(draft.daysToKeep)
    ? Number(draft.daysToKeep)
    : null;
  const time: ScheduleProblems = draft.interval !== "hourly" &&
      !TIME_OF_DAY.test(draft.time)
    ? { time: "installation.backups.settings.schedule.time.invalid" }
    : {};
  const minute: ScheduleProblems =
    draft.interval === "hourly" && !MINUTE.test(draft.minute)
      ? { minute: "installation.backups.settings.schedule.minute.invalid" }
      : {};
  const daysToKeep: ScheduleProblems =
    days === null || days < DAYS_TO_KEEP_MIN || days > DAYS_TO_KEEP_MAX
      ? { daysToKeep: "installation.backups.settings.schedule.days.invalid" }
      : {};
  return { ...time, ...minute, ...daysToKeep };
}

export function scheduleReady(draft: ScheduleDraft): boolean {
  return Object.keys(scheduleProblems(draft)).length === 0;
}

export function scheduleTimeOfDay(draft: ScheduleDraft): string {
  return draft.interval === "hourly"
    ? `00:${draft.minute.padStart(2, "0")}`
    : draft.time;
}

export function scheduleInput(draft: ScheduleDraft): BackupSchedulePut | null {
  if (!scheduleReady(draft)) return null;
  return {
    enabled: draft.enabled,
    interval: draft.interval,
    timeOfDayUtc: scheduleTimeOfDay(draft),
    daysToKeep: Number(draft.daysToKeep),
  };
}

export function scheduleChanged(
  draft: ScheduleDraft,
  saved: ScheduleFields,
): boolean {
  const base = scheduleDraftOf(saved);
  return draft.enabled !== base.enabled ||
    draft.interval !== base.interval ||
    scheduleTimeOfDay(draft) !== scheduleTimeOfDay(base) ||
    draft.daysToKeep !== base.daysToKeep;
}

export function localTimeOfDay(
  time: string,
  nowMs: number,
  locale: string,
  timeZone: string,
): string | null {
  if (!TIME_OF_DAY.test(time)) return null;
  const day = new Date(nowMs);
  const at = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Number(time.slice(0, 2)),
    Number(time.slice(3)),
  );
  const options = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  } as const;
  const local = new Intl.DateTimeFormat(locale, { ...options, timeZone })
    .format(at);
  const utc = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
    .format(at);
  return local === utc ? null : local;
}

export type OffsiteDraft = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export type OffsiteProblems = {
  readonly endpoint?: MessageKey;
  readonly region?: MessageKey;
  readonly bucket?: MessageKey;
  readonly prefix?: MessageKey;
  readonly keys?: MessageKey;
};

export function offsiteDraftOf(
  saved: Pick<BackupOffsite, "endpoint" | "region" | "bucket" | "prefix">,
): OffsiteDraft {
  return {
    endpoint: saved.endpoint ?? "",
    region: saved.region ?? "",
    bucket: saved.bucket ?? "",
    prefix: saved.prefix ?? "",
    accessKeyId: "",
    secretAccessKey: "",
  };
}

export function keysRequired(
  draft: OffsiteDraft,
  saved: OffsiteDestination,
): boolean {
  return !saved.configured ||
    draft.endpoint.trim() !== (saved.endpoint ?? "") ||
    draft.region.trim() !== (saved.region ?? "") ||
    draft.bucket.trim() !== (saved.bucket ?? "");
}

function endpointProblem(endpoint: string): OffsiteProblems {
  if (endpoint === "") return {};
  if (!endpoint.toLowerCase().startsWith("https://")) {
    return {
      endpoint: "installation.backups.settings.offsite.endpoint.scheme",
    };
  }
  if (!HTTPS_ORIGIN.test(endpoint)) {
    return {
      endpoint: "installation.backups.settings.offsite.endpoint.origin",
    };
  }
  if (endpoint.length < ENDPOINT_MIN || endpoint.length > ENDPOINT_MAX) {
    return {
      endpoint: "installation.backups.settings.offsite.endpoint.length",
    };
  }
  return {};
}

export function offsiteProblems(
  draft: OffsiteDraft,
  saved: OffsiteDestination,
): OffsiteProblems {
  const endpoint = draft.endpoint.trim();
  const region = draft.region.trim();
  const bucket = draft.bucket.trim();
  const keyHalf = (draft.accessKeyId === "") !==
    (draft.secretAccessKey === "");
  const keysTooLong = draft.accessKeyId.length > ACCESS_KEY_ID_MAX ||
    draft.secretAccessKey.length > SECRET_ACCESS_KEY_MAX;
  const keysMissing = draft.accessKeyId === "" &&
    draft.secretAccessKey === "" && keysRequired(draft, saved) &&
    (endpoint !== "" || region !== "" || bucket !== "");
  const regionProblem: OffsiteProblems = region.length > REGION_MAX
    ? { region: "installation.backups.settings.offsite.region.invalid" }
    : {};
  const bucketProblem: OffsiteProblems = bucket !== "" &&
      (bucket.length < BUCKET_MIN || bucket.length > BUCKET_MAX ||
        !BUCKET_NAME.test(bucket))
    ? { bucket: "installation.backups.settings.offsite.bucket.invalid" }
    : {};
  const prefixProblem: OffsiteProblems = draft.prefix.length > PREFIX_MAX
    ? { prefix: "installation.backups.settings.offsite.prefix.invalid" }
    : {};
  const keysProblem: OffsiteProblems = keyHalf || keysMissing
    ? { keys: "installation.backups.settings.offsite.keys.both" }
    : keysTooLong
    ? { keys: "installation.backups.settings.offsite.keys.tooLong" }
    : {};
  return {
    ...endpointProblem(endpoint),
    ...regionProblem,
    ...bucketProblem,
    ...prefixProblem,
    ...keysProblem,
  };
}

export function offsiteRequiredProblems(draft: OffsiteDraft): OffsiteProblems {
  return {
    ...(draft.endpoint.trim() === ""
      ? {
        endpoint:
          "installation.backups.settings.offsite.endpoint.scheme" as const,
      }
      : {}),
    ...(draft.region.trim() === ""
      ? {
        region:
          "installation.backups.settings.offsite.region.required" as const,
      }
      : {}),
    ...(draft.bucket.trim() === ""
      ? {
        bucket: "installation.backups.settings.offsite.bucket.invalid" as const,
      }
      : {}),
  };
}

export function offsiteReady(
  draft: OffsiteDraft,
  saved: OffsiteDestination,
): boolean {
  return draft.endpoint.trim() !== "" && draft.region.trim() !== "" &&
    draft.bucket.trim() !== "" &&
    Object.keys(offsiteProblems(draft, saved)).length === 0;
}

export function offsiteInput(draft: OffsiteDraft): BackupOffsitePut {
  return {
    endpoint: draft.endpoint.trim(),
    region: draft.region.trim(),
    bucket: draft.bucket.trim(),
    prefix: draft.prefix.trim(),
    ...(draft.accessKeyId === "" && draft.secretAccessKey === "" ? {} : {
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
    }),
  };
}

export type SaveFailure =
  | "stale"
  | "invalid"
  | "credentialsRequired"
  | "unavailable"
  | "failed";

export function classifySaveFailure(
  failure: {
    readonly status: number | null;
    readonly code?: string;
    readonly reason?: string;
    readonly issueCodes?: readonly string[];
  },
): SaveFailure {
  if (failure.status === 412 || failure.status === 428) return "stale";
  if (failure.status === 422) {
    return failure.issueCodes?.includes("credentials_required")
      ? "credentialsRequired"
      : "invalid";
  }
  if (failure.status === 400) return "invalid";
  if (
    failure.status === 409 && failure.code === "STATE_CONFLICT" &&
    failure.reason === undefined
  ) return "unavailable";
  return "failed";
}

export type VerifyOutcome = BackupOffsiteVerification["outcome"];

export const VERIFY_KEYS: Readonly<Record<VerifyOutcome, MessageKey>> = {
  verified: "installation.backups.settings.verify.verified",
  not_configured: "installation.backups.settings.verify.not_configured",
  destination_refused:
    "installation.backups.settings.verify.destination_refused",
  destination_unreachable:
    "installation.backups.settings.verify.destination_unreachable",
  destination_private_address:
    "installation.backups.settings.verify.destination_private_address",
  integrity_failed: "installation.backups.settings.verify.integrity_failed",
};

export type PointInTimeView =
  | { readonly kind: "off" }
  | { readonly kind: "waiting" }
  | {
    readonly kind: "window";
    readonly earliest: string;
    readonly latest: string;
    readonly reportedAt: string;
  };

export function pointInTimeView(
  pointInTime: Pick<
    BackupPointInTime,
    "enabled" | "earliestRestorableAt" | "latestRestorableAt" | "reportedAt"
  >,
): PointInTimeView {
  if (!pointInTime.enabled) return { kind: "off" };
  const { earliestRestorableAt, latestRestorableAt, reportedAt } = pointInTime;
  if (
    earliestRestorableAt === null || latestRestorableAt === null ||
    reportedAt === null
  ) return { kind: "waiting" };
  return {
    kind: "window",
    earliest: earliestRestorableAt,
    latest: latestRestorableAt,
    reportedAt,
  };
}
