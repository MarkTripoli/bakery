-- The cutoff of a backup (issue #64 slice C, also #49): the moment the
-- installation was quiet and the snapshot began, taken from the database
-- clock, with a census of the external effects that could still reach a
-- provider at that moment. A restore must know what may have happened AFTER
-- the backup so it never replays an effect whose outcome is unknown.
--
-- One row per backup run, written once by the runner's cutoff request while the
-- run holds the quiesced installation and BEFORE the dumps start, so the row is
-- inside the dump it describes: a restored database carries its own cutoff.
-- Counts only (never an effect's arguments, target or id); the digest is a
-- SHA-256 over the sorted ids of those effects, so a restored database can be
-- checked against it. Rows are never updated.
create table bakery.backup_cutoffs (
  run_id uuid primary key
    references bakery.backup_runs (id) on delete cascade,
  cutoff_at timestamptz not null,
  effects_total integer not null,
  effects_prepared integer not null,
  effects_submitted integer not null,
  effects_uncertain integer not null,
  -- [{"operation": "<name>", "count": <n>}], sorted by operation.
  effects_by_operation jsonb not null,
  effects_digest text not null,
  created_at timestamptz not null default now()
);

grant select, insert on bakery.backup_cutoffs to bakery_app;
