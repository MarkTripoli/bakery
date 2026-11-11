-- Hand-written, in the shape of the Better Auth generator's output for the
-- Bakery session-assurance plugin's `session.passkeyId` field.
--   - "passkeyId" records the passkey whose sign-in ceremony created the
--     session; null for every other sign-in method.
--   - the foreign key cascades so deleting a passkey deletes every session it
--     created in the same statement; Bakery's `/passkey/delete-passkey` hook
--     relies on it (AC2: a stolen session loses access with its passkey).
alter table "session" add column "passkeyId" uuid references "passkey" ("id") on delete cascade;

create index "session_passkeyId_idx" on "session" ("passkeyId");
