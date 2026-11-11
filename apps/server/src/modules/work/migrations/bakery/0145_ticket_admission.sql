-- Ticket sources, readiness reports and single admission (issue #82). Five
-- tables: ticket_sources (an authorized provider container mapped to an
-- application and repository, with a versioned policy), external_tickets (the
-- bounded current snapshot of one provider ticket), ticket_task_links (an
-- explicit ticket to task link), ticket_readiness_reports (one immutable
-- evaluation per observed basis) and ticket_requests (one admission generation
-- that owns a task and, when allowed, one run). Every parent key carries
-- organization_id, so a row can only point at parents of its own organization.
-- ticket_requests names its ticket and its link together, which keeps a
-- request's ticket equal to its link's ticket. The partial unique index
-- ticket_requests_one_nonterminal_idx lets one ticket hold at most one request
-- in waiting, admitted, active or suspended; terminal generations free it.
-- ticket_task_links_one_primary_idx lets a task have one primary ticket link.
-- A request keeps its receipt pointer only until the receipt expires: the
-- route key sets inbound_event_route_id to null, and authority_evidence holds
-- the durable facts. Vocabulary (intent, origin, disposition, verdict, reason
-- codes, health), policy shape and every lifecycle transition are enforced in
-- TypeScript, never here. Update grants are column lists, so bakery_app writes
-- nothing else. ticket_readiness_reports has no update or delete grant, so a
-- recorded evaluation cannot be rewritten. No table has a delete grant. On the
-- other four tables these columns carry no update grant, and neither does
-- created_at:
--   ticket_sources: id, organization_id, provider, integration_connection_id,
--     integration_resource_id, application_id, repository_id,
--     external_container_id;
--   external_tickets: id, organization_id, ticket_source_id,
--     external_ticket_id;
--   ticket_task_links: id, organization_id, external_ticket_id, task_id, role;
--   ticket_requests: id, organization_id, ticket_task_link_id,
--     external_ticket_id, generation, origin, authority_principal_id,
--     authority_evidence, inbound_event_route_id, pinned_preset.
-- A request's admission-time authority evidence and preset pin are therefore
-- fixed at insert; a re-pin rewrites requirements_digest, readiness_report_id
-- and source_policy_revision, and a lifecycle step rewrites disposition and
-- its reason, intent, workflow_run_id and pause_requested_at.
-- Structure only.
create table bakery.ticket_sources (
  id uuid primary key,
  organization_id uuid not null,
  provider text not null default 'github',
  integration_connection_id uuid not null,
  integration_resource_id uuid not null,
  application_id uuid not null,
  repository_id uuid,
  external_container_id text not null,
  enabled boolean not null,
  policy jsonb not null,
  policy_revision integer not null default 1,
  sync_checkpoint jsonb,
  sync_health text not null default 'unknown',
  last_synced_at timestamptz,
  last_problem_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ticket_sources_organization_id_unique
    unique (organization_id, id),
  constraint ticket_sources_container_unique
    unique (organization_id, integration_connection_id, external_container_id),
  constraint ticket_sources_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_sources_connection_fk
    foreign key (organization_id, integration_connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete no action,
  constraint ticket_sources_resource_fk
    foreign key (integration_resource_id, integration_connection_id)
    references bakery.integration_resources (id, connection_id)
    on delete no action,
  constraint ticket_sources_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id)
    on delete no action,
  constraint ticket_sources_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
    on delete no action
);

-- Keyset pages of one organization's sources, newest first.
create index ticket_sources_page_idx
  on bakery.ticket_sources (organization_id, created_at desc, id desc);
-- Webhook and poll find the sources of one selected resource; the index also
-- sits behind the resource key.
create index ticket_sources_resource_idx
  on bakery.ticket_sources (integration_resource_id, integration_connection_id);
create index ticket_sources_application_idx
  on bakery.ticket_sources (organization_id, application_id);

create table bakery.external_tickets (
  id uuid primary key,
  organization_id uuid not null,
  ticket_source_id uuid not null,
  external_ticket_id text not null,
  key text not null,
  number text,
  safe_url text not null,
  snapshot jsonb not null,
  requirements_digest text not null,
  provider_update_marker text not null,
  visibility text not null,
  state text not null,
  last_observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint external_tickets_organization_id_unique
    unique (organization_id, id),
  constraint external_tickets_identity_unique
    unique (organization_id, ticket_source_id, external_ticket_id),
  constraint external_tickets_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint external_tickets_source_fk
    foreign key (organization_id, ticket_source_id)
    references bakery.ticket_sources (organization_id, id) on delete cascade
);

-- Keyset pages of one source's tickets, newest first.
create index external_tickets_source_page_idx
  on bakery.external_tickets (organization_id, ticket_source_id, created_at desc, id desc);
-- Keyset pages of one organization's tickets, newest first, when no source is
-- named.
create index external_tickets_org_page_idx
  on bakery.external_tickets (organization_id, created_at desc, id desc);
-- A webhook or poll names a ticket by its number inside one source.
create index external_tickets_source_number_idx
  on bakery.external_tickets (organization_id, ticket_source_id, number);

create table bakery.ticket_task_links (
  id uuid primary key,
  organization_id uuid not null,
  external_ticket_id uuid not null,
  task_id uuid not null,
  role text not null,
  status_comment_external_id text,
  last_synced_run_revision integer,
  sync_health text not null default 'unknown',
  last_problem_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ticket_task_links_organization_id_unique
    unique (organization_id, id),
  -- Lets ticket_requests name its ticket and its link together.
  constraint ticket_task_links_ticket_id_unique
    unique (organization_id, external_ticket_id, id),
  constraint ticket_task_links_pair_unique
    unique (organization_id, external_ticket_id, task_id),
  constraint ticket_task_links_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_task_links_ticket_fk
    foreign key (organization_id, external_ticket_id)
    references bakery.external_tickets (organization_id, id) on delete cascade,
  constraint ticket_task_links_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete no action
);

create unique index ticket_task_links_one_primary_idx
  on bakery.ticket_task_links (organization_id, task_id)
  where role = 'primary';
-- Reads of every link a task carries, reference links included.
create index ticket_task_links_task_idx
  on bakery.ticket_task_links (organization_id, task_id);

create table bakery.ticket_readiness_reports (
  id uuid primary key,
  organization_id uuid not null,
  external_ticket_id uuid not null,
  version integer not null,
  verdict text not null,
  basis_digest text not null,
  requirements_digest text,
  dependency_digest text,
  source_policy_revision integer not null,
  preset jsonb not null,
  checks jsonb not null,
  origin text not null,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ticket_readiness_reports_organization_id_unique
    unique (organization_id, id),
  -- Lets ticket_requests name its ticket and its pinned report together.
  constraint ticket_readiness_reports_ticket_id_unique
    unique (organization_id, external_ticket_id, id),
  constraint ticket_readiness_reports_version_unique
    unique (external_ticket_id, version),
  constraint ticket_readiness_reports_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_readiness_reports_ticket_fk
    foreign key (organization_id, external_ticket_id)
    references bakery.external_tickets (organization_id, id) on delete cascade
);

create table bakery.ticket_requests (
  id uuid primary key,
  organization_id uuid not null,
  ticket_task_link_id uuid not null,
  external_ticket_id uuid not null,
  intent text not null,
  generation integer not null,
  origin text not null,
  authority_principal_id uuid,
  authority_evidence jsonb not null,
  inbound_event_route_id uuid,
  source_policy_revision integer not null,
  requirements_digest text not null,
  readiness_report_id uuid,
  pinned_preset jsonb not null,
  disposition text not null,
  disposition_reason text,
  workflow_run_id uuid,
  pause_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ticket_requests_organization_id_unique
    unique (organization_id, id),
  constraint ticket_requests_link_generation_unique
    unique (ticket_task_link_id, generation),
  constraint ticket_requests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_requests_ticket_fk
    foreign key (organization_id, external_ticket_id)
    references bakery.external_tickets (organization_id, id) on delete cascade,
  -- The request's ticket must equal its link's ticket.
  constraint ticket_requests_link_fk
    foreign key (organization_id, external_ticket_id, ticket_task_link_id)
    references bakery.ticket_task_links (organization_id, external_ticket_id, id)
    on delete no action,
  constraint ticket_requests_authority_principal_fk
    foreign key (authority_principal_id)
    references bakery.principals (id) on delete no action,
  -- Receipt retention may delete the route; the request then keeps its
  -- authority_evidence and loses only the pointer.
  constraint ticket_requests_route_fk
    foreign key (organization_id, inbound_event_route_id)
    references bakery.inbound_event_routes (organization_id, id)
    on delete set null (inbound_event_route_id),
  constraint ticket_requests_report_fk
    foreign key (organization_id, external_ticket_id, readiness_report_id)
    references bakery.ticket_readiness_reports (organization_id, external_ticket_id, id)
    on delete no action,
  constraint ticket_requests_run_fk
    foreign key (organization_id, workflow_run_id)
    references bakery.workflow_runs (organization_id, id) on delete no action
);

-- One request per ticket in waiting, admitted, active or suspended.
create unique index ticket_requests_one_nonterminal_idx
  on bakery.ticket_requests (external_ticket_id)
  where disposition in ('waiting', 'admitted', 'active', 'suspended');
-- Newest generation of one ticket first.
create index ticket_requests_ticket_idx
  on bakery.ticket_requests (organization_id, external_ticket_id, generation desc);
-- The request that owns a run.
create index ticket_requests_run_idx
  on bakery.ticket_requests (organization_id, workflow_run_id)
  where workflow_run_id is not null;
-- The requests that point at a route. Receipt retention deletes routes in bulk
-- and each one nulls this pointer, which would otherwise scan every request of
-- the organization.
create index ticket_requests_route_idx
  on bakery.ticket_requests (organization_id, inbound_event_route_id)
  where inbound_event_route_id is not null;

grant select, insert on bakery.ticket_sources to bakery_app;
grant update (enabled, policy, policy_revision, sync_checkpoint, sync_health,
  last_synced_at, last_problem_code, updated_at, version)
  on bakery.ticket_sources to bakery_app;

grant select, insert on bakery.external_tickets to bakery_app;
grant update (key, number, safe_url, snapshot, requirements_digest,
  provider_update_marker, visibility, state, last_observed_at, updated_at,
  version)
  on bakery.external_tickets to bakery_app;

grant select, insert on bakery.ticket_task_links to bakery_app;
grant update (status_comment_external_id, last_synced_run_revision,
  sync_health, last_problem_code, updated_at, version)
  on bakery.ticket_task_links to bakery_app;

grant select, insert on bakery.ticket_readiness_reports to bakery_app;

grant select, insert on bakery.ticket_requests to bakery_app;
grant update (intent, source_policy_revision, requirements_digest,
  readiness_report_id, disposition, disposition_reason, workflow_run_id,
  pause_requested_at, updated_at, version)
  on bakery.ticket_requests to bakery_app;
