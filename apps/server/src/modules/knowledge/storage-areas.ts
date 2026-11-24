/**
 * Folder policy rules for the storage tree's working areas (chapter 25
 * sections 17.1 and 17.5, slice F5, #447). Pure: no database, no clock. The
 * store in storage-working-areas.ts asks these and does what they say, so each
 * rule is tested once here and enforced in one place.
 */

import type { StoragePolicy } from "./storage-tree.ts";

/** The organization settings O42 names, with the defaults section 17.5 gives. */
export type StorageLimits = Readonly<{
  /** Versions a working-area file keeps; older ones are pruned on write. */
  workingVersionsKept: number;
  /** Days a trashed entry stays restorable before the sweep removes it. */
  trashRetentionDays: number;
  /** Days a scratch file lives after its last write. */
  scratchRetentionDays: number;
  /** Largest single file, in bytes. */
  maxFileBytes: number;
  organizationQuotaBytes: number;
  projectQuotaBytes: number;
  personalQuotaBytes: number;
  /** Bytes one run step attempt may write through an agent (O49). */
  stepWriteBytes: number;
  /** Distinct files and folders one run step attempt may write (O49). */
  stepWriteFiles: number;
}>;

const GIB = 1024 * 1024 * 1024;

/**
 * Section 17.5 fixes the first four. It does not fix quota sizes, so these are
 * Bakery's choice: generous enough not to bite a normal organization, small
 * enough that a runaway writer pauses long before the disk does. Every value
 * is an organization setting an Admin can change.
 */
export const DEFAULT_STORAGE_LIMITS: StorageLimits = Object.freeze({
  workingVersionsKept: 20,
  trashRetentionDays: 30,
  scratchRetentionDays: 30,
  maxFileBytes: 5 * GIB,
  organizationQuotaBytes: 100 * GIB,
  projectQuotaBytes: 50 * GIB,
  personalQuotaBytes: 10 * GIB,
  // O49: by default each step may write up to 2 GiB and 2,000 files.
  stepWriteBytes: 2 * GIB,
  stepWriteFiles: 2000,
});

/** Bounds an Admin may set; outside them a setting is refused, never clamped. */
export const STORAGE_LIMIT_BOUNDS = Object.freeze(
  {
    workingVersionsKept: [1, 1000],
    trashRetentionDays: [1, 3650],
    scratchRetentionDays: [1, 3650],
    maxFileBytes: [1, 5 * GIB],
    organizationQuotaBytes: [1, 1024 * 1024 * GIB],
    projectQuotaBytes: [1, 1024 * 1024 * GIB],
    personalQuotaBytes: [1, 1024 * 1024 * GIB],
    stepWriteBytes: [1024 * 1024, 1024 * GIB],
    stepWriteFiles: [1, 1_000_000],
  } as const satisfies Record<keyof StorageLimits, readonly [number, number]>,
);

/** The field of a limit outside its bounds, or undefined when all are valid. */
export function invalidLimit(
  limits: StorageLimits,
): keyof StorageLimits | undefined {
  for (
    const [field, [low, high]] of Object.entries(STORAGE_LIMIT_BOUNDS) as [
      keyof StorageLimits,
      readonly [number, number],
    ][]
  ) {
    const value = limits[field];
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      return field;
    }
  }
  return undefined;
}

/** Why an area refuses an operation; the store turns it into a named fault. */
export type AreaRefusal =
  | "record_area"
  | "library_area"
  | "trash_area"
  | "system_area"
  | "system_folder"
  | "folder_view_only";

/** An entry as the rules see it. */
export type AreaEntry = Readonly<{
  policy: StoragePolicy;
  ownerId: string | null;
  /** Set on folders Bakery made (top-level areas, attachments, projects). */
  systemKey: string | null;
}>;

/** Whether a policy is one people and granted steps may write into. */
export function isWritablePolicy(policy: StoragePolicy): boolean {
  return policy === "working" || policy === "personal" ||
    policy === "scratch";
}

function refusalFor(policy: StoragePolicy): AreaRefusal {
  switch (policy) {
    case "record":
      return "record_area";
    case "library":
      return "library_area";
    default:
      return "system_area";
  }
}

/**
 * Whether the principal may see an entry at all. A personal or scratch entry is
 * owner only (section 17.3), and to anyone else it does not exist: a refusal
 * would confirm the path.
 */
export function isVisibleTo(entry: AreaEntry, principalId: string): boolean {
  if (entry.policy === "personal" || entry.policy === "scratch") {
    return entry.ownerId === null || entry.ownerId === principalId;
  }
  return true;
}

/**
 * Whether a principal may create a file or folder in, or move one into, a
 * folder. Record areas take writes only through declared outputs, the library
 * only through its own operations, and /trash and /system not at all.
 * /connections holds outside storage, read through (O38), so nothing is
 * written into it by path. A personal or scratch folder takes writes from its
 * owner only, and /users itself from nobody.
 */
export function writeRefusal(
  folder: AreaEntry,
  principalId: string,
): AreaRefusal | undefined {
  if (folder.systemKey === "trash") return "trash_area";
  if (!isWritablePolicy(folder.policy)) return refusalFor(folder.policy);
  if (folder.systemKey === "connections") return "system_area";
  if (
    (folder.policy === "personal" || folder.policy === "scratch") &&
    folder.ownerId !== principalId
  ) {
    return "system_area";
  }
  return undefined;
}

/**
 * Whether an entry may be renamed, moved or trashed. rm trashes in working
 * areas and is refused in record areas (section 17.4); the folders Bakery made
 * are the layout and stay put.
 */
export function changeRefusal(entry: AreaEntry): AreaRefusal | undefined {
  if (!isWritablePolicy(entry.policy)) return refusalFor(entry.policy);
  if (entry.systemKey !== null) return "system_folder";
  return undefined;
}

/** The policy a new child of this folder inherits. */
export function childPolicy(folder: AreaEntry): StoragePolicy {
  return folder.policy;
}

/**
 * Version revisions to delete after a write, oldest first. Working and personal
 * areas keep the newest `kept`; scratch keeps only the latest (section 17.1).
 */
export function revisionsToPrune(
  policy: StoragePolicy,
  revisions: readonly number[],
  kept: number,
): number[] {
  const keep = policy === "scratch" ? 1 : kept;
  const newestFirst = [...revisions].sort((a, b) => b - a);
  return newestFirst.slice(keep).sort((a, b) => a - b);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a trashed entry has outlived the trash retention. */
export function trashExpired(
  trashedAt: Date,
  now: Date,
  limits: Pick<StorageLimits, "trashRetentionDays">,
): boolean {
  return now.getTime() - trashedAt.getTime() >=
    limits.trashRetentionDays * DAY_MS;
}

/** Whether a scratch file has outlived scratch retention since its last write. */
export function scratchExpired(
  updatedAt: Date,
  now: Date,
  limits: Pick<StorageLimits, "scratchRetentionDays">,
): boolean {
  return now.getTime() - updatedAt.getTime() >=
    limits.scratchRetentionDays * DAY_MS;
}

/** Quota warning and pause thresholds (section 17.5). */
export const QUOTA_WARNING_RATIO = 0.75;
export const QUOTA_PAUSE_RATIO = 0.9;

export type QuotaState = "ok" | "warning" | "paused";

/** Where usage stands against a limit. */
export function quotaState(usedBytes: number, limitBytes: number): QuotaState {
  if (usedBytes >= limitBytes * QUOTA_PAUSE_RATIO) return "paused";
  if (usedBytes >= limitBytes * QUOTA_WARNING_RATIO) return "warning";
  return "ok";
}

/**
 * Whether a write of `addedBytes` is admitted. New writes pause at 90%: a write
 * is refused when usage after it would reach the pause line, so the last 10%
 * stays as headroom and no write is ever half-stored. A write that adds nothing
 * (identical bytes) is always admitted. A copy counts in full, even though it
 * shares the blob: quota is what an area holds, not what the store dedupes.
 */
export function admitsWrite(
  usedBytes: number,
  addedBytes: number,
  limitBytes: number,
): boolean {
  if (addedBytes <= 0) return true;
  return usedBytes + addedBytes < limitBytes * QUOTA_PAUSE_RATIO;
}

/**
 * The quota scope a folder's children count against, from the system keys of
 * the folder and its ancestors, nearest first: 'project:<id>' under a project,
 * 'user:<id>' under a personal folder, null elsewhere (only the organization's
 * quota applies).
 */
export function scopeKeyFromAncestors(
  systemKeys: readonly (string | null)[],
): string | null {
  for (const key of systemKeys) {
    const match = key?.match(/^(project|user):([0-9a-f-]{36})(?::|$)/i);
    if (match) return match[1] + ":" + match[2];
  }
  return null;
}

/** What one run step attempt's agent writes hold so far (O49). */
export type StepWriteUse = Readonly<{
  /** Distinct entries the attempt wrote. */
  files: number;
  /** Bytes of the versions the attempt's puts and copies made. */
  bytes: number;
}>;

/** Which step write limit a write would pass; the fault's reason. */
export type StepWriteLimitReason = "files" | "bytes";

/**
 * Whether one more agent write fits the step's limits. A write to an entry the
 * attempt already wrote adds no file; a write that adds no bytes (a folder, a
 * move, a trash) is checked against the file count only. The limits are
 * inclusive: a step may write exactly stepWriteFiles files and stepWriteBytes
 * bytes.
 */
export function stepWriteLimitRefusal(
  used: StepWriteUse,
  write: Readonly<{ newEntry: boolean; addedBytes: number }>,
  limits: Pick<StorageLimits, "stepWriteBytes" | "stepWriteFiles">,
): StepWriteLimitReason | undefined {
  if (write.newEntry && used.files + 1 > limits.stepWriteFiles) return "files";
  if (
    write.addedBytes > 0 &&
    used.bytes + write.addedBytes > limits.stepWriteBytes
  ) return "bytes";
  return undefined;
}
