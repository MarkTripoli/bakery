-- Which run spawned a run (issue #413, chapter 25 sections 9 and 18.1, O50).
--
-- An agent that starts runs can recurse, so every run an agent starts names the
-- run it came from. Depth is the length of that chain, the count of live
-- children of a run is read from it, and the authority a spawned run holds is
-- the intersection of the workflows along it: a child never holds more than its
-- parent. A run a person starts has no parent and is depth 0.
--
-- Rules for this column:
-- * Written once, in the transaction that admits the run, and never edited.
-- * Nullable, with no default: a person's run is not a spawn.
-- * The bounds on depth and children are TypeScript and configuration, not
--   constraints; the PostgreSQL boundary rail forbids CHECK constraints.
alter table bakery.workflow_runs
  add column spawned_by_run_id uuid;

alter table bakery.workflow_runs
  add constraint workflow_runs_spawned_by_fk
    foreign key (organization_id, spawned_by_run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete set null (spawned_by_run_id);

-- The live children of one run, which is what the spawn count reads.
create index workflow_runs_spawned_by_idx
  on bakery.workflow_runs (organization_id, spawned_by_run_id)
  where spawned_by_run_id is not null;

-- The application role may set the column, and only that column: it is written
-- once by the transaction that admits the spawned run, never edited after.
grant update (spawned_by_run_id) on bakery.workflow_runs to bakery_app;
