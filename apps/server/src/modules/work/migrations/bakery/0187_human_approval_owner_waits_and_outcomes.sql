-- The human.approval step end to end (issue #411, chapter 25 section 9 and
-- section 17.1): a workflow owner who is the default approver, a recorded wait
-- that is excluded from the run's active clock, and a named outcome for every
-- way a run can end.
--
-- Why the owner lives on the definition and not on the version. A version's
-- created_by is whoever last edited the workflow, which is an editor, not the
-- person accountable for approving it. Resolving the approver from created_by
-- would silently make the last editor the approver, and a workflow with no
-- accountable owner would fall back to "any organization admin" - a widening
-- nobody asked for. owner_principal_id is therefore its own column, nullable,
-- and a null owner is a named refusal (no-resolvable-approver) rather than a
-- fallback. The vocabulary and the refusal name live in TypeScript; the
-- PostgreSQL boundary rail forbids CHECK constraints, triggers and functions.
--
-- Why waits are a table and not a counter. The active clock is wall time minus
-- the time a run spent waiting for a person. Recording each wait as an interval
-- means the exclusion is derived from rows that exist, so a wait cannot be
-- forgotten by a caller that meant to subtract it, and an open wait (ended_at
-- null) is still excluded while it is happening. A counter column would need
-- every writer to remember to add to it, and the one that forgot would make a
-- seven-day wait look like seven days of work.
--
-- Why the outcome is a column and not a status value. status says whether the
-- run is running, finished or failed; outcome says what it ended as. Collapsing
-- them would make "rejected" and "stopped" and "expired" indistinguishable from
-- a failure, and a workflow that branches on what happened needs the name.
-- outcome_reason carries the human explanation for the endings that have one.
--
-- Why the ledger gets a partial unique index. One approval is decided once, so
-- a second ledger entry for the same approval is a replay or a race, not a
-- reversal (a reversal is a decision about a different, superseding approval).
-- The index makes that collision happen at the data layer, where the operations
-- layer can absorb it as a conflict instead of appending a duplicate row. It is
-- partial because other subject kinds legitimately carry several entries: a run
-- can be steered, stopped and steered again.

alter table bakery.workflow_definitions
  add column owner_principal_id uuid,
  add constraint workflow_definitions_owner_principal_fk
    foreign key (owner_principal_id)
    references bakery.principals (id) on delete restrict;

-- "Which workflows does this person own?" is the approver's inbox query.
create index workflow_definitions_owner_idx
  on bakery.workflow_definitions (organization_id, owner_principal_id)
  where owner_principal_id is not null;

alter table bakery.workflow_runs
  add column outcome text,
  add column outcome_reason text;

-- A run's ending is read by outcome, and the unfinished runs are the ones a
-- sweep looks for, so the index is partial on the rows that have one.
create index workflow_runs_outcome_idx
  on bakery.workflow_runs (organization_id, outcome, finished_at)
  where outcome is not null;

-- One row per wait. ended_at null means the run is waiting right now, which is
-- exactly the state the active clock must exclude.
create table bakery.run_waits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  step_key text not null,
  kind text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint run_waits_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_waits_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_waits_organization_id_unique
    unique (organization_id, id)
);

-- The active clock sums a run's waits, so this is the read path.
create index run_waits_run_idx
  on bakery.run_waits (organization_id, run_id, started_at);
-- At most one open wait per step: a step that is waiting is waiting once, and a
-- second open row would double-count the exclusion.
create unique index run_waits_one_open_per_step_idx
  on bakery.run_waits (organization_id, run_id, step_key)
  where ended_at is null;

-- An expiry has no human decider, so the ledger must be able to say so. A null
-- decided_by means the system ended the entry, and the reason names why. Writing
-- the approver's id instead would claim a person made a decision they never
-- made, which is worse than an explicit null.
alter table bakery.decisions_ledger alter column decided_by drop not null;

create unique index decisions_ledger_approval_once_idx
  on bakery.decisions_ledger (organization_id, subject_kind, subject_id)
  where subject_kind = 'approval';

-- bakery_app writes waits and outcomes at runtime. Without these grants every
-- write fails with "permission denied for table", which no structural check
-- catches; the integration path is the only thing that finds it.
grant select, insert, update on bakery.run_waits to bakery_app;
