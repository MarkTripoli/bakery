-- Worker registration, claims, leases, and the single append-only attempt journal.
-- No row-level security is used; every access path binds organization and host identity.
create table bakery.worker_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  principal_id uuid not null,
  name text not null,
  os text not null,
  architecture text not null,
  allowed_capabilities jsonb not null default '[]'::jsonb,
  slots integer not null,
  token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  worker_host_id uuid,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_enrollments_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_enrollments_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete restrict,
  constraint worker_enrollments_token_unique unique (token_hash),
  constraint worker_enrollments_organization_id_unique unique (organization_id, id)
);
create index worker_enrollments_pending_idx
  on bakery.worker_enrollments (organization_id, expires_at, consumed_at);

create table bakery.worker_enrollment_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  principal_id uuid not null,
  idempotency_key text not null,
  request_digest text not null,
  response_ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_enrollment_replays_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_enrollment_replays_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete restrict,
  constraint worker_enrollment_replays_unique
    unique (organization_id, principal_id, idempotency_key)
);

create table bakery.worker_hosts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  principal_id uuid not null,
  principal_type text not null default 'worker',
  name text not null,
  os text not null,
  architecture text not null,
  capabilities jsonb not null default '[]'::jsonb,
  toolchain_versions jsonb not null default '{}'::jsonb,
  slots integer not null,
  status text not null default 'online',
  desired_mode text not null default 'accepting',
  last_heartbeat_at timestamptz,
  credential_hash text not null,
  credential_generation integer not null default 1,
  worker_session_id uuid,
  worker_session_generation bigint not null default 0,
  protocol_version integer not null default 1,
  inventory_revision integer not null default 1,
  readiness_revision integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint worker_hosts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_hosts_principal_fk
    foreign key (principal_id, principal_type)
    references bakery.principals (id, principal_type) on delete restrict,
  constraint worker_hosts_principal_unique unique (principal_id),
  constraint worker_hosts_credential_unique unique (credential_hash),
  constraint worker_hosts_organization_id_unique unique (organization_id, id)
);
alter table bakery.worker_enrollments
  add constraint worker_enrollments_host_fk
  foreign key (organization_id, worker_host_id)
  references bakery.worker_hosts (organization_id, id) on delete restrict;
create index worker_hosts_claim_idx
  on bakery.worker_hosts (organization_id, status, desired_mode, id);


create table bakery.worker_registration_replays (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null,
  idempotency_key text not null,
  request_digest text not null,
  worker_host_id uuid not null,
  principal_id uuid not null,
  registration_generation integer not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_registration_replays_enrollment_fk
    foreign key (enrollment_id)
    references bakery.worker_enrollments (id) on delete cascade,
  constraint worker_registration_replays_host_fk
    foreign key (worker_host_id)
    references bakery.worker_hosts (id) on delete restrict,
  constraint worker_registration_replays_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete restrict,
  constraint worker_registration_replays_unique
    unique (enrollment_id, idempotency_key)
);

create table bakery.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_step_id uuid,
  conversation_id uuid not null,
  agent_version_id uuid not null,
  harness text not null default 'codex',
  status text not null default 'starting',
  resume_ref jsonb,
  parent_session_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint agent_sessions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint agent_sessions_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint agent_sessions_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint agent_sessions_parent_fk
    foreign key (organization_id, parent_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete set null (parent_session_id),
  constraint agent_sessions_organization_id_unique
    unique (organization_id, id)
);
create index agent_sessions_run_step_idx
  on bakery.agent_sessions (organization_id, run_step_id, id);

create table bakery.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_step_id uuid not null,
  repository_id uuid,
  action text not null,
  requirements jsonb not null default '{}'::jsonb,
  input jsonb not null default '{}'::jsonb,
  current_checkpoints jsonb not null default '[]'::jsonb,
  agent_config jsonb not null default '{}'::jsonb,
  skill_refs jsonb not null default '[]'::jsonb,
  agent_version_id uuid,
  billing jsonb,
  installation_reservation_id uuid,
  status text not null default 'queued',
  available_at timestamptz not null default now(),
  priority integer not null default 0,
  current_fence bigint not null default 0,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint jobs_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint jobs_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint jobs_organization_id_unique unique (organization_id, id),
  constraint jobs_run_step_action_unique unique (run_step_id, action)
);
create index jobs_claim_idx
  on bakery.jobs (organization_id, status, available_at, priority desc, id);

create table bakery.job_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  worker_host_id uuid not null,
  worker_session_id uuid not null,
  worker_session_generation bigint not null,
  attempt_no integer not null,
  fence bigint not null,
  lease_token_hash text not null,
  lease_expires_at timestamptz not null,
  status text not null default 'leased',
  last_event_seq bigint not null default 0,
  version integer not null default 0,
  result jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_attempts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint job_attempts_job_fk
    foreign key (organization_id, job_id)
    references bakery.jobs (organization_id, id) on delete cascade,
  constraint job_attempts_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete restrict,
  constraint job_attempts_organization_id_unique unique (organization_id, id),
  constraint job_attempts_number_unique unique (job_id, attempt_no),
  constraint job_attempts_fence_unique unique (job_id, fence)
);
create index job_attempts_live_host_idx
  on bakery.job_attempts (organization_id, worker_host_id, status, lease_expires_at);
create index job_attempts_session_idx
  on bakery.job_attempts (organization_id, worker_host_id, worker_session_generation, status);

create index job_attempts_job_idx
  on bakery.job_attempts (organization_id, job_id, created_at desc, id desc);

create table bakery.attempt_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  local_seq bigint not null,
  event_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  payload_digest text not null,
  occurred_at timestamptz not null default now(),
  saved_ack jsonb not null,
  constraint attempt_events_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint attempt_events_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint attempt_events_organization_id_unique unique (organization_id, id),
  constraint attempt_events_sequence_unique unique (attempt_id, local_seq),
  constraint attempt_events_identity_unique unique (attempt_id, event_id)
);
create index attempt_events_attempt_seq_idx
  on bakery.attempt_events (organization_id, attempt_id, local_seq);

create table bakery.worker_claim_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  attempt_id uuid,
  claim_key uuid not null,
  request_digest text not null,
  response_status integer not null,
  response_ciphertext text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint worker_claim_replays_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint worker_claim_replays_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_claim_replays_unique
    unique (worker_host_id, claim_key)
);
create index worker_registration_replays_expiry_idx
  on bakery.worker_registration_replays (expires_at);
create index worker_claim_replays_expiry_idx
  on bakery.worker_claim_replays (expires_at);
create index worker_enrollment_replays_expiry_idx
  on bakery.worker_enrollment_replays (expires_at);
create table bakery.worker_lease_renewal_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  idempotency_key text not null,
  request_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_lease_renewal_replays_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint worker_lease_renewal_replays_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_lease_renewal_replays_unique
    unique (organization_id, attempt_id, idempotency_key)
);
create index worker_lease_renewal_replays_expiry_idx
  on bakery.worker_lease_renewal_replays (expires_at);

create table bakery.worker_heartbeat_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_host_id uuid not null,
  idempotency_key text not null,
  request_digest text not null,
  response_status integer not null,
  response_body text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint worker_heartbeat_replays_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_heartbeat_replays_unique
    unique (worker_host_id, idempotency_key)
);
create index worker_heartbeat_replays_expiry_idx
  on bakery.worker_heartbeat_replays (expires_at);






create table bakery.worker_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  message_id uuid,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint worker_commands_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_commands_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint worker_commands_organization_id_unique unique (organization_id, id),
  constraint worker_commands_message_unique unique (attempt_id, message_id)
);
create index worker_commands_pending_idx
  on bakery.worker_commands (organization_id, attempt_id, status, created_at, id);
create index worker_commands_terminal_retention_idx
  on bakery.worker_commands (acknowledged_at, id)
  where status in ('acknowledged', 'rejected');

create table bakery.worker_command_ack_tombstones (
  command_id uuid primary key,
  organization_id uuid not null,
  worker_host_id uuid not null,
  status text not null,
  acknowledged_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint worker_command_ack_tombstones_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_command_ack_tombstones_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint worker_command_ack_tombstones_scope_unique
    unique (organization_id, command_id)
);
create index worker_command_ack_tombstones_expiry_idx
  on bakery.worker_command_ack_tombstones (expires_at, command_id);
create index worker_command_ack_tombstones_host_idx
  on bakery.worker_command_ack_tombstones (
    organization_id, worker_host_id, command_id
  );


-- Route handlers receive only the table privileges they exercise.
revoke insert, update on
  bakery.worker_enrollments,
    bakery.worker_enrollment_replays,
    bakery.worker_hosts,
    bakery.worker_registration_replays,
    bakery.agent_sessions,
    bakery.jobs,
    bakery.job_attempts,
    bakery.attempt_events,
    bakery.worker_claim_replays,
    bakery.worker_lease_renewal_replays,
    bakery.worker_heartbeat_replays,
    bakery.worker_commands,
    bakery.worker_command_ack_tombstones
  from bakery_app;

grant select
  on bakery.worker_enrollments,
    bakery.worker_enrollment_replays,
    bakery.worker_hosts,
    bakery.worker_registration_replays,
    bakery.agent_sessions,
    bakery.jobs,
    bakery.job_attempts,
    bakery.attempt_events,
    bakery.worker_claim_replays,
    bakery.worker_lease_renewal_replays,
    bakery.worker_heartbeat_replays,
    bakery.worker_commands,
    bakery.worker_command_ack_tombstones
  to bakery_app;
grant insert (
    organization_id, principal_id, name, os, architecture,
    allowed_capabilities, slots, token_hash, expires_at
  )
  on bakery.worker_enrollments
  to bakery_app;
grant update (consumed_at, worker_host_id, updated_at, version)
  on bakery.worker_enrollments
  to bakery_app;
grant insert (
    organization_id, principal_id, idempotency_key, request_digest,
    response_ciphertext, expires_at
  )
  on bakery.worker_enrollment_replays
  to bakery_app;
grant insert (
    organization_id, principal_id, name, os, architecture, capabilities,
    toolchain_versions, slots, credential_hash, credential_generation,
    protocol_version, worker_session_id, worker_session_generation
  )
  on bakery.worker_hosts
  to bakery_app;
grant update (
    worker_session_id, worker_session_generation, last_heartbeat_at,
    status, updated_at, version
  )
  on bakery.worker_hosts
  to bakery_app;
grant insert (
    enrollment_id, idempotency_key, request_digest, worker_host_id,
    principal_id, registration_generation, response, expires_at
  )
  on bakery.worker_registration_replays
  to bakery_app;
grant update (status, current_fence, updated_at, version)
  on bakery.jobs
  to bakery_app;
grant insert (
    organization_id, job_id, worker_host_id, worker_session_id,
    worker_session_generation, attempt_no, fence, lease_token_hash,
    lease_expires_at, status
  )
  on bakery.job_attempts
  to bakery_app;
grant update (
    worker_session_id, worker_session_generation, status, started_at,
    last_event_seq, lease_expires_at, result, ended_at, updated_at, version
  )
  on bakery.job_attempts
  to bakery_app;
grant insert (
    organization_id, attempt_id, local_seq, event_id, event_type,
    payload, payload_digest, saved_ack
  )
  on bakery.attempt_events
  to bakery_app;
grant insert (
    organization_id, worker_host_id, claim_key, request_digest,
    response_status, response_ciphertext, attempt_id, expires_at
  )
  on bakery.worker_claim_replays
  to bakery_app;
grant insert (
    organization_id, attempt_id, worker_host_id, idempotency_key,
    request_digest, response, expires_at
  )
  on bakery.worker_lease_renewal_replays
  to bakery_app;
grant insert (
    organization_id, worker_host_id, idempotency_key, request_digest,
    response_status, response_body, expires_at
  )
  on bakery.worker_heartbeat_replays
  to bakery_app;
grant update (status, acknowledged_at)
  on bakery.worker_commands
  to bakery_app;
grant insert (
    command_id, organization_id, worker_host_id, status,
    acknowledged_at, expires_at
  )
  on bakery.worker_command_ack_tombstones
  to bakery_app;
grant delete
  on bakery.worker_enrollments,
    bakery.worker_enrollment_replays,
    bakery.worker_registration_replays,
    bakery.worker_claim_replays,
    bakery.worker_lease_renewal_replays,
    bakery.worker_heartbeat_replays,
    bakery.worker_command_ack_tombstones,
    bakery.worker_commands
  to bakery_app;
