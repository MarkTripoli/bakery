-- Paid custom roles (roles.custom). A role is a named set of catalog
-- permission keys scoped to one organization. A member holds at most one
-- custom role; the membership keeps the lowest system role (guest) so the
-- rank-based checks fail closed and custom roles never count toward the
-- last-administrator rule. Existing roles keep granting when the licence
-- lapses, so no table here is gated on entitlement.
create table bakery.organization_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  permissions text[] not null,
  created_by_principal_id uuid not null
    references bakery.principals (id) on delete restrict,
  created_at timestamptz not null default CURRENT_TIMESTAMP,
  updated_at timestamptz not null default CURRENT_TIMESTAMP,
  version integer not null default 1,
  constraint organization_roles_organization_key_unique
    unique (organization_id, key),
  constraint organization_roles_organization_id_unique
    unique (organization_id, id)
);

create index organization_roles_organization_created_idx
  on bakery.organization_roles (organization_id, created_at, id);

grant select, insert, update, delete on bakery.organization_roles to bakery_app;

alter table bakery.organization_memberships
  add column custom_role_id uuid;

alter table bakery.organization_memberships
  add constraint organization_memberships_custom_role_fk
    foreign key (organization_id, custom_role_id)
    references bakery.organization_roles (organization_id, id);

create index organization_memberships_custom_role_idx
  on bakery.organization_memberships (custom_role_id)
  where custom_role_id is not null;
