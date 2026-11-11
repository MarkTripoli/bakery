-- Immutable published organization repository rule baselines. A revision is
-- inserted once and never updated or deleted; bakery_app gets no update or
-- delete privilege. The application serializes publishers per organization.
create table bakery.organization_repository_rule_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  revision integer not null,
  config jsonb not null,
  digest text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint organization_repository_rule_versions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint organization_repository_rule_versions_created_by_fk
    foreign key (created_by)
    references bakery.principals (id),
  constraint organization_repository_rule_versions_revision_unique
    unique (organization_id, revision),
  constraint organization_repository_rule_versions_organization_id_unique
    unique (organization_id, id)
);

grant select, insert on bakery.organization_repository_rule_versions to bakery_app;
