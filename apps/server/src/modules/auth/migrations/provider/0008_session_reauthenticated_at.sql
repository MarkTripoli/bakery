-- Hand-written, in the shape of the Better Auth generator's output for the
-- Bakery session-assurance plugin's `session.reauthenticatedAt` field.
--   - "reauthenticatedAt" records when the person last re-proved their
--     password on this exact session (`POST /api/auth/bakery/reauthenticate`);
--     null until then. The management `fresh` check accepts the later of
--     "createdAt" and "reauthenticatedAt", so no replacement session is minted.
alter table "session" add column "reauthenticatedAt" timestamptz;
