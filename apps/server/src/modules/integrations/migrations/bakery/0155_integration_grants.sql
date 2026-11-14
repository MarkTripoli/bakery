-- Integration grants (issue #20): which subject may use which integration
-- capability through one connection, in which direction, and on which resource,
-- application or repository. The gate (catalog/integration-gate.ts) matches a
-- request exactly against these rows (IntegrationGrantRecord); nothing here is
-- a wildcard. A subject is a principal, an organization role or an automation.
-- Structure only: the subject and scope rules, expiry and revocation are
-- enforced in TypeScript. The application role may insert and select, and may
-- change only the revocation columns; a granted scope is immutable to it, and
-- it cannot delete, so an effect's grant provenance always resolves.
create table bakery.integration_grants (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  subject_type text not null,
  subject_principal_id uuid,
  subject_role text,
  automation_definition_id uuid,
  direction text not null,
  capability text not null,
  action_version integer,
  resource_id uuid,
  application_id uuid,
  repository_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  granted_by uuid not null,
  policy_revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_grants_organization_id_unique
    unique (organization_id, id),
  constraint integration_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_grants_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  constraint integration_grants_resource_fk
    foreign key (organization_id, resource_id)
    references bakery.integration_resources (organization_id, id)
    on delete cascade
);

-- A connection's live grants, newest first, for the list and the gate.
create index integration_grants_connection_page
  on bakery.integration_grants (organization_id, connection_id, created_at, id);

grant select, insert on bakery.integration_grants to bakery_app;
grant update (revoked_at, revoked_by, updated_at, version)
  on bakery.integration_grants to bakery_app;
