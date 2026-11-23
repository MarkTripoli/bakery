-- Placement is data on the run (chapter 25 section 8, O22): the requirements
-- every job of the run adds to its own, and an affinity key. An empty object
-- means no constraint, which is what every existing run has.
alter table bakery.workflow_runs
  add column placement jsonb not null default '{}'::jsonb;

comment on column bakery.workflow_runs.placement is
  'Run placement constraint: {requirements:{capabilities,platform?}, affinityKey?}. Merged into each job''s requirements at dispatch.';
