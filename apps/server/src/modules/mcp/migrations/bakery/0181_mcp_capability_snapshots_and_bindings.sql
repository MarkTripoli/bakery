-- Immutable capability snapshots and the bindings that grant them (issue #20).
--
-- A snapshot is what discovery observed, frozen. It is never updated: a
-- re-discovery writes a new row and the connection's `current_snapshot_id`
-- moves, so the versions an invocation pinned stay readable and a drift check
-- is a digest comparison rather than a diff against something that mutated
-- under it. That immutability is the whole point of the table - discovery
-- observes, it never grants.
--
-- `capability_bindings` is the grant. A binding names exactly one owner (the
-- work that may use a capability) and exactly one target (the connection it
-- reaches). Because the owner and target columns are real foreign keys rather
-- than a polymorphic id table, an unvalidated id cannot be stored at all, which
-- is what "no unvalidated polymorphic ids" has to mean to be worth anything.
create table bakery.mcp_capability_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  observed_at timestamptz not null,
  -- The version the server actually answered with. Bakery targets 2026-07-28
  -- and does not claim compatibility with older upstream versions, so this is
  -- recorded as observed rather than assumed from our own target.
  protocol_version text not null,
  manifest jsonb not null,
  -- Digest of the manifest. UNIQUE per connection so the same observation
  -- twice is one row, and a changed manifest is a different row.
  digest text not null,
  created_at timestamptz not null default now(),
  constraint mcp_capability_snapshots_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint mcp_capability_snapshots_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.mcp_connections (organization_id, id)
    on delete cascade,
  constraint mcp_capability_snapshots_connection_digest_unique
    unique (connection_id, digest),
  constraint mcp_capability_snapshots_organization_id_unique
    unique (organization_id, id)
);

create table bakery.capability_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid,
  agent_version_id uuid,
  workflow_version_id uuid,
  skill_version_owner_id uuid,
  automation_version_id uuid,
  -- A step inside the workflow owner. Meaningless without one, which the
  -- application checks; the column stays nullable so an owner may bind a whole
  -- workflow rather than one step.
  step_key text,
  mcp_connection_id uuid,
  integration_connection_id uuid,
  skill_version_id uuid,
  allowed_operations jsonb not null default '[]'::jsonb,
  -- Distinguishes a binding the owner requires from one it merely permits.
  required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint capability_bindings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint capability_bindings_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
    on delete cascade,
  constraint capability_bindings_agent_version_fk
    foreign key (organization_id, agent_version_id)
    references bakery.agent_versions (organization_id, id)
    on delete cascade,
  constraint capability_bindings_workflow_version_fk
    foreign key (organization_id, workflow_version_id)
    references bakery.workflow_versions (organization_id, id)
    on delete cascade,
  constraint capability_bindings_skill_version_owner_fk
    foreign key (organization_id, skill_version_owner_id)
    references bakery.skill_versions (organization_id, id)
    on delete cascade,
  constraint capability_bindings_automation_version_fk
    foreign key (organization_id, automation_version_id)
    references bakery.automation_versions (organization_id, id)
    on delete cascade,
  constraint capability_bindings_mcp_connection_fk
    foreign key (organization_id, mcp_connection_id)
    references bakery.mcp_connections (organization_id, id)
    on delete cascade,
  constraint capability_bindings_integration_connection_fk
    foreign key (organization_id, integration_connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  constraint capability_bindings_skill_version_fk
    foreign key (organization_id, skill_version_id)
    references bakery.skill_versions (organization_id, id)
    on delete cascade,
  constraint capability_bindings_organization_id_unique
    unique (organization_id, id)
);

-- The dispatcher's read: every binding one owner holds. Separate partial
-- indexes rather than one composite because owner columns are individually
-- nullable and a run looks up exactly one of them.
create index capability_bindings_agent_version_idx
  on bakery.capability_bindings (agent_version_id)
  where agent_version_id is not null;
create index capability_bindings_workflow_version_idx
  on bakery.capability_bindings (workflow_version_id)
  where workflow_version_id is not null;
create index capability_bindings_repository_idx
  on bakery.capability_bindings (repository_id)
  where repository_id is not null;
create index capability_bindings_mcp_connection_idx
  on bakery.capability_bindings (mcp_connection_id)
  where mcp_connection_id is not null;
