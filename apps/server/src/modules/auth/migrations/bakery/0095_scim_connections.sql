-- SCIM provisioning connection per organization (paid feature `scim`).
-- A credential secret is 32 random bytes shown once; only its SHA-256 digest is
-- stored. The runtime role can insert a credential but never rewrite its
-- digest or prefix: column-level UPDATE covers expiry, revocation and last use
-- only, so a rotation is a new row, never an edited secret.
create table bakery.scim_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  created_by_principal_id uuid not null
    references bakery.principals (id) on delete restrict,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  version integer not null default 1,
  constraint scim_connections_organization_unique unique (organization_id)
);

create table bakery.scim_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references bakery.scim_connections (id) on delete cascade,
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  created_by_principal_id uuid not null
    references bakery.principals (id) on delete restrict,
  prefix text not null,
  secret_sha256 text not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  constraint scim_credentials_secret_sha256_unique unique (secret_sha256)
);

create index scim_credentials_connection_created_idx
  on bakery.scim_credentials (connection_id, created_at desc, id desc);

-- Memberships the SCIM projection created. Only these are ever deactivated or
-- re-roled by provisioning, so SCIM never touches a membership an
-- administrator made by hand.
create table bakery.scim_memberships (
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  principal_id uuid not null
    references bakery.principals (id) on delete cascade,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  primary key (organization_id, principal_id)
);

grant select, insert on bakery.scim_connections to bakery_app;
grant update (revoked_at, updated_at, version)
  on bakery.scim_connections to bakery_app;

grant select, insert on bakery.scim_credentials to bakery_app;
grant update (expires_at, last_used_at, revoked_at)
  on bakery.scim_credentials to bakery_app;

grant select, insert, delete on bakery.scim_memberships to bakery_app;
