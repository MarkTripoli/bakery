alter table bakery.run_steps
  add constraint run_steps_prepared_operation_scope_unique
  unique (organization_id, run_id, id);
alter table bakery.jobs
  add constraint jobs_prepared_operation_scope_unique
  unique (organization_id, run_step_id, id);
alter table bakery.job_attempts
  add constraint job_attempts_prepared_operation_scope_unique
  unique (
    organization_id, job_id, id, worker_host_id, worker_session_id,
    worker_session_generation, fence, lease_token_hash
  );

create table bakery.prepared_operations (
  id uuid primary key,
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid not null,
  repository_profile_id uuid not null,
  repository_profile_revision integer not null,
  repository_profile_digest text not null,
  observation_id uuid,
  observation_digest text,
  base_sha text,
  run_id uuid not null,
  run_step_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  worker_session_id uuid not null,
  worker_session_generation bigint not null,
  requester_id uuid not null references bakery.principals(id),
  secret_id uuid not null,
  secret_version_id uuid not null,
  secret_generation integer not null,
  policy_revision integer not null,
  invalidation_generation integer not null,
  verified_provider_account_id text not null,
  provider text not null,
  action text not null,
  input_digest text not null,
  fence bigint not null,
  lease_token_hash text not null,
  lease_expires_at timestamptz not null,
  status text not null,
  expires_at timestamptz not null,
  io_attempt integer not null default 0,
  request_digest text,
  safe_result jsonb,
  safe_code text,
  result_digest text,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, id),
  unique (organization_id, attempt_id),
  unique (organization_id, job_id, attempt_id),
  foreign key (organization_id, application_id)
    references bakery.applications(organization_id, id),
  foreign key (organization_id, repository_id)
    references bakery.repositories(organization_id, id),
  foreign key (
    organization_id, application_id, repository_id,
    repository_profile_id, repository_profile_revision,
    repository_profile_digest
  ) references bakery.repository_profiles(
    organization_id, application_id, repository_id,
    id, revision, digest
  ),
  foreign key (organization_id, run_id)
    references bakery.workflow_runs(organization_id, id),
  foreign key (organization_id, run_id, run_step_id)
    references bakery.run_steps(organization_id, run_id, id),
  foreign key (organization_id, run_step_id, job_id)
    references bakery.jobs(organization_id, run_step_id, id),
  foreign key (
    organization_id, job_id, attempt_id, worker_host_id, worker_session_id,
    worker_session_generation, fence, lease_token_hash
  ) references bakery.job_attempts(
    organization_id, job_id, id, worker_host_id, worker_session_id,
    worker_session_generation, fence, lease_token_hash
  ),
  foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts(organization_id, id),
  foreign key (organization_id, application_id, secret_id)
    references bakery.secrets(organization_id, application_id, id),
  foreign key (secret_id, secret_version_id)
    references bakery.secret_versions(secret_id, id)
);

create index prepared_operations_expiry_idx
  on bakery.prepared_operations (expires_at, id);
create index prepared_operations_job_idx
  on bakery.prepared_operations (organization_id, job_id, id);

grant select, insert on bakery.prepared_operations to bakery_app;
grant update (
  status, io_attempt, request_digest, safe_result, safe_code,
  result_digest, completed_at, updated_at
) on bakery.prepared_operations to bakery_app;
