/**
 * The period choices the usage page offers, and the windows they mean.
 *
 * Kept apart from the screen so the arithmetic can be tested without React:
 * the difference between "this month" and "the last 30 days" is a different
 * set of receipts, and getting it wrong shows a real figure under the wrong
 * heading.
 */

/** The period choices the server's window can express; all live in the URL. */
export const USAGE_PERIODS = [
  "last7",
  "last30",
  "thisMonth",
  "custom",
] as const;
export type UsagePeriod = typeof USAGE_PERIODS[number];

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return typeof value === "string" &&
    (USAGE_PERIODS as readonly string[]).includes(value);
}

/** The longest window the server accepts, in days. */
export const USAGE_MAX_PERIOD_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A window for one period choice, in the browser's own clock.
 *
 * `custom` is not turned into a window here: the caller supplies the range the
 * person picked, and a missing range falls back to the last 30 days rather than
 * to an unbounded window the server would refuse.
 */
export function usageWindow(
  period: UsagePeriod,
  now: Date,
  custom?: Readonly<{ from: Date; to: Date }>,
): Readonly<{ from: Date; to: Date }> {
  if (period === "custom") {
    return custom ?? { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
  }
  if (period === "last7") {
    return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
  }
  if (period === "thisMonth") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: now,
    };
  }
  return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
}

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

export const isDateInput = (value: unknown): value is string =>
  typeof value === "string" && DATE_INPUT.test(value) &&
  !Number.isNaN(new Date(`${value}T00:00:00`).getTime());

export function dateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function customWindow(
  from: unknown,
  to: unknown,
): Readonly<{ from: Date; to: Date }> | null {
  if (!isDateInput(from) || !isDateInput(to)) return null;
  return {
    from: new Date(`${from}T00:00:00`),
    to: new Date(`${to}T23:59:59.999`),
  };
}

export const usageWindowReversed = (
  window: Readonly<{ from: Date; to: Date }>,
): boolean => window.from.getTime() > window.to.getTime();

/**
 * Whether a window is longer than the server will answer for.
 *
 * A window that starts after it ends is not too long; it is wrong, and the
 * server says so. Calling it "too long" would send the reader to trim dates
 * that are already short.
 */
export function usageWindowTooLong(
  window: Readonly<{ from: Date; to: Date }>,
): boolean {
  const span = window.to.getTime() - window.from.getTime();
  return span > USAGE_MAX_PERIOD_DAYS * DAY_MS;
}
