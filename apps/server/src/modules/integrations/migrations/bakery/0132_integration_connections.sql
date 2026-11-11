-- Organization connections to a host-owned installation (issue #481). The
-- composite foreign key pins external_authorization_id and
-- external_account_id to the installation's immutable identity, and no
-- update grant covers them. One live connection per organization and
-- installation. Status (pending/enabled/disabled/revoked) and health
-- (unknown/healthy/degraded/auth_required) are separate columns whose
-- transitions are enforced in TypeScript; structure only.
create table bakery.integration_connections (
  id uuid primary key,
  organization_id uuid not null,
  provider text not null,
  installation_id uuid not null,
  external_authorization_id text not null,
  external_account_id text not null,
  label text not null,
  config jsonb not null default '{}'::jsonb,
  config_schema_version integer not null default 1,
  adapter_version text not null,
  secret_id uuid,
  granted_permissions jsonb not null,
  authorization_revision integer not null default 1,
  status text not null,
  health text not null,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  next_allowed_at timestamptz,
  last_problem_code text,
  archived_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_connections_organization_id_unique
    unique (organization_id, id),
  constraint integration_connections_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_connections_installation_identity_fk
    foreign key (installation_id, external_authorization_id,
      external_account_id)
    references bakery.integration_installations (id,
      external_authorization_id, external_account_id),
  constraint integration_connections_secret_fk
    foreign key (organization_id, secret_id)
    references bakery.secrets (organization_id, id),
  constraint integration_connections_created_by_fk
    foreign key (created_by) references bakery.principals (id)
);

create unique index integration_connections_live_installation_unique
  on bakery.integration_connections (organization_id, installation_id)
  where archived_at is null;

grant select, insert on bakery.integration_connections to bakery_app;
grant update (label, config, config_schema_version, adapter_version,
  secret_id, granted_permissions, authorization_revision, status, health,
  last_checked_at, last_success_at, next_allowed_at, last_problem_code,
  archived_at, updated_at, version)
  on bakery.integration_connections to bakery_app;
