-- issue-40: Bakery owns durable workflow admission.
alter table bakery.jobs
  add column max_attempts integer not null default 3;

grant insert (
    organization_id, run_step_id, action, input, status, available_at, priority,
    max_attempts
  )
  on bakery.jobs
  to bakery_app;

alter table bakery.workflow_runs
  add column engine_owner_token text,
  add column engine_owner_generation bigint not null default 0,
  add column engine_owner_lease_expires_at timestamptz;

create index workflow_runs_engine_owner_recovery_idx
  on bakery.workflow_runs (status, engine_owner_lease_expires_at, id);

grant update (
  engine_owner_token, engine_owner_generation, engine_owner_lease_expires_at
)
  on bakery.workflow_runs
  to bakery_app;
