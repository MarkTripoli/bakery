-- Queued Admin purges of record-area files (chapter 25 section 17.5, #447).
--
-- A record-area file is an artifact; its bytes are artifact versions, and
-- only the database owner may clear them (the runtime role has no update on
-- bakery.artifact_versions content, blob_id, purged_at or purge_policy). So an
-- Admin purge of such a file, made as the runtime role inside the request,
-- only records a request here. An owner-privileged job
-- (apps/server/src/modules/knowledge/storage-record-purge.ts) takes pending
-- requests and clears the bytes.
--
-- Rules for this table:
-- * One request per entry: purging the same file twice finds the same
--   request (the unique constraint), it never queues a second one.
-- * completed_at is set by the owner job only. The runtime role may insert and
--   read requests, nothing else. No triggers, functions or CHECK constraints.

create table bakery.storage_purge_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  entry_id uuid not null,
  artifact_id uuid not null,
  requested_by_id uuid not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint storage_purge_requests_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint storage_purge_requests_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint storage_purge_requests_requested_by_fk
    foreign key (requested_by_id) references bakery.principals (id)
    on delete restrict,
  constraint storage_purge_requests_entry_unique
    unique (organization_id, entry_id)
);

-- The owner job reads pending requests oldest first.
create index storage_purge_requests_pending_idx
  on bakery.storage_purge_requests (requested_at, id)
  where completed_at is null;

grant select, insert on bakery.storage_purge_requests to bakery_app;
