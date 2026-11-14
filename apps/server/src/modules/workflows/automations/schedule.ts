/**
 * Cron schedules in an IANA timezone, as pure functions (issue #36).
 *
 * `automation.tick` asks one question of this module: which UTC instants of a
 * schedule fall in a window? A schedule is the five fields of a classic cron
 * expression (`minute hour day-of-month month day-of-week`) and a timezone
 * name; nothing here runs or evaluates anything the author wrote beyond those
 * five fields.
 *
 * Daylight saving time is deterministic (design, "Schedules and
 * event-triggered agents"):
 *   - a local time that does not exist (the hour skipped in spring) is advanced
 *     to the next valid local instant, which is the instant the clocks change;
 *     several skipped times of one schedule collapse to that one instant;
 *   - a local time that happens twice (the hour repeated in autumn) is one
 *     occurrence, at its first UTC instant.
 * The result is always a UTC instant, which is what a firing is keyed by.
 */

export type CronErrorCode =
  | "CRON_EXPRESSION_INVALID"
  | "CRON_TIMEZONE_INVALID";

export class CronError extends Error {
  override readonly name = "CronError";
  constructor(readonly code: CronErrorCode, message: string) {
    super(message);
  }
}

/** A parsed cron expression: the allowed values of each field, ascending. */
export type CronSchedule = Readonly<{
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[];
  months: readonly number[];
  /** 0 to 6, Sunday is 0 (7 in the expression is folded into 0). */
  daysOfWeek: readonly number[];
  /** The day-of-month field began with `*`: it does not restrict the day. */
  dayOfMonthOpen: boolean;
  /** The day-of-week field began with `*`: it does not restrict the day. */
  dayOfWeekOpen: boolean;
}>;

const MAX_EXPRESSION_LENGTH = 100;
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = Readonly<{
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Added to a name's index to give its value. */
  nameOffset?: number;
}>;

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 },
];

function invalid(message: string): never {
  throw new CronError("CRON_EXPRESSION_INVALID", message);
}

function fieldNumber(text: string, spec: FieldSpec): number {
  if (/^[0-9]{1,2}$/.test(text)) {
    const value = Number(text);
    if (value < spec.min || value > spec.max) {
      invalid(`${spec.name} ${value} is outside ${spec.min}-${spec.max}`);
    }
    return value;
  }
  if (spec.names !== undefined) {
    const index = spec.names.indexOf(text.toLowerCase());
    if (index >= 0 && /^[A-Za-z]{3}$/.test(text)) {
      return index + (spec.nameOffset ?? 0);
    }
  }
  return invalid(`${spec.name} has an unreadable value`);
}

function parseField(text: string, spec: FieldSpec): number[] {
  if (text.length === 0) invalid(`${spec.name} is empty`);
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (part.length === 0) invalid(`${spec.name} has an empty list item`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) invalid(`${spec.name} has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^[0-9]{1,2}$/.test(stepText) || Number(stepText) < 1) {
        invalid(`${spec.name} step must be a whole number from 1`);
      }
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = spec.min;
      // In day-of-week the range reaches 7, which is only another name for 0 and is folded below.
      to = spec.max;
    } else if (range!.includes("-")) {
      const [low, high, more] = range!.split("-");
      if (more !== undefined || low === undefined || high === undefined) {
        invalid(`${spec.name} has a malformed range`);
      }
      from = fieldNumber(low, spec);
      to = fieldNumber(high, spec);
      if (from > to) invalid(`${spec.name} range runs backwards`);
    } else {
      from = fieldNumber(range!, spec);
      // `5/10` means from 5 to the end of the field, every 10.
      to = stepText === undefined ? from : spec.max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a five-field cron expression, or throws a `CronError`. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") invalid("expression must be a string");
  if (expression.length > MAX_EXPRESSION_LENGTH) invalid("expression too long");
  // Only spaces and tabs separate or surround fields: no other whitespace is ignored at an edge and refused inside.
  const parts = expression.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  if (parts.length !== 5) {
    invalid("expression must have exactly five fields");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekdays = parseField(dayOfWeek, FIELDS[4]!).map((day) => day % 7);
  return Object.freeze({
    minutes: Object.freeze(parseField(minute, FIELDS[0]!)),
    hours: Object.freeze(parseField(hour, FIELDS[1]!)),
    daysOfMonth: Object.freeze(parseField(dayOfMonth, FIELDS[2]!)),
    months: Object.freeze(parseField(month, FIELDS[3]!)),
    daysOfWeek: Object.freeze([...new Set(weekdays)].sort((a, b) => a - b)),
    dayOfMonthOpen: dayOfMonth.startsWith("*"),
    dayOfWeekOpen: dayOfWeek.startsWith("*"),
  });
}

/**
 * Whether `zone` is an IANA zone name the runtime knows. Offsets such as
 * `+02:00` or `UTC+2`, and anything with spaces, dots or other characters, are
 * not zone names for a schedule. The letter case of a name is not checked: the
 * runtime resolves `europe/berlin` and `Us/Pacific` as it does `Europe/Berlin`
 * and `US/Pacific`, and the schedule behaves the same, so what is stored is
 * what the author wrote. Link names (`US/Pacific`, `Asia/Kolkata`) are IANA
 * names and are accepted.
 */
export function isValidTimeZone(zone: string): boolean {
  if (
    typeof zone !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)*$/.test(zone)
  ) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

type Wall = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

/** The local wall-clock fields of a UTC instant in `zone`. */
function wallOf(zone: string, utcMs: number): Wall {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year!,
    month: fields.month!,
    day: fields.day!,
    hour: fields.hour! === 24 ? 0 : fields.hour!,
    minute: fields.minute!,
    second: fields.second!,
  };
}

/** A wall time written as if it were UTC: the common currency for comparing and subtracting. */
function wallMs(wall: Wall): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(zone: string, utcMs: number): number {
  return wallMs(wallOf(zone, utcMs)) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instants of a schedule's occurrences on one local day, ascending and
 * without repeats, by the daylight saving rules above. A day away from a clock
 * change has one offset all day and each time is just that offset away from
 * UTC; on a change day the instant of the change is found once and every time
 * of the day is placed against it, so a schedule of a thousand occurrences in
 * the day costs a thousand subtractions, not a thousand searches.
 */
function instantsOfDay(
  schedule: CronSchedule,
  zone: string,
  year: number,
  month: number,
  day: number,
): number[] {
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  // The zone's offset a day either side bounds every offset of the local day.
  const before = offsetAt(zone, noon - 86_400_000);
  const after = offsetAt(zone, noon + 86_400_000);
  const walls: number[] = [];
  for (const hour of schedule.hours) {
    for (const minute of schedule.minutes) {
      walls.push(Date.UTC(year, month - 1, day, hour, minute, 0));
    }
  }
  if (before === after) return walls.map((wall) => wall - before);
  // The clocks change in this window: find the instant, to the second.
  let low = noon - 86_400_000;
  let high = noon + 86_400_000;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (offsetAt(zone, middle) === before) low = middle;
    else high = middle;
  }
  const change = high;
  const instants = new Set<number>();
  for (const wall of walls) {
    const first = wall - before; // right if it falls before the change
    const second = wall - after; // right if it falls at or after the change
    const early = first < change;
    const late = second >= change;
    // Both: the time happens twice, the first instant counts. Neither: the time
    // does not exist, the instant of the change stands in for it.
    instants.add(early ? first : late ? second : change);
  }
  // Placed in the order of their wall times, which the change never reverses: a Set keeps that order and drops the repeats.
  return [...instants];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(
  schedule: CronSchedule,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!schedule.months.includes(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const inMonth = schedule.daysOfMonth.includes(day);
  const inWeek = schedule.daysOfWeek.includes(weekday);
  // A restricted day-of-month and a restricted day-of-week are alternatives;
  // an open one does not restrict.
  return schedule.dayOfMonthOpen || schedule.dayOfWeekOpen
    ? inMonth && inWeek
    : inMonth || inWeek;
}

/** The instants a schedule is asked about: from 1970 to the end of year 9999, where every platform's dates and the zone data are sound. */
const EARLIEST_MS = Date.UTC(1970, 0, 1);
const LATEST_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
/** The most occurrences one call may return; a caller that needs more asks again from the last. */
export const MAX_OCCURRENCES = 100_000;

function requireInstant(name: string, date: Date): number {
  const ms = date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > LATEST_MS) {
    throw new RangeError(`${name} must be a date from 1970 to 9999`);
  }
  return ms;
}

/** How far ahead to look for an occurrence: covers a February 29 schedule across a century gap. */
const HORIZON_DAYS = 366 * 9;

/** The local calendar day after the given one. */
function nextDay(
  year: number,
  month: number,
  day: number,
): [number, number, number] {
  return day < daysInMonth(year, month)
    ? [year, month, day + 1]
    : month < 12
    ? [year, month + 1, 1]
    : [year + 1, 1, 1];
}

/**
 * The occurrences strictly after `afterMs`, in order, day by day from the local
 * day it falls on, for at most `days` local days; each day's instants are
 * worked out once.
 */
function* occurrencesFrom(
  schedule: CronSchedule,
  zone: string,
  afterMs: number,
  days: number,
): Generator<number> {
  const start = wallOf(zone, afterMs);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  // The last instant given: a skipped hour that ends at local midnight is advanced
  // to the instant of the change, which is also the next day's first wall time
  // (Greenland), so one day's last instant can be the next day's first.
  let last = afterMs;
  for (let index = 0; index < days; index += 1) {
    if (dayMatches(schedule, year, month, day)) {
      for (const instant of instantsOfDay(schedule, zone, year, month, day)) {
        if (instant > last) {
          last = instant;
          yield instant;
        }
      }
    }
    [year, month, day] = nextDay(year, month, day);
  }
}

/**
 * The first occurrence strictly after `after`, as a UTC instant, or null when
 * the schedule never fires within the horizon (for example `0 0 31 2 *`).
 */
export function nextOccurrence(
  schedule: CronSchedule,
  zone: string,
  after: Date,
): Date | null {
  if (!isValidTimeZone(zone)) {
    throw new CronError("CRON_TIMEZONE_INVALID", `unknown time zone ${zone}`);
  }
  const afterMs = requireInstant("after", after);
  for (
    const instant of occurrencesFrom(schedule, zone, afterMs, HORIZON_DAYS)
  ) {
    // An occurrence past year 9999 is outside what a schedule is asked about.
    return instant > LATEST_MS ? null : new Date(instant);
  }
  return null;
}

/**
 * The occurrences after `after` up to and including `until`, oldest first, at
 * most `limit` of them; `truncated` says there were more. The window may span
 * at most nine years, and each local day is worked out once, so the cost is the
 * number of days plus the number of occurrences.
 */
export function occurrencesBetween(
  schedule: CronSchedule,
  zone: string,
  after: Date,
  until: Date,
  limit: number,
): { occurrences: Date[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OCCURRENCES) {
    throw new RangeError(
      `limit must be a whole number from 1 to ${MAX_OCCURRENCES}`,
    );
  }
  const afterMs = requireInstant("after", after);
  const untilMs = requireInstant("until", until);
  if (!isValidTimeZone(zone)) {
    throw new CronError("CRON_TIMEZONE_INVALID", `unknown time zone ${zone}`);
  }
  // Whole days of the window, with a day either side for the zone's offset.
  const days = Math.ceil((untilMs - afterMs) / 86_400_000) + 2;
  if (days > HORIZON_DAYS) {
    throw new RangeError("the window must be at most nine years");
  }
  const occurrences: Date[] = [];
  for (const instant of occurrencesFrom(schedule, zone, afterMs, days)) {
    if (instant > untilMs) break;
    if (occurrences.length >= limit) return { occurrences, truncated: true };
    occurrences.push(new Date(instant));
  }
  return { occurrences, truncated: false };
}
