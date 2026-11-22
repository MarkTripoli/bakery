-- Backups (issue #80 slice S1a): the server's record of what was asked for and
-- what the host runner reported. The server never holds backup bytes or the
-- age private key; a privileged host runner takes the backup and reports back
-- here with its own credential. All validation (status values, transitions,
-- the lease, the report sequence) is enforced in TypeScript; the PostgreSQL
-- boundary rail forbids CHECK constraints, triggers and stored routines.

create table bakery.backup_runs (
  id uuid primary key default gen_random_uuid(),
  -- 'manual' is a person asking now; 'scheduled' is reserved for slice S1b.
  trigger_kind text not null,
  -- requested -> claimed -> running -> completed | failed
  status text not null,
  requested_by_principal_id uuid
    references bakery.principals (id) on delete set null,
  requested_at timestamptz not null default now(),
  -- The runner's claim. Only the hash of the lease token is stored; the lease
  -- ends at lease_expires_at and an expired claim may be taken again.
  claimed_at timestamptz,
  lease_token_hash text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Highest report sequence applied: a replayed report is answered from the
  -- row, a gap or a regression is refused.
  report_sequence integer not null default 0,
  -- Digest of the last applied report body (without the lease token), so the
  -- same sequence sent again is recognised as a replay or as a different body.
  last_report_digest text,
  progress_percent integer,
  size_bytes bigint,
  -- Where the finished backup is kept, as stable words: 'server-host' and
  -- later 'off-site'.
  locations text[] not null default '{}',
  -- A stable code (disk_full, destination_refused, ...) and the destination's
  -- own answer text, so the page can say the cause and the fix.
  failure_code text,
  failure_detail text,
  version integer not null default 1
);

-- One backup at a time per installation, without a trigger: at most one row
-- may be taken (claimed or running), and at most one request may be waiting,
-- so asking twice returns the waiting request.
create unique index backup_runs_one_active
  on bakery.backup_runs ((true))
  where status in ('claimed', 'running');
create unique index backup_runs_one_waiting
  on bakery.backup_runs ((true))
  where status = 'requested';

-- The list: newest first, keyset on (requested_at, id).
create index backup_runs_list_idx
  on bakery.backup_runs (requested_at desc, id desc);

-- The one credential the host runner presents. One row per installation (id is
-- always true); only the hash is stored, and the secret is shown once when it
-- is issued. Rotating bumps generation and replaces the hash.
create table bakery.backup_runner_credentials (
  id boolean primary key,
  token_hash text not null,
  generation integer not null default 1,
  issued_by_principal_id uuid
    references bakery.principals (id) on delete set null,
  issued_at timestamptz not null default now(),
  last_used_at timestamptz
);

grant select, insert (
  trigger_kind, status, requested_by_principal_id, requested_at
) on bakery.backup_runs to bakery_app;
grant update (
  status, claimed_at, lease_token_hash, lease_expires_at, started_at,
  finished_at, report_sequence, last_report_digest, progress_percent, size_bytes, locations,
  failure_code, failure_detail, version
) on bakery.backup_runs to bakery_app;

grant select, insert (
  id, token_hash, generation, issued_by_principal_id, issued_at
) on bakery.backup_runner_credentials to bakery_app;
grant update (
  token_hash, generation, issued_by_principal_id, issued_at, last_used_at
) on bakery.backup_runner_credentials to bakery_app;
