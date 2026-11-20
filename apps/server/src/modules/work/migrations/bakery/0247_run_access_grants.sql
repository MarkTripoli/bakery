-- Run-scoped access (issue #456, chapter 25 section 19.2): a person who is a
-- member of the organization but has no standing access to a run can be given
-- the right to see that one run.
--
-- This is observe only. It names one person and one run, never a project and
-- never a verb: the right to do something (decide, answer, comment, steer) is a
-- separate, expiring grant on one thing, added in a later slice. Observe stays
-- after a request ends; only removing access (revoked_at) takes it away.
--
-- It extends the authorization gate, it does not replace it: the gate lets a
-- grant-holder read exactly the run, its steps and its task, and every other
-- action stays closed to them. Every lookup carries organization_id.
--
-- "via" records how the person got it, so "who can see this run" can say so
-- (a request or a mention). The closed vocabulary is owned by TypeScript.
create table bakery.run_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  principal_id uuid not null,
  source_request_id uuid,
  via text not null,
  granted_by uuid,
  granted_by_kind text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  version integer not null default 1,
  constraint run_access_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_access_grants_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_access_grants_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint run_access_grants_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint run_access_grants_request_fk
    foreign key (organization_id, source_request_id)
    references bakery.person_requests (organization_id, id)
    on delete set null (source_request_id),
  constraint run_access_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete set null,
  constraint run_access_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete set null,
  constraint run_access_grants_organization_id_unique
    unique (organization_id, id)
);

-- One live grant per person and run: asking again does not add a second.
create unique index run_access_grants_live_unique
  on bakery.run_access_grants (organization_id, run_id, principal_id)
  where revoked_at is null;

-- The gate's lookup: this person's live grants, by run and by task.
create index run_access_grants_principal_idx
  on bakery.run_access_grants (organization_id, principal_id, run_id)
  where revoked_at is null;
create index run_access_grants_task_idx
  on bakery.run_access_grants (organization_id, principal_id, task_id)
  where revoked_at is null;

-- "Who can see this run".
create index run_access_grants_run_idx
  on bakery.run_access_grants (organization_id, run_id, created_at desc)
  where revoked_at is null;

grant select, insert on bakery.run_access_grants to bakery_app;
grant update (revoked_at, revoked_by, version) on bakery.run_access_grants
  to bakery_app;
