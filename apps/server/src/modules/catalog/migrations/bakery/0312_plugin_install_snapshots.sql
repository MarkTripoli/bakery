-- Keep the state an install had before it moved to another version (#34, B14.03).
--
-- An update pins another version of the package. The new version may save state
-- in a shape the old one cannot read, and the person who updated may want the
-- old version back. A rollback of code is safe only when the state it will read
-- is state it can read, so the moment an install leaves a version this table
-- keeps a copy of the state as that version left it: the "versioned snapshot" of
-- chapter 11. A rollback to that version can then restore it, and nothing else
-- can: the restore is checked against the version the snapshot was taken from.
--
-- One snapshot per install. The next move replaces it, so the copy is bounded by
-- the state cap (256 keys per owner, each with the value-size cap) and does not
-- grow with the number of updates. An install that is uninstalled keeps its
-- snapshot with the rest of its retained data and loses it with the install.
--
-- The tables are plain data written by the one writer that updates an install,
-- under the install row's lock, so no constraint beyond the references is
-- needed; the boundary rail forbids CHECK constraints and triggers in new
-- migrations, and the writer validates the shape.

create table bakery.plugin_install_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_install_id uuid not null,
  from_plugin_version_id uuid not null,
  from_state_schema_version integer not null,
  state_row_count integer not null,
  created_at timestamptz not null default now(),
  constraint plugin_install_snapshots_install_fk
    foreign key (organization_id, plugin_install_id)
    references bakery.plugin_installs (organization_id, id) on delete cascade,
  constraint plugin_install_snapshots_version_fk
    foreign key (from_plugin_version_id)
    references bakery.plugin_versions (id) on delete cascade,
  constraint plugin_install_snapshots_one_per_install
    unique (organization_id, plugin_install_id),
  constraint plugin_install_snapshots_organization_id_unique
    unique (organization_id, id)
);

create table bakery.plugin_install_snapshot_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_install_snapshot_id uuid not null,
  owner_principal_id uuid,
  namespace text not null,
  key text not null,
  schema_version integer not null,
  value jsonb not null,
  constraint plugin_install_snapshot_state_snapshot_fk
    foreign key (organization_id, plugin_install_snapshot_id)
    references bakery.plugin_install_snapshots (organization_id, id)
    on delete cascade,
  constraint plugin_install_snapshot_state_owner_fk
    foreign key (owner_principal_id)
    references bakery.principals (id) on delete cascade
);

-- Private state is keyed per person, shared state per install: the same two
-- partial indexes as plugin_state, for the same reason (a NULL owner does not
-- collide in a plain unique index).
create unique index plugin_install_snapshot_state_private_unique
  on bakery.plugin_install_snapshot_state
    (organization_id, plugin_install_snapshot_id, owner_principal_id, namespace, key)
  where owner_principal_id is not null;

create unique index plugin_install_snapshot_state_shared_unique
  on bakery.plugin_install_snapshot_state
    (organization_id, plugin_install_snapshot_id, namespace, key)
  where owner_principal_id is null;

-- The CAS numbers an install has issued for its state. A restore deletes keys,
-- so a key's own counter can go back down; every writer takes the next number
-- from this mark instead, under the install row's lock, so no number is ever
-- issued twice for one install and a writer holding an old number cannot match.
-- Backfilled with the highest number each install's live state already holds.
alter table bakery.plugin_installs
  add column state_cas_issued bigint not null default 0;

update bakery.plugin_installs i
   set state_cas_issued = s.top
  from (
    select organization_id, plugin_install_id, max(cas_version) as top
      from bakery.plugin_state
     group by organization_id, plugin_install_id
  ) s
 where i.organization_id = s.organization_id and i.id = s.plugin_install_id;

grant select, insert, delete on bakery.plugin_install_snapshots to bakery_app;
grant select, insert, delete on bakery.plugin_install_snapshot_state to bakery_app;
