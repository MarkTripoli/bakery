-- Issue #59 [B08.05]: machine inventory readiness and provider bindings.
--
-- Reconciles the machines chapter (docs/technical-design/21-machines.md):
-- enrollment lineage (replacement/re-pair), host inventory components and
-- readiness checks, organization-owned provider accounts with account-level
-- quota identity, per-machine provider bindings and auth attempts, and
-- organization-constrained worker/enrollment domain-event scopes.
--
-- Enrollment state stays derived (pending/consumed/canceled/expired) from
-- consumed_at, canceled_at and expires_at; the locked register/cancel
-- transaction decides the winner. No response ever stores or returns a raw
-- provider credential; challenges are encrypted with the shared secret key.
--
-- Column vocabularies and bounds (enrollment mutation verbs, component kinds
-- and versions, check statuses and reasons, provider/account text fields,
-- auth attempt flows and states, positive generations) are enforced in the
-- transaction code and the generated transport schemas, not by CHECK
-- constraints: the PostgreSQL responsibility boundary keeps migrations
-- structural.
alter table bakery.worker_enrollments
  add column replacement_of_id uuid,
  add column target_worker_host_id uuid,
  add column expected_credential_generation integer;

-- Re-pair and replacement lineage must stay inside the owning organization.
alter table bakery.worker_enrollments
  add constraint worker_enrollments_replacement_fk
    foreign key (organization_id, replacement_of_id)
    references bakery.worker_enrollments (organization_id, id)
    on delete restrict,
  add constraint worker_enrollments_target_host_fk
    foreign key (organization_id, target_worker_host_id)
    references bakery.worker_hosts (organization_id, id)
    on delete restrict;

create index worker_enrollments_pending_replacement_idx
  on bakery.worker_enrollments (replacement_of_id)
  where replacement_of_id is not null
    and consumed_at is null
    and canceled_at is null;

-- At most one still-pending re-pair enrollment per target host.
create unique index worker_enrollments_pending_repair_idx
  on bakery.worker_enrollments (target_worker_host_id)
  where target_worker_host_id is not null
    and consumed_at is null
    and canceled_at is null;

-- Idempotent Admin enrollment mutations (cancel/replace/re-pair). One replay
-- row per (enrollment, verb, idempotency key); expired rows are reclaimable.
create table bakery.worker_enrollment_mutations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  enrollment_id uuid not null,
  verb text not null,
  idempotency_key text not null,
  request_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_enrollment_mutations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_enrollment_mutations_enrollment_fk
    foreign key (organization_id, enrollment_id)
    references bakery.worker_enrollments (organization_id, id) on delete cascade,
  constraint worker_enrollment_mutations_unique
    unique (enrollment_id, verb, idempotency_key)
);
create index worker_enrollment_mutations_expiry_idx
  on bakery.worker_enrollment_mutations (expires_at);

-- Bounded inventory of installed/available components, one row per
-- (host, component key). Paths stay host-local; no secrets.
create table bakery.worker_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  component_key text not null,
  kind text not null,
  actual_version text not null,
  actual_digest text,
  install_owner text not null,
  adapter_version text not null,
  available_version text,
  channel text,
  observed_at timestamptz not null,
  capabilities jsonb not null default '[]'::jsonb,
  maintenance_support jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_components_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_components_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_components_component_unique unique (worker_host_id, component_key)
);

-- One latest check result per (host, check id, optional component key).
-- Results carry the host generation and inventory revision they were observed
-- at; stale or superseded results can neither restore readiness nor advertise
-- usable capacity. Safe reason text is bounded and Problem-referenced.
create table bakery.worker_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  component_key text,
  check_id text not null,
  check_version text not null,
  host_generation integer not null,
  inventory_revision integer not null,
  status text not null,
  reason text,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_checks_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_checks_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_checks_component_fk
    foreign key (worker_host_id, component_key)
    references bakery.worker_components (worker_host_id, component_key)
    on delete set null (component_key)
    deferrable initially deferred
);
create unique index worker_checks_latest_idx
  on bakery.worker_checks (worker_host_id, check_id, coalesce(component_key, ''));
create index worker_checks_capability_idx
  on bakery.worker_checks (worker_host_id, check_id, status);

-- Idempotent inventory reports: one replay row per (host, report id).
create table bakery.worker_inventory_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  report_id uuid not null,
  request_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_inventory_replays_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_inventory_replays_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_inventory_replays_unique unique (worker_host_id, report_id)
);
create index worker_inventory_replays_expiry_idx
  on bakery.worker_inventory_replays (expires_at);

-- Organization-owned provider account identity. Account health and quota are
-- keyed to the verified billing identity: many machines sharing an account
-- share this row and its single observation. Unverified identities are never
-- merged; a unique (organization, provider, identity hash) key keeps each
-- organization's ledger private.
create table bakery.model_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider text not null,
  billing_identity text not null,
  identity_hash text not null,
  billing_route text not null,
  display_identity text not null,
  verified_at timestamptz,
  auth_state text not null default 'unknown',
  last_checked_at timestamptz,
  quota_source text,
  quota_remaining text,
  quota_observed_at timestamptz,
  safe_problem text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint model_provider_accounts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint model_provider_accounts_identity_unique
    unique (organization_id, provider, identity_hash),
  constraint model_provider_accounts_organization_id_unique
    unique (organization_id, id)
);

-- Explicit authorized account placement on one machine/harness component.
create table bakery.worker_provider_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  component_key text not null,
  provider text not null,
  billing_route text not null,
  enabled boolean not null default true,
  auth_mode text not null,
  credential_location text not null,
  secret_id uuid,
  model_provider_account_id uuid,
  auth_generation integer not null default 1,
  last_checked_at timestamptz,
  safe_problem text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_provider_bindings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_provider_bindings_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_provider_bindings_account_fk
    foreign key (organization_id, model_provider_account_id)
    references bakery.model_provider_accounts (organization_id, id) on delete restrict,
  constraint worker_provider_bindings_unique
    unique (worker_host_id, component_key, provider),
  constraint worker_provider_bindings_organization_id_unique
    unique (organization_id, id)
);

-- Scoped expiring remote-login attempts. One active attempt per binding;
-- protected_state holds the encrypted temporary protocol state and is never
-- returned raw. A winning completion is bound to the attempt's own binding
-- and the host generation it was issued for.
create table bakery.worker_provider_auth_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_provider_binding_id uuid not null,
  worker_host_id uuid not null,
  host_generation integer not null,
  requesting_principal_id uuid not null,
  flow text not null,
  state text not null,
  protected_state text,
  result jsonb,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_provider_auth_attempts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_provider_auth_attempts_binding_fk
    foreign key (organization_id, worker_provider_binding_id)
    references bakery.worker_provider_bindings (organization_id, id) on delete cascade,
  constraint worker_provider_auth_attempts_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_provider_auth_attempts_requester_fk
    foreign key (requesting_principal_id)
    references bakery.principals (id) on delete restrict,
  constraint worker_provider_auth_attempts_organization_id_unique
    unique (organization_id, id)
);
create unique index worker_provider_auth_attempts_active_idx
  on bakery.worker_provider_auth_attempts (worker_provider_binding_id)
  where state in ('pending', 'challenge_issued');

-- Idempotent provider-auth reports: one replay row per (attempt, report id).
create table bakery.worker_provider_auth_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_provider_auth_attempt_id uuid not null,
  report_id uuid not null,
  request_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_provider_auth_reports_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_provider_auth_reports_attempt_fk
    foreign key (organization_id, worker_provider_auth_attempt_id)
    references bakery.worker_provider_auth_attempts (organization_id, id)
    on delete cascade,
  constraint worker_provider_auth_reports_unique
    unique (worker_provider_auth_attempt_id, report_id)
);
create index worker_provider_auth_reports_expiry_idx
  on bakery.worker_provider_auth_reports (expires_at);

-- Organization-constrained worker and enrollment domain-event scopes so
-- subscriptions and snapshots authorize before any task exists.
alter table bakery.domain_events
  add column worker_host_id uuid,
  add column worker_enrollment_id uuid;

alter table bakery.domain_events
  add constraint domain_events_worker_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  add constraint domain_events_worker_enrollment_fk
    foreign key (organization_id, worker_enrollment_id)
    references bakery.worker_enrollments (organization_id, id) on delete cascade;

create index domain_events_worker_host_idx
  on bakery.domain_events (organization_id, worker_host_id, organization_sequence);
create index domain_events_worker_enrollment_idx
  on bakery.domain_events (organization_id, worker_enrollment_id, organization_sequence);

-- bakery_app column/table grants. Every access path above binds organization
-- and host identity explicitly; no row-level security is used.
grant insert (
    organization_id, principal_id, name, os, architecture,
    allowed_capabilities, slots, token_hash, expires_at,
    replacement_of_id, target_worker_host_id, expected_credential_generation
  )
  on bakery.worker_enrollments
  to bakery_app;
grant update (
    consumed_at, worker_host_id, canceled_at, updated_at, version,
    replacement_of_id, target_worker_host_id, expected_credential_generation
  )
  on bakery.worker_enrollments
  to bakery_app;

grant select, insert, delete
  on bakery.worker_enrollment_mutations
  to bakery_app;

grant insert (
    organization_id, worker_host_id, component_key, kind, actual_version,
    actual_digest, install_owner, adapter_version, available_version,
    channel, observed_at, capabilities, maintenance_support
  )
  on bakery.worker_components
  to bakery_app;
grant select, delete
  on bakery.worker_components
  to bakery_app;
grant update (
    actual_version, actual_digest, install_owner, adapter_version,
    available_version, channel, observed_at, capabilities,
    maintenance_support, updated_at, version
  )
  on bakery.worker_components
  to bakery_app;

grant select, insert, update, delete
  on bakery.worker_checks
  to bakery_app;
grant update (
    component_key, check_version, status, reason, observed_at,
    received_at, expires_at, updated_at, version
  )
  on bakery.worker_checks
  to bakery_app;

grant select, insert, delete
  on bakery.worker_inventory_replays
  to bakery_app;

grant select, insert, delete
  on bakery.model_provider_accounts
  to bakery_app;
grant update (
    verified_at, auth_state, last_checked_at, quota_source,
    quota_remaining, quota_observed_at, safe_problem, updated_at, version
  )
  on bakery.model_provider_accounts
  to bakery_app;

grant select, insert, delete
  on bakery.worker_provider_bindings
  to bakery_app;
grant update (
    enabled, auth_mode, credential_location, secret_id,
    model_provider_account_id, auth_generation, last_checked_at,
    safe_problem, updated_at, version
  )
  on bakery.worker_provider_bindings
  to bakery_app;

grant select, insert, delete
  on bakery.worker_provider_auth_attempts
  to bakery_app;
grant update (
    state, protected_state, result, expires_at, completed_at,
    updated_at, version
  )
  on bakery.worker_provider_auth_attempts
  to bakery_app;

grant select, insert, delete
  on bakery.worker_provider_auth_reports
  to bakery_app;

grant insert (worker_host_id, worker_enrollment_id)
  on bakery.domain_events
  to bakery_app;

grant update (
    desired_mode, inventory_revision, readiness_revision, status,
    credential_hash, credential_generation, updated_at, version
  )
  on bakery.worker_hosts
  to bakery_app;
