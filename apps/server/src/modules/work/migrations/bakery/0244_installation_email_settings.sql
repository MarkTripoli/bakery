-- How this installation sends email (issue #458, chapter 25 section 19).
--
-- One row, like the skill storage settings: the installation owns it, only an
-- installation administrator reads or changes it, and the SMTP password never
-- lives here. The password is one installation-owned secret (provider 'smtp'),
-- sealed with the installation secrets key, so this row carries only the
-- secret's id and revision.
--
-- Bakery emails only a link, never the content of work, so the row holds
-- transport settings and the outcome of the last test and nothing else. The
-- last test is cleared whenever the settings are saved, because a result for
-- settings that no longer exist would be a lie.
--
-- Turning email off deletes this row and revokes the secret; the application
-- role cannot delete secret rows, so a revoked secret is how "removed" reads.
-- The closed vocabularies (security, test outcome) are owned by TypeScript.
create table bakery.installation_email_settings (
  id text primary key,
  host text not null,
  port integer not null,
  security text not null,
  username text,
  from_address text not null,
  from_name text not null,
  secret_id uuid,
  credential_revision integer,
  credential_updated_at timestamptz,
  last_test_outcome text,
  last_test_at timestamptz,
  last_test_address text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint installation_email_settings_secret_fk
    foreign key (secret_id) references bakery.secrets (id),
  constraint installation_email_settings_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

grant select, delete on bakery.installation_email_settings to bakery_app;
grant insert (id, host, port, security, username, from_address, from_name,
  secret_id, credential_revision, credential_updated_at, version, created_at,
  updated_at, updated_by)
  on bakery.installation_email_settings to bakery_app;
grant update (host, port, security, username, from_address, from_name,
  secret_id, credential_revision, credential_updated_at, last_test_outcome,
  last_test_at, last_test_address, version, updated_at, updated_by)
  on bakery.installation_email_settings to bakery_app;
