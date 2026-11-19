-- Working areas, trash, retention classes and quotas over the storage tree
-- (chapter 25 sections 17.1 and 17.5, slice F5, #447). Builds on #444's
-- bakery.storage_entries; there is still one tree and one entry model.
--
-- Rules for these tables:
-- * Policy decisions (who may write, what rm does, what is kept, quota math)
--   live in TypeScript (apps/server/src/modules/knowledge/storage-areas.ts).
--   The PostgreSQL boundary rails forbid CHECK constraints, triggers and
--   functions, so nothing here enforces a vocabulary.
-- * A record-area file keeps pointing at its artifact (#444). A file people or
--   steps write into a working, personal or scratch area has no work item, so
--   its versions are rows in bakery.storage_file_versions instead, and each
--   version names a blob or carries small inline bytes, exactly like an
--   artifact version (one of blob_id or content).

alter table bakery.storage_entries
  -- Optimistic concurrency for put, mv, rm and restore (If-Match).
  add column version integer not null default 1,
  add column updated_at timestamptz not null default now(),
  -- The working-area file's current version.
  add column current_version_id uuid,
  -- The member a personal or scratch entry belongs to; null elsewhere.
  add column owner_id uuid,
  -- Which quota a file counts against besides the organization's:
  -- 'project:<application id>' or 'user:<principal id>'; null for /shared.
  add column scope_key text,
  -- Trash: a trashed entry sits under /trash with name_key 'trash:<id>' so the
  -- name it had stays free, and remembers where it came from for restore.
  add column trashed_at timestamptz,
  add column trashed_by_id uuid,
  add column trash_parent_id uuid,
  add column trash_name text,
  -- Set by the owner storage-purges task when it completes an Admin purge of
  -- a record-area file: the entry stays as a tombstone. A working-area purge
  -- deletes the entry instead, so only record-area files carry it.
  add column purged_at timestamptz,
  add constraint storage_entries_owner_fk
    foreign key (owner_id) references bakery.principals (id)
    on delete restrict,
  add constraint storage_entries_trashed_by_fk
    foreign key (trashed_by_id) references bakery.principals (id)
    on delete restrict,
  add constraint storage_entries_trash_parent_fk
    foreign key (organization_id, trash_parent_id)
    references bakery.storage_entries (organization_id, id) on delete set null (trash_parent_id);

create table bakery.storage_file_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  entry_id uuid not null,
  revision integer not null,
  blob_id uuid,
  content bytea,
  sha256 text not null,
  size_bytes bigint not null,
  media_type text not null,
  author_id uuid not null,
  created_at timestamptz not null default now(),
  constraint storage_file_versions_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint storage_file_versions_org_id_unique unique (organization_id, id),
  constraint storage_file_versions_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint storage_file_versions_blob_fk
    foreign key (organization_id, blob_id)
    references bakery.blobs (organization_id, id) on delete restrict,
  constraint storage_file_versions_author_fk
    foreign key (author_id) references bakery.principals (id)
    on delete restrict,
  constraint storage_file_versions_revision_unique
    unique (organization_id, entry_id, revision)
);

alter table bakery.storage_entries
  add constraint storage_entries_current_version_fk
    foreign key (organization_id, current_version_id)
    references bakery.storage_file_versions (organization_id, id)
    on delete set null (current_version_id);

-- Quota sums and the trash and scratch sweeps read by these keys.
create index storage_entries_scope_idx
  on bakery.storage_entries (organization_id, scope_key);
create index storage_entries_trashed_idx
  on bakery.storage_entries (organization_id, trashed_at desc, id desc)
  where trashed_at is not null;
create index storage_file_versions_entry_idx
  on bakery.storage_file_versions (organization_id, entry_id, revision desc);

-- The organization's storage limits (O42). A missing row means the defaults
-- in storage-areas.ts; a row stores every value explicitly.
create table bakery.storage_settings (
  organization_id uuid primary key,
  working_versions_kept integer not null,
  trash_retention_days integer not null,
  scratch_retention_days integer not null,
  max_file_bytes bigint not null,
  organization_quota_bytes bigint not null,
  project_quota_bytes bigint not null,
  personal_quota_bytes bigint not null,
  version integer not null default 1,
  updated_by_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint storage_settings_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint storage_settings_updated_by_fk
    foreign key (updated_by_id) references bakery.principals (id)
    on delete restrict
);

-- Working areas rename, move, trash, restore and purge entries; pruning old
-- versions and the trash and scratch sweeps delete them.
grant update, delete on bakery.storage_entries to bakery_app;
grant select, insert, delete on bakery.storage_file_versions to bakery_app;
grant select, insert, update on bakery.storage_settings to bakery_app;
