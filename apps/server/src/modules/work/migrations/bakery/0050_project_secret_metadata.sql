create table bakery.secrets (
  id uuid primary key,
  organization_id uuid references bakery.organizations(id),
  application_id uuid,
  integration_installation_id uuid,
  name text not null,
  provider text,
  verified_provider_account_id text,
  verified_login text,
  active_version_id uuid,
  active_version_revision integer not null default 1,
  generation integer not null default 1,
  policy_revision integer not null default 1,
  invalidation_generation integer not null default 1,
  allowed_principals jsonb not null default '[]',
  allowed_actions jsonb not null default '[]',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (organization_id, id),
  unique (organization_id, application_id, id),
  foreign key (organization_id, application_id) references bakery.applications(organization_id, id)
);
create table bakery.secret_versions (
  id uuid primary key,
  organization_id uuid references bakery.organizations(id),
  application_id uuid,
  integration_installation_id uuid,
  secret_id uuid not null references bakery.secrets(id),
  revision integer not null,
  ciphertext bytea not null,
  nonce bytea not null,
  key_id text not null,
  created_by uuid not null references bakery.principals(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (secret_id, revision),
  unique (secret_id, id),
  foreign key (organization_id, secret_id) references bakery.secrets(organization_id, id),
  foreign key (organization_id, application_id, secret_id) references bakery.secrets(organization_id, application_id, id)
);
alter table bakery.secrets add foreign key (id, active_version_id) references bakery.secret_versions(secret_id, id);
create index secrets_project_page on bakery.secrets(organization_id, application_id, created_at desc, id desc);
grant select, insert on bakery.secrets, bakery.secret_versions to bakery_app;
grant update (active_version_id) on bakery.secrets to bakery_app;
