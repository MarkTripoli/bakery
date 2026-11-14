import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  canonicalTimeZone,
  CronError,
  isValidTimeZone,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
} from "../../apps/server/src/modules/workflows/automations/schedule.ts";
import {
  CATCH_UP_DAYS,
  dueOccurrences,
  planFiring,
} from "../../apps/server/src/modules/workflows/automations/tick-plan.ts";
import {
  parseTrigger,
  TriggerError,
} from "../../apps/server/src/modules/workflows/automations/trigger.ts";

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

Deno.test("a timezone is an IANA name the runtime knows, not an offset; the letter case of a name is not checked", () => {
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
      // The runtime resolves a name in any letter case, links included; the schedule is the same.
      "europe/berlin",
      "EUROPE/BERLIN",
      "Us/Pacific",
      "US/PACIFIC",
      "Asia/KOLKATA",
      "asia/kolkata",
      "utc",
    ]
  ) assertEquals(isValidTimeZone(good), true, good);
  for (
    const bad of [
      "",
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
    () =>
      nextOccurrence(
        parseCron("0 0 * * *"),
        "Mars/Olympus",
        new Date("2026-01-01T00:00:00Z"),
      ),
    CronError,
  );
  // Another case of a name is the same schedule.
  assertEquals(
    at("europe/berlin", "0 9 * * *", "2026-01-10T00:00:00Z"),
    at("Europe/Berlin", "0 9 * * *", "2026-01-10T00:00:00Z"),
  );
  assertEquals(
    at("Asia/KOLKATA", "0 9 * * *", "2026-01-10T00:00:00Z"),
    "2026-01-10T03:30:00.000Z",
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

Deno.test("the asked-about instants and the limit are validated, not trusted", () => {
  const schedule = parseCron("*/10 * * * *");
  const window = (after: Date, until: Date, limit: number) =>
    occurrencesBetween(schedule, "UTC", after, until, limit);
  const ok = new Date("2026-11-14T00:00:00Z");
  const later = new Date("2026-11-14T01:00:00Z");
  // The limit is a whole number from 1 to 100000.
  for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity, 100_001]) {
    assertThrows(
      () => window(ok, later, limit),
      RangeError,
      "limit",
      String(limit),
    );
  }
  assertThrows(
    () => window(ok, later, "5" as unknown as number),
    RangeError,
    "limit",
  );
  assertEquals(window(ok, later, 1).occurrences.length, 1);
  assertEquals(window(ok, later, 100_000).occurrences.length, 6);
  // Both instants are valid dates from 1970 to 9999.
  for (
    const bad of [
      new Date(NaN),
      new Date(-8.64e15),
      new Date(8.64e15),
      new Date("1969-12-31T23:59:59Z"),
      new Date("10000-01-01T00:00:00Z"),
      new Date("0000-06-01T00:00:00Z"),
      "2026-01-01" as unknown as Date,
      null as unknown as Date,
    ]
  ) {
    assertThrows(() => window(bad, later, 5), RangeError, "after", String(bad));
    assertThrows(() => window(ok, bad, 5), RangeError, "until", String(bad));
    assertThrows(
      () => nextOccurrence(schedule, "UTC", bad),
      RangeError,
      "after",
      String(bad),
    );
  }
  // The edges of the range are inside it.
  assertEquals(
    nextOccurrence(schedule, "UTC", new Date("1970-01-01T00:00:00Z"))
      ?.toISOString(),
    "1970-01-01T00:10:00.000Z",
  );
  assertEquals(
    nextOccurrence(schedule, "UTC", new Date("9999-12-31T23:59:59Z")),
    null,
  );
  // An end before the start is an empty window.
  assertEquals(window(later, ok, 5), { occurrences: [], truncated: false });
});

Deno.test("a parsed schedule cannot be changed by its caller, and only spaces and tabs surround or separate fields", () => {
  const schedule = parseCron("*/20 9 * * 1");
  for (
    const field of [
      schedule.minutes,
      schedule.hours,
      schedule.daysOfMonth,
      schedule.months,
      schedule.daysOfWeek,
    ]
  ) {
    assert(Object.isFrozen(field));
    assertThrows(() => (field as number[]).push(61), TypeError);
  }
  assertThrows(
    () => (schedule as unknown as { minutes: number[] }).minutes = [61],
    TypeError,
  );
  assertEquals(schedule.minutes, [0, 20, 40]);
  // No other whitespace is ignored at an edge while refused between fields.
  for (
    const bad of [
      "\u00a0* * * * *",
      "* * * * *\u00a0",
      "* *\u00a0* * *",
      "\n* * * * *",
      "* * * * *\n",
      "\u2003* * * * *",
    ]
  ) assertThrows(() => parseCron(bad), CronError, "", JSON.stringify(bad));
  assertEquals(parseCron(" \t* * * * *\t ").minutes.length, 60);
});

Deno.test("a per-minute catch-up over a clock-change day is bounded: each day is worked out once, not once per occurrence", () => {
  const everyMinute = parseCron("* * * * *");
  const timed = (
    zone: string,
    after: string,
    until: string,
    limit: number,
  ) => {
    const started = performance.now();
    const result = occurrencesBetween(
      everyMinute,
      zone,
      new Date(after),
      new Date(until),
      limit,
    );
    return { result, ms: performance.now() - started };
  };
  // Berlin 2026-03-29 has 23 hours: 1380 occurrences between its two midnights.
  const spring = timed(
    "Europe/Berlin",
    "2026-03-28T23:00:00Z",
    "2026-03-29T22:00:00Z",
    10_000,
  );
  assertEquals(spring.result.occurrences.length, 1380);
  assertEquals(spring.result.truncated, false);
  // Berlin 2026-10-25 has 25 hours, but each of its 1440 wall-clock minutes is one occurrence.
  const fall = timed(
    "Europe/Berlin",
    "2026-10-24T22:00:00Z",
    "2026-10-25T23:00:00Z",
    10_000,
  );
  assertEquals(fall.result.occurrences.length, 1440);
  // Before the change it took over a minute of blocking CPU; whole seconds are a generous bound for a loaded runner.
  assert(spring.ms < 3000, `spring day took ${spring.ms} ms`);
  assert(fall.ms < 3000, `fall day took ${fall.ms} ms`);
  // A month of them, cut by the limit, stops at the limit without working out the month.
  const month = timed(
    "Europe/Berlin",
    "2026-03-01T00:00:00Z",
    "2026-04-01T00:00:00Z",
    50,
  );
  assertEquals(month.result.occurrences.length, 50);
  assertEquals(month.result.truncated, true);
  assert(month.ms < 3000, `limited month took ${month.ms} ms`);
  // The same instants as asking one at a time, across both change days.
  let cursor = new Date("2026-03-28T23:30:00Z");
  for (const instant of spring.result.occurrences.slice(30, 60)) {
    const next = nextOccurrence(everyMinute, "Europe/Berlin", cursor);
    assertEquals(iso(next), iso(instant));
    cursor = next!;
  }
});

Deno.test("a window is at most nine years, and an unknown zone is refused before any work", () => {
  const schedule = parseCron("0 0 1 1 *");
  const start = new Date("2026-01-01T00:00:00Z");
  assertEquals(
    occurrencesBetween(
      schedule,
      "UTC",
      start,
      new Date("2034-12-31T00:00:00Z"),
      20,
    )
      .occurrences.map(iso),
    [
      "2027-01-01T00:00:00.000Z",
      "2028-01-01T00:00:00.000Z",
      "2029-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
      "2031-01-01T00:00:00.000Z",
      "2032-01-01T00:00:00.000Z",
      "2033-01-01T00:00:00.000Z",
      "2034-01-01T00:00:00.000Z",
    ],
  );
  assertThrows(
    () =>
      occurrencesBetween(
        schedule,
        "UTC",
        start,
        new Date("2036-01-01T00:00:00Z"),
        5,
      ),
    RangeError,
    "nine years",
  );
  assertThrows(
    () =>
      occurrencesBetween(
        schedule,
        "Mars/Olympus",
        start,
        new Date("2026-02-01T00:00:00Z"),
        5,
      ),
    CronError,
  );
  // Across the turn of a year and a leap day the calendar is walked correctly.
  const year = occurrencesBetween(
    parseCron("0 12 * * *"),
    "UTC",
    new Date("2027-12-30T00:00:00Z"),
    new Date("2028-01-02T00:00:00Z"),
    10,
  );
  assertEquals(year.occurrences.map(iso), [
    "2027-12-30T12:00:00.000Z",
    "2027-12-31T12:00:00.000Z",
    "2028-01-01T12:00:00.000Z",
  ]);
  const leap = occurrencesBetween(
    parseCron("0 12 * * *"),
    "UTC",
    new Date("2028-02-27T00:00:00Z"),
    new Date("2028-03-02T00:00:00Z"),
    10,
  );
  assertEquals(
    leap.occurrences.map((date) => date.toISOString().slice(0, 10)),
    [
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ],
  );
});

Deno.test("where a skipped hour ends at local midnight the change instant is one occurrence, not two (Greenland)", () => {
  // Godthab, 2025-03-30: the clocks jump at 01:00Z from 22:59 to 00:00, so 23:00 to 23:59 does not exist and is advanced to 01:00Z, which is also the next day's 00:00.
  const hourly = occurrencesBetween(
    parseCron("0 * * * *"),
    "America/Godthab",
    new Date("2025-03-29T20:00:00Z"),
    new Date("2025-03-30T04:00:00Z"),
    100,
  );
  assertEquals(hourly.occurrences.map(iso), [
    "2025-03-29T21:00:00.000Z",
    "2025-03-29T22:00:00.000Z",
    "2025-03-29T23:00:00.000Z",
    "2025-03-30T00:00:00.000Z",
    "2025-03-30T01:00:00.000Z",
    "2025-03-30T02:00:00.000Z",
    "2025-03-30T03:00:00.000Z",
    "2025-03-30T04:00:00.000Z",
  ]);
  // The same on the 2026 change, for a schedule that names both the skipped hour and midnight.
  const both = occurrencesBetween(
    parseCron("0 0,23 * * *"),
    "America/Godthab",
    new Date("2026-03-28T00:00:00Z"),
    new Date("2026-03-30T12:00:00Z"),
    100,
  );
  assertEquals(
    both.occurrences.filter((date) => iso(date) === "2026-03-29T01:00:00.000Z")
      .length,
    1,
  );
  // And asking one at a time gives the same.
  let cursor = new Date("2025-03-29T22:30:00Z");
  const chained: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const next = nextOccurrence(
      parseCron("0 * * * *"),
      "America/Godthab",
      cursor,
    )!;
    chained.push(iso(next)!);
    cursor = next;
  }
  assertEquals(chained, [
    "2025-03-29T23:00:00.000Z",
    "2025-03-30T00:00:00.000Z",
    "2025-03-30T01:00:00.000Z",
    "2025-03-30T02:00:00.000Z",
  ]);
});

Deno.test("occurrences are strictly increasing and equal to asking one at a time, over every clock change of two years in zones of every kind", () => {
  const zones = [
    "America/Godthab", // skipped hour ends at local midnight
    "America/Nuuk",
    "America/Scoresbysund",
    "Europe/Berlin",
    "America/New_York",
    "Australia/Lord_Howe", // 30-minute change
    "America/Santiago", // changes at midnight
    "Africa/Cairo",
    "Asia/Beirut",
    "Pacific/Chatham", // 45-minute offset
    "America/St_Johns", // 30-minute offset
    "Antarctica/Troll", // 2-hour change
  ];
  const expressions = [
    "0 * * * *",
    "*/30 * * * *",
    "0 0,23 * * *",
    "59 23 * * *",
    "0 0 * * *",
    "15 2 * * *",
    "*/20 22-23 * * *",
  ];
  for (const zone of zones) {
    for (const expression of expressions) {
      const schedule = parseCron(expression);
      const { occurrences } = occurrencesBetween(
        schedule,
        zone,
        new Date("2024-12-31T00:00:00Z"),
        new Date("2026-12-31T00:00:00Z"),
        100_000,
      );
      assert(occurrences.length > 300, `${zone} ${expression}`);
      for (let index = 1; index < occurrences.length; index += 1) {
        assert(
          occurrences[index]!.getTime() > occurrences[index - 1]!.getTime(),
          `${zone} ${expression} not increasing at ${iso(occurrences[index])}`,
        );
      }
      // Asking one at a time, from just before each clock change of the two years, agrees.
      for (let index = 0; index < occurrences.length - 1; index += 400) {
        const chained = nextOccurrence(schedule, zone, occurrences[index]!);
        assertEquals(
          iso(chained),
          iso(occurrences[index + 1]),
          `${zone} ${expression}`,
        );
      }
    }
  }
});

const triggerReason = (value: unknown): string => {
  try {
    parseTrigger(value);
  } catch (error) {
    assert(error instanceof TriggerError);
    return `${error.path.join(".")}:${error.reason}`;
  }
  return "accepted";
};

Deno.test("a trigger is exactly a schedule or an event: data, with nothing else accepted", () => {
  assertEquals(
    parseTrigger({
      type: "schedule",
      cron: " 0 9 * * mon-fri ",
      timezone: "Europe/Berlin",
    }),
    { type: "schedule", cron: "0 9 * * mon-fri", timezone: "Europe/Berlin" },
  );
  assertEquals(
    parseTrigger({ type: "event", provider: "github", kind: "issues" }),
    { type: "event", provider: "github", kind: "issues", filter: {} },
  );
  // One canonical form: equivalent schedules are equal.
  assertEquals(
    parseTrigger({
      type: "schedule",
      cron: "0 \t 9  * *\tMON-FRI",
      timezone: "europe/berlin",
    }),
    { type: "schedule", cron: "0 9 * * mon-fri", timezone: "Europe/Berlin" },
  );
  assertEquals(
    parseTrigger({ type: "schedule", cron: "0 0 * * *", timezone: "utc" }),
    { type: "schedule", cron: "0 0 * * *", timezone: "UTC" },
  );
  assertEquals(
    JSON.stringify(
      parseTrigger({
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "US/PACIFIC",
      }),
    ),
    JSON.stringify(
      parseTrigger({
        type: "schedule",
        cron: " 0   9 * *  1 ",
        timezone: "us/pacific",
      }),
    ),
  );
  assertEquals(
    canonicalTimeZone("Asia/Kolkata"),
    canonicalTimeZone("asia/kolkata"),
  );
  assertEquals(canonicalTimeZone("Europe/Berlin"), "Europe/Berlin");
  // The filter is sorted by key, so the same trigger is the same bytes.
  assertEquals(
    JSON.stringify(
      parseTrigger({
        type: "event",
        provider: "github",
        kind: "issues",
        action: "opened",
        filter: { b: 2, a: "x", c: true },
      }),
    ),
    JSON.stringify({
      type: "event",
      provider: "github",
      kind: "issues",
      action: "opened",
      filter: { a: "x", b: 2, c: true },
    }),
  );
  const cases: [unknown, string][] = [
    [null, ":trigger_not_object"],
    [undefined, ":trigger_not_object"],
    [7, ":trigger_not_object"],
    ["0 9 * * *", ":trigger_not_object"],
    [[], ":trigger_not_object"],
    [{}, "type:type_unknown"],
    [{ type: "run", command: "rm -rf /" }, "type:type_unknown"],
    [{ type: "SCHEDULE" }, "type:type_unknown"],
    [{ type: "schedule", timezone: "UTC" }, "cron:cron_invalid"],
    [{ type: "schedule", cron: 5, timezone: "UTC" }, "cron:cron_invalid"],
    [
      { type: "schedule", cron: "@daily", timezone: "UTC" },
      "cron:cron_invalid",
    ],
    [
      { type: "schedule", cron: "$(id) * * * *", timezone: "UTC" },
      "cron:cron_invalid",
    ],
    [{ type: "schedule", cron: "0 9 * * *" }, "timezone:timezone_invalid"],
    [
      { type: "schedule", cron: "0 9 * * *", timezone: 3 },
      "timezone:timezone_invalid",
    ],
    [
      { type: "schedule", cron: "0 9 * * *", timezone: "+02:00" },
      "timezone:timezone_invalid",
    ],
    [
      { type: "schedule", cron: "0 9 * * *", timezone: "Nowhere/Land" },
      "timezone:timezone_invalid",
    ],
    [
      { type: "schedule", cron: "0 9 * * *", timezone: "UTC", extra: 1 },
      "extra:unknown_key",
    ],
    [{
      type: "schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
      provider: "github",
    }, "provider:unknown_key"],
    [
      { type: "event", provider: "gitlab", kind: "issues" },
      "provider:provider_unknown",
    ],
    [{ type: "event", kind: "issues" }, "provider:provider_unknown"],
    [{ type: "event", provider: "github" }, "kind:kind_invalid"],
    [
      { type: "event", provider: "github", kind: "Issues" },
      "kind:kind_invalid",
    ],
    [
      { type: "event", provider: "github", kind: "a".repeat(65) },
      "kind:kind_invalid",
    ],
    [
      { type: "event", provider: "github", kind: "issues", action: "Opened" },
      "action:action_invalid",
    ],
    [
      { type: "event", provider: "github", kind: "issues", action: 7 },
      "action:action_invalid",
    ],
    [
      { type: "event", provider: "github", kind: "issues", filter: [] },
      "filter:filter_not_object",
    ],
    [
      { type: "event", provider: "github", kind: "issues", filter: null },
      "filter:filter_not_object",
    ],
    [
      { type: "event", provider: "github", kind: "issues", filter: "a=b" },
      "filter:filter_not_object",
    ],
    [{
      type: "event",
      provider: "github",
      kind: "issues",
      filter: { "a b": 1 },
    }, "filter.a b:filter_key_invalid"],
    [
      { type: "event", provider: "github", kind: "issues", filter: { "": 1 } },
      "filter.:filter_key_invalid",
    ],
    [
      {
        type: "event",
        provider: "github",
        kind: "issues",
        filter: { "1a": 1 },
      },
      "filter.1a:filter_key_invalid",
    ],
    [{
      type: "event",
      provider: "github",
      kind: "issues",
      filter: { a: { b: 1 } },
    }, "filter.a:filter_value_invalid"],
    [
      { type: "event", provider: "github", kind: "issues", filter: { a: [1] } },
      "filter.a:filter_value_invalid",
    ],
    [
      {
        type: "event",
        provider: "github",
        kind: "issues",
        filter: { a: null },
      },
      "filter.a:filter_value_invalid",
    ],
    [
      { type: "event", provider: "github", kind: "issues", filter: { a: NaN } },
      "filter.a:filter_value_invalid",
    ],
    [{
      type: "event",
      provider: "github",
      kind: "issues",
      filter: { a: Infinity },
    }, "filter.a:filter_value_invalid"],
    [{
      type: "event",
      provider: "github",
      kind: "issues",
      filter: { a: "x".repeat(257) },
    }, "filter.a:filter_value_too_long"],
    [
      { type: "event", provider: "github", kind: "issues", extra: 1 },
      "extra:unknown_key",
    ],
    [
      { type: "event", provider: "github", kind: "issues", cron: "0 9 * * *" },
      "cron:unknown_key",
    ],
  ];
  for (const [value, expected] of cases) {
    assertEquals(triggerReason(value), expected, JSON.stringify(value));
  }
  // At most 16 filter entries; exactly 16 is fine; 256 characters of value is fine.
  const entries = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`k${index}`, index]),
    );
  assertEquals(
    triggerReason({
      type: "event",
      provider: "github",
      kind: "issues",
      filter: entries(17),
    }),
    "filter:filter_too_large",
  );
  assertEquals(
    triggerReason({
      type: "event",
      provider: "github",
      kind: "issues",
      filter: entries(16),
    }),
    "accepted",
  );
  assertEquals(
    triggerReason({
      type: "event",
      provider: "github",
      kind: "issues",
      filter: { a: "x".repeat(256) },
    }),
    "accepted",
  );
  // Only plain objects: a class instance, a null-prototype object or a prototype key is refused, not read through.
  class Fake {
    type = "schedule";
    cron = "0 9 * * *";
    timezone = "UTC";
  }
  assertEquals(triggerReason(new Fake()), ":trigger_not_object");
  assertEquals(
    triggerReason(
      Object.assign(Object.create(null), {
        type: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
      }),
    ),
    ":trigger_not_object",
  );
  assertEquals(
    triggerReason(
      JSON.parse(
        '{"type":"schedule","cron":"0 9 * * *","timezone":"UTC","__proto__":{"x":1}}',
      ),
    ),
    "__proto__:unknown_key",
  );
  // A trigger is never changed by being read.
  const original = {
    type: "event",
    provider: "github",
    kind: "issues",
    filter: { b: 1, a: 2 },
  };
  const snapshot = JSON.stringify(original);
  parseTrigger(original);
  assertEquals(JSON.stringify(original), snapshot);
});

Deno.test("the due occurrences from the cursor to now are counted once each, however many, and only within the catch-up window", () => {
  const due = (expression: string, zone: string, cursor: string, now: string) =>
    dueOccurrences(
      parseCron(expression),
      zone,
      new Date(cursor),
      new Date(now),
    );
  // On time: the cursor itself is the one due occurrence.
  const onTime = due(
    "*/5 * * * *",
    "UTC",
    "2026-11-14T10:05:00Z",
    "2026-11-14T10:05:30Z",
  )!;
  assertEquals(onTime.count, 1);
  assertEquals(iso(onTime.latest), "2026-11-14T10:05:00.000Z");
  // Late by several occurrences: the cursor and every one up to now, inclusive of now.
  const late = due(
    "*/5 * * * *",
    "UTC",
    "2026-11-14T10:05:00Z",
    "2026-11-14T10:30:00Z",
  )!;
  assertEquals(late.count, 6);
  assertEquals(iso(late.latest), "2026-11-14T10:30:00.000Z");
  // Nothing due before the cursor.
  assertEquals(
    due("*/5 * * * *", "UTC", "2026-11-14T10:05:00Z", "2026-11-14T10:04:59Z"),
    null,
  );
  // Counted in chunks of a hundred thousand: 100 days of a per-minute schedule is 144000.
  const many = due(
    "* * * * *",
    "UTC",
    "2026-08-01T00:00:00Z",
    "2026-11-09T00:00:00Z",
  )!;
  assertEquals(many.count, 100 * 1440 + 1);
  assertEquals(iso(many.latest), "2026-11-09T00:00:00.000Z");
  // Older than the window is not counted: the window is the last CATCH_UP_DAYS days.
  const ancient = due(
    "0 0 * * *",
    "UTC",
    "2015-01-01T00:00:00Z",
    "2026-11-14T12:00:00Z",
  )!;
  assertEquals(CATCH_UP_DAYS, 366);
  assertEquals(ancient.count, 366);
  assertEquals(iso(ancient.latest), "2026-11-14T00:00:00.000Z");
  // A clock-change day is counted by its real occurrences: Berlin's hourly schedule has 23 in the spring day, and the window's closing midnight is the 24th.
  const spring = due(
    "0 * * * *",
    "Europe/Berlin",
    "2026-03-28T23:00:00Z",
    "2026-03-29T22:00:00Z",
  )!;
  assertEquals(spring.count, 24);
  // Greenland: the skipped hour and midnight are one occurrence.
  const greenland = due(
    "0 * * * *",
    "America/Godthab",
    "2025-03-29T21:00:00Z",
    "2025-03-30T04:00:00Z",
  )!;
  assertEquals(greenland.count, 8);
});

Deno.test("one firing stands in for the due occurrences: coalesce queues the latest and counts the rest, skip records them all and runs none", () => {
  const latest = new Date("2026-11-14T10:30:00Z");
  // On time: an ordinary queued firing under either policy.
  for (const policy of ["coalesce", "skip"] as const) {
    assertEquals(planFiring(policy, { count: 1, latest }), {
      scheduledAt: latest,
      status: "queued",
      pending: true,
      skippedCount: 0,
    });
  }
  assertEquals(planFiring("coalesce", { count: 6, latest }), {
    scheduledAt: latest,
    status: "queued",
    pending: true,
    skippedCount: 5,
  });
  assertEquals(planFiring("skip", { count: 6, latest }), {
    scheduledAt: latest,
    status: "skipped",
    pending: false,
    skippedCount: 6,
  });
  assertEquals(
    planFiring("coalesce", { count: 144_001, latest }).skippedCount,
    144_000,
  );
  // Never a negative count, whatever is asked of it.
  assertEquals(planFiring("coalesce", { count: 0, latest }).skippedCount, 0);
  assertEquals(
    planFiring("skip", { count: 144_001, latest }).skippedCount,
    144_001,
  );
});
