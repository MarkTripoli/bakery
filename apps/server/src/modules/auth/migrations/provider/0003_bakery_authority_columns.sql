alter table public.organization
  add column "updatedAt" timestamptz not null default CURRENT_TIMESTAMP,
  add column version integer not null default 1,
  add constraint organization_version_positive check (version > 0);

alter table public.member
  add column status text not null default 'active',
  add column "joinedAt" timestamptz not null default CURRENT_TIMESTAMP,
  add column "updatedAt" timestamptz not null default CURRENT_TIMESTAMP,
  add column version integer not null default 1,
  add constraint member_role_supported check (role in ('admin', 'developer')),
  add constraint member_status_supported check (status in ('active', 'inactive')),
  add constraint member_version_positive check (version > 0);

alter table public.member
  add constraint member_organization_user_unique unique ("organizationId", "userId"),
  add constraint member_organization_id_unique unique ("organizationId", id);

alter table public.invitation
  alter column "inviterId" drop not null;

update public.invitation as invitation
set status = 'canceled'
where status = 'pending'
  and not exists (
    select 1
    from public.member as membership
    where membership."organizationId" = invitation."organizationId"
      and membership."userId" = invitation."inviterId"
  );

update public.invitation as invitation
set "inviterId" = null
where not exists (
  select 1
  from public.member as membership
  where membership."organizationId" = invitation."organizationId"
    and membership."userId" = invitation."inviterId"
);

alter table public.invitation
  add constraint invitation_same_organization_inviter_fk
  foreign key ("organizationId", "inviterId")
  references public.member ("organizationId", "userId")
  on delete restrict;
