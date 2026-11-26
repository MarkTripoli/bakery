create table bakery.person_request_next_asks (
  organization_id uuid not null,
  run_id uuid not null,
  step_key text not null,
  step_iteration integer not null,
  asked_at timestamptz not null default now(),
  constraint person_request_next_asks_pkey
    primary key (organization_id, run_id, step_key, step_iteration),
  constraint person_request_next_asks_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade
);

grant select, insert on bakery.person_request_next_asks to bakery_app;
