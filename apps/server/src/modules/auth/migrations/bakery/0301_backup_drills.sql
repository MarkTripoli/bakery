-- The history of restore drills (issue #64 slice D, also #49): each time the
-- host restores a backup set into an isolated, throwaway database and checks
-- it, the runner reports what it found and how long it took. The drill proves
-- a backup can be restored; this table is the record that it was done, when,
-- and with what backup age (RPO) and recovery time (RTO).
--
-- One row per drill, written once by the runner's report and never updated.
-- The id is chosen by the runner, so reporting the same drill again returns the
-- same row. Counts, names and numbers only: never a path, a key, a row of
-- restored data or any secret. The outcome words and the check names are
-- enforced in TypeScript (the PostgreSQL boundary rail forbids CHECK
-- constraints, triggers and stored routines).
create table bakery.backup_drills (
  id uuid primary key,
  -- The directory name of the backup set that was restored.
  backup_name text not null,
  -- passed | failed
  outcome text not null,
  -- A short stable code when the drill failed; null when it passed.
  failure_code text,
  -- Plain words saying what to do about a failure; null when it passed.
  detail text,
  -- The database-clock cutoff the set recorded, when it had one.
  cutoff_at timestamptz,
  -- Seconds from that cutoff to the start of the drill: the age of the backup,
  -- which is the data a failure at that moment would have lost.
  rpo_seconds integer,
  -- Seconds from the start of the drill to the end of its last check: the time
  -- a restore of this set took on this host.
  rto_seconds integer not null,
  -- [{"check": "<name>", "passed": true|false}], in the order they ran.
  checks jsonb not null,
  started_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create index backup_drills_recorded_idx
  on bakery.backup_drills (recorded_at desc, id desc);

grant select, insert on bakery.backup_drills to bakery_app;
