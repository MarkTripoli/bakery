-- Where imported library data came from (one engine O6/O7, #426). A T0
-- package is validated data, and importing one creates ordinary drafts and
-- kind versions. This table is the lineage: one row per imported item, naming
-- the package it arrived in, the item's digest in that package and what it
-- became here. A later copy or edit of the result never rewrites a row, and the
-- source organization is never recorded because a package does not carry it.
create table bakery.package_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  package_digest text not null,
  package_name text not null,
  item_kind text not null,
  item_key text not null,
  item_digest text not null,
  resulting_id uuid not null,
  imported_by uuid not null,
  created_at timestamptz not null default now(),
  constraint package_imports_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint package_imports_imported_by_fk
    foreign key (imported_by)
    references bakery.principals (id) on delete restrict
);

create index package_imports_package_idx
  on bakery.package_imports (organization_id, package_digest, created_at);
create index package_imports_resulting_idx
  on bakery.package_imports (organization_id, resulting_id);

revoke all on bakery.package_imports from public, bakery_app;
grant select, insert on bakery.package_imports to bakery_app;
