-- Issue #25 slice A: remote maintenance operations journal.
--
-- One durable row per typed Admin maintenance request on one machine
-- (docs/technical-design/21-machines.md, "Remote maintenance and recovery").
-- The verb, phase and result vocabularies, the per-verb component rules and
-- every phase transition live in TypeScript (execution/maintenance.ts); this
-- migration stays structural, with no CHECK constraints, triggers or RLS.
--
-- The partial unique index is the database guard that serializes mutating
-- maintenance per host: at most one nonterminal operation whose verb changes
-- the host (every verb except refresh_inventory and verify). The create path
-- also takes the worker_hosts row lock that the worker claim path takes, so
-- the claim gate closes in the same order.
create table bakery.worker_maintenance_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  verb text not null,
  component_key text,
  target_version text,
  target_digest text,
  requested_by uuid not null,
  expected_inventory_revision integer not null,
  expected_credential_generation integer not null,
  captured_desired_mode text not null,
  phase text not null,
  fence bigint not null default 0,
  deadline_at timestamptz not null,
  expires_at timestamptz not null,
  idempotency_key text not null,
  request_digest text not null,
  result jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_maintenance_operations_organization_id_unique
    unique (organization_id, id),
  constraint worker_maintenance_operations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_maintenance_operations_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_maintenance_operations_requested_by_fk
    foreign key (requested_by)
    references bakery.principals (id) on delete restrict,
  constraint worker_maintenance_operations_idempotency_unique
    unique (organization_id, worker_host_id, idempotency_key)
);

create unique index worker_maintenance_operations_one_mutating_idx
  on bakery.worker_maintenance_operations (worker_host_id)
  where verb not in ('refresh_inventory', 'verify')
    and phase not in ('succeeded', 'failed', 'canceled', 'expired');

create index worker_maintenance_operations_list_idx
  on bakery.worker_maintenance_operations (
    organization_id, worker_host_id, created_at desc, id desc
  );

grant select, insert
  on bakery.worker_maintenance_operations
  to bakery_app;
grant update (phase, fence, result, updated_at, version)
  on bakery.worker_maintenance_operations
  to bakery_app;
