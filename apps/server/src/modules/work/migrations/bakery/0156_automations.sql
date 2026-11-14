-- Automations (issue #36): a named definition, its immutable versions and the
-- deduplicated occurrences ("firings") the one `automation.tick` clock admits.
-- * automation_definitions: the stable identity, the active version and the
--   scheduler's cursor (next_fire_at, null while disabled or without a
--   schedule).
-- * automation_versions: a pinned trigger (a cron expression with an IANA
--   timezone, or a registered event predicate; never an executable
--   expression), the workflow version it starts, its inputs and its misfire and
--   overlap policies. Insert-only.
-- * automation_firings: one row per occurrence, keyed by the canonical UTC
--   instant so a repeated tick is a no-op, and by the verified inbound event
--   for an event trigger. skipped_count records the occurrences a coalesced
--   catch-up did not queue; pending marks a queued firing whose run has not
--   started.
-- Structure only: the trigger and policy vocabularies, the active-version rule,
-- the schedule cursor and the firing outcomes are enforced in TypeScript.
create table bakery.automation_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  slug text not null,
  name text not null,
  description text,
  active_version_id uuid,
  enabled boolean not null default true,
  next_fire_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint automation_definitions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint automation_definitions_organization_id_unique
    unique (organization_id, id),
  constraint automation_definitions_slug_unique
    unique (organization_id, slug)
);

create index automation_definitions_organization_created_idx
  on bakery.automation_definitions (organization_id, created_at desc, id desc);
-- The tick's claim: enabled definitions whose next occurrence is due.
create index automation_definitions_due_idx
  on bakery.automation_definitions (next_fire_at, id)
  where enabled and next_fire_at is not null;

create table bakery.automation_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  automation_id uuid not null,
  revision integer not null,
  trigger jsonb not null,
  workflow_version_id uuid not null,
  actor_id uuid not null,
  inputs jsonb not null,
  misfire_policy text not null,
  overlap_policy text not null,
  digest text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint automation_versions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint automation_versions_automation_fk
    foreign key (organization_id, automation_id)
    references bakery.automation_definitions (organization_id, id)
    on delete cascade,
  constraint automation_versions_workflow_version_fk
    foreign key (organization_id, workflow_version_id)
    references bakery.workflow_versions (organization_id, id)
    on delete restrict,
  constraint automation_versions_actor_fk
    foreign key (actor_id)
    references bakery.principals (id) on delete restrict,
  constraint automation_versions_organization_id_unique
    unique (organization_id, id),
  constraint automation_versions_revision_unique
    unique (automation_id, revision)
);

create index automation_versions_automation_created_idx
  on bakery.automation_versions (
    organization_id, automation_id, revision desc, id desc
  );

alter table bakery.automation_definitions
  add constraint automation_definitions_active_version_fk
  foreign key (organization_id, active_version_id)
  references bakery.automation_versions (organization_id, id)
  on delete set null (active_version_id);

create table bakery.automation_firings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  automation_version_id uuid not null,
  scheduled_at timestamptz not null,
  trigger_event_id uuid,
  status text not null,
  pending boolean not null default false,
  skipped_count integer not null default 0,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint automation_firings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint automation_firings_version_fk
    foreign key (organization_id, automation_version_id)
    references bakery.automation_versions (organization_id, id)
    on delete cascade,
  constraint automation_firings_trigger_event_fk
    foreign key (trigger_event_id)
    references bakery.inbound_events (id) on delete set null,
  constraint automation_firings_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete restrict,
  constraint automation_firings_organization_id_unique
    unique (organization_id, id),
  -- The canonical UTC instant is the dedupe key: a repeated tick is a no-op.
  constraint automation_firings_scheduled_unique
    unique (automation_version_id, scheduled_at),
  constraint automation_firings_trigger_event_unique
    unique (automation_version_id, trigger_event_id)
);

-- An automation's firings, newest occurrence first, for the list.
create index automation_firings_version_page_idx
  on bakery.automation_firings (
    organization_id, automation_version_id, scheduled_at desc, id desc
  );

-- Versions are insert-only; a definition changes name, enabled, active version
-- and cursor; a firing's outcome columns change as it is queued and started.
grant select, insert, update
  on bakery.automation_definitions
  to bakery_app;
grant select, insert
  on bakery.automation_versions
  to bakery_app;
grant select, insert
  on bakery.automation_firings
  to bakery_app;
grant update (
  status, pending, skipped_count, run_id, updated_at, version
)
  on bakery.automation_firings
  to bakery_app;
