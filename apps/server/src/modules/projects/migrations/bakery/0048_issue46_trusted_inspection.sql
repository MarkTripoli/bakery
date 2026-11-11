-- Main/applied ledger preflight: base 539b5521515c10f0ce74f12cc312ba17f4104c76,
-- latest 0047_issue46_repository_slug_uniqueness. Published migrations stay immutable.
-- TypeScript authorizes standalone repository.inspect jobs and validates all
-- inspection bounds/lifecycle state. PostgreSQL supplies relational identity only.
alter table bakery.jobs
  alter column run_step_id drop not null,
  add constraint jobs_inspection_scope_unique
    unique (organization_id, application_id, repository_id, id);

grant insert (id, requirements) on bakery.jobs to bakery_app;

alter table bakery.job_attempts
  add constraint job_attempts_inspection_scope_unique
    unique (organization_id, job_id, id);

-- #44 mapping revisions are operator-owned strings, not numeric counters.
-- Preserve already published numeric revisions without modifying old SQL bytes.
alter table bakery.repository_profile_observations
  drop constraint repository_profile_observations_source_mapping_revision_check,
  alter column source_mapping_revision type text using source_mapping_revision::text;

create table bakery.repository_onboardings (
  id uuid primary key,
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid not null,
  job_id uuid not null,
  requested_by uuid not null,
  input jsonb not null,
  input_digest text not null,
  source_envelope text not null,
  source_attempt_id uuid,
  source_next_offset integer not null default 0,
  published_profile_id uuid,
  published_profile_revision integer,
  published_profile_digest text,
  observation_id uuid,
  observation_digest text,
  base_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_onboardings_organization_fk
    foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint repository_onboardings_repository_fk
    foreign key (organization_id, application_id, repository_id)
    references bakery.repositories (organization_id, application_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_onboardings_job_fk
    foreign key (organization_id, application_id, repository_id, job_id)
    references bakery.jobs (organization_id, application_id, repository_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_onboardings_requester_fk
    foreign key (requested_by) references bakery.principals (id) on delete restrict,
  constraint repository_onboardings_source_attempt_fk
    foreign key (organization_id, job_id, source_attempt_id)
    references bakery.job_attempts (organization_id, job_id, id)
    on delete no action deferrable initially deferred,
  constraint repository_onboardings_observation_fk
    foreign key (
      organization_id, application_id, repository_id, observation_id,
      published_profile_id, published_profile_revision, published_profile_digest,
      observation_digest, base_sha
    ) references bakery.repository_profile_observations (
      organization_id, application_id, repository_id, id, profile_id,
      profile_revision, profile_digest, observation_digest, base_sha
    ) on delete no action deferrable initially deferred,
  constraint repository_onboardings_job_unique unique (organization_id, job_id),
  constraint repository_onboardings_profile_unique unique (organization_id, published_profile_id),
  constraint repository_onboardings_observation_unique unique (organization_id, observation_id)
);
create index repository_onboardings_repository_idx
  on bakery.repository_onboardings (organization_id, repository_id, created_at desc, id desc);

grant select on bakery.repository_onboardings to bakery_app;
grant insert (
  id, organization_id, application_id, repository_id, job_id, requested_by,
  input, input_digest, source_envelope
) on bakery.repository_onboardings to bakery_app;
grant update (
  source_attempt_id, source_next_offset,
  published_profile_id, published_profile_revision, published_profile_digest,
  observation_id, observation_digest, base_sha, updated_at
) on bakery.repository_onboardings to bakery_app;
