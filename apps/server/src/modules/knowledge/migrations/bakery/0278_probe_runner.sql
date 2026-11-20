-- The probe runner: what still needs asking, and where an answer can live
-- (#437 slice 4).
--
-- Slice 2 gave the probe a store and slice 3 gave it two readers, but nothing
-- ever ran a probe: every answer a reader saw was either a row somebody wrote in
-- a test or "nobody has asked". This migration adds the two things a runner
-- needs, and nothing else.
--
-- ## What to ask
--
-- `probe_requests` is a queue, not a log. A version write inserts one row and
-- returns; the write never waits for a sandbox. The runner takes rows oldest
-- first, and the unique constraint means writing the same version twice queues
-- it once.
--
-- ## Where an answer can live
--
-- `blob_probes` used to key on a blob, which was true while every probed thing
-- had one. Bytes under the inline limit are written into the version row itself,
-- and there are two such rows: a storage file version, and an artifact version
-- written on a server with no object store. Neither has a blob to key on. The key
-- becomes exactly one of three shapes:
--
--   * (organization_id, blob_id)             -- bytes shared by every version
--                                               that has them, because a blob is
--                                               deduplicated by digest;
--   * (organization_id, entry_id, revision)  -- one storage version's own inline
--                                               bytes, which nothing else shares;
--   * (organization_id, artifact_version_id) -- one artifact version's own inline
--                                               bytes, same reason. Artifact
--                                               revisions are per artifact, not
--                                               per line, so the version id is
--                                               the whole address.
--
-- The two CHECKs make that exclusive rather than merely intended, and the three
-- partial uniques keep "one answer per subject" true for every shape. The
-- existing foreign keys are MATCH SIMPLE, so a null half of a key is not
-- enforced and no conditional key is needed.
--
-- A request with no answer row and an answer row with no request are both
-- ordinary: a request is deleted when it completes, and an answer outlives any
-- number of requests for the same bytes.

alter table bakery.blob_probes
  alter column blob_id drop not null,
  add column entry_id uuid,
  add column revision integer,
  add column artifact_version_id uuid;

alter table bakery.blob_probes
  add constraint blob_probes_subject_exclusive_check
    check (
      (blob_id is not null)::int + (entry_id is not null)::int +
      (artifact_version_id is not null)::int = 1
    ),
  add constraint blob_probes_subject_complete_check
    check ((entry_id is null) = (revision is null)),
  add constraint blob_probes_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  add constraint blob_probes_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete cascade;

alter table bakery.blob_probes
  drop constraint blob_probes_blob_unique;

create unique index blob_probes_blob_unique
  on bakery.blob_probes (organization_id, blob_id)
  where blob_id is not null;

create unique index blob_probes_entry_unique
  on bakery.blob_probes (organization_id, entry_id, revision)
  where entry_id is not null;

create unique index blob_probes_artifact_version_unique
  on bakery.blob_probes (organization_id, artifact_version_id)
  where artifact_version_id is not null;

comment on column bakery.blob_probes.entry_id is
  'The storage entry whose inline bytes this answer describes; null unless the subject is a storage version.';
comment on column bakery.blob_probes.revision is
  'The inline version this answer describes; set exactly when entry_id is.';
comment on column bakery.blob_probes.artifact_version_id is
  'The artifact version whose inline bytes this answer describes; null unless the subject is an artifact version.';

-- One row per version still needing an answer. A blob subject asks once per
-- blob however many versions share it, so the two partial uniques below are the
-- deduplication and this table stores no digest of its own.
create table bakery.probe_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  blob_id uuid,
  entry_id uuid,
  revision integer,
  artifact_version_id uuid,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  constraint probe_requests_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint probe_requests_blob_fk
    foreign key (organization_id, blob_id)
    references bakery.blobs (organization_id, id) on delete cascade,
  constraint probe_requests_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint probe_requests_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete cascade,
  -- The same subject rule as the answer table: one blob, or one storage version,
  -- or one artifact version -- never two and never none.
  constraint probe_requests_subject_exclusive_check
    check (
      (blob_id is not null)::int + (entry_id is not null)::int +
      (artifact_version_id is not null)::int = 1
    ),
  constraint probe_requests_subject_complete_check
    check ((entry_id is null) = (revision is null)),
  constraint probe_requests_revision_positive_check
    check (revision is null or revision > 0)
);

create unique index probe_requests_blob_unique
  on bakery.probe_requests (organization_id, blob_id)
  where blob_id is not null;

create unique index probe_requests_entry_unique
  on bakery.probe_requests (organization_id, entry_id, revision)
  where entry_id is not null;

create unique index probe_requests_artifact_version_unique
  on bakery.probe_requests (organization_id, artifact_version_id)
  where artifact_version_id is not null;

-- The runner reads oldest first and skips rows a peer has claimed.
create index probe_requests_pending_idx
  on bakery.probe_requests (requested_at, id);

grant select, insert on bakery.probe_requests to bakery_app;
-- The runner is the database owner: it inserts answers and clears requests.
grant delete on bakery.probe_requests to bakery_app;
