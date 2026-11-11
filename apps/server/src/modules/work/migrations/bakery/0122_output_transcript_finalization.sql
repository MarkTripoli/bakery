-- Purpose-bound execution-owned transcript finalization and bounded transient history.
create table bakery.session_output_finalizations (
  id uuid primary key,
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid,
  task_id uuid not null,
  conversation_id uuid not null,
  run_step_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  author_id uuid not null,
  session_id uuid not null,
  scope_digest text not null,
  frozen_highwater bigint not null,
  capture text not null,
  capture_reason text not null,
  authority_identity text not null,
  payload_digest text,
  finalization_identity text,
  state text not null default 'assembling',
  assembly_failure text,
  attempt_count integer not null default 0,
  grant_expires_at timestamptz not null,
  transient_expires_at timestamptz not null,
  revoked_at timestamptz,
  history_expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, session_id),
  foreign key (organization_id, session_id) references bakery.session_output_streams(organization_id, id) on delete cascade,
  foreign key (organization_id, job_id) references bakery.jobs(organization_id, id) on delete cascade,
  foreign key (organization_id, attempt_id) references bakery.job_attempts(organization_id, id) on delete cascade,
  foreign key (organization_id, worker_host_id) references bakery.worker_hosts(organization_id, id) on delete restrict,
  foreign key (author_id) references bakery.principals(id) on delete restrict
);
create table bakery.session_output_finalization_segments (
  organization_id uuid not null,
  grant_id uuid not null,
  ordinal integer not null,
  first_sequence bigint not null,
  last_sequence bigint not null,
  -- Intent bytes are nulled once published, terminal or history-expired;
  -- ranges and digests remain for status.
  content bytea,
  sha256 text not null,
  size_bytes integer not null,
  primary key (organization_id, grant_id, ordinal),
  foreign key (organization_id, grant_id) references bakery.session_output_finalizations(organization_id, id) on delete cascade
);
create table bakery.session_output_finalization_manifests (
  organization_id uuid not null,
  grant_id uuid primary key,
  content bytea not null,
  sha256 text not null,
  size_bytes integer not null,
  foreign key (organization_id, grant_id) references bakery.session_output_finalizations(organization_id, id) on delete cascade
);
create table bakery.session_output_finalization_receipts (
  id uuid primary key,
  organization_id uuid not null,
  grant_id uuid not null,
  operation text not null,
  operation_identity text not null,
  request_digest text not null,
  worker_host_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, grant_id, operation, operation_identity),
  foreign key (organization_id, grant_id) references bakery.session_output_finalizations(organization_id, id) on delete cascade,
  foreign key (organization_id, worker_host_id) references bakery.worker_hosts(organization_id, id) on delete restrict
);
create index session_output_finalizations_expiry_idx
  on bakery.session_output_finalizations (organization_id, transient_expires_at, id);
create index session_output_finalization_segments_sequence_idx
  on bakery.session_output_finalization_segments (organization_id, grant_id, first_sequence);

grant select, insert on bakery.session_output_finalizations to bakery_app;
grant select, insert on bakery.session_output_finalization_segments,
  bakery.session_output_finalization_manifests,
  bakery.session_output_finalization_receipts to bakery_app;
grant update (payload_digest, finalization_identity, state, assembly_failure,
  attempt_count, revoked_at, history_expired_at, updated_at)
  on bakery.session_output_finalizations to bakery_app;
grant update (content) on bakery.session_output_finalization_segments to bakery_app;
