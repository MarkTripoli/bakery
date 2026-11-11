-- Organization-bound access tokens. The secret is 32 random bytes shown once;
-- only its SHA-256 digest is stored. A token is live-capped by its principal's
-- current permissions, so no permission snapshot is kept here.
create table bakery.access_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  principal_id uuid not null
    references bakery.principals (id) on delete cascade,
  created_by_principal_id uuid not null
    references bakery.principals (id) on delete restrict,
  name text not null,
  prefix text not null,
  secret_sha256 text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  version integer not null default 1,
  constraint access_tokens_secret_sha256_unique unique (secret_sha256),
  constraint access_tokens_organization_id_unique unique (organization_id, id)
);

create index access_tokens_organization_created_idx
  on bakery.access_tokens (organization_id, created_at desc, id desc);

create index access_tokens_principal_idx
  on bakery.access_tokens (principal_id);

grant select, insert, update on bakery.access_tokens to bakery_app;
