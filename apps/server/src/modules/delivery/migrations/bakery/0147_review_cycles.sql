-- Independent review and bounded repair evidence (issue #94). Three
-- insert-only tables, one row per fact:
--   review_cycles      one independent review of one exact candidate: the head,
--                      base and effective policy it judged, the reviewer's
--                      server-created agent session and worker principal, and
--                      the implementing session and principal it reviewed. The
--                      worker host, attempt and fence that produced the report
--                      are kept like check_runs does.
--   review_findings    the structured findings a cycle reported, one row per
--                      fingerprint, with the severity, path, line and detail.
--   delivery_decisions the proceed, repair or stop decision taken after a
--                      cycle (or after a failed review job, which has no
--                      cycle), with the failed checks, blocking fingerprints
--                      and loop limits it was taken under.
-- No update or delete grant exists, so evidence cannot be rewritten after it is
-- recorded. A row goes only with its run, so the session foreign keys cascade
-- like the run's own steps and sessions do. A finding is never marked resolved
-- here: whether it is resolved is derived from later cycles. status, severity,
-- decision and reason are vocabulary enforced in TypeScript, never here.
-- reviewer_principal_id and implementer_principal_id are worker principals,
-- which are not scoped to one organization, so they carry no composite foreign
-- key. job_id, attempt_id and fence carry no foreign key either, as in
-- check_runs, so recording a cycle takes no lock on the job, attempt or step
-- rows. Structure only.
create table bakery.review_cycles (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  job_id uuid,
  attempt_id uuid,
  fence bigint,
  ordinal integer not null,
  reviewer_session_id uuid not null,
  reviewer_principal_id uuid not null,
  implementer_session_id uuid not null,
  implementer_principal_id uuid not null,
  head_sha text not null,
  base_sha text not null,
  policy_digest text not null,
  status text not null,
  finding_count integer not null,
  blocking_count integer not null,
  created_at timestamptz not null default now(),
  constraint review_cycles_organization_id_unique
    unique (organization_id, id),
  constraint review_cycles_run_ordinal_unique
    unique (organization_id, run_id, ordinal),
  constraint review_cycles_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete cascade,
  constraint review_cycles_reviewer_session_fk
    foreign key (organization_id, reviewer_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete cascade,
  constraint review_cycles_implementer_session_fk
    foreign key (organization_id, implementer_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete cascade
);

-- A job attempt records one cycle per fence. A cycle that no job produced
-- leaves job_id null, so the index is partial.
create unique index review_cycles_job_fence_unique
  on bakery.review_cycles (organization_id, job_id, fence)
  where job_id is not null;
create index review_cycles_reviewer_session_idx
  on bakery.review_cycles (organization_id, reviewer_session_id);

create table bakery.review_findings (
  id uuid primary key,
  organization_id uuid not null,
  review_cycle_id uuid not null,
  fingerprint text not null,
  severity text not null,
  path text not null,
  line integer,
  body text not null,
  created_at timestamptz not null default now(),
  constraint review_findings_organization_id_unique
    unique (organization_id, id),
  constraint review_findings_cycle_fingerprint_unique
    unique (review_cycle_id, fingerprint),
  constraint review_findings_cycle_fk
    foreign key (organization_id, review_cycle_id)
    references bakery.review_cycles (organization_id, id)
    on delete cascade
);

create index review_findings_cycle_idx
  on bakery.review_findings (organization_id, review_cycle_id, id);

create table bakery.delivery_decisions (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  ordinal integer not null,
  review_cycle_id uuid,
  decision text not null,
  reason text not null,
  head_sha text not null,
  base_sha text,
  policy_digest text,
  failed_checks jsonb not null,
  blocking_fingerprints jsonb not null,
  limits jsonb not null,
  created_at timestamptz not null default now(),
  constraint delivery_decisions_organization_id_unique
    unique (organization_id, id),
  constraint delivery_decisions_run_ordinal_unique
    unique (organization_id, run_id, ordinal),
  constraint delivery_decisions_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete cascade,
  constraint delivery_decisions_cycle_fk
    foreign key (organization_id, review_cycle_id)
    references bakery.review_cycles (organization_id, id)
    on delete cascade
);

create index delivery_decisions_cycle_idx
  on bakery.delivery_decisions (organization_id, review_cycle_id);

grant select, insert on bakery.review_cycles to bakery_app;
grant select, insert on bakery.review_findings to bakery_app;
grant select, insert on bakery.delivery_decisions to bakery_app;
