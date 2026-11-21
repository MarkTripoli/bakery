-- Notes left for a workflow step that has not started (chapter 25 section 9,
-- #412): a person writes the note now, and the agent that runs the step receives
-- it once, with its input. A started step has a live session, and a steer on
-- that session is the way to reach it.
--
-- Rules for these tables:
-- * Both tables are append-only (SELECT and INSERT only for bakery_app). A note
--   is never edited, and "delivered" is a row in the second table rather than a
--   column updated on the first, so the record of what was written survives
--   being delivered.
-- * body length, the refusal of NUL and lone surrogates and the "step must be
--   pending" rule are enforced in TypeScript. The PostgreSQL boundary rails
--   forbid CHECK constraints, triggers and functions here.
-- * step_key is bounded text with no foreign key: run_steps rows are keyed by
--   (run_id, step_key, iteration), so one column cannot reference one row. The
--   writer checks the step exists and is pending.
-- * client_note_id makes a retried request return the original note.
-- * run_step_note_deliveries.note_id is UNIQUE: that constraint is what makes a
--   note deliverable once, even if two admissions race.
create table bakery.run_step_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  step_key text not null,
  author_id uuid not null,
  body text not null,
  client_note_id text not null,
  created_at timestamptz not null default now(),
  constraint run_step_notes_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint run_step_notes_author_fk
    foreign key (author_id)
    references bakery.principals (id) on delete restrict,
  constraint run_step_notes_organization_id_unique
    unique (organization_id, id),
  constraint run_step_notes_client_note_unique
    unique (organization_id, run_id, author_id, client_note_id)
);

-- A step's undelivered notes are read oldest-first at admission.
create index run_step_notes_step_idx
  on bakery.run_step_notes (organization_id, run_id, step_key, created_at, id);

create table bakery.run_step_note_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  note_id uuid not null,
  job_id uuid not null,
  delivered_at timestamptz not null default now(),
  constraint run_step_note_deliveries_note_fk
    foreign key (organization_id, note_id)
    references bakery.run_step_notes (organization_id, id) on delete cascade,
  constraint run_step_note_deliveries_job_fk
    foreign key (job_id)
    references bakery.jobs (id) on delete cascade,
  constraint run_step_note_deliveries_note_unique
    unique (organization_id, note_id)
);

grant select, insert on bakery.run_step_notes to bakery_app;
grant select, insert on bakery.run_step_note_deliveries to bakery_app;
