-- Plugin installs, their capability grants, and install-scoped state (#15,
-- B14.01, slice 2; chapter 11 "Plugin data contract").
--
-- Why the selected version must be proved to belong to the package in the data
-- layer. An install names a package and a version, and an install that pins a
-- version of a different package is not a typo to be tolerated: it would let a
-- caller enable one package while carrying evidence for another. The version
-- table therefore grows a unique key over (organization, package, id) and the
-- install references that key as a whole, so the pair can only name a version
-- that really belongs to the package. A trigger would enforce the same thing,
-- and the boundary rail forbids triggers; a check in one writer would be
-- bypassed by the next writer.
--
-- Why grants are their own table. bakery.permission_grants grants a person a
-- capability in the organization. That table is authority a *member* holds, and
-- a plugin must never be able to mint it: an install-bound grant that widened a
-- caller's organization capabilities would be privilege escalation with a
-- private package as the delivery mechanism. plugin_install_grants records what
-- this install may do, bounded by the install, and is consulted only when the
-- install is enabled.
--
-- Why the owner rule and the positive-version rules are not constraints. A
-- personal install has an owner and an organization install does not, and
-- schema/cas versions are positive. The boundary rail forbids CHECK constraints
-- in new migrations, so these are enforced by the writer and by two partial
-- unique indexes for one-package-per-scope, and they are written down here so a
-- reader knows the rule exists rather than assuming the absence is an oversight.

alter table bakery.plugin_versions
  add constraint plugin_versions_organization_package_id_unique
    unique (organization_id, plugin_package_id, id);

create table bakery.plugin_installs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_package_id uuid not null,
  plugin_version_id uuid not null,
  scope text not null,
  owner_principal_id uuid,
  status text not null default 'staged',
  state_schema_version integer not null default 1,
  activated_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint plugin_installs_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- The trio is the real reference: a version of another package cannot be
  -- named here at all. Deleting the version cascades rather than restricting,
  -- because a version is removed only by removing its package, and an install
  -- of a package that no longer exists would be an install with nothing to run.
  -- Cascade also keeps two paths from racing: the organization cascade and a
  -- restrict to a version can meet in whichever order the planner chooses, and
  -- the restrict then fails on a delete that should have succeeded.
  constraint plugin_installs_package_version_fk
    foreign key (organization_id, plugin_package_id, plugin_version_id)
    references bakery.plugin_versions (organization_id, plugin_package_id, id)
    on delete cascade,
  constraint plugin_installs_owner_fk
    foreign key (owner_principal_id)
    references bakery.principals (id) on delete cascade,
  constraint plugin_installs_organization_id_unique
    unique (organization_id, id)
);

-- One organization install per package. Uninstalled rows are excluded so a
-- person who uninstalls and reinstalls keeps the evidence of both.
create unique index plugin_installs_one_organization_per_package_idx
  on bakery.plugin_installs (organization_id, plugin_package_id)
  where scope = 'organization' and status <> 'uninstalled';

-- One personal install per package per person, and only ever one row with no
-- owner per scope. A NULL owner cannot collide in a plain unique index, so the
-- organization case is its own index.
create unique index plugin_installs_one_personal_per_package_idx
  on bakery.plugin_installs (organization_id, owner_principal_id, plugin_package_id)
  where scope = 'personal' and status <> 'uninstalled';

create index plugin_installs_list_idx
  on bakery.plugin_installs (organization_id, updated_at desc, id desc);

create table bakery.plugin_install_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_install_id uuid not null,
  capability text not null,
  created_at timestamptz not null default now(),
  constraint plugin_install_grants_install_fk
    foreign key (organization_id, plugin_install_id)
    references bakery.plugin_installs (organization_id, id) on delete cascade,
  constraint plugin_install_grants_capability_unique
    unique (organization_id, plugin_install_id, capability)
);

create index plugin_install_grants_install_idx
  on bakery.plugin_install_grants (organization_id, plugin_install_id);

create table bakery.plugin_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_install_id uuid not null,
  owner_principal_id uuid,
  namespace text not null,
  key text not null,
  schema_version integer not null,
  cas_version integer not null default 1,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint plugin_state_install_fk
    foreign key (organization_id, plugin_install_id)
    references bakery.plugin_installs (organization_id, id) on delete cascade,
  constraint plugin_state_owner_fk
    foreign key (owner_principal_id)
    references bakery.principals (id) on delete cascade,
  constraint plugin_state_organization_id_unique
    unique (organization_id, id)
);

-- Private state is keyed per person, shared state per install. Two indexes
-- rather than one, because a NULL owner does not collide in a unique index and
-- shared state must still be unique per (install, namespace, key).
create unique index plugin_state_private_unique
  on bakery.plugin_state (organization_id, plugin_install_id, owner_principal_id, namespace, key)
  where owner_principal_id is not null;

create unique index plugin_state_shared_unique
  on bakery.plugin_state (organization_id, plugin_install_id, namespace, key)
  where owner_principal_id is null;

create index plugin_state_read_idx
  on bakery.plugin_state (organization_id, plugin_install_id, owner_principal_id, namespace);

grant select, insert, update on bakery.plugin_installs to bakery_app;
grant select, insert, delete on bakery.plugin_install_grants to bakery_app;
grant select, insert, update, delete on bakery.plugin_state to bakery_app;
