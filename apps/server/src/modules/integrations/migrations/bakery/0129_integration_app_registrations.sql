-- Installation-owned provider app registrations (GitHub App manifest flow,
-- issue #477). Credentials are configured through the product UI: the client
-- secret, private key and webhook secret live in bakery.secrets and
-- bakery.secret_versions with organization_id and application_id null, and
-- this table holds only their ids. webhook_secret_id is null when GitHub
-- generated no webhook secret. Structure only: lifecycle, single-use
-- state claims and authorization are enforced in TypeScript.
create table bakery.integration_app_registrations (
  id uuid primary key,
  provider text not null,
  external_app_id bigint not null,
  slug text not null,
  name text not null,
  client_id text not null,
  owner_login text not null,
  owner_id bigint not null,
  owner_type text not null,
  html_url text not null,
  permissions jsonb not null,
  events jsonb not null,
  client_secret_id uuid not null,
  private_key_secret_id uuid not null,
  webhook_secret_id uuid,
  status text not null,
  registered_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_app_registrations_provider_unique unique (provider),
  constraint integration_app_registrations_client_secret_fk
    foreign key (client_secret_id) references bakery.secrets (id),
  constraint integration_app_registrations_private_key_fk
    foreign key (private_key_secret_id) references bakery.secrets (id),
  constraint integration_app_registrations_webhook_secret_fk
    foreign key (webhook_secret_id) references bakery.secrets (id),
  constraint integration_app_registrations_registered_by_fk
    foreign key (registered_by) references bakery.principals (id)
);

-- One row per manifest registration attempt. Only the SHA-256 hash of the
-- state is stored. consumed_at is the single-use flag; outcome, the converted
-- App id and slug are written once after the claim.
create table bakery.integration_app_registration_attempts (
  id uuid primary key,
  provider text not null,
  state_hash text not null,
  initiating_principal_id uuid not null,
  session_id text not null,
  organization_login text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  outcome text,
  external_app_id bigint,
  slug text,
  registration_id uuid,
  created_at timestamptz not null default now(),
  constraint integration_app_registration_attempts_state_hash_unique
    unique (state_hash),
  constraint integration_app_registration_attempts_principal_fk
    foreign key (initiating_principal_id) references bakery.principals (id),
  constraint integration_app_registration_attempts_registration_fk
    foreign key (registration_id)
    references bakery.integration_app_registrations (id)
);

grant select, insert on bakery.integration_app_registrations to bakery_app;
grant select, insert on bakery.integration_app_registration_attempts
  to bakery_app;
grant update (consumed_at, outcome, external_app_id, slug, registration_id)
  on bakery.integration_app_registration_attempts to bakery_app;
