-- Restore to any minute (issue #80, point-in-time slice P1).
--
-- One installation-wide row: the administrator's switch, and the restorable
-- window the host runner last reported. Postgres archives WAL continuously on
-- the host; the runner copies it off-site and reports what it holds:
--   enabled               the "Restore to any minute" switch (off until set);
--   earliest_restorable_at start of the oldest kept base backup;
--   latest_restorable_at   time of the newest WAL segment copied off-site;
--   latest_segment         that segment's file name, for the operator;
--   reported_at            when the runner last reported.
-- A null bound means the server does not know it yet. No CHECK constraints or
-- triggers: the rules live in TypeScript (`backups/point-in-time.ts`).
create table bakery.backup_point_in_time_settings (
  id text primary key,
  enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  earliest_restorable_at timestamptz,
  latest_restorable_at timestamptz,
  latest_segment text,
  reported_at timestamptz
);

grant select, insert, update on bakery.backup_point_in_time_settings to bakery_app;
