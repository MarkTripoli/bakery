-- Ad hoc multi-repository coordination (E06 #78).
-- Task repository links, immutable versioned plans and per-lane child
-- bindings. Plan specs are insert-only: bakery_app may update status columns
-- but never the spec, its digest or the budget ceiling. Status vocabularies,
-- alias formats, digests and DAG validity stay TypeScript responsibilities.
-- Aliases and roles live in bakery.repository_role_bindings (migration 0046);
-- plans resolve against its non-archived rows, so there is one source of truth.
-- Application consistency is DB-enforced: every plan, lane, child and link
-- carries application_id in composite foreign keys.
alter table bakery.tasks
  add constraint tasks_organization_application_id_unique
    unique (organization_id, application_id, id);

create table bakery.task_repositories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  task_id uuid not null,
  repository_id uuid not null,
  role text not null,
  required boolean not null default true,
  provenance text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint task_repositories_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint task_repositories_task_fk
    foreign key (organization_id, application_id, task_id)
    references bakery.tasks (organization_id, application_id, id)
    on delete cascade,
  constraint task_repositories_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete cascade,
  constraint task_repositories_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint task_repositories_organization_id_unique
    unique (organization_id, id),
  constraint task_repositories_pair_unique
    unique (organization_id, task_id, repository_id)
);
create index task_repositories_task_idx
  on bakery.task_repositories (organization_id, task_id, created_at, id);

create table bakery.coordination_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  parent_task_id uuid not null,
  revision integer not null,
  spec jsonb not null,
  digest text not null,
  budget_limit_usd numeric(14, 6),
  status text not null default 'planned',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint coordination_plans_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint coordination_plans_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete restrict,
  constraint coordination_plans_parent_fk
    foreign key (organization_id, application_id, parent_task_id)
    references bakery.tasks (organization_id, application_id, id)
    on delete restrict,
  constraint coordination_plans_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint coordination_plans_organization_id_unique
    unique (organization_id, id),
  constraint coordination_plans_application_id_unique
    unique (organization_id, application_id, id),
  constraint coordination_plans_revision_unique
    unique (organization_id, parent_task_id, revision)
);
create index coordination_plans_parent_idx
  on bakery.coordination_plans (
    organization_id, parent_task_id, revision desc
  );

create table bakery.coordination_lanes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  plan_id uuid not null,
  lane_key text not null,
  position integer not null,
  repository_id uuid not null,
  child_task_id uuid,
  reused_from_lane_id uuid,
  prerequisites text[] not null default '{}',
  declared_outputs jsonb not null default '[]'::jsonb,
  lane_digest text not null,
  status text not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint coordination_lanes_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint coordination_lanes_plan_fk
    foreign key (organization_id, application_id, plan_id)
    references bakery.coordination_plans (organization_id, application_id, id)
    on delete cascade,
  constraint coordination_lanes_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete restrict,
  constraint coordination_lanes_child_task_fk
    foreign key (organization_id, application_id, child_task_id)
    references bakery.tasks (organization_id, application_id, id)
    on delete restrict,
  constraint coordination_lanes_reused_from_fk
    foreign key (organization_id, reused_from_lane_id)
    references bakery.coordination_lanes (organization_id, id) on delete restrict,
  constraint coordination_lanes_organization_id_unique
    unique (organization_id, id),
  constraint coordination_lanes_key_unique
    unique (organization_id, plan_id, lane_key),
  constraint coordination_lanes_position_unique
    unique (organization_id, plan_id, position)
);
-- A child task is owned by exactly one originating lane; a later plan revision
-- may reuse it through reused_from_lane_id without owning it again.
create unique index coordination_lanes_child_task_unique
  on bakery.coordination_lanes (organization_id, child_task_id)
  where child_task_id is not null and reused_from_lane_id is null;
create index coordination_lanes_child_task_idx
  on bakery.coordination_lanes (organization_id, child_task_id)
  where child_task_id is not null;

grant select, insert, update on bakery.task_repositories to bakery_app;
grant select, insert on bakery.coordination_plans to bakery_app;
grant update (status, updated_at, version)
  on bakery.coordination_plans
  to bakery_app;
grant select, insert on bakery.coordination_lanes to bakery_app;
-- A lane child is bound once: the TypeScript update only fills a null
-- child_task_id (triggers and CHECKs are banned in new migrations), and the
-- partial unique index below keeps one owning lane per child.
grant update (child_task_id, reused_from_lane_id, status, updated_at, version)
  on bakery.coordination_lanes
  to bakery_app;
