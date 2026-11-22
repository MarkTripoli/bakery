-- One release attempt of a merged revision to one environment (#43, B10.06). A
-- row names the exact commit and the digest of the built artifact it deploys,
-- and previous_deployment_id names the release it replaced, which is the one a
-- rollback restores and never changes. The status values follow the delivery
-- adapter contract and are validated by the server, not by the database:
-- queued, deploying, verifying, healthy, degraded, failed, unknown,
-- rolling_back or rolled_back. `unknown` is a real state: the answer to a deploy
-- or a rollback was lost, so the outcome is settled by reading it back with the
-- same external effect, never by a second mutation.
--
-- The partial unique index is the serialization: at most one deployment per
-- repository and environment is in flight, and an `unknown` one counts as in
-- flight so uncertainty blocks further writes. A healthy, degraded or failed
-- deployment is not in flight.
create table bakery.deployments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid not null,
  run_id uuid not null,
  -- preview, staging or production.
  environment text not null,
  commit_sha text not null,
  artifact_digest text not null,
  previous_deployment_id uuid,
  status text not null default 'queued',
  external_effect_id uuid,
  health_evidence_id uuid,
  requested_by_id uuid not null,
  request_id text not null,
  trace_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint deployments_organization_id_unique
    unique (organization_id, id),
  constraint deployments_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete cascade,
  constraint deployments_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint deployments_previous_fk
    foreign key (organization_id, previous_deployment_id)
    references bakery.deployments (organization_id, id),
  constraint deployments_external_effect_fk
    foreign key (organization_id, external_effect_id)
    references bakery.external_effects (organization_id, id),
  constraint deployments_health_evidence_fk
    foreign key (organization_id, health_evidence_id)
    references bakery.artifact_versions (organization_id, id),
  constraint deployments_requester_fk
    foreign key (requested_by_id) references bakery.principals (id)
    on delete restrict
);

create unique index deployments_in_flight_unique
  on bakery.deployments (organization_id, repository_id, environment)
  where status in ('queued', 'deploying', 'verifying', 'rolling_back', 'unknown');

create index deployments_list_idx
  on bakery.deployments (organization_id, created_at desc, id desc);

-- The release serving an environment is its newest healthy or degraded one.
create index deployments_environment_idx
  on bakery.deployments (organization_id, repository_id, environment, created_at desc);

grant select, insert, update on bakery.deployments to bakery_app;
