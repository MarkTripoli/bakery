-- External MCP server definitions and their configured connections (issue #20).
--
-- Two levels because they change on different clocks. An `mcp_servers` row is
-- the shared definition of a capability - the transport, the launch spec, the
-- config schema, what it requires of a host. An `mcp_connections` row is one
-- organization's configured use of it, and that is where locality lives: a
-- `stdio` server runs in a process on a particular worker host, so the
-- connection names that host rather than pretending the definition is portable.
--
-- Structure only. The transport enum, the status lifecycle, the "stdio requires
-- a host or a required host capability" rule and the command allowlist are all
-- enforced in TypeScript (docs/technical-design/09-integrations.md): the schema
-- carries no CHECK or trigger, because a constraint that lives in two places
-- drifts in one of them. `transport` and `status` are text for the same reason
-- every other lifecycle column here is.
create table bakery.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  slug text not null,
  name text not null,
  transport text not null,
  launch_spec jsonb,
  endpoint_template text,
  config_schema jsonb not null default '{}'::jsonb,
  required_capabilities jsonb not null default '[]'::jsonb,
  source_revision text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint mcp_servers_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- Slug addresses a server inside one organization, so two organizations may
  -- both have a `filesystem` server without colliding.
  constraint mcp_servers_organization_slug_unique unique (organization_id, slug),
  constraint mcp_servers_organization_id_unique unique (organization_id, id)
);

create table bakery.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  server_id uuid not null,
  integration_connection_id uuid,
  -- Where a stdio server actually runs. Null for a remote transport, which
  -- reaches the server over the network and needs no particular host.
  worker_host_id uuid,
  label text not null,
  config jsonb not null default '{}'::jsonb,
  -- Credentials never live on this row: they are encrypted secret versions and
  -- this column is the only reference to them.
  secret_id uuid,
  enabled_capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'enabled',
  -- The snapshot discovery last pinned. Null until a first successful
  -- discovery; a connection with no pinned snapshot cannot dispatch.
  current_snapshot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint mcp_connections_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint mcp_connections_server_fk
    foreign key (organization_id, server_id)
    references bakery.mcp_servers (organization_id, id)
    on delete cascade,
  constraint mcp_connections_integration_connection_fk
    foreign key (organization_id, integration_connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete set null,
  constraint mcp_connections_worker_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id)
    on delete restrict,
  constraint mcp_connections_organization_id_unique unique (organization_id, id)
);

-- The dispatcher's read: the enabled connections of one organization.
create index mcp_connections_organization_status_idx
  on bakery.mcp_connections (organization_id, status);
-- Locality lookups: which connections require a given host, so a host losing
-- eligibility can find the connections it strands.
create index mcp_connections_worker_host_idx
  on bakery.mcp_connections (worker_host_id)
  where worker_host_id is not null;
