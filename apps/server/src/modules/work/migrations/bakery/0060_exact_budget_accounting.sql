create table bakery.budget_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  scope text not null,
  run_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  limit_usd numeric(14,6) not null,
  reserved_usd numeric(14,6) not null default 0,
  settled_usd numeric(14,6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint budget_accounts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint budget_accounts_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint budget_accounts_identity_unique
    unique nulls not distinct (scope, organization_id, run_id, period_start),
  constraint budget_accounts_organization_id_unique
    unique (organization_id, id)
);

create table bakery.budget_action_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  action text not null,
  action_version text not null,
  agent_version_id uuid not null,
  provider text not null,
  billing_account_id text not null,
  model text not null,
  billing_route text not null,
  pricing_metadata_snapshot text not null,
  reserved_usd numeric(14,6) not null,
  content_digest text not null,
  dedupe_key text not null,
  status text not null default 'held',
  installation_reservation_id uuid,
  run_reservation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint budget_action_intents_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint budget_action_intents_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint budget_action_intents_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint budget_action_intents_unique
    unique (organization_id, dedupe_key)
);

create table bakery.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  budget_account_id uuid not null,
  run_step_id uuid,
  dedupe_key text not null,
  reserved_usd numeric(14,6) not null,
  settled_usd numeric(14,6),
  status text not null default 'held',
  expires_at timestamptz not null,
  external_effect_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint budget_reservations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint budget_reservations_account_fk
    foreign key (budget_account_id)
    references bakery.budget_accounts (id) on delete restrict,
  constraint budget_reservations_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint budget_reservations_unique
    unique (budget_account_id, dedupe_key)
);

alter table bakery.budget_action_intents
  add constraint budget_action_intents_installation_reservation_fk
  foreign key (installation_reservation_id)
  references bakery.budget_reservations (id) on delete restrict;
alter table bakery.budget_action_intents
  add constraint budget_action_intents_run_reservation_fk
  foreign key (run_reservation_id)
  references bakery.budget_reservations (id) on delete restrict;

create table bakery.usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  worker_session_id uuid not null,
  worker_session_generation bigint not null,
  fence bigint not null,
  result_event_id uuid not null,
  usage_fact_id text not null,
  canonical_digest text not null,
  provider text not null,
  billing_account_id text not null,
  model text not null,
  billing_type text not null,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric(14,6),
  measurement text not null,
  provider_call_id text not null,
  pricing_metadata_snapshot text not null,
  dedupe_key text not null,
  occurred_at timestamptz not null,
  budget_reservation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint usage_records_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint usage_records_provider_call_unique
    unique (organization_id, provider, billing_account_id, provider_call_id),
  constraint usage_records_fact_unique
    unique (organization_id, usage_fact_id),
  constraint usage_records_dedupe_unique
    unique (organization_id, dedupe_key)
);

create index budget_reservations_run_step_idx
  on bakery.budget_reservations (organization_id, run_step_id, id);
create index budget_reservations_expiry_idx
  on bakery.budget_reservations (expires_at, id)
  where status = 'held';
create index usage_records_run_occurred_idx
  on bakery.usage_records (organization_id, run_id, occurred_at, id);

revoke all on
  bakery.budget_accounts,
  bakery.budget_action_intents,
  bakery.budget_reservations,
  bakery.usage_records
from public, bakery_app;

grant select on
  bakery.budget_accounts,
  bakery.budget_action_intents,
  bakery.budget_reservations,
  bakery.usage_records
to bakery_app;

grant insert (
  id, organization_id, scope, run_id, period_start, period_end,
  limit_usd, reserved_usd, settled_usd, version
) on bakery.budget_accounts to bakery_app;
grant update (reserved_usd, settled_usd, updated_at, version)
  on bakery.budget_accounts to bakery_app;
grant insert (
  id, organization_id, run_id, run_step_id, action, action_version,
  agent_version_id, provider, billing_account_id, model, billing_route,
  pricing_metadata_snapshot, reserved_usd, content_digest, dedupe_key, status
) on bakery.budget_action_intents to bakery_app;
grant update (
  installation_reservation_id, run_reservation_id, status, updated_at, version
) on bakery.budget_action_intents to bakery_app;
grant insert (
  id, organization_id, budget_account_id, run_step_id, dedupe_key,
  reserved_usd, settled_usd, status, expires_at, version
) on bakery.budget_reservations to bakery_app;
grant update (settled_usd, status, external_effect_id, updated_at, version)
  on bakery.budget_reservations to bakery_app;
grant insert (
  id, organization_id, run_id, run_step_id, attempt_id, worker_host_id,
  worker_session_id, worker_session_generation, fence, result_event_id,
  usage_fact_id, canonical_digest, provider, billing_account_id, model,
  billing_type, input_tokens, output_tokens, cost_usd, measurement,
  provider_call_id, pricing_metadata_snapshot, dedupe_key, occurred_at,
  budget_reservation_id
) on bakery.usage_records to bakery_app;
grant update (
  input_tokens, output_tokens, cost_usd, measurement, canonical_digest,
  updated_at, version
) on bakery.usage_records to bakery_app;

grant insert (billing, installation_reservation_id)
  on bakery.jobs
  to bakery_app;
