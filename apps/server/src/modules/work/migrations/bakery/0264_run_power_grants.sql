-- The right to do one thing on one run (issue #456 slice 2a, chapter 25 section
-- 19.2): a person asked to approve or to answer is given exactly that one
-- approval or question, until the request ends. It is separate from
-- run_access_grants, which is observe only and outlives a request.
--
-- It names one person, one power and one target row, never a project and never
-- a role. It replaces the audience check of that one row; it does not sit
-- beside it and it reaches nothing else. The closed vocabulary of powers is
-- owned by TypeScript. Every lookup carries organization_id.
--
-- The target is a question or an approval (both are question rows), a real
-- foreign key, so a grant can never name a row that does not exist, and it goes
-- with the row it was for. A later slice that needs another kind of target adds
-- its own column then.

-- The request names the question or approval it asks about; null for a request
-- that asks for none (a plain "just let them know").
alter table bakery.person_requests add column target_id uuid;

-- An open request is one per person, run, intent, step and target, so two
-- approvals on one run can both be asked of the same person.
drop index bakery.person_requests_open_unique;
create unique index person_requests_open_unique
  on bakery.person_requests (
    organization_id, run_id, recipient_id, intent, coalesce(step_key, ''),
    coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'open';

create table bakery.run_power_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  principal_id uuid not null,
  power text not null,
  target_kind text not null,
  question_id uuid not null,
  source_request_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  version integer not null default 1,
  constraint run_power_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_power_grants_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_power_grants_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint run_power_grants_question_fk
    foreign key (organization_id, question_id)
    references bakery.questions (organization_id, id) on delete cascade,
  constraint run_power_grants_request_fk
    foreign key (organization_id, source_request_id)
    references bakery.person_requests (organization_id, id)
    on delete set null (source_request_id),
  constraint run_power_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete set null,
  constraint run_power_grants_organization_id_unique
    unique (organization_id, id)
);

-- One live grant per person, power and target: asking again does not add a
-- second.
create unique index run_power_grants_live_unique
  on bakery.run_power_grants (
    organization_id, principal_id, power,
    question_id
  )
  where revoked_at is null;

-- The gate's lookup, and "who can act on this run".
create index run_power_grants_run_idx
  on bakery.run_power_grants (organization_id, run_id, created_at desc)
  where revoked_at is null;

grant select, insert on bakery.run_power_grants to bakery_app;
grant update (revoked_at, revoked_by, version) on bakery.run_power_grants
  to bakery_app;
