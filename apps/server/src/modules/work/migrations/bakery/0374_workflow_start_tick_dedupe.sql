alter table bakery.workflow_definitions
  add column active_version_set_at timestamptz;

alter table bakery.workflow_start_firings
  add column scheduled_for timestamptz;

create unique index workflow_start_firings_tick_unique
  on bakery.workflow_start_firings (
    organization_id, workflow_id, start_id, scheduled_for
  )
  where scheduled_for is not null;
