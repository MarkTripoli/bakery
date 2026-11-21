-- Bundle retention for private plugin versions (#15, B14.01).
--
-- A version's archive lives in the object store at `bundle_object_ref` and
-- nowhere else, so before this there was no row a collector could mark and no
-- policy that named those bytes: an install could be removed, its package
-- withdrawn, and the archive would sit in the store forever. The artifact
-- collector has `purged_at` and `purge_policy` for exactly this reason.
--
-- Two columns rather than one: `bundle_purged_at` answers "are the bytes still
-- there", and `purge_policy` records which policy decided, so a later policy
-- change can find what an earlier one collected.
--
-- The reference is kept. `bundle_object_ref` stays set after collection because
-- it is the only record of where the archive was, and because the row is
-- immutable apart from these two columns - a purged version still describes
-- itself truthfully, and a read of it answers from `bundle_purged_at` rather
-- than by probing the store.
alter table bakery.plugin_versions
  add column bundle_purged_at timestamptz,
  add column purge_policy text;

comment on column bakery.plugin_versions.bundle_purged_at is
  'When retention removed the archive from the object store; null while the bytes exist.';
comment on column bakery.plugin_versions.purge_policy is
  'The policy that decided collection, recorded so a later policy can find an earlier one''s work.';

-- The application role already holds select and insert on this table and no
-- update at all, because a version is immutable. Collection updates exactly
-- these two columns, so the grant is column-scoped rather than table-wide: an
-- addition that widened the table grant would let a caller rewrite a manifest
-- or a digest.
grant update (bundle_purged_at, purge_policy)
  on bakery.plugin_versions to bakery_app;

-- Collection reads the versions whose package is withdrawn or that were never
-- published, and only those; a partial index keeps the scan off every version
-- an organization has ever published.
create index plugin_versions_collectable_idx
  on bakery.plugin_versions (organization_id, plugin_package_id)
  where bundle_purged_at is null;
