-- Handoff continuations (chapter 17, "Handoff and interruption protocol"; #33, S2).
--
-- One row records that a source attempt was retired and its job admitted again
-- for a continuation: the source attempt is fenced (lost), the job's fence
-- advances and the job is queued again, all in the transaction that inserts this
-- row. The manifest the continuation was admitted from is pinned here by id, so
-- the target can read exactly the record it was admitted with.
--
-- It is written once and never changed or removed: the application role gets
-- INSERT and SELECT only. The unique key on the manifest is what makes a second
-- winner impossible even if the application's locking were wrong, and the unique
-- key on (job_id, new_fence) says one continuation per fence step.
--
-- `mode` is what the continuation will do, decided by the server when it was
-- admitted: fresh_session now, exact_harness_resume only after the eligibility
-- gate of the next slice has matched the session, host, version, commit and
-- checkpoint. Nothing here validates that; it is validated in TypeScript.

create table bakery.handoff_continuations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  manifest_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  job_id uuid not null,
  source_attempt_id uuid not null,
  previous_fence bigint not null,
  new_fence bigint not null,
  mode text not null,
  admitted_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  constraint handoff_continuations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint handoff_continuations_manifest_fk
    foreign key (organization_id, manifest_id)
    references bakery.handoff_manifests (organization_id, id) on delete cascade,
  constraint handoff_continuations_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint handoff_continuations_job_fk
    foreign key (organization_id, job_id)
    references bakery.jobs (organization_id, id) on delete cascade,
  constraint handoff_continuations_manifest_unique unique (manifest_id),
  constraint handoff_continuations_job_fence_unique unique (job_id, new_fence)
);

create index handoff_continuations_run_step_idx
  on bakery.handoff_continuations (organization_id, run_step_id, created_at desc, id);

grant select, insert on bakery.handoff_continuations to bakery_app;
