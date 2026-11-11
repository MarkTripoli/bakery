alter table bakery.principals
  add column created_at timestamptz not null default CURRENT_TIMESTAMP,
  add column updated_at timestamptz not null default CURRENT_TIMESTAMP,
  add column version integer not null default 1,
  add constraint principals_version_positive check (version > 0);

alter table bakery.principals
  add constraint principals_id_type_unique unique (id, principal_type);

create table bakery.installation_administrators (
  principal_id uuid primary key,
  principal_type text not null default 'human'
    check (principal_type = 'human'),
  granted_by_principal_id uuid not null,
  granted_by_principal_type text not null default 'human'
    check (granted_by_principal_type = 'human'),
  revoked_at timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  version integer not null default 1,
  constraint installation_administrators_version_positive check (version > 0),
  constraint installation_administrators_distinct_principals check (
    principal_id <> granted_by_principal_id
  ),
  constraint installation_administrators_principal_fk
    foreign key (principal_id, principal_type)
    references bakery.principals (id, principal_type) on delete cascade,
  constraint installation_administrators_grantor_fk
    foreign key (granted_by_principal_id, granted_by_principal_type)
    references bakery.principals (id, principal_type) on delete restrict
);

create table bakery.permission_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization (id) on delete cascade,
  principal_id uuid not null references bakery.principals (id) on delete cascade,
  capability text not null check (
    btrim(capability) <> '' and capability not like '%*%'
  ),
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by_principal_id uuid not null references bakery.principals (id) on delete restrict,
  policy_revision bigint not null default 1,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  version integer not null default 1,
  constraint permission_grants_organization_id_unique unique (organization_id, id),
  constraint permission_grants_policy_revision_positive check (policy_revision > 0),
  constraint permission_grants_version_positive check (version > 0)
);

create unique index permission_grants_active_subject_capability_unique
  on bakery.permission_grants (organization_id, principal_id, capability)
  where revoked_at is null and expires_at is null;

create function bakery.enforce_permission_grant_active_unique()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, bakery
as $$
begin
  if new.revoked_at is null and
      (new.expires_at is null or new.expires_at > current_timestamp) then
    perform pg_advisory_xact_lock(
      hashtextextended(
        new.organization_id::text || ':' ||
          new.principal_id::text || ':' || new.capability,
        0
      )
    );
    if exists (
      select 1
      from bakery.permission_grants as existing
      where existing.organization_id = new.organization_id
        and existing.principal_id = new.principal_id
        and existing.capability = new.capability
        and existing.id <> new.id
        and existing.revoked_at is null
        and (existing.expires_at is null or existing.expires_at > current_timestamp)
    ) then
      raise exception using
        errcode = '23505',
        message = 'active permission grant already exists';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function bakery.enforce_permission_grant_active_unique()
  from public;

create trigger permission_grants_active_unique
  before insert or update of organization_id, principal_id, capability,
    expires_at, revoked_at on bakery.permission_grants
  for each row execute function bakery.enforce_permission_grant_active_unique();

grant select on bakery.installation_administrators to bakery_app;
grant select, insert on bakery.permission_grants to bakery_app;
