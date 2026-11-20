-- What a sandboxed probe said about one blob's bytes (chapter 25 section 17.6,
-- #437 slice 2).
--
-- The probe runs in a subprocess that costs a memory cap, a CPU quota and up to
-- ten seconds of wall clock. That is too expensive to repeat every time an
-- artifact pane opens, and the answer never changes for the same bytes: a
-- blob is stored once per organization under its SHA-256, and its content
-- cannot be rewritten. So the answer is recorded against the blob, and a
-- reader reuses it.
--
-- The key is the blob, not the artifact version. Two versions that share bytes
-- -- a revert, a re-upload of the same file -- share one probe, which is the
-- truth about deduplication and not a shortcut.
--
-- Two columns carry the honesty of the record:
--
-- * `status` is 'described' or 'refused'. A refusal is kept, not retried on
--   every read: a 300 MB file will be too large tomorrow as well, and the
--   reader still needs to be told why the file is not previewed.
-- * There is no 'failed' status. A probe that could not run at all -- no user
--   bus on this host, a launcher that did not start -- writes nothing, so the
--   next read tries again. Recording a host's bad afternoon as a property of
--   the file would be the one thing this table must never do.
--
-- Deterministic in, deterministic out: the same bytes give the same row, so
-- the upsert is idempotent and two requests racing on one blob agree.
create table bakery.blob_probes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  blob_id uuid not null,
  status text not null,
  kind text,
  media_type text,
  byte_length bigint,
  width integer,
  height integer,
  duration_ms bigint,
  line_count bigint,
  utf8 boolean,
  failure_code text,
  failure_limit bigint,
  probed_at timestamptz not null default now(),
  constraint blob_probes_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  -- The blob row carries the organization, so a probe can never describe
  -- another tenant's bytes.
  constraint blob_probes_blob_fk
    foreign key (organization_id, blob_id)
    references bakery.blobs (organization_id, id)
    on delete cascade,
  -- One answer per blob: this is the cache key, and a second row would make
  -- "what did the probe say" ambiguous.
  constraint blob_probes_blob_unique unique (organization_id, blob_id),
  constraint blob_probes_status_check
    check (status in ('described', 'refused')),
  -- A described blob says what it is; a refused one says why it is not.
  constraint blob_probes_shape_check
    check (
      (status = 'described' and kind is not null and media_type is not null
        and byte_length is not null and failure_code is null)
      or (status = 'refused' and failure_code is not null and kind is null
        and media_type is null and byte_length is null)
    )
);

-- Reading a blob's probe is by (organization, blob), which the unique
-- constraint already indexes. The other question -- "which blobs have no
-- probe yet" -- is answered by a plain anti-join over the blobs of one
-- organization:
--   select b.id from bakery.blobs b
--   where b.organization_id = $1
--     and not exists (
--       select 1 from bakery.blob_probes p
--       where p.organization_id = b.organization_id and p.blob_id = b.id
--     );
-- A partial index cannot express that predicate (Postgres refuses subqueries
-- in an index predicate), and a queue column here would be state that can fall
-- out of date with the rows it describes.

grant select, insert, update on bakery.blob_probes to bakery_app;
