-- Generated once via Better Auth's getMigrations with
-- plugins: [organization(), twoFactor(), passkey()] against a scratch
-- database migrated through 0001-0004, then pasted (throwaway script,
-- deleted after use). Two deviations from the generator's output are
-- hand-made and deliberate:
--   - "passkey_credentialID_key" replaces the generator's non-unique
--     "passkey_credentialID_idx": `/passkey/verify-authentication` looks
--     the row up by `credentialID` alone, so two rows would make sign-in
--     ambiguous. A later regeneration re-emits "passkey_credentialID_idx";
--     drop it from that output, the unique index already serves the lookup.
--   - the `bakery_app` grant: the runtime role owns nothing (0002).
create table "passkey" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text, "publicKey" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" boolean not null, "transports" text, "createdAt" timestamptz, "aaguid" text);

create index "passkey_userId_idx" on "passkey" ("userId");

create unique index "passkey_credentialID_key" on "passkey" ("credentialID");

grant select, insert, update, delete
on table
  public."passkey"
to bakery_app;
