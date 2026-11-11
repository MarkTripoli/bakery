-- Hand-written, in the shape of the Better Auth generator's output for a
-- `number` field. "rateLimit"."lastRequest" held epoch milliseconds as bigint,
-- which `pg` returns as a string, so Better Auth computed a nonsense
-- X-Retry-After (string concatenation). double precision returns a JS number
-- and represents epoch milliseconds exactly (below 2^53); stored values are
-- unchanged.
alter table "rateLimit" alter column "lastRequest" type double precision;
