-- The ask power names a role (issue #414 slice 4, chapter 25 section 18.2).
--
-- An agent may put a question to one role, and the grant names which: a person
-- grants the ask power per workflow and per role, so a step cannot widen who it
-- can reach. role_key is that role, a built-in role (admin or developer) or a
-- custom role key. It is null for every other power; the writer enforces both
-- (the PostgreSQL boundary rail forbids CHECK constraints).
--
-- The uniqueness index gains the role: the same workflow may be granted ask for
-- two different roles, and a second grant of the same role is still a conflict.
alter table bakery.agent_power_grants
  add column role_key text;

drop index bakery.agent_power_grants_scope_idx;

create unique index agent_power_grants_scope_idx
  on bakery.agent_power_grants (
    organization_id,
    power,
    coalesce(workflow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(access_token_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(role_key, '')
  );
