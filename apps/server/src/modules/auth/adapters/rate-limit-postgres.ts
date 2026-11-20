import type { PgDatabase } from "../../../platform/database.ts";
import { boundRetryAfterSeconds } from "../../../platform/retry-after.ts";

/**
 * Spends one attempt against a fixed-window limit kept in the provider's own
 * `rateLimit` table under a Bakery key prefix; for these keys
 * `lastRequest` holds the window start in epoch milliseconds. Resolves the
 * bounded Retry-After seconds when the attempt is over the limit, else
 * undefined. Spent before any lookup so a failed guess counts.
 */
export async function spendRateLimitAttempt(
  database: Pick<PgDatabase, "query">,
  key: string,
  limit: { max: number; windowMs: number },
  nowMs: number,
): Promise<number | undefined> {
  const { windowMs, max } = limit;
  const result = await database.query<{ count: number; windowStart: number }>(
    `insert into public."rateLimit" (key, count, "lastRequest")
     values ($1, 1, $2)
     on conflict (key) do update set
       count = case when "rateLimit"."lastRequest" <= $3 then 1
         else "rateLimit".count + 1 end,
       "lastRequest" = case when "rateLimit"."lastRequest" <= $3 then $2
         else "rateLimit"."lastRequest" end
     returning count, "lastRequest" as "windowStart"`,
    [key, nowMs, nowMs - windowMs],
  );
  const row = result.rows[0];
  if (!row || row.count <= max) return undefined;
  return boundRetryAfterSeconds(
    (Number(row.windowStart) + windowMs - nowMs) / 1000,
  );
}
