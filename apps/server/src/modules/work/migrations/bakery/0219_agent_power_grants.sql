-- Agent power grants (issue #414, chapter 25 sections 18.2 and 18.3, O50 to O52).
--
-- An agent never decides, controls a run or starts one by default. A person
-- grants one of those powers per workflow or per seat (O52), and every use is
-- labelled as an agent's action (O50). One row is one grant of one power:
--   power            decide | run_control | run_start (TypeScript vocabulary,
--                    not a CHECK constraint: the PostgreSQL boundary rail
--                    forbids them);
--   workflow_id      the immutable id of a workflow that holds the power, in
--                    two senses at once: an agent session running a step of it
--                    may use the power, and an agent may use the power on its
--                    runs. An agent acts on a target only when BOTH its own
--                    workflow and the target's hold the grant, so one grant
--                    cannot reach every workflow. Null covers every workflow
--                    and then the writer requires a seat, so there is no
--                    organization-wide agent grant;
--   access_token_id  the seat (access token) the grant is limited to; null lets
--                    any agent session of the named workflow use the power.
-- Only a person grants or revokes (O51: who holds authority). A revoke deletes
-- the row; the audit log keeps the grant and the revocation. A grant never lets
-- an agent act on its own work (O51: nothing for oneself): the guard for each
-- power refuses its own run, any other run of its task and its task lineage,
-- regardless of the grant.
create table bakery.agent_power_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  power text not null,
  workflow_id uuid,
  access_token_id uuid,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint agent_power_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint agent_power_grants_access_token_fk
    foreign key (access_token_id)
    references bakery.access_tokens (id) on delete cascade,
  constraint agent_power_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict,
  constraint agent_power_grants_organization_id_unique
    unique (organization_id, id)
);

-- One grant per (power, workflow, seat); the guard reads by power and workflow,
-- so this index serves both the uniqueness and the lookup.
create unique index agent_power_grants_scope_idx
  on bakery.agent_power_grants (
    organization_id,
    power,
    coalesce(workflow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(access_token_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

grant select, insert, delete on bakery.agent_power_grants to bakery_app;
