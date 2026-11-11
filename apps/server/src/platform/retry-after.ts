/** The longest provider-requested wait Bakery honors, in seconds. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** Whole seconds, at least one and at most MAX_RETRY_AFTER_SECONDS. */
export function boundRetryAfterSeconds(seconds: number): number {
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

/**
 * Parses Retry-After as delta-seconds or an HTTP date, bounded to 1..3600
 * seconds; undefined when absent or invalid.
 */
export function retryAfterSeconds(
  headers: Headers,
  nowMs: number,
): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^[0-9]{1,9}$/.test(raw)) return boundRetryAfterSeconds(Number(raw));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return boundRetryAfterSeconds((at - nowMs) / 1000);
}
