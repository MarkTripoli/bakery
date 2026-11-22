-- Asking a role or a group, and grants that end (issue #414, chapter 25
-- sections 18.2, 18.3 and 19; O50 to O52).
--
-- An agent may ask people only where a person granted its workflow the "ask"
-- power, and that grant names exactly who may be asked: one role (built-in
-- admin or developer, or a custom role's key) or one organization group
-- (0243). Asking goes through run requests (0246), so there is one way to ask
-- a person: the role or group is resolved to its active human members when the
-- request is made and one request row is written per member, frozen, so a
-- later change to the role or group never rewrites who was asked. The request
-- rows remember the audience they came from, for display and audit.
--
-- Every agent power grant may also carry an expiry. Null means it does not
-- expire; once past it, the guard refuses the power with a named reason, live
-- on every call, exactly as a revoke does. No CHECK constraints and no
-- triggers: the closed vocabularies and the "ask names one audience" rule are
-- owned by TypeScript (the PostgreSQL boundary rail forbids them).

alter table bakery.agent_power_grants
  add column expires_at timestamptz,
  add column role_key text,
  add column group_id uuid,
  add constraint agent_power_grants_group_fk
    foreign key (organization_id, group_id)
    references bakery.organization_groups (organization_id, id)
    on delete cascade;

-- One grant per power, workflow, seat and audience: an ask grant for admin and
-- one for a group can sit side by side on one workflow.
drop index bakery.agent_power_grants_scope_idx;
create unique index agent_power_grants_scope_idx
  on bakery.agent_power_grants (
    organization_id,
    power,
    coalesce(workflow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(access_token_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(role_key, ''),
    coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- The audience a request was asked of, when it was asked of a role or a group
-- rather than one person. audience_name is the role's or group's name at the
-- time, frozen with the members; the group reference goes null if the group is
-- deleted, and the name still says who was meant.
alter table bakery.person_requests
  add column audience_role_key text,
  add column audience_group_id uuid,
  add column audience_name text,
  add constraint person_requests_audience_group_fk
    foreign key (organization_id, audience_group_id)
    references bakery.organization_groups (organization_id, id)
    on delete set null (audience_group_id);
