-- Fenced handoff manifests (chapter 17, "Worker handoff manifest"; issue #33, S1).
--
-- A manifest is the source session's bounded record of where it stopped: the
-- repository state, accepted decisions, exact context selection, recent checks,
-- effects still to reconcile and a durable checkpoint. It is a record and never
-- the authority for run state: on any conflict the run-step, attempt/fence,
-- artifact, conversation and external-effect rows win. Nothing here validates
-- that; the server checks and recomputes the safe boundary in TypeScript before
-- a row is written, and a row is only ever read as a claim to be re-verified.
--
-- One manifest per source attempt (and so per fence): the same bytes replay, a
-- different manifest for the same attempt is a conflict the route reports. The
-- row is written before the source is retired, so a crash between the two
-- leaves a manifest and a live attempt, never a retired attempt with nothing to
-- continue from.
--
-- `status` moves only forward and only by the coordinator transition that
-- retires the source and admits the continuation (a later slice):
--   pending    written, source still live
--   continued  the source was retired and a continuation admitted
--   blocked    continuation was refused (capture incomplete, effects unresolved)
--
-- `digest` is the SHA-256 of the canonical manifest the server stored (with its
-- own safe-boundary value), so a reader can tell two manifests apart and a
-- continuation can pin exactly the one it was admitted with.

create table bakery.handoff_manifests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  source_attempt_id uuid not null,
  -- The fence of the source attempt when the manifest was written.
  source_fence bigint not null,
  mode text not null,
  digest text not null,
  -- SHA-256 of the manifest exactly as the source sent it, before the server
  -- replaced its safe boundary and pending effects. A retry is compared on this,
  -- so the same bytes replay even after an effect settles or an event lands.
  request_digest text not null,
  -- Server-computed; the source's own claim is never stored here.
  safe_boundary boolean not null,
  status text not null default 'pending',
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint handoff_manifests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint handoff_manifests_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint handoff_manifests_source_attempt_fk
    foreign key (organization_id, source_attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint handoff_manifests_organization_id_unique
    unique (organization_id, id),
  constraint handoff_manifests_source_attempt_unique
    unique (source_attempt_id)
);

-- A run's manifests, newest first, for the read path and the continuation.
create index handoff_manifests_run_step_idx
  on bakery.handoff_manifests (organization_id, run_step_id, created_at desc, id);

grant select, insert on bakery.handoff_manifests to bakery_app;
grant update (status, updated_at, version) on bakery.handoff_manifests to bakery_app;
