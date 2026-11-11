-- Task admission storage owns relational structure, foreign keys, indexes,
-- grants, and immutable snapshots. Lifecycle validation, status vocabularies,
-- DAG cycle checks, ranges, and input formats remain TypeScript responsibilities.
create table bakery.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  condition text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint task_dependencies_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint task_dependencies_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint task_dependencies_depends_on_task_fk
    foreign key (organization_id, depends_on_task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint task_dependencies_organization_id_unique
    unique (organization_id, id),
  constraint task_dependencies_pair_unique
    unique (organization_id, task_id, depends_on_task_id)
);

create index task_dependencies_task_created_idx
  on bakery.task_dependencies (organization_id, task_id, created_at desc, id desc);
create index task_dependencies_depends_on_task_idx
  on bakery.task_dependencies (organization_id, depends_on_task_id);

create table bakery.workflow_definitions (
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
  constraint workflow_definitions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_definitions_organization_id_unique
    unique (organization_id, id),
  constraint workflow_definitions_slug_unique
    unique (organization_id, slug)
);

create index workflow_definitions_organization_created_idx
  on bakery.workflow_definitions (organization_id, created_at desc, id desc);

create table bakery.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  revision integer not null,
  source_yaml text not null,
  normalized_spec jsonb not null,
  digest text not null,
  status text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint workflow_versions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_versions_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id) on delete cascade,
  constraint workflow_versions_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint workflow_versions_organization_id_unique
    unique (organization_id, id),
  constraint workflow_versions_revision_unique
    unique (workflow_id, revision)
);

create index workflow_versions_workflow_created_idx
  on bakery.workflow_versions (organization_id, workflow_id, created_at desc, id desc);
create index workflow_versions_published_idx
  on bakery.workflow_versions (organization_id, status, workflow_id, revision desc);

alter table bakery.workflow_definitions
  add constraint workflow_definitions_active_version_fk
  foreign key (organization_id, active_version_id)
  references bakery.workflow_versions (organization_id, id) on delete set null (active_version_id);

create table bakery.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  workflow_version_id uuid not null,
  repository_profile_id uuid,
  requested_by uuid not null,
  inngest_run_id text,
  status text not null default 'queued',
  snapshot jsonb not null,
  budget_limit_usd numeric(14, 6) not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint workflow_runs_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_runs_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete restrict,
  constraint workflow_runs_workflow_version_fk
    foreign key (organization_id, workflow_version_id)
    references bakery.workflow_versions (organization_id, id) on delete restrict,
  constraint workflow_runs_repository_profile_fk
    foreign key (organization_id, repository_profile_id)
    references bakery.repository_profiles (organization_id, id) on delete restrict,
  constraint workflow_runs_requested_by_fk
    foreign key (requested_by)
    references bakery.principals (id) on delete restrict,
  constraint workflow_runs_organization_id_unique
    unique (organization_id, id)
);

create index workflow_runs_task_created_idx
  on bakery.workflow_runs (organization_id, task_id, created_at desc, id desc);
create index workflow_runs_status_created_idx
  on bakery.workflow_runs (organization_id, status, created_at desc, id desc);

alter table bakery.tasks
  add constraint tasks_current_run_fk
  foreign key (organization_id, current_run_id)
  references bakery.workflow_runs (organization_id, id) on delete set null (current_run_id);

create table bakery.run_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  step_key text not null,
  position integer not null,
  iteration integer not null default 0,
  status text not null default 'pending',
  input jsonb not null,
  output jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint run_steps_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_steps_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_steps_organization_id_unique
    unique (organization_id, id),
  constraint run_steps_key_unique
    unique (run_id, step_key, iteration)
);

create index run_steps_run_position_idx
  on bakery.run_steps (organization_id, run_id, position asc, iteration asc, id asc);

-- Published workflow versions are immutable after insert. Runs and steps
-- retain only lifecycle DML required by admission and execution.
grant select, insert, delete
  on bakery.task_dependencies
  to bakery_app;
grant select, insert, update
  on bakery.workflow_definitions
  to bakery_app;
grant select, insert
  on bakery.workflow_versions
  to bakery_app;
grant select, insert
  on bakery.workflow_runs,
    bakery.run_steps
  to bakery_app;
grant update (
  status, inngest_run_id, started_at, finished_at, updated_at, version
)
  on bakery.workflow_runs
  to bakery_app;
grant update (
  status, output, error, started_at, finished_at, updated_at, version
)
  on bakery.run_steps
  to bakery_app;
