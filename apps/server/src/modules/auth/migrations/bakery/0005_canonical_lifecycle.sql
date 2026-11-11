-- Bakery owns organization lifecycle state from this migration onward.
-- The untracked 0004 proposal is deliberately not read as authority. If a
-- task database applied it with data, this migration fails before changing it.
create table if not exists bakery.provider_invitation_migration_snapshot (
  id uuid primary key,
  organization_id uuid not null,
  email text not null,
  role text,
  status text,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  inviter_provider_user_id uuid
);

create temporary table canonical_invitation_migration_source (
  id uuid primary key,
  organization_id uuid not null,
  email text not null,
  role text,
  status text,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  inviter_provider_user_id uuid
) on commit drop;

insert into canonical_invitation_migration_source (
  id, organization_id, email, role, status, expires_at, created_at,
  inviter_provider_user_id
)
select id, organization_id, email, role, status, expires_at, created_at,
  inviter_provider_user_id
from bakery.provider_invitation_migration_snapshot
union all
select invitation.id, invitation."organizationId", invitation.email,
  invitation.role, invitation.status, invitation."expiresAt",
  invitation."createdAt", invitation."inviterId"
from public.invitation as invitation
where not exists (
  select 1
  from bakery.provider_invitation_migration_snapshot as snapshot
  where snapshot.id = invitation.id
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'bakery'
      and table_name = 'permission_grants'
      and column_name = 'role'
  ) then
    raise exception using
      errcode = '23514',
      message = 'CANONICAL_MIGRATION_UNAPPROVED_PERMISSION_GRANT_ROLE_COLUMN';
  end if;

  if exists (
    select 1
    from public.organization
    where btrim(name) = '' or btrim(slug) = ''
  ) then
    raise exception using
      errcode = '23514',
      message = 'CANONICAL_MIGRATION_ORGANIZATION_MAPPING_REQUIRED';
  end if;

  if exists (
    select 1
    from public.member
    where role not in ('admin', 'developer')
      or status not in ('active', 'inactive')
  ) then
    raise exception using
      errcode = '23514',
      message = 'CANONICAL_MIGRATION_MEMBERSHIP_MAPPING_REQUIRED';
  end if;

  if exists (
    select 1
    from canonical_invitation_migration_source
    where role is null
      or role not in ('admin', 'developer')
      or status not in ('pending', 'accepted', 'rejected', 'canceled')
      or btrim(email) = ''
      or (status = 'pending' and inviter_provider_user_id is null)
  ) then
    raise exception using
      errcode = '23514',
      message = 'CANONICAL_MIGRATION_INVITATION_MAPPING_REQUIRED';
  end if;

  if exists (
    select 1
    from canonical_invitation_migration_source
    where status = 'pending'
    group by organization_id, lower(btrim(email))
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'CANONICAL_MIGRATION_DUPLICATE_PENDING_INVITATION';
  end if;

  begin
    perform metadata::jsonb
    from public.organization
    where metadata is not null;
  exception when others then
    raise exception using
      errcode = '22P02',
      message = 'CANONICAL_MIGRATION_ORGANIZATION_METADATA_UNMAPPABLE';
  end;
end;
$$;

-- Every provider user needs a stable Bakery principal before a provider
-- membership or invitation can be copied. Existing disabled state is kept.
insert into bakery.principals (
  provider_user_id,
  display_name,
  principal_type
)
select id, name, 'human'
from public."user"
where btrim(name) <> ''
on conflict (provider_user_id) do nothing;

do $$
begin
  if exists (
    select 1
    from public."user" as provider_user
    left join bakery.principals as principal
      on principal.provider_user_id = provider_user.id
    where principal.id is null
  ) then
    raise exception using
      errcode = '23503',
      message = 'CANONICAL_MIGRATION_PRINCIPAL_MAPPING_REQUIRED';
  end if;

  if exists (
    select provider_user_id
    from bakery.principals
    where provider_user_id is not null
    group by provider_user_id
    having count(*) <> 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'CANONICAL_MIGRATION_DUPLICATE_PRINCIPAL_MAPPING';
  end if;

  if exists (
    select 1
    from public.member as member
    left join bakery.principals as principal
      on principal.provider_user_id = member."userId"
    where principal.id is null
  ) then
    raise exception using
      errcode = '23503',
      message = 'CANONICAL_MIGRATION_ORPHANED_MEMBERSHIP';
  end if;

  if exists (
    select 1
    from canonical_invitation_migration_source as invitation
    left join bakery.principals as principal
      on principal.provider_user_id = invitation.inviter_provider_user_id
    where invitation.status = 'pending'
      and principal.id is null
  ) then
    raise exception using
      errcode = '23503',
      message = 'CANONICAL_MIGRATION_UNMAPPABLE_INVITER';
  end if;
end;
$$;

create table bakery.organizations (
  id uuid primary key,
  name text not null check (btrim(name) <> ''),
  slug text not null check (btrim(slug) <> ''),
  logo text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1,
  constraint organizations_version_positive check (version > 0),
  constraint organizations_slug_unique unique (slug)
);

create table bakery.organization_memberships (
  id uuid primary key,
  organization_id uuid not null,
  principal_id uuid not null,
  role text,
  status text not null,
  joined_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1,
  constraint organization_memberships_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint organization_memberships_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete restrict,
  constraint organization_memberships_role_supported
    check (role is null or role in ('admin', 'developer')),
  constraint organization_memberships_status_supported
    check (status in ('active', 'inactive')),
  constraint organization_memberships_version_positive check (version > 0),
  constraint organization_memberships_organization_id_unique
    unique (organization_id, id),
  constraint organization_memberships_organization_id_principal_unique
    unique (organization_id, id, principal_id),
  constraint organization_memberships_organization_principal_unique
    unique (organization_id, principal_id)
);

create table bakery.organization_invitations (
  id uuid primary key,
  organization_id uuid not null,
  email text not null check (email = lower(btrim(email)) and btrim(email) <> ''),
  role text not null check (role in ('admin', 'developer')),
  status text not null check (
    status in ('pending', 'accepted', 'rejected', 'canceled')
  ),
  expires_at timestamptz not null,
  inviter_principal_id uuid,
  inviter_membership_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1,
  constraint organization_invitations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint organization_invitations_inviter_principal_fk
    foreign key (inviter_principal_id)
    references bakery.principals (id) on delete restrict,
  constraint organization_invitations_inviter_membership_fk
    foreign key (
      organization_id,
      inviter_membership_id,
      inviter_principal_id
    )
    references bakery.organization_memberships (
      organization_id,
      id,
      principal_id
    )
    on delete set null (inviter_membership_id),
  constraint organization_invitations_version_positive check (version > 0),
  constraint organization_invitations_organization_id_unique
    unique (organization_id, id)
);

create unique index organization_invitations_pending_email_unique
  on bakery.organization_invitations (organization_id, email)
  where status = 'pending';

-- Human memberships are role-bearing. Service and worker memberships may be
-- role-free, preserving exact-grant-only access without a role promotion.
create function bakery.validate_organization_membership_role()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, bakery
as $$
declare
  principal_kind text;
begin
  select principal_type
  into principal_kind
  from bakery.principals
  where id = new.principal_id;
  if principal_kind = 'human' and new.role is null then
    raise exception using
      errcode = '23514',
      message = 'HUMAN_MEMBERSHIP_ROLE_REQUIRED';
  end if;
  return new;
end;
$$;
revoke execute on function bakery.validate_organization_membership_role()
  from public;
create trigger organization_memberships_role_validation
  before insert or update of principal_id, role
  on bakery.organization_memberships
  for each row execute function bakery.validate_organization_membership_role();

insert into bakery.organizations (
  id, name, slug, logo, metadata, created_at, updated_at, version
)
select id, name, slug, logo, coalesce(metadata, '{}')::jsonb,
  "createdAt", "updatedAt", version
from public.organization;

insert into bakery.organization_memberships (
  id, organization_id, principal_id, role, status, joined_at,
  created_at, updated_at, version
)
select member.id,
  member."organizationId",
  principal.id,
  member.role,
  member.status,
  member."joinedAt",
  member."createdAt",
  member."updatedAt",
  member.version
from public.member as member
join bakery.principals as principal
  on principal.provider_user_id = member."userId";

insert into bakery.organization_invitations (
  id, organization_id, email, role, status, expires_at,
  inviter_principal_id, inviter_membership_id, created_at, updated_at, version
)
select invitation.id,
  invitation.organization_id,
  lower(btrim(invitation.email)),
  invitation.role,
  invitation.status,
  invitation.expires_at,
  inviter.id,
  inviter_membership.id,
  invitation.created_at,
  invitation.created_at,
  1
from canonical_invitation_migration_source as invitation
left join bakery.principals as inviter
  on inviter.provider_user_id = invitation.inviter_provider_user_id
left join bakery.organization_memberships as inviter_membership
  on inviter_membership.organization_id = invitation.organization_id
  and inviter_membership.principal_id = inviter.id;

drop table bakery.provider_invitation_migration_snapshot;

-- Existing exact grants retain their IDs and state; only the canonical
-- organization owner changes. No membership is required for exact-only actors.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_record.conname
    from pg_constraint as constraint_record
    where constraint_record.conrelid = 'bakery.permission_grants'::regclass
      and constraint_record.contype = 'f'
      and constraint_record.confrelid = 'public.organization'::regclass
  loop
    execute format(
      'alter table bakery.permission_grants drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;
alter table bakery.permission_grants
  add constraint permission_grants_organization_id_fkey
  foreign key (organization_id)
  references bakery.organizations (id) on delete cascade;

-- A role column from the unpublished proposal is intentionally neither
-- removed nor trusted here. Non-null data failed the preflight above; a
-- separate forward data-treatment decision is required before removal.

create function bakery.prevent_organization_invitation_scope_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, bakery
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.email is distinct from old.email
    or new.role is distinct from old.role
    or new.expires_at is distinct from old.expires_at
    or new.inviter_principal_id is distinct from old.inviter_principal_id
    or (new.inviter_membership_id is not null
      and new.inviter_membership_id is distinct from old.inviter_membership_id)
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'INVITATION_SCOPE_FIELDS_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke execute on function bakery.prevent_organization_invitation_scope_change()
  from public;
create trigger organization_invitations_scope_validation
  before update on bakery.organization_invitations
  for each row execute function bakery.prevent_organization_invitation_scope_change();

grant select, insert, update, delete
  on bakery.organizations,
    bakery.organization_memberships,
    bakery.organization_invitations
  to bakery_app;
