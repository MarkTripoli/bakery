-- The request record (issue #456, chapter 25 section 19): one person asks
-- another, on one run, for one thing.
--
-- The product word is "request". The record is the whole story of the ask:
-- who asked, who was asked (frozen when it was made, so a later change to a
-- group or a role never rewrites it), what for (the intent), the optional note
-- and "needed by" time, and how it ended. It never copies the thing it is
-- about: the run, step and task are references, and what the recipient may do
-- is carried by the access grant (0247), not by this row.
--
-- A request ends in exactly one way: answered, handled by someone else in the
-- group, expired (seven days after it was made, never approved by silence) or
-- withdrawn. The closed vocabularies (intent, status, who asked) are owned by
-- TypeScript, not CHECK constraints.
--
-- An open request is unique per recipient, run, step and intent, so asking
-- again reminds the person instead of stacking a second row.
create table bakery.person_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  step_key text,
  intent text not null,
  recipient_id uuid not null,
  -- Set when the person asked for could not be resolved and the run's starter
  -- was asked instead; names who was meant, so the page can say so (O62).
  fallback_for_name text,
  asked_by uuid,
  asked_by_kind text not null,
  note text,
  needed_by timestamptz,
  status text not null default 'open',
  expires_at timestamptz not null,
  responded_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint person_requests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint person_requests_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint person_requests_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint person_requests_recipient_fk
    foreign key (recipient_id)
    references bakery.principals (id) on delete cascade,
  constraint person_requests_asked_by_fk
    foreign key (asked_by)
    references bakery.principals (id) on delete set null,
  constraint person_requests_withdrawn_by_fk
    foreign key (withdrawn_by)
    references bakery.principals (id) on delete set null,
  constraint person_requests_organization_id_unique
    unique (organization_id, id)
);

create unique index person_requests_open_unique
  on bakery.person_requests (
    organization_id, run_id, recipient_id, intent, coalesce(step_key, '')
  )
  where status = 'open';

-- "People asked" on a run, newest first.
create index person_requests_run_idx
  on bakery.person_requests (organization_id, run_id, created_at desc, id desc);

-- "What was I asked" for one person.
create index person_requests_recipient_idx
  on bakery.person_requests (organization_id, recipient_id, status, run_id);

grant select, insert on bakery.person_requests to bakery_app;
grant update (status, responded_at, withdrawn_at, withdrawn_by, updated_at,
  version)
  on bakery.person_requests to bakery_app;
