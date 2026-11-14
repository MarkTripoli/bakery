import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CronError,
  isValidTimeZone,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
} from "../../apps/server/src/modules/workflows/automations/schedule.ts";

// #36 [B07.06]: schedules are cron expressions in an IANA timezone, and what
// the tick needs is the UTC instants of their occurrences, with the daylight
// saving rules of the design: a local time that does not exist is advanced to
// the instant the clocks change, a local time that happens twice is one
// occurrence at its first instant.

const iso = (date: Date | null) => date?.toISOString() ?? null;
const at = (zone: string, expression: string, after: string) =>
  iso(nextOccurrence(parseCron(expression), zone, new Date(after)));

Deno.test("an expression is five fields; lists, ranges, steps and names are read; anything else is refused", () => {
  const every = parseCron("*/15 9-17 * * mon-fri");
  assertEquals(every.minutes, [0, 15, 30, 45]);
  assertEquals(every.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assertEquals(every.daysOfWeek, [1, 2, 3, 4, 5]);
  assertEquals(every.dayOfMonthOpen, true);
  assertEquals(every.dayOfWeekOpen, false);
  assertEquals(parseCron("0 0 1,15 JAN,jul *").months, [1, 7]);
  assertEquals(parseCron("0 0 * * 0,7").daysOfWeek, [0]);
  assertEquals(parseCron("0 0 * * 7").daysOfWeek, [0]);
  assertEquals(parseCron("5/20 * * * *").minutes, [5, 25, 45]);
  assertEquals(parseCron("0-30/10 * * * *").minutes, [0, 10, 20, 30]);
  assertEquals(parseCron("  0\t12 * *  * ").hours, [12]);
  assertEquals(parseCron("0 0 * * *").daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  for (
    const bad of [
      "",
      "* * * *",
      "* * * * * *",
      "@daily",
      "@reboot",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "*/-1 * * * *",
      "1-2-3 * * * *",
      "5-1 * * * *",
      "*/2/3 * * * *",
      "1,,2 * * * *",
      ", * * * *",
      "? * * * *",
      "L * * * *",
      "0 0 L * *",
      "0 0 * * 1#2",
      "0 0 1W * *",
      "$(id) * * * *",
      "a * * * *",
      "mon * * * *",
      "* * * foo *",
      "* * * * funday",
      "0 0 * jan-feb-mar *",
      "99999 * * * *",
      "0 0 * * *; rm -rf /",
      "0 0 * * *\n0 1 * * *",
      "x".repeat(101),
    ]
  ) {
    const error = assertThrows(() => parseCron(bad), CronError, "", bad);
    assertEquals(error.code, "CRON_EXPRESSION_INVALID", bad);
  }
  // Not a string at all.
  assertThrows(() => parseCron(7 as unknown as string), CronError);
  // A valid expression is still refused when it is longer than 100 characters.
  const longButValid = `${
    Array.from({ length: 60 }, (_, index) => index).join(",")
  } * * * *`;
  assert(longButValid.length > 100);
  assertThrows(() => parseCron(longButValid), CronError, "too long");
  const withinLimit = `${
    Array.from({ length: 31 }, (_, index) => index).join(",")
  } * * * *`;
  assert(withinLimit.length <= 100);
  assertEquals(parseCron(withinLimit).minutes.length, 31);
});

Deno.test("a timezone is an IANA name written the IANA way, not an offset or another letter case", () => {
  for (
    const good of [
      "UTC",
      "Europe/Berlin",
      "America/New_York",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Australia/Lord_Howe",
      "Pacific/Auckland",
      "Etc/GMT+5",
      "US/Pacific",
      "America/Argentina/Buenos_Aires",
      "Africa/Dar_es_Salaam",
    ]
  ) assertEquals(isValidTimeZone(good), true, good);
  for (
    const bad of [
      "",
      "europe/berlin",
      "EUROPE/BERLIN",
      "asia/kolkata",
      "us/pacific",
      "utc",
      "+02:00",
      "UTC+2",
      "GMT+2",
      "Z",
      "Mars/Olympus",
      "Europe/Berlin ",
      " Europe/Berlin",
      "../Europe/Berlin",
      "Europe/Berlin\n",
      "a".repeat(65),
      "Europe//Berlin;x",
    ]
  ) assertEquals(isValidTimeZone(bad), false, JSON.stringify(bad));
  assertEquals(isValidTimeZone(5 as unknown as string), false);
  assertThrows(
    () => nextOccurrence(parseCron("0 0 * * *"), "Mars/Olympus", new Date(0)),
    CronError,
  );
});

Deno.test("an ordinary schedule gives the next instant strictly after, in UTC and in a zone with an offset", () => {
  assertEquals(
    at("UTC", "30 9 * * *", "2026-11-14T00:00:00Z"),
    "2026-11-14T09:30:00.000Z",
  );
  // Strictly after: the instant itself is not the next occurrence.
  assertEquals(
    at("UTC", "30 9 * * *", "2026-11-14T09:30:00Z"),
    "2026-11-15T09:30:00.000Z",
  );
  assertEquals(
    at("UTC", "30 9 * * *", "2026-11-14T09:29:59.999Z"),
    "2026-11-14T09:30:00.000Z",
  );
  // Winter in Berlin is UTC+1.
  assertEquals(
    at("Europe/Berlin", "0 9 * * *", "2026-01-10T00:00:00Z"),
    "2026-01-10T08:00:00.000Z",
  );
  // Half-hour and 45-minute zones.
  assertEquals(
    at("Asia/Kolkata", "0 9 * * *", "2026-01-10T00:00:00Z"),
    "2026-01-10T03:30:00.000Z",
  );
  assertEquals(
    at("Asia/Kathmandu", "0 9 * * *", "2026-01-10T00:00:00Z"),
    "2026-01-10T03:15:00.000Z",
  );
  // The local day, not the UTC day: 23:30 in Los Angeles is the next UTC day.
  assertEquals(
    at("America/Los_Angeles", "30 23 * * *", "2026-01-10T00:00:00Z"),
    "2026-01-10T07:30:00.000Z",
  );
  // Every 15 minutes across an hour boundary.
  assertEquals(
    at("UTC", "*/15 * * * *", "2026-11-14T10:46:00Z"),
    "2026-11-14T11:00:00.000Z",
  );
});

Deno.test("spring forward: a local time that does not exist is advanced to the instant the clocks change, once", () => {
  // Berlin 2026-03-29: 02:00 to 03:00 at 01:00 UTC; 02:30 does not exist.
  assertEquals(
    at("Europe/Berlin", "30 2 * * *", "2026-03-28T12:00:00Z"),
    "2026-03-29T01:00:00.000Z",
  );
  // The next day it is 02:30 CEST (UTC+2) again.
  assertEquals(
    at("Europe/Berlin", "30 2 * * *", "2026-03-29T01:00:00Z"),
    "2026-03-30T00:30:00.000Z",
  );
  // New York 2026-03-08: 02:00 to 03:00 at 07:00 UTC.
  assertEquals(
    at("America/New_York", "30 2 * * *", "2026-03-07T12:00:00Z"),
    "2026-03-08T07:00:00.000Z",
  );
  // Several skipped times of one schedule are one occurrence.
  const skipped = occurrencesBetween(
    parseCron("*/15 2 * * *"),
    "Europe/Berlin",
    new Date("2026-03-28T12:00:00Z"),
    new Date("2026-03-29T12:00:00Z"),
    50,
  );
  assertEquals(skipped.occurrences.map(iso), ["2026-03-29T01:00:00.000Z"]);
  // A time just after the gap is not disturbed.
  assertEquals(
    at("Europe/Berlin", "0 3 * * *", "2026-03-28T12:00:00Z"),
    "2026-03-29T01:00:00.000Z",
  );
  assertEquals(
    at("Europe/Berlin", "30 3 * * *", "2026-03-28T12:00:00Z"),
    "2026-03-29T01:30:00.000Z",
  );
  // A time just before the gap.
  assertEquals(
    at("Europe/Berlin", "30 1 * * *", "2026-03-28T12:00:00Z"),
    "2026-03-29T00:30:00.000Z",
  );
  // Lord Howe moves by 30 minutes: 02:00 to 02:30 on 2026-10-04 (UTC+10:30 to +11).
  assertEquals(
    at("Australia/Lord_Howe", "15 2 * * *", "2026-10-03T00:00:00Z"),
    "2026-10-03T15:30:00.000Z",
  );
});

Deno.test("fall back: a local time that happens twice is one occurrence, at its first instant", () => {
  // Berlin 2026-10-25: 03:00 CEST to 02:00 CET at 01:00 UTC; 02:30 happens at 00:30 UTC and 01:30 UTC.
  assertEquals(
    at("Europe/Berlin", "30 2 * * *", "2026-10-24T12:00:00Z"),
    "2026-10-25T00:30:00.000Z",
  );
  // After the first one, the repeated 02:30 is not another occurrence.
  assertEquals(
    at("Europe/Berlin", "30 2 * * *", "2026-10-25T00:30:00Z"),
    "2026-10-26T01:30:00.000Z",
  );
  assertEquals(
    at("Europe/Berlin", "30 2 * * *", "2026-10-25T01:15:00Z"),
    "2026-10-26T01:30:00.000Z",
  );
  const all = occurrencesBetween(
    parseCron("30 2 * * *"),
    "Europe/Berlin",
    new Date("2026-10-24T12:00:00Z"),
    new Date("2026-10-26T12:00:00Z"),
    10,
  );
  assertEquals(all.occurrences.map(iso), [
    "2026-10-25T00:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
  ]);
  // Every 30 minutes across the repeated hour: each local wall time once.
  const repeated = occurrencesBetween(
    parseCron("*/30 2 * * *"),
    "Europe/Berlin",
    new Date("2026-10-24T22:00:00Z"),
    new Date("2026-10-25T03:00:00Z"),
    10,
  );
  assertEquals(repeated.occurrences.map(iso), [
    "2026-10-25T00:00:00.000Z",
    "2026-10-25T00:30:00.000Z",
  ]);
  // New York 2026-11-01: 01:30 happens at 05:30 and 06:30 UTC.
  assertEquals(
    at("America/New_York", "30 1 * * *", "2026-10-31T12:00:00Z"),
    "2026-11-01T05:30:00.000Z",
  );
  assertEquals(
    at("America/New_York", "30 1 * * *", "2026-11-01T05:30:00Z"),
    "2026-11-02T06:30:00.000Z",
  );
});

Deno.test("days: day-of-month and day-of-week are alternatives when both are restricted, and restrict together when one is open", () => {
  // The 13th or a Friday (both restricted: either).
  const either = occurrencesBetween(
    parseCron("0 12 13 * fri"),
    "UTC",
    new Date("2026-11-01T00:00:00Z"),
    new Date("2026-11-30T23:59:59Z"),
    50,
  ).occurrences.map((date) => date.getUTCDate());
  assertEquals(either, [6, 13, 20, 27]);
  // Fridays only (day-of-month open).
  assertEquals(
    occurrencesBetween(
      parseCron("0 12 * * fri"),
      "UTC",
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-30T23:59:59Z"),
      50,
    ).occurrences.map((date) => date.getUTCDate()),
    [6, 13, 20, 27],
  );
  // The 13th only (day-of-week open).
  assertEquals(
    at("UTC", "0 12 13 * *", "2026-11-14T00:00:00Z"),
    "2026-12-13T12:00:00.000Z",
  );
  // Months and the last days of short months.
  assertEquals(
    at("UTC", "0 0 31 * *", "2026-04-01T00:00:00Z"),
    "2026-05-31T00:00:00.000Z",
  );
  assertEquals(
    at("UTC", "0 0 29 2 *", "2026-01-01T00:00:00Z"),
    "2028-02-29T00:00:00.000Z",
  );
  // A date that never exists never fires.
  assertEquals(at("UTC", "0 0 31 2 *", "2026-01-01T00:00:00Z"), null);
  // The weekday is the local one.
  assertEquals(
    at("Pacific/Auckland", "0 9 * * mon", "2026-11-14T00:00:00Z"),
    "2026-11-15T20:00:00.000Z",
  );
});

Deno.test("occurrencesBetween is bounded: at most limit, oldest first, and it says when there were more", () => {
  const schedule = parseCron("*/10 * * * *");
  const first = occurrencesBetween(
    schedule,
    "UTC",
    new Date("2026-11-14T00:00:00Z"),
    new Date("2026-11-14T01:00:00Z"),
    4,
  );
  assertEquals(first.occurrences.map(iso), [
    "2026-11-14T00:10:00.000Z",
    "2026-11-14T00:20:00.000Z",
    "2026-11-14T00:30:00.000Z",
    "2026-11-14T00:40:00.000Z",
  ]);
  assertEquals(first.truncated, true);
  // Exactly as many as the limit is not truncated.
  const exact = occurrencesBetween(
    schedule,
    "UTC",
    new Date("2026-11-14T00:00:00Z"),
    new Date("2026-11-14T00:40:00Z"),
    4,
  );
  assertEquals(exact.occurrences.length, 4);
  assertEquals(exact.truncated, false);
  // The window is open at the start, closed at the end.
  const edges = occurrencesBetween(
    schedule,
    "UTC",
    new Date("2026-11-14T00:10:00Z"),
    new Date("2026-11-14T00:30:00Z"),
    10,
  );
  assertEquals(edges.occurrences.map(iso), [
    "2026-11-14T00:20:00.000Z",
    "2026-11-14T00:30:00.000Z",
  ]);
  assertEquals(
    occurrencesBetween(schedule, "UTC", new Date(0), new Date(0), 5),
    { occurrences: [], truncated: false },
  );
  assertEquals(
    occurrencesBetween(
      parseCron("0 0 31 2 *"),
      "UTC",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2030-01-01T00:00:00Z"),
      5,
    ),
    { occurrences: [], truncated: false },
  );
});

Deno.test("every occurrence is strictly increasing and a whole minute, across a year of DST in several zones", () => {
  for (
    const zone of [
      "UTC",
      "Europe/Berlin",
      "America/New_York",
      "Australia/Sydney",
      "Australia/Lord_Howe",
      "Asia/Kathmandu",
    ]
  ) {
    for (const expression of ["*/20 * * * *", "30 2 * * *", "0 */6 * * *"]) {
      const { occurrences } = occurrencesBetween(
        parseCron(expression),
        zone,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2027-01-01T00:00:00Z"),
        20_000,
      );
      assert(occurrences.length > 300, `${zone} ${expression}`);
      for (let index = 1; index < occurrences.length; index += 1) {
        assert(
          occurrences[index]!.getTime() > occurrences[index - 1]!.getTime(),
          `${zone} ${expression} ${iso(occurrences[index])}`,
        );
      }
      for (const occurrence of occurrences) {
        assertEquals(occurrence.getTime() % 60_000, 0, `${zone} ${expression}`);
      }
    }
  }
});
