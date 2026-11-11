-- Host-owned provider installations (issue #481). One row per verified
-- GitHub App installation of the registered App; it may serve several
-- organization connections. external_authorization_id (the GitHub
-- installation id) and external_account_id are immutable once written;
-- account_login is presentation only. credential_secret_id stays null until
-- the token broker stores an installation credential. Structure only: the
-- pending/enabled/suspended/revoked lifecycle is enforced in TypeScript.
create table bakery.integration_installations (
  id uuid primary key,
  provider text not null,
  registration_id uuid not null,
  external_authorization_id text not null,
  external_account_id text not null,
  account_login text not null,
  account_type text not null,
  repository_selection text not null,
  granted_permissions jsonb not null,
  credential_secret_id uuid,
  authorization_revision integer not null default 1,
  status text not null,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_installations_identity_unique
    unique (registration_id, external_authorization_id),
  -- Lets connections pin the external identity they were bound to.
  constraint integration_installations_external_identity_unique
    unique (id, external_authorization_id, external_account_id),
  constraint integration_installations_registration_fk
    foreign key (registration_id)
    references bakery.integration_app_registrations (id),
  constraint integration_installations_credential_secret_fk
    foreign key (credential_secret_id) references bakery.secrets (id)
);

grant select, insert on bakery.integration_installations to bakery_app;
grant update (account_login, repository_selection, granted_permissions,
  credential_secret_id, authorization_revision, status, last_checked_at,
  updated_at, version)
  on bakery.integration_installations to bakery_app;
