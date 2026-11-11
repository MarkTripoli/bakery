-- GHI-278 generalizes durable runs for source-owned imports and persists
-- checkpointed source/content proof without storing remote archive bytes.
alter table bakery.workflow_runs
  add column kind text not null default 'workflow',
  add column skill_source_id uuid,
  alter column task_id drop not null,
  alter column workflow_version_id drop not null,
  add constraint workflow_runs_skill_source_fk
    foreign key (organization_id, skill_source_id)
    references bakery.skill_sources (organization_id, id) on delete restrict,
  add constraint workflow_runs_import_owner_unique
    unique (organization_id, id, skill_source_id);

create index workflow_runs_import_recovery_idx
  on bakery.workflow_runs (organization_id, status, updated_at, id)
  where kind = 'skill_import';

alter table bakery.skills
  add column source_path text;

create unique index skills_remote_source_path_unique
  on bakery.skills (organization_id, source_id, source_path)
  where source_id is not null and source_path is not null;

create table bakery.skill_imports (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  source_id uuid not null,
  requested_revision text not null,
  source_path text not null,
  registered_source_type text not null,
  registered_locator text not null,
  registered_license text not null,
  state text not null,
  recovery_generation bigint not null default 0,
  recovery_lease_token uuid,
  recovery_lease_expires_at timestamptz,
  resolved_revision text,
  source_proof_digest text,
  skill_id uuid,
  ordinal integer,
  skill_version_id uuid,
  manifest_digest text,
  entry_path text,
  file_inventory jsonb,
  terminal_fault jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_imports_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint skill_imports_run_source_fk
    foreign key (organization_id, run_id, source_id)
    references bakery.workflow_runs (organization_id, id, skill_source_id)
    on delete cascade,
  constraint skill_imports_source_fk
    foreign key (organization_id, source_id)
    references bakery.skill_sources (organization_id, id) on delete restrict,
  constraint skill_imports_skill_fk
    foreign key (organization_id, skill_id)
    references bakery.skills (organization_id, id) on delete restrict,
  constraint skill_imports_version_skill_fk
    foreign key (organization_id, skill_version_id, skill_id)
    references bakery.skill_versions (organization_id, id, skill_id)
    on delete restrict,
  constraint skill_imports_organization_id_unique
    unique (organization_id, id),
  constraint skill_imports_run_unique unique (organization_id, run_id),
  constraint skill_imports_identity_unique
    unique (organization_id, source_id, requested_revision, source_path)
);

create index skill_imports_recovery_idx
  on bakery.skill_imports (state, recovery_lease_expires_at, updated_at, id);

revoke all on bakery.skill_imports from bakery_app;
grant select, insert on bakery.skill_imports to bakery_app;
grant update (
  state, recovery_generation, recovery_lease_token, recovery_lease_expires_at,
  resolved_revision, source_proof_digest, skill_id, ordinal, skill_version_id,
  manifest_digest, entry_path, file_inventory, terminal_fault, updated_at, version
) on bakery.skill_imports to bakery_app;
grant update (status, updated_at, version)
  on bakery.skill_versions to bakery_app;
