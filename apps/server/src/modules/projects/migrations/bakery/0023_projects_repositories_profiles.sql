-- GHI-126 Projects owns repositories and immutable repository profiles and
-- gives bakery.tasks its repository and profile pin. Repository identity is the
-- unverified provider pair; integration_connection_id has no referent yet.
do $$
begin
  if exists (select 1 from bakery.tasks where repository_id is not null) then
    raise exception using
      errcode = '23514',
      message = 'PROJECTS_MIGRATION_TASKS_WITH_REPOSITORY_ID_PRESENT';
  end if;
end $$;

create table bakery.repositories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  integration_connection_id uuid not null,
  provider_repo_id text not null check (btrim(provider_repo_id) <> ''),
  owner text not null check (owner ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  default_branch text not null check (btrim(default_branch) <> ''),
  active_profile_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint repositories_version_positive check (version > 0),
  constraint repositories_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint repositories_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete restrict,
  constraint repositories_organization_id_unique unique (organization_id, id),
  constraint repositories_provider_identity_unique
    unique (integration_connection_id, provider_repo_id)
);
create index repositories_organization_created_idx
  on bakery.repositories (organization_id, created_at desc, id desc);

create table bakery.repository_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid not null,
  revision integer not null check (revision >= 1),
  config jsonb not null,
  budget_caps jsonb,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint repository_profiles_immutable check (version = 1),
  constraint repository_profiles_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint repository_profiles_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete cascade,
  constraint repository_profiles_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint repository_profiles_organization_id_unique unique (organization_id, id),
  constraint repository_profiles_revision_unique unique (repository_id, revision)
);
create index repository_profiles_repository_created_idx
  on bakery.repository_profiles (repository_id, created_at desc, id desc);

alter table bakery.repositories
  add constraint repositories_active_profile_fk
  foreign key (organization_id, active_profile_id)
  references bakery.repository_profiles (organization_id, id) on delete restrict;

alter table bakery.tasks
  add column repository_profile_id uuid,
  add column repository_profile_revision integer,
  add column repository_profile_digest text,
  add constraint tasks_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete restrict,
  add constraint tasks_repository_profile_fk
    foreign key (organization_id, repository_profile_id)
    references bakery.repository_profiles (organization_id, id) on delete restrict,
  add constraint tasks_profile_pin_complete check (
    (repository_profile_id is null) = (repository_profile_revision is null)
    and (repository_profile_id is null) = (repository_profile_digest is null)
  ),
  add constraint tasks_profile_requires_repository check (
    repository_id is not null or repository_profile_id is null
  );

grant select, insert, update on bakery.repositories to bakery_app;
grant select, insert on bakery.repository_profiles to bakery_app;
