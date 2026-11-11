-- Execution-owned logical streams do not require an agent session.
create table bakery.session_output_streams (
  id uuid primary key,
  organization_id uuid not null references bakery.organizations(id) on delete cascade,
  job_id uuid not null,
  scope_digest text not null,
  scope jsonb not null,
  highwater bigint not null default 0,
  writer_generation bigint not null default 0,
  display_bytes bigint not null default 0,
  status_bytes bigint not null default 0,
  closed boolean not null default false,
  capture text not null default 'capturing',
  reason text,
  unique (organization_id, id),
  unique (organization_id, job_id, scope_digest),
  foreign key (organization_id, job_id) references bakery.jobs(organization_id, id) on delete cascade
);
create table bakery.session_output_producers (
  organization_id uuid not null,
  session_id uuid not null,
  writer_generation bigint not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  worker_session_id uuid not null,
  worker_session_generation bigint not null,
  fence bigint not null,
  ended_reason text,
  primary key (organization_id, session_id, writer_generation),
  foreign key (organization_id, session_id) references bakery.session_output_streams(organization_id, id) on delete cascade,
  foreign key (organization_id, attempt_id) references bakery.job_attempts(organization_id, id) on delete cascade,
  foreign key (organization_id, worker_host_id) references bakery.worker_hosts(organization_id, id) on delete restrict
);
create table bakery.session_output_batches (
  organization_id uuid not null,
  session_id uuid not null,
  sequence bigint not null,
  batch_id uuid not null,
  writer_generation bigint not null,
  attempt_id uuid not null,
  event_id uuid not null,
  payload jsonb not null,
  primary key (organization_id, session_id, sequence),
  unique (organization_id, session_id, batch_id),
  unique (organization_id, attempt_id, event_id),
  foreign key (organization_id, session_id, writer_generation) references bakery.session_output_producers(organization_id, session_id, writer_generation) on delete cascade
);
create table bakery.session_output_receipts (
  organization_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  operation text not null,
  idempotency_key uuid not null,
  request_digest text not null,
  response jsonb not null,
  primary key (organization_id, attempt_id, operation, idempotency_key),
  foreign key (organization_id, attempt_id) references bakery.job_attempts(organization_id, id) on delete cascade
);
grant select, insert on bakery.session_output_streams, bakery.session_output_producers,
  bakery.session_output_batches, bakery.session_output_receipts to bakery_app;
grant update (highwater, writer_generation, display_bytes, status_bytes, closed, capture, reason)
  on bakery.session_output_streams to bakery_app;
grant update (ended_reason) on bakery.session_output_producers to bakery_app;
