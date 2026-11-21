-- The record of a restore in place (issue #64 slice E1, also #49): when the
-- installation's state was replaced from a backup and what the fence did about
-- work that was running or unsettled at the time.
--
-- A restore replaces the database that would hold its own request, so this row
-- is not a request. It is written by the privileged `restore-fence` task, after
-- the stores were restored and before any service starts, and it is what keeps
-- the installation closed: while a row has no `released_at`, every entry point
-- that starts or changes work refuses with INSTALLATION_RESTORING. Unlike the
-- backup switch there is no lease: nothing renews it, and it must not lapse. It
-- ends only when an administrator completes the ordered steps (slice E3).
--
-- Counts and names only: never an effect's target or arguments, a path, a key or
-- a row of restored data. The row is inserted once by the owner role; the
-- application role may read it. Releasing it is slice E3's grant.
create table bakery.installation_restores (
  id uuid primary key,
  -- The directory name of the backup set that was restored.
  backup_name text not null,
  -- The database-clock cutoff the restored set recorded, when it recorded one.
  cutoff_at timestamptz,
  -- When the fence ran, on the database clock.
  restored_at timestamptz not null default now(),
  -- External effects that were prepared or submitted, now held as uncertain.
  effects_held integer not null,
  -- Worker attempts that were leased, running or canceling, now quarantined.
  attempts_quarantined integer not null,
  -- Jobs those attempts belong to, now awaiting reconciliation.
  jobs_awaiting_reconciliation integer not null,
  -- Worker hosts that were not revoked and now must be enrolled again.
  workers_revoked integer not null,
  -- Set when an administrator completes the re-enable steps; null while held.
  released_at timestamptz,
  created_at timestamptz not null default now()
);

create index installation_restores_held_idx
  on bakery.installation_restores (restored_at desc)
  where released_at is null;

grant select on bakery.installation_restores to bakery_app;
