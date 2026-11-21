-- The storage tree (chapter 25 section 17, slice F2, #444): folders and files at
-- places in one virtual tree per organization. A path is a name, not an
-- identity (O34): an entry has a stable id, and renaming or moving it changes
-- this row only.
--
-- Rules for this table:
-- * kind and policy are bounded text; their vocabularies are enforced in
--   TypeScript (apps/server/src/modules/knowledge/storage-tree.ts). The
--   PostgreSQL boundary rails forbid CHECK constraints, triggers and functions.
-- * A file entry points at an artifact. Its current version is that artifact's
--   own `current_version_id`, so projecting an existing artifact moves no data
--   and writes no artifact or version row.
-- * name_key is the name after normalization and case folding. Names are unique
--   per folder by name_key (nulls not distinct, so top-level entries compare
--   too).
-- * system_key names a folder Bakery made (for example `projects` or
--   `task:<uuid>`), so ensuring the default layout is idempotent and finds its
--   folders without walking paths.
-- * One entry per artifact: a second projection of the same artifact is a
--   no-op.
-- * bakery_app has SELECT and INSERT only for now. Rename, move and trash arrive
--   with the working areas and grant their own updates.
create table bakery.storage_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  parent_id uuid,
  name text not null,
  name_key text not null,
  kind text not null,
  policy text not null,
  artifact_id uuid,
  system_key text,
  created_at timestamptz not null default now(),
  constraint storage_entries_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint storage_entries_organization_id_unique
    unique (organization_id, id),
  constraint storage_entries_parent_fk
    foreign key (organization_id, parent_id)
    references bakery.storage_entries (organization_id, id) on delete restrict,
  constraint storage_entries_artifact_fk
    foreign key (organization_id, artifact_id)
    references bakery.artifacts (organization_id, id) on delete cascade,
  constraint storage_entries_name_unique
    unique nulls not distinct (organization_id, parent_id, name_key),
  constraint storage_entries_artifact_unique
    unique (organization_id, artifact_id),
  constraint storage_entries_system_key_unique
    unique (organization_id, system_key)
);

grant select, insert on bakery.storage_entries to bakery_app;

-- A run input may name a storage path (#444). Admission resolves it to the
-- entry's current version and the run keeps that pin, not the path. This
-- records, per input, which entry and path the version came from: the path is
-- only a label, and the ids and digest are what the run pinned. Append-only, so
-- a later move or new version cannot rewrite what a run resolved.
create table bakery.run_input_paths (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  input_name text not null,
  storage_path text not null,
  entry_id uuid,
  artifact_id uuid not null,
  artifact_version_id uuid not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  constraint run_input_paths_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_input_paths_run_input_unique
    unique (organization_id, run_id, input_name)
);

grant select, insert on bakery.run_input_paths to bakery_app;
