-- Route continuations (#26 slice 6a): the record that a stalled step was
-- continued on another route.
--
-- A step pinned to a route with an open incident can be continued on another
-- route. Admission is the next slice and a command of its own; this slice only
-- states what an admission leaves behind, so the offers read can stop offering a
-- choice that was already made and the admission has one row to be unique on.
--
-- Only an admitted continuation is stored. A choice that turns out stale (the
-- incident recovered, the run was canceled, someone else switched first) commits
-- nothing, so there is no "stale" or "refused" row and no status column: a row
-- exists exactly when a continuation happened.
--
-- One continuation per step and incident generation. A second would mean two
-- producers for one stalled step, which is the case the whole slice exists to
-- make impossible, so the structure states it and a mistaken writer cannot
-- satisfy it silently. A *newer* incident on the same route is a new generation
-- and may be continued again.
--
-- No CHECK constraint, trigger or policy; which transitions are allowed is the
-- application's rule. The reads run as `bakery_app`, so SELECT is granted here;
-- the admission's INSERT arrives with the code that needs it.

create table bakery.route_continuations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  job_id uuid not null,
  incident_id uuid not null,
  -- The incident's generation when the choice was offered and admitted.
  incident_generation integer not null,
  source_route_id uuid not null,
  target_route_id uuid not null,
  admitted_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  constraint route_continuations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint route_continuations_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint route_continuations_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint route_continuations_job_fk
    foreign key (organization_id, job_id)
    references bakery.jobs (organization_id, id) on delete cascade,
  constraint route_continuations_incident_fk
    foreign key (organization_id, incident_id)
    references bakery.provider_incidents (organization_id, id)
    on delete restrict,
  constraint route_continuations_source_route_fk
    foreign key (organization_id, source_route_id)
    references bakery.provider_routes (organization_id, id)
    on delete restrict,
  constraint route_continuations_target_route_fk
    foreign key (organization_id, target_route_id)
    references bakery.provider_routes (organization_id, id)
    on delete restrict,
  constraint route_continuations_step_generation_unique
    unique (organization_id, run_step_id, incident_generation)
);

create index route_continuations_run_idx
  on bakery.route_continuations (organization_id, run_id, created_at desc);

grant select on bakery.route_continuations to bakery_app;
