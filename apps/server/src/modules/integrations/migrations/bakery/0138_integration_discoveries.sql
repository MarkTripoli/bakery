-- Admin-requested resource rediscovery scans (issue #488). One row per
-- integrationDiscoveries.create: the scan an Inngest function runs for one
-- connection, no earlier than not_before, which paces scans of one
-- installation in Postgres across all its connections. At most one queued
-- or running scan per connection. Only a complete, successful scan changes
-- resource availability; partial, throttled and refused scans leave the
-- inventory untouched. Structure only: the queued/running/completed/partial/
-- failed lifecycle is enforced in TypeScript.
create table bakery.integration_discoveries (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  requested_by uuid not null,
  status text not null,
  outcome_code text,
  not_before timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  listed_count integer,
  unavailable_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_discoveries_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_discoveries_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  constraint integration_discoveries_installation_fk
    foreign key (installation_id)
    references bakery.integration_installations (id),
  constraint integration_discoveries_requested_by_fk
    foreign key (requested_by) references bakery.principals (id)
);

-- One active scan per connection: a second request answers the first.
create unique index integration_discoveries_active_unique
  on bakery.integration_discoveries (connection_id)
  where status in ('queued', 'running');

-- Per-installation pacing reads the latest scheduled scan.
create index integration_discoveries_installation_pacing
  on bakery.integration_discoveries (installation_id, not_before desc);

-- Recovery re-sends the event for scans left queued or running.
create index integration_discoveries_stale
  on bakery.integration_discoveries (updated_at)
  where status in ('queued', 'running');

grant select, insert on bakery.integration_discoveries to bakery_app;
grant update (status, outcome_code, started_at, completed_at, listed_count,
  unavailable_count, updated_at, version)
  on bakery.integration_discoveries to bakery_app;

-- The lifecycle sweep's batch order: when reconciliation of an installation
-- was last attempted, successful or not, so an installation whose reconcile
-- keeps failing yields its place to the others. last_checked_at still means
-- the last successful read of GitHub's state.
alter table bakery.integration_installations
  add column reconcile_attempted_at timestamptz;

grant update (reconcile_attempted_at)
  on bakery.integration_installations to bakery_app;
