-- Issue #46 Projects substrate: stable repository identity, immutable observed
-- profile evidence, explicit role bindings, and exact execution pins. Legacy
-- #126 rows remain readable; v2 rows must carry the complete evidence tuple.

alter table bakery.repositories
  add column slug text,
  add constraint repositories_slug_format check (
    slug is null or slug ~ '^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$'
  ),
  add constraint repositories_organization_application_id_unique
    unique (organization_id, application_id, id);

alter table bakery.repository_profiles
  add column application_id uuid;

-- Existing #126 profiles derive their application scope from their repository.
update bakery.repository_profiles as profile
   set application_id = repository.application_id
  from bakery.repositories as repository
 where profile.organization_id = repository.organization_id
   and profile.repository_id = repository.id
   and profile.application_id is null;
-- The completed backfill makes application scope mandatory for all rows.
alter table bakery.repository_profiles
  alter column application_id set not null;

-- Preserve #126 writers that omitted application_id while making new rows
-- satisfy the application-scoped identity foreign keys below.
create function bakery.populate_repository_profile_application_id()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, bakery
as $$
begin
  if new.application_id is null then
    select repository.application_id
      into new.application_id
      from bakery.repositories as repository
     where repository.organization_id = new.organization_id
       and repository.id = new.repository_id;
  end if;
  return new;
end;
$$;
revoke execute on function bakery.populate_repository_profile_application_id()
  from public;
create trigger repository_profiles_application_backfill
  before insert or update of application_id, repository_id
  on bakery.repository_profiles
  for each row
  execute function bakery.populate_repository_profile_application_id();

-- New deferred NO ACTION edges permit tenant-wide cascade while still
-- rejecting direct deletion of referenced rows at commit. Existing #126
-- profile RESTRICT edges remain immediate; the org-delete integration test
-- guards their PostgreSQL cascade trigger ordering.
alter table bakery.repository_profiles
  add constraint repository_profiles_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete no action
    deferrable initially deferred,
  add constraint repository_profiles_application_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete no action deferrable initially deferred,
  add constraint repository_profiles_observation_identity_unique
    unique (
      organization_id, application_id, repository_id, id, revision, digest
    );

create table bakery.repository_profile_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid not null,
  profile_id uuid not null,
  profile_revision integer not null check (profile_revision >= 1),
  profile_digest text not null check (profile_digest ~ '^[a-f0-9]{64}$'),
  observation_digest text not null check (observation_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  source_mapping_revision integer not null check (source_mapping_revision >= 1),
  source_mapping_digest text not null check (source_mapping_digest ~ '^[a-f0-9]{64}$'),
  base_sha text not null check (
    base_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  payload jsonb not null,
  readiness text not null check (readiness in ('eligible', 'blocked')),
  schema_version integer not null default 1 check (schema_version = 1),
  constraint repository_profile_observations_payload_size_check check (
    octet_length(payload::text) <= 65536
  ),
  constraint repository_profile_observations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint repository_profile_observations_profile_identity_fk
    foreign key (
      organization_id, application_id, repository_id, profile_id,
      profile_revision, profile_digest
    ) references bakery.repository_profiles (
      organization_id, application_id, repository_id, id, revision, digest
    ) on delete no action deferrable initially deferred,
  constraint repository_profile_observations_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_profile_observations_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_profile_observations_profile_id_unique
    unique (organization_id, profile_id),
  constraint repository_profile_observations_pin_unique
    unique (
      organization_id, application_id, repository_id, id, profile_id,
      profile_revision, profile_digest, observation_digest, base_sha
    )
);
create index repository_profile_observations_repository_idx
  on bakery.repository_profile_observations (
    organization_id, application_id, repository_id, observed_at desc, id desc
  );

create table bakery.repository_role_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid not null,
  role text not null check (
    role = btrim(role) and role = lower(role) and
    role ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ),
  alias text check (
    alias is null or (
      alias = btrim(alias) and alias = lower(alias) and
      alias ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    )
  ),
  provenance text check (
    provenance is null or (
      provenance = btrim(provenance) and char_length(provenance) between 1 and 200
    )
  ),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint repository_role_bindings_version_positive check (version > 0),
  constraint repository_role_bindings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint repository_role_bindings_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_role_bindings_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_role_bindings_organization_id_unique
    unique (organization_id, id)
);
create index repository_role_bindings_lookup_idx
  on bakery.repository_role_bindings (
    organization_id, application_id, role, alias, repository_id
  )
  where archived_at is null;
grant select, insert, update on bakery.repository_role_bindings to bakery_app;

grant select, insert on bakery.repository_profile_observations to bakery_app;
revoke update, delete on bakery.repository_profile_observations from bakery_app;

alter table bakery.tasks
  add column observation_id uuid,
  add column observation_digest text,
  add column base_sha text,
  add constraint tasks_repository_profile_identity_fk
    foreign key (
      organization_id, application_id, repository_id, repository_profile_id,
      repository_profile_revision, repository_profile_digest
    ) references bakery.repository_profiles (
      organization_id, application_id, repository_id, id, revision, digest
    ) on delete no action deferrable initially deferred not valid,
  add constraint tasks_observation_pin_fk
    foreign key (
      organization_id, application_id, repository_id, observation_id,
      repository_profile_id, repository_profile_revision,
      repository_profile_digest, observation_digest, base_sha
    ) references bakery.repository_profile_observations (
      organization_id, application_id, repository_id, id, profile_id,
      profile_revision, profile_digest, observation_digest, base_sha
    ) on delete no action deferrable initially deferred,
  add constraint tasks_repository_profile_identity_complete check (
    (
      repository_profile_id is null and
      repository_profile_revision is null and
      repository_profile_digest is null
    ) or (
      repository_id is not null and
      repository_profile_id is not null and
      repository_profile_revision is not null and
      repository_profile_digest is not null
    )
  ),
  add constraint tasks_observation_pin_complete check (
    (
      observation_id is null and observation_digest is null and base_sha is null
    ) or (
      application_id is not null and repository_id is not null and
      repository_profile_id is not null and
      repository_profile_revision is not null and
      repository_profile_digest is not null and observation_id is not null and
      observation_digest is not null and base_sha is not null and
      base_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
    )
  );

alter table bakery.workflow_runs
  add column application_id uuid,
  add column repository_id uuid,
  add column repository_profile_revision integer,
  add column repository_profile_digest text,
  add column observation_id uuid,
  add column observation_digest text,
  add column base_sha text;

-- A legacy run carries only task_id and repository_profile_id.  Backfill the
-- application/repository identity from the same-organization task/profile
-- pair, but fail before writing anything when that pair is not exact.
do $$
begin
  if exists (
    select 1
      from bakery.workflow_runs as run
      left join bakery.tasks as task
        on task.organization_id = run.organization_id
       and task.id = run.task_id
      left join bakery.repository_profiles as profile
        on profile.organization_id = run.organization_id
       and profile.id = run.repository_profile_id
     where run.repository_profile_id is not null
       and (
         task.id is null or
         profile.id is null or
         task.repository_profile_id is distinct from run.repository_profile_id or
         task.repository_id is distinct from profile.repository_id or
         task.application_id is distinct from profile.application_id or
         task.repository_profile_revision is distinct from profile.revision or
         task.repository_profile_digest is distinct from profile.digest
       )
  ) then
    raise exception using
      errcode = '23503',
      message =
        'PROJECTS_MIGRATION_WORKFLOW_RUN_REPOSITORY_PROFILE_IDENTITY_MISMATCH';
  end if;
end $$;

update bakery.workflow_runs as run
   set application_id = task.application_id,
       repository_id = task.repository_id,
       repository_profile_revision = profile.revision,
       repository_profile_digest = profile.digest
  from bakery.tasks as task,
       bakery.repository_profiles as profile
 where run.repository_profile_id is not null
   and task.organization_id = run.organization_id
   and task.id = run.task_id
   and profile.organization_id = run.organization_id
   and profile.id = run.repository_profile_id;

alter table bakery.workflow_runs
  add constraint workflow_runs_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id)
    on delete no action deferrable initially deferred,
  add constraint workflow_runs_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
    on delete no action deferrable initially deferred,
  add constraint workflow_runs_repository_profile_identity_fk
    foreign key (
      organization_id, application_id, repository_id, repository_profile_id,
      repository_profile_revision, repository_profile_digest
    ) references bakery.repository_profiles (
      organization_id, application_id, repository_id, id, revision, digest
    ) on delete no action deferrable initially deferred not valid,
  add constraint workflow_runs_observation_pin_fk
    foreign key (
      organization_id, application_id, repository_id, observation_id,
      repository_profile_id, repository_profile_revision,
      repository_profile_digest, observation_digest, base_sha
    ) references bakery.repository_profile_observations (
      organization_id, application_id, repository_id, id, profile_id,
      profile_revision, profile_digest, observation_digest, base_sha
    ) on delete no action deferrable initially deferred;

alter table bakery.workflow_runs
  add constraint workflow_runs_repository_profile_identity_complete check (
    (
      application_id is null and repository_id is null and
      repository_profile_id is null and
      repository_profile_revision is null and repository_profile_digest is null
    ) or (
      application_id is not null and repository_id is not null and
      repository_profile_id is not null and
      repository_profile_revision is not null and
      repository_profile_digest is not null
    )
  ),
  add constraint workflow_runs_observation_pin_complete check (
    (
      observation_id is null and observation_digest is null and base_sha is null
    ) or (
      application_id is not null and repository_id is not null and
      repository_profile_id is not null and
      repository_profile_revision is not null and
      repository_profile_digest is not null and observation_id is not null and
      observation_digest is not null and base_sha is not null and
      base_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
    )
  );

alter table bakery.jobs
  add column application_id uuid,
  add column repository_profile_id uuid,
  add column repository_profile_revision integer,
  add column repository_profile_digest text,
  add column observation_id uuid,
  add column observation_digest text,
  add column base_sha text,
  add constraint jobs_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id)
    on delete no action deferrable initially deferred,
  add constraint jobs_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
    on delete no action deferrable initially deferred,
  add constraint jobs_repository_profile_identity_fk
    foreign key (
      organization_id, application_id, repository_id, repository_profile_id,
      repository_profile_revision, repository_profile_digest
    ) references bakery.repository_profiles (
      organization_id, application_id, repository_id, id, revision, digest
    ) on delete no action deferrable initially deferred not valid,
  add constraint jobs_observation_pin_fk
    foreign key (
      organization_id, application_id, repository_id, observation_id,
      repository_profile_id, repository_profile_revision,
      repository_profile_digest, observation_digest, base_sha
    ) references bakery.repository_profile_observations (
      organization_id, application_id, repository_id, id, profile_id,
      profile_revision, profile_digest, observation_digest, base_sha
    ) on delete no action deferrable initially deferred,
  add constraint jobs_repository_profile_identity_complete check (
    (
      application_id is null and
      repository_profile_id is null and repository_profile_revision is null and
      repository_profile_digest is null
    ) or (
      application_id is not null and repository_id is not null and
      repository_profile_id is not null and
      repository_profile_revision is not null and
      repository_profile_digest is not null
    )
  ),
  add constraint jobs_observation_pin_complete check (
    (
      observation_id is null and observation_digest is null and base_sha is null
    ) or (
      application_id is not null and repository_id is not null and
      repository_profile_id is not null and repository_profile_revision is not null and
      repository_profile_digest is not null and observation_id is not null and
      observation_digest is not null and base_sha is not null and
      base_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
    )
  );
grant insert (
  application_id,
  repository_id,
  repository_profile_id,
  repository_profile_revision,
  repository_profile_digest,
  observation_id,
  observation_digest,
  base_sha
)
  on bakery.jobs
  to bakery_app;

alter table bakery.tasks
  validate constraint tasks_repository_profile_identity_fk;
alter table bakery.workflow_runs
  validate constraint workflow_runs_repository_profile_identity_fk;
alter table bakery.jobs
  validate constraint jobs_repository_profile_identity_fk;

create index tasks_observation_pin_idx
  on bakery.tasks (organization_id, observation_id, repository_id)
  where observation_id is not null;
create index workflow_runs_observation_pin_idx
  on bakery.workflow_runs (organization_id, observation_id, repository_id)
  where observation_id is not null;
create index jobs_observation_pin_idx
  on bakery.jobs (organization_id, observation_id, repository_id)
  where observation_id is not null;
