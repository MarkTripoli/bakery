-- GHI-277 persists tenant-owned skill identities and immutable publication
-- metadata. Uploaded bytes remain outside PostgreSQL.
create table bakery.skill_sources (
  id uuid primary key,
  organization_id uuid not null,
  source_type text not null,
  locator text not null,
  display_name text not null,
  publisher text,
  license text,
  last_checked_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_sources_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint skill_sources_organization_id_unique unique (organization_id, id),
  constraint skill_sources_locator_unique unique (organization_id, locator)
);
create index skill_sources_organization_created_idx
  on bakery.skill_sources (organization_id, created_at desc, id desc);

create table bakery.skills (
  id uuid primary key,
  organization_id uuid not null,
  source_id uuid,
  slug text not null,
  name text not null,
  description text,
  active_version_id uuid,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skills_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint skills_source_fk
    foreign key (organization_id, source_id)
    references bakery.skill_sources (organization_id, id) on delete restrict,
  constraint skills_organization_id_unique unique (organization_id, id),
  constraint skills_slug_unique unique (organization_id, slug)
);
create index skills_organization_created_idx
  on bakery.skills (organization_id, created_at desc, id desc);

create table bakery.skill_versions (
  id uuid primary key,
  organization_id uuid not null,
  skill_id uuid not null,
  revision integer not null,
  source_revision text not null,
  digest text not null,
  entry_path text not null,
  manifest jsonb not null,
  status text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_versions_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint skill_versions_skill_fk
    foreign key (organization_id, skill_id)
    references bakery.skills (organization_id, id) on delete restrict,
  constraint skill_versions_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint skill_versions_organization_id_unique unique (organization_id, id),
  constraint skill_versions_organization_id_skill_unique
    unique (organization_id, id, skill_id),
  constraint skill_versions_revision_unique unique (skill_id, revision),
  constraint skill_versions_digest_unique unique (skill_id, digest)
);
create index skill_versions_skill_created_idx
  on bakery.skill_versions (organization_id, skill_id, created_at desc, id desc);

alter table bakery.skills
  add constraint skills_active_version_fk
  foreign key (organization_id, active_version_id, id)
  references bakery.skill_versions (organization_id, id, skill_id)
  on delete restrict;

create table bakery.skill_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  skill_version_id uuid not null,
  path text not null,
  media_type text not null,
  object_key text not null,
  size_bytes integer not null,
  sha256 text not null,
  is_executable boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_files_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint skill_files_version_fk
    foreign key (organization_id, skill_version_id)
    references bakery.skill_versions (organization_id, id) on delete restrict,
  constraint skill_files_organization_id_unique unique (organization_id, id),
  constraint skill_files_path_unique unique (skill_version_id, path)
);
create index skill_files_version_created_idx
  on bakery.skill_files (organization_id, skill_version_id, created_at, id);

revoke all on bakery.skill_sources, bakery.skills,
  bakery.skill_versions, bakery.skill_files from bakery_app;
grant select, insert on bakery.skill_sources, bakery.skills,
  bakery.skill_versions, bakery.skill_files to bakery_app;
grant update (display_name, license, last_checked_at, enabled, updated_at, version)
  on bakery.skill_sources to bakery_app;
grant update (name, description, active_version_id, enabled, updated_at, version)
  on bakery.skills to bakery_app;
