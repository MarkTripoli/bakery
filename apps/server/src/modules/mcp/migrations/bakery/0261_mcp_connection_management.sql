-- Managing MCP servers and connections (issue #434, chapter 25 section 15.4).
--
-- #20 shipped the tables and the invoke path but no writer: `bakery_app` held no
-- privilege on any of them, so nothing could register a server, enter a credential
-- or pin a snapshot. This adds what the writers and the three rules of section 15.4
-- need, and the grants for exactly those writes.
--
-- Structure only, like 0180 and 0181: the effect classes, the connection scope and
-- the status lifecycle are enforced in TypeScript. The schema carries no CHECK and
-- no trigger, because a rule that lives in two places drifts in one of them.

-- A personal connection (O27) is one a member registered for their own runs. Null
-- means an organization connection, registered by an Admin. The owner is a real
-- foreign key so an unvalidated principal id cannot be stored.
alter table bakery.mcp_connections
  add column owner_principal_id uuid,
  add constraint mcp_connections_owner_fk
    foreign key (owner_principal_id)
    references bakery.principals (id) on delete no action,
  -- The credential is a sealed secret version. 0180 left this column without a
  -- foreign key; it points at an organization-owned secret now that one can be written.
  add constraint mcp_connections_secret_fk
    foreign key (organization_id, secret_id)
    references bakery.secrets (organization_id, id) on delete no action;

-- The connections one member owns, for "my connections" and for revoking them all.
create index mcp_connections_owner_idx
  on bakery.mcp_connections (organization_id, owner_principal_id)
  where owner_principal_id is not null;

-- What an Admin said each enabled tool does (O26). One row per connection and tool;
-- a tool with no row is unclassified, which the application treats as a write that
-- runs at most once. The digest is the snapshot the Admin classified against, so a
-- schema that changed since is visible as a classification made for an older tool.
create table bakery.mcp_tool_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  tool_name text not null,
  effect_class text not null,
  -- Named only for write_idempotent: the argument whose value is the effect key.
  effect_key_argument text,
  -- Named only for write_reconcilable: the read tool that confirms the write.
  paired_read_tool text,
  snapshot_digest text not null,
  classified_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint mcp_tool_classifications_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint mcp_tool_classifications_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.mcp_connections (organization_id, id)
    on delete cascade,
  constraint mcp_tool_classifications_classified_by_fk
    foreign key (classified_by)
    references bakery.principals (id) on delete no action,
  constraint mcp_tool_classifications_tool_unique
    unique (organization_id, connection_id, tool_name)
);

-- The owner's explicit grant that lets one shared workflow use their personal
-- connection (O27). Revoking stamps the row rather than deleting it, so what was
-- once granted stays on record, and at most one live grant exists per pair.
create table bakery.mcp_use_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  workflow_id uuid not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  constraint mcp_use_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint mcp_use_grants_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.mcp_connections (organization_id, id)
    on delete cascade,
  constraint mcp_use_grants_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint mcp_use_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete no action,
  constraint mcp_use_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete no action
);
create unique index mcp_use_grants_live_unique
  on bakery.mcp_use_grants (organization_id, connection_id, workflow_id)
  where revoked_at is null;

-- Grants, column-scoped so identity cannot move: a server's slug, transport, launch
-- spec and source revision are fixed at registration (a new revision is a new
-- server); a connection never changes server, owner or organization; a snapshot is
-- never updated, because discovery observes and a pin must stay comparable.
grant select, insert on bakery.mcp_servers to bakery_app;
grant update (name, enabled, required_capabilities, updated_at, version)
  on bakery.mcp_servers to bakery_app;

grant select, insert on bakery.mcp_connections to bakery_app;
grant update (
  label, config, secret_id, enabled_capabilities, status, current_snapshot_id,
  updated_at, version
) on bakery.mcp_connections to bakery_app;

grant select, insert on bakery.mcp_capability_snapshots to bakery_app;

grant select, insert on bakery.mcp_tool_classifications to bakery_app;
grant update (
  effect_class, effect_key_argument, paired_read_tool, snapshot_digest,
  classified_by, updated_at, version
) on bakery.mcp_tool_classifications to bakery_app;

grant select, insert on bakery.mcp_use_grants to bakery_app;
grant update (revoked_at, revoked_by) on bakery.mcp_use_grants to bakery_app;
