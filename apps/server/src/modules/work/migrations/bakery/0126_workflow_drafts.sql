-- One mutable draft per workflow. Publish copies the draft into the immutable
-- workflow_versions ledger; the draft keeps its revision counter. Identity
-- columns stay immutable for the application role via the column-scoped grant.
create table bakery.workflow_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  revision integer not null,
  source_yaml text not null,
  definition jsonb not null,
  digest text not null,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint workflow_drafts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_drafts_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id) on delete cascade,
  constraint workflow_drafts_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint workflow_drafts_updated_by_fk
    foreign key (updated_by)
    references bakery.principals (id) on delete restrict,
  constraint workflow_drafts_organization_id_unique
    unique (organization_id, id),
  constraint workflow_drafts_workflow_unique
    unique (organization_id, workflow_id),
  constraint workflow_drafts_revision_unique
    unique (workflow_id, revision)
);

grant select, insert, delete on bakery.workflow_drafts to bakery_app;
grant update (source_yaml, definition, digest, updated_by, updated_at, version)
  on bakery.workflow_drafts
  to bakery_app;
