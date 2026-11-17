-- A run's declared inputs, resolved to exact artifact versions at admission.
--
-- This is deliberately a second pin, distinct from a person's indefinite hold
-- (bakery.artifacts.pinned_at): it is created when the run is admitted, carries
-- the digest the bytes had at that moment, and ends with the run. Keeping the
-- two apart is what lets a run pin outlive a person's unpin and lets a person's
-- hold survive the run's end.
create table bakery.run_input_pins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  artifact_id uuid not null,
  artifact_version_id uuid not null,
  sha256 text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  constraint run_input_pins_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_input_pins_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_input_pins_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete cascade,
  constraint run_input_pins_version_unique
    unique (organization_id, run_id, artifact_version_id)
);

create index run_input_pins_run_idx
  on bakery.run_input_pins (organization_id, run_id, id);
create index run_input_pins_version_idx
  on bakery.run_input_pins (organization_id, artifact_version_id);

-- The pin is written once at admission and never rewritten: there is no update
-- grant, so a served digest cannot drift under a live run.
grant select, insert on bakery.run_input_pins to bakery_app;
