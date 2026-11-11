-- Generated once via Better Auth's getMigrations against a scratch database
-- migrated through 0001-0003, then pasted (see apps/server/throwaway script,
-- deleted after use). Two statements below are hand-added, NOT part of the
-- generator's output, and are deliberate deviations kept for data integrity
-- the generator does not enforce on its own:
--   - "twoFactor_userId_key": the plugin's `enable` endpoint does a
--     find-or-create keyed on `userId` with no database-level uniqueness, so
--     two concurrent `enable` calls before verification can leave two rows
--     for the same user.
--   - "verification_bakery_totp_used_key": backs Bakery's insert-first TOTP
--     replay guard (`session-assurance.ts`) with a partial unique index
--     scoped to the `bakery-totp-used-` identifier prefix so an unrelated
--     `verification` row (challenges, email tokens, ...) is never
--     constrained by it.
alter table "user" add column "twoFactorEnabled" boolean default false;

alter table "session" add column "factorVerifiedAt" timestamptz;

create table "twoFactor" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "secret" text not null, "backupCodes" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create table "rateLimit" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "twoFactor_secret_idx" on "twoFactor" ("secret");

create index "twoFactor_userId_idx" on "twoFactor" ("userId");

create unique index "twoFactor_userId_key" on "twoFactor" ("userId");

create unique index "verification_bakery_totp_used_key" on "verification" ("identifier") where "identifier" like 'bakery-totp-used-%';

grant select, insert, update, delete
on table
  public."twoFactor",
  public."rateLimit"
to bakery_app;
