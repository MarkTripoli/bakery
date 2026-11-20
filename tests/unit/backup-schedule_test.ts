import { assert, assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  BackupInterval,
  intervalMs,
  isBackupDue,
  isTimeOfDayUtc,
  latestSlotAtOrBefore,
  NO_SCHEDULE_STALE_AFTER_MS,
  staleAfterMs,
} from "../../apps/server/src/modules/backups/schedule.ts";
import { backupStateWord } from "../../apps/server/src/modules/backups/state.ts";
import {
  BackupDestinationInvalid,
  normalizePrefix,
  resolveBackupDestination,
  safeDetail,
} from "../../apps/server/src/modules/backups/s3.ts";

/** #80 S1b: when a scheduled backup is due and how old is too old, with no database. */

const iso = (value: string) => new Date(value);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

Deno.test("the latest slot is the most recent scheduled instant at or before now", () => {
  const hourly = { interval: BackupInterval.Hourly, timeOfDayUtc: "07:30" };
  // Only the minutes count for hourly: HH is ignored.
  assertEquals(
    latestSlotAtOrBefore(hourly, iso("2026-11-20T10:45:00Z")).toISOString(),
    "2026-11-20T10:30:00.000Z",
  );
  assertEquals(
    latestSlotAtOrBefore(hourly, iso("2026-11-20T10:15:00Z")).toISOString(),
    "2026-11-20T09:30:00.000Z",
  );
  const daily = { interval: BackupInterval.Daily, timeOfDayUtc: "03:00" };
  assertEquals(
    latestSlotAtOrBefore(daily, iso("2026-11-20T02:59:59Z")).toISOString(),
    "2026-11-19T03:00:00.000Z",
  );
  // The slot instant itself is its own latest slot.
  assertEquals(
    latestSlotAtOrBefore(daily, iso("2026-11-20T03:00:00Z")).toISOString(),
    "2026-11-20T03:00:00.000Z",
  );
  // Weekly is Monday: 2026-11-20 is a Friday, 2026-11-16 the Monday before.
  const weekly = { interval: BackupInterval.Weekly, timeOfDayUtc: "03:00" };
  assertEquals(
    latestSlotAtOrBefore(weekly, iso("2026-11-20T10:00:00Z")).toISOString(),
    "2026-11-16T03:00:00.000Z",
  );
  // Monday before the slot time belongs to the previous week's slot.
  assertEquals(
    latestSlotAtOrBefore(weekly, iso("2026-11-16T02:00:00Z")).toISOString(),
    "2026-11-09T03:00:00.000Z",
  );
  // Sunday is the last day of the Monday-anchored week.
  assertEquals(
    latestSlotAtOrBefore(weekly, iso("2026-11-22T23:59:00Z")).toISOString(),
    "2026-11-16T03:00:00.000Z",
  );
});

Deno.test("a scheduled backup is due only when nothing was requested since the latest slot", () => {
  const rule = {
    enabled: true,
    interval: BackupInterval.Daily,
    timeOfDayUtc: "03:00",
  };
  const now = iso("2026-11-20T10:00:00Z");
  const slot = iso("2026-11-20T03:00:00Z");
  // Off is never due.
  assertEquals(isBackupDue({ ...rule, enabled: false }, now, null), false);
  // The first backup after the schedule is switched on is due at once.
  assertEquals(isBackupDue(rule, now, null), true);
  // Strictly before the slot is due; at the slot instant or after is covered.
  assertEquals(isBackupDue(rule, now, new Date(slot.getTime() - 1)), true);
  assertEquals(isBackupDue(rule, now, slot), false);
  assertEquals(isBackupDue(rule, now, new Date(slot.getTime() + 1)), false);
  // Yesterday's backup is due again once today's slot has passed...
  assertEquals(isBackupDue(rule, now, iso("2026-11-19T03:00:05Z")), true);
  // ...but not before it.
  assertEquals(
    isBackupDue(rule, iso("2026-11-20T02:00:00Z"), iso("2026-11-19T03:00:05Z")),
    false,
  );
});

Deno.test("the stale age is twice the schedule interval, or seven days without a schedule", () => {
  assertEquals(staleAfterMs(null), NO_SCHEDULE_STALE_AFTER_MS);
  assertEquals(NO_SCHEDULE_STALE_AFTER_MS, 7 * DAY);
  assertEquals(
    staleAfterMs({ enabled: false, interval: BackupInterval.Hourly }),
    7 * DAY,
  );
  assertEquals(
    staleAfterMs({ enabled: true, interval: BackupInterval.Hourly }),
    2 * HOUR,
  );
  assertEquals(
    staleAfterMs({ enabled: true, interval: BackupInterval.Daily }),
    2 * DAY,
  );
  assertEquals(
    staleAfterMs({ enabled: true, interval: BackupInterval.Weekly }),
    14 * DAY,
  );
  assertEquals(intervalMs(BackupInterval.Weekly), 7 * DAY);
});

Deno.test("the state word turns stale at the schedule's own threshold", () => {
  const now = iso("2026-11-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const word = (lastGoodAt: Date | null, staleAfter?: number) =>
    backupStateWord({
      now,
      held: null,
      newestFinishedStatus: lastGoodAt === null ? null : "completed",
      lastGoodAt,
      staleAfterMs: staleAfter,
    });
  const daily = staleAfterMs({ enabled: true, interval: BackupInterval.Daily });
  assertEquals(word(ago(47 * HOUR), daily), "protected");
  assertEquals(word(ago(48 * HOUR), daily), "protected");
  assertEquals(word(ago(48 * HOUR + 1), daily), "stale");
  // No schedule keeps the seven-day default, with or without the argument.
  assertEquals(word(ago(6 * DAY)), "protected");
  assertEquals(word(ago(8 * DAY)), "stale");
  assertEquals(word(ago(6 * DAY), NO_SCHEDULE_STALE_AFTER_MS), "protected");
  // A backup that never completed is stale, whatever the schedule.
  assertEquals(word(null, daily), "stale");
});

Deno.test("times of day are HH:MM on a 24-hour clock", () => {
  for (const good of ["00:00", "03:00", "23:59", "12:30"]) {
    assert(isTimeOfDayUtc(good), good);
  }
  for (const bad of ["24:00", "3:00", "03:60", "0300", "03:00:00", "", 3]) {
    assertEquals(isTimeOfDayUtc(bad), false, String(bad));
  }
  assertThrows(() =>
    latestSlotAtOrBefore(
      { interval: BackupInterval.Daily, timeOfDayUtc: "99:99" },
      new Date(),
    )
  );
});

const production = { allowLoopbackEndpoint: false };
const test = { allowLoopbackEndpoint: true };
const base = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "bakery-backups",
  prefix: "",
};

function invalidField(
  source: typeof base,
  options: { allowLoopbackEndpoint: boolean },
): string {
  try {
    resolveBackupDestination(source, options);
  } catch (error) {
    if (error instanceof BackupDestinationInvalid) return error.field;
    throw error;
  }
  return "none";
}

Deno.test("an off-site destination is a public https origin, a valid bucket and a plain folder", () => {
  assertEquals(resolveBackupDestination(base, production), {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "bakery-backups",
    prefix: "",
    host: "s3.example.com",
    loopbackAllowed: false,
  });
  // Plain http is refused outside a test environment, loopback or not.
  assertEquals(
    invalidField({ ...base, endpoint: "http://s3.example.com" }, production),
    "endpoint",
  );
  assertEquals(
    invalidField({ ...base, endpoint: "http://127.0.0.1:9000" }, production),
    "endpoint",
  );
  // A loopback fixture is allowed only in a test environment, and only http.
  assertEquals(
    invalidField({ ...base, endpoint: "http://127.0.0.1:9000" }, test),
    "none",
  );
  assertEquals(
    invalidField({ ...base, endpoint: "http://s3.example.com" }, test),
    "endpoint",
  );
  // Which addresses a host may resolve to is the host check's job (dns.ts and
  // address-policy.ts, tested in backup-destination-dns_test.ts), not the shape's.
  // Credentials, a path, a query or a fragment in the address are refused.
  for (
    const endpoint of [
      "https://user:pass@s3.example.com",
      "https://s3.example.com/path",
      "https://s3.example.com/?a=1",
      "https://s3.example.com/#x",
      "not a url",
    ]
  ) {
    assertEquals(invalidField({ ...base, endpoint }, production), "endpoint");
  }
  assertEquals(
    invalidField({ ...base, bucket: "Bad_Bucket" }, production),
    "bucket",
  );
  assertEquals(
    invalidField({ ...base, region: "us east" }, production),
    "region",
  );
});

Deno.test("a folder is normalised and cannot climb", () => {
  assertEquals(normalizePrefix(""), "");
  assertEquals(normalizePrefix("/"), "");
  assertEquals(normalizePrefix("bakery/prod"), "bakery/prod/");
  assertEquals(normalizePrefix("//bakery///prod//"), "bakery/prod/");
  assertThrows(() => normalizePrefix("../etc"), BackupDestinationInvalid);
  assertThrows(() => normalizePrefix("a/./b"), BackupDestinationInvalid);
  assertThrows(() => normalizePrefix("a\\b"), BackupDestinationInvalid);
});

Deno.test("the destination's answer is bounded and never carries the credentials", () => {
  const credentials = {
    accessKeyId: "AKIAEXAMPLEKEY",
    secretAccessKey: "s3cr3t/valueXYZ",
  };
  const detail = safeDetail(
    `AccessDenied: key AKIAEXAMPLEKEY with s3cr3t/valueXYZ rejected\u0000`,
    credentials,
  )!;
  assert(!detail.includes("AKIAEXAMPLEKEY"));
  assert(!detail.includes("s3cr3t/valueXYZ"));
  assert(!detail.includes("\u0000"));
  assert(detail.includes("[redacted]"));
  assertEquals(safeDetail("x".repeat(2000), credentials)!.length, 500);
  assertEquals(safeDetail("   ", credentials), null);
});

Deno.test("the schedule and destination contracts refuse values outside their closed sets", () => {
  const schedule = {
    enabled: true,
    interval: "daily",
    timeOfDayUtc: "03:00",
    daysToKeep: 30,
  };
  assert(contractSchemas.BackupSchedulePut.safeParse(schedule).success);
  for (
    const bad of [
      { ...schedule, interval: "monthly" },
      { ...schedule, daysToKeep: 0 },
      { ...schedule, daysToKeep: 3651 },
      { ...schedule, daysToKeep: 1.5 },
      { ...schedule, enabled: "yes" },
      { ...schedule, extra: true },
    ]
  ) {
    assertEquals(
      contractSchemas.BackupSchedulePut.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
  const destination = {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "bakery-backups",
  };
  assert(contractSchemas.BackupOffsitePut.safeParse(destination).success);
  assertEquals(
    contractSchemas.BackupOffsitePut.safeParse({ ...destination, extra: 1 })
      .success,
    false,
  );
  assertEquals(
    contractSchemas.BackupOffsitePut.safeParse({
      ...destination,
      secretAccessKey: "x".repeat(1025),
    }).success,
    false,
  );
});
