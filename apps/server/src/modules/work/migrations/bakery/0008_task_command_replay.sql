-- GHI-29 task-command replay owns the minimal parent graph its commands need.
-- GHI-30 delivered organization/principal authority but no applications,
-- conversations, or tasks. Repository and workflow-run references stay plain
-- UUID columns until their Integrations/Projects/Execution owners land.
create table bakery.applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  slug text not null check (btrim(slug) <> ''),
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint applications_version_positive check (version > 0),
  constraint applications_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint applications_organization_slug_unique unique (organization_id, slug),
  constraint applications_organization_id_unique unique (organization_id, id)
);

create table bakery.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid,
  repository_id uuid,
  title text not null check (btrim(title) <> '' and char_length(title) <= 500),
  created_by uuid not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint conversations_version_positive check (version > 0),
  constraint conversations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint conversations_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete cascade,
  constraint conversations_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint conversations_organization_id_unique unique (organization_id, id)
);

create table bakery.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  application_id uuid not null,
  repository_id uuid,
  conversation_id uuid not null,
  parent_task_id uuid,
  title text not null check (btrim(title) <> '' and char_length(title) <= 500),
  description text not null default '' check (char_length(description) <= 20000),
  task_type text not null check (
    task_type in ('feature', 'bug', 'epic', 'maintenance')
  ),
  status text not null default 'draft' check (
    status in (
      'draft', 'queued', 'active', 'waiting_input', 'blocked',
      'completed', 'failed', 'canceled'
    )
  ),
  priority integer not null default 50,
  created_by uuid not null,
  current_run_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint tasks_priority_range check (priority between 0 and 100),
  constraint tasks_version_positive check (version > 0),
  constraint tasks_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint tasks_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete restrict,
  constraint tasks_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint tasks_parent_fk
    foreign key (organization_id, parent_task_id)
    references bakery.tasks (organization_id, id)
    on delete set null (parent_task_id),
  constraint tasks_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint tasks_organization_id_unique unique (organization_id, id)
);

create table bakery.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('organization', 'installation')),
  organization_id uuid,
  principal_id uuid not null,
  operation text not null check (btrim(operation) <> ''),
  key text not null check (btrim(key) <> ''),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('in_progress', 'completed')),
  response_status integer,
  response_body text,
  response_headers jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint idempotency_records_scope_organization check (
    (scope = 'organization' and organization_id is not null)
    or (scope = 'installation' and organization_id is null)
  ),
  constraint idempotency_records_completed_envelope check (
    (
      status = 'completed'
      and response_status is not null
      and response_body is not null
      and response_headers is not null
    )
    or (
      status = 'in_progress'
      and response_status is null
      and response_body is null
      and response_headers is null
    )
  ),
  constraint idempotency_records_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint idempotency_records_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete restrict,
  constraint idempotency_records_scope_unique
    unique nulls not distinct (scope, organization_id, principal_id, operation, key)
);

create table bakery.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  principal_id uuid,
  operation text not null check (btrim(operation) <> ''),
  resource_type text not null check (btrim(resource_type) <> ''),
  resource_id text not null check (btrim(resource_id) <> ''),
  outcome text not null check (outcome in ('allowed', 'denied', 'succeeded', 'failed')),
  request_id text not null,
  trace_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint audit_events_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete set null
);

create table bakery.domain_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  sequence bigint not null generated always as identity,
  event_type text not null check (btrim(event_type) <> ''),
  schema_version integer not null default 1,
  application_id uuid,
  repository_id uuid,
  task_id uuid,
  conversation_id uuid,
  aggregate_id uuid not null,
  aggregate_version integer not null,
  payload jsonb not null default '{}'::jsonb,
  trace_id text,
  created_at timestamptz not null default now(),
  constraint domain_events_schema_version_positive check (schema_version > 0),
  constraint domain_events_aggregate_version_positive check (aggregate_version > 0),
  constraint domain_events_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint domain_events_aggregate_unique
    unique (organization_id, aggregate_id, aggregate_version, event_type),
  constraint domain_events_sequence_unique unique (sequence)
);

create table bakery.outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_id uuid not null,
  destination text not null check (destination in ('inngest', 'slack', 'github')),
  delivery_key text not null check (btrim(delivery_key) <> ''),
  status text not null default 'pending' check (
    status in ('pending', 'sending', 'delivered', 'failed')
  ),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_attempt_count_nonnegative check (attempt_count >= 0),
  constraint outbox_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint outbox_event_fk
    foreign key (event_id)
    references bakery.domain_events (id) on delete restrict,
  constraint outbox_destination_delivery_unique unique (destination, delivery_key)
);

grant select, insert, update
  on bakery.applications,
    bakery.conversations,
    bakery.tasks,
    bakery.idempotency_records,
    bakery.outbox
  to bakery_app;
grant select, insert
  on bakery.audit_events,
    bakery.domain_events
  to bakery_app;
