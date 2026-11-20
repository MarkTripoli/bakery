-- Agent file grants and the agent session on audit rows (chapter 25 section
-- 17.6, O39, O45, O50 to O52, issue #448).
--
-- An agent in a session writes files through Bakery's own storage operations
-- only where a person granted its workflow a folder. One row is one grant:
--   workflow_id  the workflow whose agent sessions the grant covers;
--   folder_id    the storage folder granted; the grant covers it and
--                everything under it;
--   access       read | write (TypeScript vocabulary in agent-file-scope.ts,
--                not a CHECK constraint: the PostgreSQL boundary rail forbids
--                them);
--   expires_at   every grant expires; the guard judges it at the time of each
--                write, so a grant that lapses mid-step stops the next write;
--   revoked_at   a revoke stamps the row instead of deleting it, so a refusal
--                can say "withdrawn" rather than "never allowed".
-- Which areas a grant may reach, who may make one (a person, never an agent)
-- and how a write is judged all live in TypeScript; nothing here enforces a
-- rule.
create table bakery.agent_file_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  folder_id uuid not null,
  access text not null,
  granted_by uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint agent_file_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint agent_file_grants_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint agent_file_grants_folder_fk
    foreign key (organization_id, folder_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint agent_file_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict,
  constraint agent_file_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete restrict,
  constraint agent_file_grants_organization_id_unique
    unique (organization_id, id)
);

-- The guard reads by workflow and the folders a target sits under.
create index agent_file_grants_lookup_idx
  on bakery.agent_file_grants (organization_id, workflow_id, folder_id);

grant select, insert, update on bakery.agent_file_grants to bakery_app;

-- O50: an agent's action is audited with both identities, the principal it
-- acted for (principal_id) and the agent session that made the call. Null for
-- a person's own action. No foreign key: an audit row outlives the session.
alter table bakery.audit_events
  add column agent_session_id uuid;
