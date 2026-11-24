-- Issue #25 slice C: machine retirement.
--
-- Revocation stops authority immediately; archive hides a revoked host from
-- the default machine list while every historical reference stays intact
-- (docs/technical-design/21-machines.md, "Recover and retire"). The cleanup
-- columns record what Bakery knows about removing its own files from the
-- host: requested at revocation, and confirmed only from host evidence. The
-- state vocabulary and its rules live in TypeScript (execution/machines.ts);
-- no CHECK constraints, triggers or RLS here.
alter table bakery.worker_hosts
  add column cleanup_state text not null default 'not_requested',
  add column cleanup_requested_at timestamptz,
  add column cleanup_confirmed_at timestamptz;

create index worker_hosts_unarchived_list_idx
  on bakery.worker_hosts (organization_id, created_at, id)
  where archived_at is null;

grant update (
    archived_at, cleanup_state, cleanup_requested_at, cleanup_confirmed_at
  )
  on bakery.worker_hosts
  to bakery_app;
