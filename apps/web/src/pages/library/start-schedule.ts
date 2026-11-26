export const SCHEDULE_REPEATS = [
  "daily",
  "weekdays",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

export type SimpleSchedule = {
  readonly repeat: ScheduleRepeat;
  readonly time: string;
};

export const NEW_SCHEDULE: SimpleSchedule = {
  repeat: "weekdays",
  time: "09:00",
};

const DAY_FIELD: Readonly<Record<ScheduleRepeat, string>> = {
  daily: "*",
  weekdays: "1-5",
  mon: "1",
  tue: "2",
  wed: "3",
  thu: "4",
  fri: "5",
  sat: "6",
  sun: "0",
};

const two = (value: number) => String(value).padStart(2, "0");

export const SCHEDULE_TIMES: readonly string[] = Array.from(
  { length: 48 },
  (_, half) => `${two(Math.floor(half / 2))}:${two((half % 2) * 30)}`,
);

export function cronOf({ repeat, time }: SimpleSchedule): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * ${DAY_FIELD[repeat]}`;
}

export function simpleSchedule(cron: string): SimpleSchedule | null {
  const read = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(cron.trim());
  if (read === null) return null;
  const [, minute, hour, day] = read;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  const repeat = SCHEDULE_REPEATS.find((one) =>
    DAY_FIELD[one] === (day === "7" ? "0" : day)
  );
  return repeat === undefined
    ? null
    : { repeat, time: `${two(Number(hour))}:${two(Number(minute))}` };
}

function runsOn(repeat: ScheduleRepeat, weekday: number): boolean {
  if (repeat === "daily") return true;
  if (repeat === "weekdays") return weekday >= 1 && weekday <= 5;
  return weekday === Number(DAY_FIELD[repeat]);
}

function wallClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((one) => one.type === type)?.value ?? "0";
  return {
    day: Date.UTC(
      Number(part("year")),
      Number(part("month")) - 1,
      Number(part("day")),
    ),
    time: `${two(Number(part("hour")))}:${two(Number(part("minute")))}`,
  };
}

export function nextRunDays(
  schedule: SimpleSchedule,
  timezone: string,
  now: Date,
  count = 5,
): readonly Date[] {
  const today = wallClock(now, timezone);
  const days: Date[] = [];
  for (let ahead = 0; days.length < count; ahead += 1) {
    const day = new Date(today.day + ahead * 86_400_000);
    if (ahead === 0 && schedule.time <= today.time) continue;
    if (runsOn(schedule.repeat, day.getUTCDay())) days.push(day);
  }
  return days;
}

export function timeZones(current: string): readonly string[] {
  const known = Intl.supportedValuesOf("timeZone");
  return [...new Set(["UTC", current, ...known])];
}
