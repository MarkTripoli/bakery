-- Generated once via Better Auth's getMigrations with
-- plugins: [organization(), twoFactor(), passkey()] and
-- user.additionalFields { firstName, lastName, title, profileVersion } mapped to
-- first_name, last_name, title and profile_version, against a scratch database
-- migrated through 0001-0005, then pasted (throwaway script, deleted after
-- use). One deviation from the generator's output is hand-made and deliberate:
--   - "profile_version" is NOT NULL: it is the If-Match version of the
--     personal profile, so a null would defeat the compare-and-swap. It is a
--     dedicated counter because "updatedAt" also moves on unrelated provider
--     writes (for example two-factor enrollment).
alter table "user" add column "first_name" text;

alter table "user" add column "last_name" text;

alter table "user" add column "title" text;

alter table "user" add column "profile_version" integer not null default 1;
