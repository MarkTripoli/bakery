import type { StorageSettings, StorageSettingsPut } from "../../api/client.ts";

/** A megabyte and a gigabyte the way the server counts them: powers of 1024. */
export const MEGABYTE = 1024 ** 2;
export const GIGABYTE = 1024 ** 3;

/** The marks on the usage meter: where Bakery starts warning, and where saving new files pauses. */
export const WARNING_SHARE = 0.75;
export const PAUSED_SHARE = 0.9;

/** Every limit the page edits, in the order the page shows them. */
export const STORAGE_FIELDS = [
  "organizationQuotaBytes",
  "projectQuotaBytes",
  "personalQuotaBytes",
  "maxFileBytes",
  "stepWriteBytes",
  "stepWriteFiles",
  "workingVersionsKept",
  "trashRetentionDays",
  "scratchRetentionDays",
] as const;
export type StorageField = typeof STORAGE_FIELDS[number];

/** Gigabytes, megabytes, or a plain count of versions, days or files. */
export type StorageFieldUnit = "gigabytes" | "megabytes" | "count";

/** The fields an empty box saves as Bakery's default: one agent step's write limits. */
export const DEFAULTED_FIELDS: readonly StorageField[] = [
  "stepWriteBytes",
  "stepWriteFiles",
];

/** Bytes in one of a field's units; 1 for a plain count. */
export function unitBytes(unit: StorageFieldUnit): number {
  return unit === "gigabytes" ? GIGABYTE : unit === "megabytes" ? MEGABYTE : 1;
}

type FieldRule = {
  readonly unit: StorageFieldUnit;
  /** Smallest value, in the field's unit. */
  readonly min: number;
  /** Largest value, in the field's unit. */
  readonly max: number;
  /** Bakery's default, in the field's unit. */
  readonly fallback: number;
};

/** The server's bounds, in the field's unit, and Bakery's defaults. */
export const FIELD_RULES: Readonly<Record<StorageField, FieldRule>> = {
  organizationQuotaBytes: {
    unit: "gigabytes",
    min: 1,
    max: Math.floor(1125899906842624 / GIGABYTE),
    fallback: 100,
  },
  projectQuotaBytes: {
    unit: "gigabytes",
    min: 1,
    max: Math.floor(1125899906842624 / GIGABYTE),
    fallback: 50,
  },
  personalQuotaBytes: {
    unit: "gigabytes",
    min: 1,
    max: Math.floor(1125899906842624 / GIGABYTE),
    fallback: 10,
  },
  maxFileBytes: { unit: "gigabytes", min: 1, max: 5, fallback: 5 },
  // The server accepts 1 MiB to 1,024 GiB of writing per step, and 1 to a million files.
  stepWriteBytes: {
    unit: "megabytes",
    min: 1,
    max: 1024 * 1024,
    fallback: 2048,
  },
  stepWriteFiles: { unit: "count", min: 1, max: 1_000_000, fallback: 2000 },
  workingVersionsKept: { unit: "count", min: 1, max: 1000, fallback: 20 },
  trashRetentionDays: { unit: "count", min: 1, max: 3650, fallback: 30 },
  scratchRetentionDays: { unit: "count", min: 1, max: 3650, fallback: 30 },
};

/** What the Admin has typed, one string per field. */
export type StorageDraft = Readonly<Record<StorageField, string>>;

/** A saved value as the field shows it: whole gigabytes or megabytes, or the count. */
export function fieldText(field: StorageField, value: number): string {
  const unit = FIELD_RULES[field].unit;
  if (unit === "count") return String(value);
  const shown = value / unitBytes(unit);
  return Number.isInteger(shown)
    ? String(shown)
    : String(Math.round(shown * 100) / 100);
}

/** The draft that shows the saved settings. */
export function draftOf(settings: StorageSettings): StorageDraft {
  return Object.fromEntries(
    STORAGE_FIELDS.map((field) => [field, fieldText(field, settings[field])]),
  ) as StorageDraft;
}

/** The draft that shows Bakery's defaults; nothing is saved until Save. */
export function defaultDraft(): StorageDraft {
  return Object.fromEntries(
    STORAGE_FIELDS.map((field) => [field, String(FIELD_RULES[field].fallback)]),
  ) as StorageDraft;
}

/** Whether the draft differs from what is saved. */
export function draftChanged(
  draft: StorageDraft,
  settings: StorageSettings,
): boolean {
  const saved = draftOf(settings);
  return STORAGE_FIELDS.some((field) => draft[field].trim() !== saved[field]);
}

/** Why a field cannot be saved, or null. */
export type FieldProblem = "whole" | "tooLarge";

export function fieldProblem(
  field: StorageField,
  text: string,
  saved: StorageSettings,
): FieldProblem | null {
  const trimmed = text.trim();
  // An empty agent-step box saves Bakery's default.
  if (trimmed === "" && DEFAULTED_FIELDS.includes(field)) return null;
  // An untouched field keeps its saved value, even one an API client set that
  // is not a whole number of gigabytes.
  if (trimmed === fieldText(field, saved[field])) return null;
  if (!/^\d+$/.test(trimmed)) return "whole";
  const value = Number(trimmed);
  const rule = FIELD_RULES[field];
  if (value < rule.min) return "whole";
  if (value > rule.max) return "tooLarge";
  return null;
}

/** The first field in error, in the order the page shows them, or null. */
export function firstProblem(
  draft: StorageDraft,
  saved: StorageSettings,
): { readonly field: StorageField; readonly problem: FieldProblem } | null {
  for (const field of STORAGE_FIELDS) {
    const problem = fieldProblem(field, draft[field], saved);
    if (problem !== null) return { field, problem };
  }
  return null;
}

/** The body of a save: every limit, an untouched one as it was saved. */
export function putOf(
  draft: StorageDraft,
  saved: StorageSettings,
): StorageSettingsPut {
  const value = (field: StorageField): number => {
    const text = draft[field].trim();
    if (text === fieldText(field, saved[field])) return saved[field];
    const rule = FIELD_RULES[field];
    const number = text === "" && DEFAULTED_FIELDS.includes(field)
      ? rule.fallback
      : Number(text);
    return number * unitBytes(rule.unit);
  };
  return {
    workingVersionsKept: value("workingVersionsKept"),
    trashRetentionDays: value("trashRetentionDays"),
    scratchRetentionDays: value("scratchRetentionDays"),
    maxFileBytes: value("maxFileBytes"),
    organizationQuotaBytes: value("organizationQuotaBytes"),
    projectQuotaBytes: value("projectQuotaBytes"),
    personalQuotaBytes: value("personalQuotaBytes"),
    stepWriteBytes: value("stepWriteBytes"),
    stepWriteFiles: value("stepWriteFiles"),
  };
}

/** Whether the organization quota in the draft is below what is stored. */
export function belowStored(
  draft: StorageDraft,
  saved: StorageSettings,
): boolean {
  if (
    fieldProblem(
      "organizationQuotaBytes",
      draft.organizationQuotaBytes,
      saved,
    ) !== null
  ) {
    return false;
  }
  return putOf(draft, saved).organizationQuotaBytes <
    saved.organizationUsedBytes;
}

/** A share of the quota used, 0 to 1, or 0 when there is no quota. */
export function usedShare(settings: StorageSettings): number {
  return settings.organizationQuotaBytes > 0
    ? settings.organizationUsedBytes / settings.organizationQuotaBytes
    : 0;
}

/** The size message and its value: bytes, KB, MB, GB or TB with one decimal at most. */
export type SizeWords = {
  readonly key:
    | "files.size.bytes"
    | "files.size.kilobytes"
    | "files.size.megabytes"
    | "files.size.gigabytes"
    | "organizationStorage.size.terabytes";
  readonly value: string;
};

export function sizeWords(bytes: number, locale: string): SizeWords {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    }).format(value);
  if (bytes < 1024) return { key: "files.size.bytes", value: number(bytes, 0) };
  if (bytes < 1024 ** 2) {
    return { key: "files.size.kilobytes", value: number(bytes / 1024, 1) };
  }
  if (bytes < GIGABYTE) {
    return { key: "files.size.megabytes", value: number(bytes / 1024 ** 2, 1) };
  }
  if (bytes < 1024 ** 4) {
    return { key: "files.size.gigabytes", value: number(bytes / GIGABYTE, 1) };
  }
  return {
    key: "organizationStorage.size.terabytes",
    value: number(bytes / 1024 ** 4, 1),
  };
}
