-- Outside storage mounted under /connections (chapter 25 section 17.4, O38,
-- slice F9, #452). A connection whose provider serves the storage family is
-- mounted as a folder under /connections and read through the provider's port:
-- nothing is copied until a run uses a file, which ingests it into an artifact
-- version. One-way sync is a workflow over the same ingest; writing out is a
-- keyed external effect (bakery.external_effects). No two-way sync.
--
-- Structure only. Who may mount, read or sync, and the one-of rules, live in
-- TypeScript (apps/server/src/modules/knowledge/storage-connections.ts): the
-- PostgreSQL boundary rails refuse CHECK constraints, triggers and functions.

-- One mount per connection: the folder under /connections it appears as.
create table bakery.storage_connection_mounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  entry_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint storage_connection_mounts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint storage_connection_mounts_org_id_unique
    unique (organization_id, id),
  constraint storage_connection_mounts_connection_unique
    unique (organization_id, connection_id),
  constraint storage_connection_mounts_entry_unique
    unique (organization_id, entry_id),
  constraint storage_connection_mounts_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  constraint storage_connection_mounts_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint storage_connection_mounts_created_by_fk
    foreign key (created_by) references bakery.principals (id)
);

grant select, insert on bakery.storage_connection_mounts to bakery_app;

-- The ingest ledger: one row per remote file revision brought into Bakery,
-- keyed by mount, remote path and remote revision so a repeated use returns
-- the same artifact version. The version goes with its bytes: collecting the
-- version removes the row, and the next use ingests again.
create table bakery.storage_connection_ingests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  mount_id uuid not null,
  remote_path text not null,
  remote_revision text not null,
  artifact_id uuid not null,
  artifact_version_id uuid not null,
  sha256 text not null,
  size_bytes bigint not null,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint storage_connection_ingests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint storage_connection_ingests_org_id_unique
    unique (organization_id, id),
  constraint storage_connection_ingests_revision_unique
    unique (organization_id, mount_id, remote_path, remote_revision),
  constraint storage_connection_ingests_mount_fk
    foreign key (organization_id, mount_id)
    references bakery.storage_connection_mounts (organization_id, id)
    on delete cascade,
  constraint storage_connection_ingests_artifact_fk
    foreign key (organization_id, artifact_id)
    references bakery.artifacts (organization_id, id) on delete cascade,
  constraint storage_connection_ingests_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id)
    on delete cascade,
  constraint storage_connection_ingests_created_by_fk
    foreign key (created_by) references bakery.principals (id)
);

-- The artifact a remote path already has, newest ingest first.
create index storage_connection_ingests_path_idx
  on bakery.storage_connection_ingests
  (organization_id, mount_id, remote_path, created_at desc, id);

grant select, insert on bakery.storage_connection_ingests to bakery_app;

-- One-way syncs: a remote folder ingested into a work item, run by the
-- storage sync workflow. change_position is the provider's change-feed
-- position the last run reached; null before the first run. paused_at stops
-- the workflow from running it.
create table bakery.storage_connection_syncs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  mount_id uuid not null,
  remote_path text not null,
  task_id uuid not null,
  change_position text,
  last_run_at timestamptz,
  paused_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint storage_connection_syncs_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint storage_connection_syncs_org_id_unique
    unique (organization_id, id),
  constraint storage_connection_syncs_mount_fk
    foreign key (organization_id, mount_id)
    references bakery.storage_connection_mounts (organization_id, id)
    on delete cascade,
  constraint storage_connection_syncs_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint storage_connection_syncs_created_by_fk
    foreign key (created_by) references bakery.principals (id)
);

-- The workflow takes syncs least recently run first, keyset by id.
create index storage_connection_syncs_due_idx
  on bakery.storage_connection_syncs (last_run_at nulls first, id);

-- The organization's syncs, oldest first, keyset by (created_at, id).
create index storage_connection_syncs_page_idx
  on bakery.storage_connection_syncs (organization_id, created_at, id);

grant select, insert on bakery.storage_connection_syncs to bakery_app;
grant update (change_position, last_run_at, paused_at, updated_at, version)
  on bakery.storage_connection_syncs to bakery_app;
