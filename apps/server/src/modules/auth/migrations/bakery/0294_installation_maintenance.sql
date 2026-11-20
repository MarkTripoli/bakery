-- Installation maintenance (issue #64 slice B): the one switch a backup holds
-- while it takes a consistent snapshot. While it is draining or quiesced the
-- server admits no new work (runs, imports, worker claims, collection) and
-- answers a retryable 503 INSTALLATION_QUIESCED instead. A webhook delivery is
-- accepted and stored, and its routes wait until the hold ends.
--
-- One row per installation (id is always true). Only the host backup runner
-- sets it, in TypeScript, for the backup run it holds. The switch is
-- lease-bound: it is active only while state is not 'off' AND lease_expires_at
-- is in the future, so a runner that dies leaves nothing stuck. The check is
-- made on read; nothing sweeps this row. A terminal report of the owning run
-- puts it back to 'off'.
--
-- Structure only: the state words, who may write and the lease rule are
-- enforced in TypeScript (the PostgreSQL boundary rail forbids CHECK
-- constraints, triggers and stored routines).

create table bakery.installation_maintenance (
  id boolean primary key,
  -- off | draining | quiesced
  state text not null,
  -- Why the installation is held: 'backup' today.
  reason text not null,
  -- The backup run that holds it. Null once that run row is gone.
  owner_run_id uuid
    references bakery.backup_runs (id) on delete set null,
  entered_at timestamptz not null,
  lease_expires_at timestamptz not null,
  version integer not null default 1
);

grant select, insert (
  id, state, reason, owner_run_id, entered_at, lease_expires_at, version
) on bakery.installation_maintenance to bakery_app;
grant update (
  state, reason, owner_run_id, entered_at, lease_expires_at, version
) on bakery.installation_maintenance to bakery_app;
