-- Signed GitHub receipts and remote-fact reconciliation (issue #71).
-- * inbound_events: one verified, deduplicated receipt per provider delivery,
--   host-level and unbound to an organization. The delivery identity is
--   (registration_id, external_delivery_id); the same identity with a
--   different digest is refused in TypeScript. expires_at bounds retention.
-- * inbound_event_routes: per-connection processing of a receipt. The
--   composite keys pin each route to its connection's organization and
--   installation and to that connection's resource, like integration_resources.
-- * integration_remote_facts: bounded provider facts (issue, check run)
--   written only from fresh provider reads, ordered by
--   (provider_updated_at, observed_started_at). Pull requests live in
--   pull_requests, not here.
-- * integration_sync_checkpoints: resumable reconciliation progress per
--   repository resource and stream.
-- * pull_requests: remote pull request identity and current SHAs for tasks.
-- Structure only: the receipt, route, checkpoint and pull request lifecycles,
-- ordering and retention are enforced in TypeScript. The (connection_id,
-- installation_id) keys carry ON UPDATE CASCADE as 0135 gave
-- integration_resources, so a same-account reconnect can move a connection to
-- its new installation while routes, facts and checkpoints exist. Each of the
-- three tables has a plain btree index on (connection_id, installation_id)
-- behind that key (0135 precedent), so the cascade finds the referencing rows
-- by index instead of scanning a table that grows with every issue.
create table bakery.inbound_events (
  id uuid primary key,
  provider text not null,
  registration_id uuid not null references bakery.integration_app_registrations (id),
  external_delivery_id text not null,
  payload_digest text not null,
  event_kind text not null,
  event_action text,
  installation_id uuid references bakery.integration_installations (id),
  normalized_projection jsonb,
  status text not null,
  rejection_reason text,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint inbound_events_delivery_unique unique (registration_id, external_delivery_id)
);
create index inbound_events_expiry on bakery.inbound_events (expires_at);

create table bakery.inbound_event_routes (
  id uuid primary key,
  inbound_event_id uuid not null references bakery.inbound_events (id) on delete cascade,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  resource_id uuid,
  purpose text not null,
  status text not null,
  outcome_code text,
  attempts integer not null default 0,
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint inbound_event_routes_organization_id_unique unique (organization_id, id),
  constraint inbound_event_routes_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id) on delete cascade,
  constraint inbound_event_routes_installation_fk
    foreign key (connection_id, installation_id)
    references bakery.integration_connections (id, installation_id)
    on update cascade on delete cascade,
  constraint inbound_event_routes_resource_fk
    foreign key (resource_id, connection_id)
    references bakery.integration_resources (id, connection_id) on delete cascade,
  constraint inbound_event_routes_purpose_unique
    unique (inbound_event_id, connection_id, purpose)
);
create index inbound_event_routes_due on bakery.inbound_event_routes (updated_at)
  where status in ('pending', 'processing', 'deferred');
create index inbound_event_routes_installation_idx
  on bakery.inbound_event_routes (connection_id, installation_id);

create table bakery.integration_remote_facts (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  resource_id uuid not null,
  kind text not null,
  external_id text not null,
  number integer,
  head_sha text,
  state text not null,
  conclusion text,
  provider_updated_at timestamptz not null,
  observed_started_at timestamptz not null,
  observed_at timestamptz not null default now(),
  digest text not null,
  summary jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  constraint integration_remote_facts_organization_id_unique unique (organization_id, id),
  constraint integration_remote_facts_identity_unique
    unique (resource_id, kind, external_id),
  constraint integration_remote_facts_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id) on delete cascade,
  constraint integration_remote_facts_installation_fk
    foreign key (connection_id, installation_id)
    references bakery.integration_connections (id, installation_id)
    on update cascade on delete cascade,
  constraint integration_remote_facts_resource_fk
    foreign key (resource_id, connection_id)
    references bakery.integration_resources (id, connection_id) on delete cascade
);
create index integration_remote_facts_head
  on bakery.integration_remote_facts (resource_id, kind, head_sha);
create index integration_remote_facts_installation_idx
  on bakery.integration_remote_facts (connection_id, installation_id);

create table bakery.integration_sync_checkpoints (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  resource_id uuid not null,
  stream text not null,
  cursor jsonb,
  status text not null,
  generation integer not null default 1,
  not_before timestamptz not null default now(),
  outcome_code text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  pages_read integer not null default 0,
  version integer not null default 1,
  constraint integration_sync_checkpoints_organization_id_unique
    unique (organization_id, id),
  constraint integration_sync_checkpoints_stream_unique unique (resource_id, stream),
  constraint integration_sync_checkpoints_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id) on delete cascade,
  constraint integration_sync_checkpoints_installation_fk
    foreign key (connection_id, installation_id)
    references bakery.integration_connections (id, installation_id)
    on update cascade on delete cascade,
  constraint integration_sync_checkpoints_resource_fk
    foreign key (resource_id, connection_id)
    references bakery.integration_resources (id, connection_id) on delete cascade
);
create index integration_sync_checkpoints_installation_idx
  on bakery.integration_sync_checkpoints (connection_id, installation_id);

-- The observation columns stay null until the first provider read of a
-- registered pull request. organization_id is deleted with its organization;
-- task and repository references are NO ACTION, so a direct delete of either
-- is refused while a pull request names it.
create table bakery.pull_requests (
  id uuid primary key,
  organization_id uuid not null,
  task_id uuid not null,
  repository_id uuid not null,
  provider_number integer not null,
  url text not null,
  head_sha text not null,
  base_sha text not null,
  status text not null,
  merged_sha text,
  provider_updated_at timestamptz,
  observed_started_at timestamptz,
  last_observed_at timestamptz,
  version integer not null default 1,
  constraint pull_requests_organization_id_unique unique (organization_id, id),
  constraint pull_requests_number_unique unique (repository_id, provider_number),
  constraint pull_requests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint pull_requests_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id),
  constraint pull_requests_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
);
create index pull_requests_head on bakery.pull_requests (repository_id, head_sha);

-- Receipts keep their identity and digest; resolving the installation and
-- settling the status are the only later writes. The retention sweep deletes
-- receipts and routes; facts, checkpoints and pull requests are never deleted
-- by the application.
grant select, insert, delete on bakery.inbound_events to bakery_app;
grant update (installation_id, status, rejection_reason)
  on bakery.inbound_events to bakery_app;

grant select, insert, delete on bakery.inbound_event_routes to bakery_app;
grant update (status, outcome_code, attempts, not_before, updated_at, version)
  on bakery.inbound_event_routes to bakery_app;

grant select, insert on bakery.integration_remote_facts to bakery_app;
grant update (number, head_sha, state, conclusion, provider_updated_at,
  observed_started_at, observed_at, digest, summary, version)
  on bakery.integration_remote_facts to bakery_app;

grant select, insert on bakery.integration_sync_checkpoints to bakery_app;
grant update (cursor, status, generation, not_before, outcome_code,
  last_started_at, last_completed_at, pages_read, version)
  on bakery.integration_sync_checkpoints to bakery_app;

grant select, insert on bakery.pull_requests to bakery_app;
grant update (url, head_sha, base_sha, status, merged_sha, provider_updated_at,
  observed_started_at, last_observed_at, version)
  on bakery.pull_requests to bakery_app;
