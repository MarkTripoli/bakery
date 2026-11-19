-- Organization groups (chapter 25 section 19, issue #458): a named set of
-- members a workflow or a person can ask by one name, where any one member can
-- answer.
--
-- A group is the audience of a request, never a grant of access: members keep
-- only the access they already have. Membership is a plain join. Deleting the
-- group or the person removes their rows; a member whose organization
-- membership merely becomes inactive keeps the row but is not listed or asked
-- (the reads join active memberships), so reactivating restores their place. A
-- group with no members is valid (its requests go to the workflow owner until
-- someone is added).
--
-- The mention name is the group's stable handle. It is fixed when the group is
-- created, because workflows and people name the group by it; only the display
-- name and purpose can change. The grant at the bottom enforces that in the
-- database: the application role has no UPDATE on mention_name, so no code path
-- can rename the handle out from under a workflow that names it. The handle's
-- shape and the length limits are owned by TypeScript, not by CHECK
-- constraints.
create table bakery.organization_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  mention_name text not null,
  purpose text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint organization_groups_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint organization_groups_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete set null,
  constraint organization_groups_organization_id_unique
    unique (organization_id, id)
);

-- One handle per organization, and one display name per organization ignoring
-- case, so two groups can never be confused in a picker or a mention.
create unique index organization_groups_mention_unique
  on bakery.organization_groups (organization_id, mention_name);
create unique index organization_groups_name_unique
  on bakery.organization_groups (organization_id, lower(name));

create table bakery.organization_group_members (
  organization_id uuid not null,
  group_id uuid not null,
  principal_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (group_id, principal_id),
  constraint organization_group_members_group_fk
    foreign key (organization_id, group_id)
    references bakery.organization_groups (organization_id, id)
    on delete cascade,
  constraint organization_group_members_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade
);

-- "Which groups is this person in" is the reverse lookup a request uses.
create index organization_group_members_principal_idx
  on bakery.organization_group_members (organization_id, principal_id);

grant select, insert, delete on bakery.organization_group_members to bakery_app;
grant select, insert, delete on bakery.organization_groups to bakery_app;
grant update (name, purpose, updated_at, version)
  on bakery.organization_groups to bakery_app;
