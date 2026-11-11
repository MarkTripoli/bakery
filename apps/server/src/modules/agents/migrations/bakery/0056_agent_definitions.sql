-- Agent catalog definitions are mutable identities; published versions are
-- immutable rows pinned by caller-supplied revision and verified digest.
create table bakery.agent_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  slug text not null,
  name text not null,
  description text,
  active_version_id uuid,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint agent_definitions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint agent_definitions_organization_id_unique
    unique (organization_id, id),
  constraint agent_definitions_organization_slug_unique
    unique (organization_id, slug)
);
create index agent_definitions_organization_created_idx
  on bakery.agent_definitions (organization_id, created_at desc, id desc);

create table bakery.agent_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  agent_id uuid not null,
  revision integer not null,
  config jsonb not null,
  digest text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint agent_versions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint agent_versions_agent_fk
    foreign key (organization_id, agent_id)
    references bakery.agent_definitions (organization_id, id) on delete cascade,
  constraint agent_versions_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint agent_versions_organization_id_unique
    unique (organization_id, id),
  constraint agent_versions_revision_unique
    unique (organization_id, agent_id, revision)
);
create index agent_versions_agent_revision_idx
  on bakery.agent_versions (organization_id, agent_id, revision desc, id desc);

alter table bakery.agent_definitions
  add constraint agent_definitions_active_version_fk
  foreign key (organization_id, active_version_id)
  references bakery.agent_versions (organization_id, id) on delete restrict;

grant select, insert, update on bakery.agent_definitions to bakery_app;
grant select, insert on bakery.agent_versions to bakery_app;
