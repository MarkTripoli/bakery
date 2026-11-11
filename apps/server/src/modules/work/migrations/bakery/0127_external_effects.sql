-- External effect ledger: immutable intent, delivery and reconciliation record
-- for every external side effect. One executor claims a dispatch generation
-- (prepared -> submitted, committed before provider I/O); unknown outcomes are
-- reconciled read-only under the same effect id.
--
-- Rules for this table:
-- * The status state machine (prepared, submitted, confirmed, uncertain,
--   failed), size bounds and the integration-effect non-null invariant
--   (connection, resource, action_version, external identities, authorization
--   revision, install, grant, manifest digest) are enforced in TypeScript by
--   Zod-parsed rows and compare-and-swap updates. The PostgreSQL boundary rails
--   forbid CHECK constraints, triggers and functions in migrations.
-- * Identity columns are immutable for bakery_app: only the outcome columns are
--   in the column-scoped UPDATE grant. There is no DELETE grant.
-- * integration_connection_id, integration_resource_id, mcp_connection_id,
--   automation_definition_id, subscription_id, integration_install_id and
--   integration_grant_id have no foreign key yet: their parent tables
--   (integration_connections, integration_resources, mcp_connections,
--   automation_definitions, integration_event_subscriptions, integration
--   installs and grants) do not exist. A later migration adds the foreign keys
--   once those tables land.
-- * credential_version_id is not written until credential provenance lands
--   (#60). The reference may name a same-organization secret version or an
--   installation-owned version, so it is a single-column foreign key.
-- * Every parent reference uses ON DELETE NO ACTION except the organization
--   (cascade). NO ACTION is checked at the end of the statement, so deleting an
--   organization removes steps, reservations and effects together, while a
--   direct delete of a run step, reservation, question, principal, secret
--   version, profile or artifact version that an effect still references is
--   refused. Ledger rows never disappear independently.
-- * budget_reservations.external_effect_id (0060) had no foreign key and no
--   code writes it today. It now references this table, closing the cycle with
--   budget_reservation_id. Both directions are NO ACTION.
alter table bakery.budget_reservations
  add constraint budget_reservations_organization_id_unique
  unique (organization_id, id);

create table bakery.external_effects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_step_id uuid,
  automation_definition_id uuid,
  subscription_id uuid,
  operation text not null,
  action_version integer,
  target text not null,
  integration_connection_id uuid,
  integration_resource_id uuid,
  mcp_connection_id uuid,
  integration_install_id text,
  integration_grant_id text,
  adapter_manifest_digest text,
  repository_profile_id uuid,
  requesting_principal_id uuid not null,
  actor_ref text not null,
  idempotency_key text not null,
  request_digest text not null,
  safe_arguments jsonb,
  argument_artifact_version_id uuid,
  external_account_id text,
  external_resource_id text,
  adapter_version text not null,
  credential_version_id uuid,
  authorization_revision integer,
  budget_reservation_id uuid,
  approval_id uuid,
  approval_stage text,
  approval_policy_digest text,
  status text not null default 'prepared',
  remote_id text,
  safe_result jsonb,
  failure_code text,
  next_retry_at timestamptz,
  dispatch_generation integer not null default 0,
  lease_expires_at timestamptz,
  last_checked_at timestamptz,
  reconciliation_attempts integer not null default 0,
  reconciliation_evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint external_effects_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint external_effects_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete no action,
  constraint external_effects_repository_profile_fk
    foreign key (organization_id, repository_profile_id)
    references bakery.repository_profiles (organization_id, id) on delete no action,
  constraint external_effects_argument_artifact_version_fk
    foreign key (organization_id, argument_artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete no action,
  constraint external_effects_requesting_principal_fk
    foreign key (requesting_principal_id)
    references bakery.principals (id) on delete no action,
  constraint external_effects_credential_version_fk
    foreign key (credential_version_id)
    references bakery.secret_versions (id) on delete no action,
  constraint external_effects_budget_reservation_fk
    foreign key (organization_id, budget_reservation_id)
    references bakery.budget_reservations (organization_id, id) on delete no action,
  constraint external_effects_approval_fk
    foreign key (organization_id, approval_id)
    references bakery.questions (organization_id, id) on delete no action,
  constraint external_effects_organization_id_unique
    unique (organization_id, id),
  constraint external_effects_idempotency_unique
    unique (organization_id, operation, target, idempotency_key)
);

alter table bakery.budget_reservations
  add constraint budget_reservations_external_effect_fk
  foreign key (organization_id, external_effect_id)
  references bakery.external_effects (organization_id, id) on delete no action;

create index external_effects_prepared_retry_idx
  on bakery.external_effects (next_retry_at, id)
  where status = 'prepared';
create index external_effects_lease_idx
  on bakery.external_effects (lease_expires_at, id)
  where status in ('submitted', 'uncertain');
create index external_effects_live_reservation_idx
  on bakery.external_effects (organization_id, budget_reservation_id)
  where status in ('prepared', 'submitted', 'uncertain');
create index external_effects_run_step_idx
  on bakery.external_effects (organization_id, run_step_id, id);
-- Plain btree indexes behind every referencing foreign key, so NO ACTION checks
-- (an organization cascade, a direct parent delete, the retention lookup) never
-- scan the whole table. The partial live-reservation index above serves the
-- hold queries; this one serves the foreign key for every status.
create index external_effects_budget_reservation_idx
  on bakery.external_effects (organization_id, budget_reservation_id);
create index external_effects_approval_idx
  on bakery.external_effects (organization_id, approval_id);
create index external_effects_requesting_principal_idx
  on bakery.external_effects (requesting_principal_id);
create index external_effects_argument_artifact_version_idx
  on bakery.external_effects (organization_id, argument_artifact_version_id);
create index external_effects_repository_profile_idx
  on bakery.external_effects (organization_id, repository_profile_id);
create index external_effects_credential_version_idx
  on bakery.external_effects (credential_version_id);
create index budget_reservations_external_effect_idx
  on bakery.budget_reservations (organization_id, external_effect_id);

revoke all on bakery.external_effects from public, bakery_app;
grant select on bakery.external_effects to bakery_app;
grant insert (
  id, organization_id, run_step_id, automation_definition_id, subscription_id,
  operation, action_version, target, integration_connection_id,
  integration_resource_id, mcp_connection_id, integration_install_id,
  integration_grant_id, adapter_manifest_digest, repository_profile_id,
  requesting_principal_id, actor_ref, idempotency_key, request_digest,
  safe_arguments, argument_artifact_version_id, external_account_id,
  external_resource_id, adapter_version, credential_version_id,
  authorization_revision, budget_reservation_id, approval_id, approval_stage,
  approval_policy_digest, status, remote_id, safe_result, failure_code,
  next_retry_at, dispatch_generation, lease_expires_at, last_checked_at,
  reconciliation_attempts, reconciliation_evidence, created_at, updated_at,
  version
) on bakery.external_effects to bakery_app;
grant update (
  status, remote_id, safe_result, failure_code, next_retry_at,
  dispatch_generation, lease_expires_at, last_checked_at,
  reconciliation_attempts, reconciliation_evidence, updated_at, version
) on bakery.external_effects to bakery_app;
