-- The tool feed of a run (#435, chapter 25 section 15.4: "a `tool` feed item per
-- call").
--
-- A `tool.call` step has no agent session, so the session feed cannot carry it.
-- Each call writes append-only rows here instead: one when the step first sends
-- and one when it settles, completed or failed. A step looked at again while its
-- write is unproven writes nothing new. The rows carry no arguments and no
-- result, only which tool was called on which connection and how it ended, so
-- nothing here can leak what a call said.
--
-- Rules for this table:
-- * Insert and select only. A row is a fact that happened and is never edited.
-- * `sequence` is the order a reader resumes from; `(run_id, call_id, phase)`
--   is unique so a replayed step records each phase once.
-- * `call_id` is the step's one effect key (run id, step key, iteration).
-- * The phase set (started, completed, failed) is TypeScript; the PostgreSQL
--   boundary rail forbids CHECK constraints and triggers.
create table bakery.run_tool_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid not null,
  sequence bigint generated always as identity,
  call_id text not null,
  connection_id uuid not null,
  tool_name text not null,
  phase text not null,
  ok boolean,
  failure_code text,
  occurred_at timestamptz not null default now(),
  constraint run_tool_calls_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint run_tool_calls_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_tool_calls_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade,
  constraint run_tool_calls_organization_id_unique
    unique (organization_id, id),
  constraint run_tool_calls_phase_unique
    unique (run_id, call_id, phase)
);

-- A run's feed, oldest first, resumed by (sequence, id).
create index run_tool_calls_run_sequence_idx
  on bakery.run_tool_calls (organization_id, run_id, sequence, id);

grant select, insert on bakery.run_tool_calls to bakery_app;
