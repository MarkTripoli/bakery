create table bakery.tool_call_cost_intents (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  action text not null,
  reserved_usd numeric(14,6) not null,
  content_digest text not null,
  dedupe_key text not null,
  status text not null,
  installation_reservation_id uuid,
  run_reservation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint tool_call_cost_intents_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint tool_call_cost_intents_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint tool_call_cost_intents_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint tool_call_cost_intents_dedupe_unique
    unique (organization_id, dedupe_key)
);

alter table bakery.tool_call_cost_intents
  add constraint tool_call_cost_intents_installation_reservation_fk
  foreign key (installation_reservation_id)
  references bakery.budget_reservations (id) on delete restrict;

alter table bakery.tool_call_cost_intents
  add constraint tool_call_cost_intents_run_reservation_fk
  foreign key (run_reservation_id)
  references bakery.budget_reservations (id) on delete restrict;

create index tool_call_cost_intents_step_idx
  on bakery.tool_call_cost_intents (organization_id, run_step_id, id);

grant select, insert on bakery.tool_call_cost_intents to bakery_app;
grant update (
  installation_reservation_id, run_reservation_id, status, updated_at, version
) on bakery.tool_call_cost_intents to bakery_app;
