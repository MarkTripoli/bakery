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
  const parts = expression.trim().split(/[ \t]+/);
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
    minutes: parseField(minute, FIELDS[0]!),
    hours: parseField(hour, FIELDS[1]!),
    daysOfMonth: parseField(dayOfMonth, FIELDS[2]!),
    months: parseField(month, FIELDS[3]!),
    daysOfWeek: [...new Set(weekdays)].sort((a, b) => a - b),
    dayOfMonthOpen: dayOfMonth.startsWith("*"),
    dayOfWeekOpen: dayOfWeek.startsWith("*"),
  });
}

/**
 * Whether `zone` is an IANA zone name the runtime knows, written the IANA way
 * (each path segment starts with a capital; `UTC` alone). Offsets such as
 * `+02:00` or `UTC+2`, other letter cases (`europe/berlin`) and anything with
 * spaces or dots are not zone names for a schedule: the author states the zone,
 * and what is stored is what they wrote. Link names (`US/Pacific`,
 * `Asia/Kolkata`) are IANA names and are accepted as written.
 */
export function isValidTimeZone(zone: string): boolean {
  if (
    typeof zone !== "string" ||
    !/^(?:UTC|[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*)$/.test(zone)
  ) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone })
      .resolvedOptions().timeZone;
    // The runtime accepts any letter case and reports the name's own: a
    // different case of the same name is not the name.
    return !(resolved !== zone &&
      resolved.toLowerCase() === zone.toLowerCase());
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
 * The UTC instant of a local wall time, by the daylight saving rules above: the
 * first instant when the time happens twice, the instant the clocks change when
 * it does not exist.
 */
function instantOfWall(zone: string, wall: number): number {
  // The zone's offset a day either side bounds every offset the wall time can have.
  const before = offsetAt(zone, wall - 86_400_000);
  const after = offsetAt(zone, wall + 86_400_000);
  const candidates = new Set<number>();
  for (const offset of new Set([before, after])) {
    const utc = wall - offset;
    if (wallMs(wallOf(zone, utc)) === wall) candidates.add(utc);
  }
  if (candidates.size > 0) return Math.min(...candidates);
  // The time does not exist: the clocks change somewhere between the two
  // estimates. Find the first instant whose local time has reached it.
  let low = wall - Math.max(before, after) - 3_600_000 * 24;
  let high = wall - Math.min(before, after) + 3_600_000 * 24;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (wallMs(wallOf(zone, middle)) >= wall) high = middle;
    else low = middle;
  }
  return high;
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

/** How far ahead to look for an occurrence: covers a February 29 schedule across a century gap. */
const HORIZON_DAYS = 366 * 9;

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
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) {
    throw new RangeError("after must be a valid date");
  }
  const start = wallOf(zone, afterMs);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  for (let index = 0; index < HORIZON_DAYS; index += 1) {
    if (dayMatches(schedule, year, month, day)) {
      let best: number | null = null;
      // Away from a clock change the offset is the same all day: no search.
      const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
      const steady = offsetAt(zone, noon - 86_400_000);
      const away = steady === offsetAt(zone, noon + 86_400_000);
      for (const hour of schedule.hours) {
        for (const minute of schedule.minutes) {
          const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
          const instant = away ? wall - steady : instantOfWall(zone, wall);
          if (instant > afterMs && (best === null || instant < best)) {
            best = instant;
          }
        }
      }
      if (best !== null) return new Date(best);
    }
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return null;
}

/**
 * The occurrences after `after` up to and including `until`, oldest first, at
 * most `limit` of them; `truncated` says there were more.
 */
export function occurrencesBetween(
  schedule: CronSchedule,
  zone: string,
  after: Date,
  until: Date,
  limit: number,
): { occurrences: Date[]; truncated: boolean } {
  const occurrences: Date[] = [];
  let cursor = after;
  while (true) {
    const next = nextOccurrence(schedule, zone, cursor);
    if (next === null || next.getTime() > until.getTime()) {
      return { occurrences, truncated: false };
    }
    if (occurrences.length >= limit) return { occurrences, truncated: true };
    occurrences.push(next);
    cursor = next;
  }
}
