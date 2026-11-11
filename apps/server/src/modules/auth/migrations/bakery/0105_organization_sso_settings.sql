-- Per-organization SSO enforcement switch. Written by the enterprise SSO
-- module only, after an entitlement and permission check; read by the session
-- policy. The table exists in the community build, where nothing writes it.
create table bakery.organization_sso_settings (
  organization_id uuid primary key
    references bakery.organizations (id) on delete cascade,
  enforce boolean not null default false,
  updated_by_principal_id uuid references bakery.principals (id) on delete restrict,
  updated_at timestamptz not null
);

grant select, insert, update on bakery.organization_sso_settings to bakery_app;
