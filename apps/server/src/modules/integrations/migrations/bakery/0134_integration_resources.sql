-- Provider resources discovered on organization connections (issue #482).
-- Setup records the repositories of the verified installation that the
-- connecting user administers: available, unselected and not enabled. The
-- composite foreign keys pin each resource to its connection's organization
-- and installation; neither they nor the provider identity (kind,
-- external_id) carry an update grant. discovered_repositories on the auth
-- attempt holds, between the OAuth callback and the bind, the identities of
-- the administered repositories per completely scanned installation (never
-- the user token); it is cleared when the attempt completes or fails.
-- Structure only: selection, availability and discovery generations are
-- enforced in TypeScript.
alter table bakery.integration_connections
  add constraint integration_connections_installation_unique
    unique (id, installation_id);

-- Keyset pages of one organization's connections, newest first.
create index integration_connections_organization_page
  on bakery.integration_connections (organization_id, created_at desc, id desc);

create table bakery.integration_resources (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  kind text not null,
  external_id text not null,
  display_name text not null,
  safe_url text,
  selected boolean not null default false,
  available boolean not null default true,
  enabled boolean not null default false,
  capability_snapshot jsonb not null default '{}'::jsonb,
  last_discovery_generation integer not null,
  secret_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_resources_organization_id_unique
    unique (organization_id, id),
  constraint integration_resources_identity_unique
    unique (connection_id, kind, external_id),
  constraint integration_resources_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_resources_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  constraint integration_resources_installation_fk
    foreign key (connection_id, installation_id)
    references bakery.integration_connections (id, installation_id)
    on delete cascade,
  constraint integration_resources_secret_fk
    foreign key (organization_id, secret_id)
    references bakery.secrets (organization_id, id)
);

-- Keyset pages of one connection's resources, newest first.
create index integration_resources_connection_page
  on bakery.integration_resources (connection_id, created_at desc, id desc);

grant select, insert on bakery.integration_resources to bakery_app;
grant update (display_name, safe_url, selected, available, enabled,
  capability_snapshot, last_discovery_generation, secret_id, archived_at,
  updated_at, version)
  on bakery.integration_resources to bakery_app;

alter table bakery.integration_auth_attempts
  add column discovered_repositories jsonb;

grant update (discovered_repositories)
  on bakery.integration_auth_attempts to bakery_app;
