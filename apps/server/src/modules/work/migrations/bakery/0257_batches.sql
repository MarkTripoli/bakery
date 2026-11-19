-- Batches: a bounded run of issues in one repository (issue #58).
--
-- A batch is a supervisor's record, not an engine. It says which repository,
-- who started it, the three limits it must stop at, and whether it carries on
-- by itself or asks first. It holds no plan and no step state: each issue it
-- works on is an ordinary ticket request and task, and the batch only points at
-- them. A supervisor reads this table and calls the existing admission actions.
--
-- Structure only, like the other lifecycle tables: the states, the reasons, the
-- ranges of the three limits and the carry-on choice are enforced in TypeScript.
-- The schema carries no CHECK and no trigger, because a rule that lives in two
-- places drifts in one of them.
create table bakery.batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid not null,
  started_by uuid not null,
  -- The three limits. All are required: a batch without them is not bounded.
  max_issues integer not null,
  max_hours integer not null,
  max_spend_usd numeric(20, 6) not null,
  -- carry_on or ask_first. No default: the person chooses, because this is the
  -- choice that makes a batch unattended.
  continue_mode text not null,
  -- running, waiting, paused, stopping, finishing, finished or stopped. Stopping
  -- and finishing are live: the batch starts nothing new while the current issue
  -- ends, after a stop that lets it finish, or after the time or spend limit.
  state text not null default 'running',
  -- Why it is paused, when it is: paused_by_person, or a named finding of the
  -- supervisor. Null otherwise.
  pause_reason text,
  paused_by uuid,
  paused_at timestamptz,
  -- Why it ended: a limit, nothing left to start, a failure, a change on GitHub,
  -- lost authority. Set when the batch starts finishing, so a batch that reached a
  -- limit while an issue was running still says why; finished_at is set when it ends.
  finish_reason text,
  finished_at timestamptz,
  stopped_by uuid,
  -- Whether a stop also cancelled the issue being worked on.
  stop_cancelled_current boolean not null default false,
  -- Set by a person's yes to the next issue under ask_first, and consumed when the
  -- supervisor starts it, so a yes is used once and the next issue asks again.
  next_approved boolean not null default false,
  -- The limit clock: elapsed time is counted from here, not from creation, so a
  -- pause that outlasts the limit is the supervisor's finding and not a surprise.
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint batches_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint batches_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id)
    on delete restrict,
  constraint batches_started_by_fk
    foreign key (started_by) references bakery.principals (id)
    on delete no action,
  constraint batches_paused_by_fk
    foreign key (paused_by) references bakery.principals (id)
    on delete no action,
  constraint batches_stopped_by_fk
    foreign key (stopped_by) references bakery.principals (id)
    on delete no action,
  constraint batches_organization_id_unique unique (organization_id, id)
);

-- One live batch per repository. A second start is refused by the structure, not
-- by a check that two requests could both pass.
create unique index batches_one_live_per_repository
  on bakery.batches (organization_id, repository_id)
  where state in ('running', 'waiting', 'paused', 'stopping', 'finishing');

-- The supervisor's read: every live batch.
create index batches_live_idx
  on bakery.batches (state)
  where state in ('running', 'waiting', 'paused', 'stopping', 'finishing');

-- The batches of one repository, newest first, for the list.
create index batches_repository_created_idx
  on bakery.batches (organization_id, repository_id, created_at desc);

-- The issues of a batch, in the order they were considered. Each one that was
-- started points at its ordinary request and task; each one passed over keeps
-- the reason, so the page can say why it was not taken.
create table bakery.batch_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_id uuid not null,
  position integer not null,
  external_ticket_id uuid not null,
  -- started, merged, failed, cancelled or passed_over.
  state text not null,
  -- For a passed-over issue, one of the existing readiness reason codes.
  reason text,
  ticket_request_id uuid,
  -- What the issue cost, recorded when it merged.
  cost_usd numeric(20, 6),
  started_at timestamptz,
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint batch_issues_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint batch_issues_batch_fk
    foreign key (organization_id, batch_id)
    references bakery.batches (organization_id, id) on delete cascade,
  constraint batch_issues_ticket_fk
    foreign key (organization_id, external_ticket_id)
    references bakery.external_tickets (organization_id, id)
    on delete restrict,
  constraint batch_issues_request_fk
    foreign key (organization_id, ticket_request_id)
    references bakery.ticket_requests (organization_id, id)
    on delete restrict,
  constraint batch_issues_position_unique unique (batch_id, position),
  -- An issue is taken once per batch, so two supervisors cannot both start it.
  constraint batch_issues_ticket_unique unique (batch_id, external_ticket_id)
);

-- Grants, column-scoped so identity cannot move: a batch's repository, starter,
-- limits and carry-on choice are fixed when it starts (a different batch is a
-- different start). What changes is its state, the reasons, and who stopped it.
grant select, insert on bakery.batches to bakery_app;
grant update (
  state, pause_reason, paused_by, paused_at, finish_reason, finished_at,
  stopped_by, stop_cancelled_current, next_approved, updated_at, version
) on bakery.batches to bakery_app;

grant select, insert on bakery.batch_issues to bakery_app;
grant update (
  state, reason, ticket_request_id, cost_usd, started_at, merged_at,
  updated_at, version
) on bakery.batch_issues to bakery_app;
