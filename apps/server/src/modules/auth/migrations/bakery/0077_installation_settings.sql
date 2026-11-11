create table bakery.installation_settings (
  id boolean primary key,
  registration_mode text not null,
  organization_creation_policy text not null,
  license_key text,
  version integer not null,
  updated_by_principal_id uuid references bakery.principals (id) on delete restrict,
  updated_at timestamptz not null,
  bootstrap_principal_id uuid
    references bakery.installation_administrators (principal_id) on delete restrict,
  bootstrap_repair_version integer
);

alter table bakery.installation_administrators
  drop constraint installation_administrators_distinct_principals;

grant select on bakery.installation_settings to bakery_app;
grant update (
  registration_mode, organization_creation_policy, version,
  updated_by_principal_id, updated_at
) on bakery.installation_settings to bakery_app;

grant insert (
  principal_id, granted_by_principal_id, created_at, updated_at, version
) on bakery.installation_administrators to bakery_app;
grant update (
  revoked_at, updated_at, version
) on bakery.installation_administrators to bakery_app;
