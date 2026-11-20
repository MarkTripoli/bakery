/**
 * The period choices the Delivery page offers, and the windows they mean.
 *
 * It reads the same arithmetic as the Usage page, so "last 30 days" and "this
 * month" mean one thing across both: a figure shown under the wrong window is
 * a real number under the wrong heading.
 */
import {
  USAGE_MAX_PERIOD_DAYS,
  USAGE_PERIODS,
  usageWindow,
  usageWindowTooLong,
} from "../usage/usage-window.ts";

export const DELIVERY_PERIODS = USAGE_PERIODS;
export type DeliveryPeriod = typeof DELIVERY_PERIODS[number];

export function isDeliveryPeriod(value: unknown): value is DeliveryPeriod {
  return typeof value === "string" &&
    (DELIVERY_PERIODS as readonly string[]).includes(value);
}

export const DELIVERY_MAX_PERIOD_DAYS = USAGE_MAX_PERIOD_DAYS;

/** A `YYYY-MM-DD` date as the start of that day, or null when it is not one. */
export function parseDay(value: string | undefined): Date | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  // A date that does not exist (2026-02-31) rolls into the next month: refuse it.
  return formatDay(parsed) === value ? parsed : null;
}

/** A date as `YYYY-MM-DD` in the browser's own calendar, for a date input. */
export function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The window for one choice. A custom range runs from the start of its first
 * day to the end of its last day, so picking one day asks for that day; a
 * custom choice with no usable range falls back to the last 30 days rather
 * than to a window the server would refuse.
 */
export function deliveryWindow(
  period: DeliveryPeriod,
  now: Date,
  custom?: Readonly<{ from?: string; to?: string }>,
): Readonly<{ from: Date; to: Date }> {
  if (period === "custom") {
    const from = parseDay(custom?.from);
    const last = parseDay(custom?.to);
    if (from !== null && last !== null) {
      const to = new Date(
        last.getFullYear(),
        last.getMonth(),
        last.getDate() + 1,
      );
      return { from, to };
    }
  }
  return usageWindow(period === "custom" ? "last30" : period, now);
}

export function deliveryWindowTooLong(
  window: Readonly<{ from: Date; to: Date }>,
): boolean {
  return usageWindowTooLong(window);
}
