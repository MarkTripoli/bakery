/**
 * How long to wait, in words: "45 seconds" under a minute, otherwise whole
 * minutes rounded up ("3 minutes"). The server gives seconds; people do not
 * count past a minute.
 */
export function formatWait(retryAfterSeconds: number, locale: string): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const unit = seconds < 60 ? "second" : "minute";
  const count = unit === "second" ? seconds : Math.ceil(seconds / 60);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(count);
}
