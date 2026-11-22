-- A workflow's starts become runs (one engine O8, #406 slice 3).
--
-- Two things were missing. A start runs as a person, and nothing recorded which
-- one: "Use this version" set the pointer and forgot who set it, so a firing
-- had no principal to act as. The definition now keeps the principal who last
-- used a version. It is nullable because every pointer set before this
-- migration has no recorded actor; a start on such a definition is refused,
-- visibly, until a person uses the version again.
--
-- And a start had nowhere to record that it fired. One row per (version, start,
-- event) is the dedupe key, so a redelivery or a replayed route changes
-- nothing. The row keeps the outcome: it is queued, then started with its run,
-- or failed with a stable code (for example the actor lost access), or skipped
-- by the hourly loop guard. Status is checked in TypeScript, not by the
-- database.
alter table bakery.workflow_definitions
  add column active_version_set_by uuid
    references bakery.principals (id) on delete restrict;

create table bakery.workflow_start_firings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  workflow_version_id uuid not null,
  start_id text not null,
  trigger_event_id uuid,
  application_id uuid not null,
  repository_id uuid not null,
  -- The principal the start runs as: who used the version. Null when none was
  -- recorded, which fails the firing as actor_unavailable.
  actor_id uuid,
  status text not null,
  failure_code text,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint workflow_start_firings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_start_firings_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint workflow_start_firings_version_fk
    foreign key (organization_id, workflow_version_id)
    references bakery.workflow_versions (organization_id, id)
    on delete restrict,
  constraint workflow_start_firings_trigger_event_fk
    foreign key (trigger_event_id)
    references bakery.inbound_events (id) on delete set null,
  constraint workflow_start_firings_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete restrict,
  constraint workflow_start_firings_actor_fk
    foreign key (actor_id)
    references bakery.principals (id) on delete restrict,
  constraint workflow_start_firings_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete restrict,
  constraint workflow_start_firings_organization_id_unique
    unique (organization_id, id),
  -- One firing per start per event: a redelivery is a no-op.
  constraint workflow_start_firings_event_unique
    unique (workflow_version_id, start_id, trigger_event_id)
);

-- A workflow's firings, newest first, for the loop guard and a future list.
create index workflow_start_firings_workflow_idx
  on bakery.workflow_start_firings (
    organization_id, workflow_id, created_at desc, id desc
  );

-- Insert-only except the outcome columns, as automation firings are.
grant select, insert
  on bakery.workflow_start_firings
  to bakery_app;
grant update (status, failure_code, run_id, updated_at, version)
  on bakery.workflow_start_firings
  to bakery_app;
