create table bakery.provider_pricing_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  billing_account_id text not null,
  model text not null,
  billing_type text not null,
  pricing_metadata_snapshot text not null,
  source_reference text not null,
  input_micro_usd_per_token numeric(20,12),
  output_micro_usd_per_token numeric(20,12),
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint provider_pricing_snapshot_identity_unique
    unique (
      provider, billing_account_id, model, billing_type,
      pricing_metadata_snapshot
    )
);

create table bakery.provider_call_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  installation_reservation_id uuid not null,
  provider text not null,
  billing_account_id text not null,
  model text not null,
  billing_type text not null,
  pricing_snapshot_id uuid not null,
  pricing_metadata_snapshot text not null,
  max_tokens bigint not null,
  max_usd_reservation numeric(14,6) not null,
  provider_call_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint provider_call_intent_reservation_unique
    unique (installation_reservation_id),
  constraint provider_call_intent_provider_call_unique
    unique (organization_id, provider, billing_account_id, provider_call_id)
);

alter table bakery.budget_action_intents
  add column provider_call_intent_id uuid;

alter table bakery.provider_call_intents
  add constraint provider_call_intent_organization_fk
  foreign key (organization_id)
  references bakery.organizations (id) on delete cascade;

alter table bakery.provider_call_intents
  add constraint provider_call_intent_pricing_snapshot_fk
  foreign key (pricing_snapshot_id)
  references bakery.provider_pricing_snapshots (id) on delete restrict;

alter table bakery.provider_call_intents
  add constraint provider_call_intent_run_fk
  foreign key (organization_id, run_id)
  references bakery.workflow_runs (organization_id, id) on delete cascade;

alter table bakery.provider_call_intents
  add constraint provider_call_intent_step_fk
  foreign key (organization_id, run_step_id)
  references bakery.run_steps (organization_id, id) on delete cascade;

alter table bakery.provider_call_intents
  add constraint provider_call_intent_reservation_fk
  foreign key (installation_reservation_id)
  references bakery.budget_reservations (id) on delete restrict;

alter table bakery.budget_action_intents
  add constraint budget_action_intents_provider_call_intent_fk
  foreign key (provider_call_intent_id)
  references bakery.provider_call_intents (id) on delete restrict;

create table bakery.provider_authoritative_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider_call_intent_id uuid not null,
  provider_call_id text not null,
  usage_fact_id text not null,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric(14,6),
  measurement text not null,
  occurred_at timestamptz not null,
  receipt_digest text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint provider_receipt_intent_unique
    unique (provider_call_intent_id),
  constraint provider_receipt_identity_unique
    unique (organization_id, provider_call_id)
);

alter table bakery.provider_authoritative_receipts
  add constraint provider_receipt_organization_fk
  foreign key (organization_id)
  references bakery.organizations (id) on delete cascade;

alter table bakery.provider_authoritative_receipts
  add constraint provider_receipt_intent_fk
  foreign key (provider_call_intent_id)
  references bakery.provider_call_intents (id) on delete restrict;

create index provider_pricing_snapshot_active_idx
  on bakery.provider_pricing_snapshots (
    provider, billing_account_id, model, billing_type,
    pricing_metadata_snapshot, effective_from
  )
  where status = 'active';
create index provider_call_intents_reconcile_idx
  on bakery.provider_call_intents (status, updated_at, id);

revoke all on
  bakery.provider_pricing_snapshots,
  bakery.provider_call_intents,
  bakery.provider_authoritative_receipts
from public, bakery_app;

grant select on
  bakery.provider_pricing_snapshots,
  bakery.provider_call_intents,
  bakery.provider_authoritative_receipts
to bakery_app;

grant insert (
  id, organization_id, run_id, run_step_id, installation_reservation_id,
  provider, billing_account_id, model, billing_type, pricing_snapshot_id,
  pricing_metadata_snapshot, max_tokens, max_usd_reservation, status, version
) on bakery.provider_call_intents to bakery_app;

grant update (provider_call_id, status, updated_at, version)
  on bakery.provider_call_intents to bakery_app;

grant insert (provider_call_intent_id)
  on bakery.budget_action_intents to bakery_app;
grant update (provider_call_intent_id)
  on bakery.budget_action_intents to bakery_app;
