-- Generated shape of the `@better-auth/sso` plugin's `ssoProvider` model with
-- `domainVerification` enabled, checked against `getMigrations` output by
-- `ee/tests/integration/sso_test.ts`. Hand edits:
--   - `userId` and `id` are `uuid` like the rest of the provider schema.
--   - the `bakery_app` grant: the runtime role owns nothing (0002). The
--     provider reads and writes provider rows; Bakery's SSO guard hooks decide
--     who may call the endpoints.
-- The table exists in the community build too, so installing or removing `ee/`
-- never changes the schema.
create table "ssoProvider" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "issuer" text not null, "oidcConfig" text, "samlConfig" text, "userId" uuid not null references "user" ("id") on delete cascade, "providerId" text not null unique, "organizationId" text, "domain" text not null, "domainVerified" boolean);

create index "ssoProvider_userId_idx" on "ssoProvider" ("userId");

create index "ssoProvider_organizationId_idx" on "ssoProvider" ("organizationId");

grant select, insert, update, delete
on table public."ssoProvider"
to bakery_app;
