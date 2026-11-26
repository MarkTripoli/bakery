alter table bakery.workflow_definitions
  add column active_version_set_at timestamptz;

update bakery.workflow_definitions
   set active_version_set_at = updated_at
 where active_version_id is not null;

alter table bakery.workflow_start_firings
  add column scheduled_for timestamptz;

create unique index workflow_start_firings_tick_unique
  on bakery.workflow_start_firings (
    organization_id, workflow_id, start_id, scheduled_for
  )
  where scheduled_for is not null;
