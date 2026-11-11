-- Resource role bindings. A binding gives one principal a system role
-- (viewer or developer) on one application or one repository, in addition to
-- the principal's organization-wide role. An application binding covers its
-- repositories and their tasks and runs; a repository binding covers its own
-- tasks and runs. Exactly one of application_id or repository_id is set; the
-- boundary rail forbids CHECK constraints, so the application and the unique
-- indexes below enforce that.
create table bakery.access_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  principal_id uuid not null
    references bakery.principals (id) on delete cascade,
  role_key text not null,
  scope_type text not null,
  application_id uuid,
  repository_id uuid,
  granted_by_principal_id uuid not null
    references bakery.principals (id) on delete restrict,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  version integer not null default 1,
  constraint access_bindings_organization_id_unique
    unique (organization_id, id),
  constraint access_bindings_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete cascade,
  constraint access_bindings_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete cascade
);

create unique index access_bindings_application_unique
  on bakery.access_bindings (principal_id, role_key, application_id)
  where application_id is not null;

create unique index access_bindings_repository_unique
  on bakery.access_bindings (principal_id, role_key, repository_id)
  where repository_id is not null;

create index access_bindings_organization_created_idx
  on bakery.access_bindings (organization_id, created_at, id);

create index access_bindings_principal_idx
  on bakery.access_bindings (organization_id, principal_id);

-- Bindings are removed by delete; the audit row beside each removal keeps the
-- history, as for permission grants.
grant select, insert, delete on bakery.access_bindings to bakery_app;
